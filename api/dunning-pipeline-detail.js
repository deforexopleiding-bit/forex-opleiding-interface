// api/dunning-pipeline-detail.js
// GET ?customer_id → één klant: fase, volledig logboek, afspraken, open facturen.
// Permission: finance.dunning.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
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

  const cid = req.query?.customer_id ? String(req.query.customer_id).trim() : null;
  if (!cid || !UUID_RE.test(cid)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });

  try {
    const { data: pipeline } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('id, customer_id, stage_slug, stage_changed_at, stage_changed_by, last_activity_at, created_at')
      .eq('customer_id', cid).maybeSingle();
    if (!pipeline) return res.status(404).json({ error: 'Klant nog niet in pipeline' });

    const { data: cust } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone')
      .eq('id', cid).maybeSingle();

    const { data: logs } = await supabaseAdmin
      .from('dunning_pipeline_log')
      .select('id, entry_type, body, meta, created_by, created_at')
      .eq('customer_id', cid)
      .order('created_at', { ascending: false })
      .limit(500);

    const { data: appts } = await supabaseAdmin
      .from('dunning_pipeline_appointments')
      .select('id, title, due_at, status, note, created_by, created_at, completed_at')
      .eq('customer_id', cid)
      .order('due_at', { ascending: true });

    const { data: invs } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, credited_amount, issue_date, due_date, status')
      .eq('customer_id', cid)
      .in('status', OPEN_STATUSES);
    const openInvoices = (invs || []).filter((i) => openAmount(i) > 0).map((i) => ({
      ...i, amount_open: openAmount(i),
    }));

    return res.status(200).json({
      pipeline,
      customer: cust ? { ...cust, display_name: customerDisplayName(cust, '(zonder naam)') } : null,
      logs   : logs  || [],
      appointments: appts || [],
      open_invoices: openInvoices,
    });
  } catch (e) {
    console.error('[dunning-pipeline-detail]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
