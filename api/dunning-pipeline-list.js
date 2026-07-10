// api/dunning-pipeline-list.js
// GET ?stage=<slug> → alle pipeline-klanten met fase + laatste log +
// eerstvolgende open afspraak + openstaand bedrag. GEBATCHT (geen N+1).
// Permission: finance.dunning.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const toCents = (eur) => Math.round((Number(eur) || 0) * 100);
function openAmount(inv) {
  const t = Number(inv?.amount_total) || 0;
  const p = Number(inv?.amount_paid) || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const stageFilter = req.query?.stage ? String(req.query.stage).trim() : null;

  try {
    let q = supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('id, customer_id, stage_slug, stage_changed_at, stage_changed_by, last_activity_at, created_at')
      .order('last_activity_at', { ascending: false })
      .limit(500);
    if (stageFilter) q = q.eq('stage_slug', stageFilter);
    const { data: rows, error: pErr } = await q;
    if (pErr) throw new Error(pErr.message);
    if (!rows || rows.length === 0) return res.status(200).json({ items: [] });

    const custIds = rows.map((r) => r.customer_id);

    // Batch 1: customers.
    const { data: custRows } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone')
      .in('id', custIds);
    const custById = new Map((custRows || []).map((c) => [c.id, c]));

    // Batch 2: open invoices per customer.
    const { data: invRows } = await supabaseAdmin
      .from('invoices')
      .select('customer_id, amount_total, amount_paid, credited_amount, status')
      .in('customer_id', custIds)
      .in('status', OPEN_STATUSES);
    const openByCust = new Map();
    for (const inv of invRows || []) {
      const open = openAmount(inv);
      if (open <= 0) continue;
      const agg = openByCust.get(inv.customer_id) || { count: 0, cents: 0 };
      agg.count++;
      agg.cents += Math.round(open * 100);
      openByCust.set(inv.customer_id, agg);
    }

    // Batch 3: laatste log-entry per klant.
    const { data: logRows } = await supabaseAdmin
      .from('dunning_pipeline_log')
      .select('customer_id, entry_type, body, created_at')
      .in('customer_id', custIds)
      .order('created_at', { ascending: false })
      .limit(2000);
    const lastLogByCust = new Map();
    for (const l of logRows || []) {
      if (!lastLogByCust.has(l.customer_id)) lastLogByCust.set(l.customer_id, l);
    }

    // Batch 4: eerstvolgende open afspraak per klant.
    const nowIso = new Date().toISOString();
    const { data: apptRows } = await supabaseAdmin
      .from('dunning_pipeline_appointments')
      .select('customer_id, id, title, due_at, status')
      .in('customer_id', custIds)
      .eq('status', 'open')
      .gte('due_at', nowIso)
      .order('due_at', { ascending: true })
      .limit(2000);
    const nextApptByCust = new Map();
    for (const a of apptRows || []) {
      if (!nextApptByCust.has(a.customer_id)) nextApptByCust.set(a.customer_id, a);
    }

    const items = rows.map((r) => {
      const c = custById.get(r.customer_id) || null;
      const agg = openByCust.get(r.customer_id) || { count: 0, cents: 0 };
      return {
        pipeline_id       : r.id,
        customer_id       : r.customer_id,
        customer_name     : c ? customerDisplayName(c, '(zonder naam)') : null,
        customer_email    : c?.email || null,
        customer_phone    : c?.phone || null,
        stage_slug        : r.stage_slug,
        stage_changed_at  : r.stage_changed_at,
        last_activity_at  : r.last_activity_at,
        open_invoice_count: agg.count,
        total_open_cents  : agg.cents,
        last_log          : lastLogByCust.get(r.customer_id) || null,
        next_appointment  : nextApptByCust.get(r.customer_id) || null,
      };
    });
    return res.status(200).json({ items });
  } catch (e) {
    console.error('[dunning-pipeline-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
