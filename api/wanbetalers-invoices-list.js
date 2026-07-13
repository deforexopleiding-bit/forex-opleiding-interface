// api/wanbetalers-invoices-list.js
// GET → alle open (open/partially_paid/overdue), is_test=false facturen +
// per-klant-aggregatie voor de Wanbetalers > Facturen sub-view.
// Permission: finance.dunning.view.
//
// Twee weergaven vanuit één response:
//   by_invoice : één rij per te-late open factuur (dagen te laat > 0)
//     — klant · factuurnr · bedrag · dagen te laat · fase-pill
//   by_customer: één rij per klant met open facturen
//     — naam · #open · totaal open · oudste · fase-pill · has_backlog
//
// Filters (querystring):
//   ?stage=<slug>            één specifieke fase-slug
//   ?backlog=1               alleen klanten met ≥2 open facturen
//                            (per-invoice → alleen facturen van die klanten)
//
// Hergebruikt de aggregatie- + is_test-filter uit crediteer-overzicht.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

function todayMidnightMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dueDateMs(iso) {
  if (!iso) return null;
  const ymd = String(iso).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function openAmt(inv) {
  const t = Number(inv?.amount_total) || 0;
  const p = Number(inv?.amount_paid)  || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}
const toCents = (eur) => Math.round((Number(eur) || 0) * 100);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  }

  const stageFilter   = req.query?.stage   ? String(req.query.stage).trim().toLowerCase() : null;
  const backlogOnly   = req.query?.backlog === '1' || req.query?.backlog === 'true';

  try {
    // 1) Open facturen + joined customer (zelfde patroon als crediteer-overzicht).
    const { data: invRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select(`
        id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, due_date, status, is_test,
        customers:customer_id ( id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test )
      `)
      .in('status', OPEN_STATUSES)
      .eq('is_test', false);
    if (invErr) throw new Error('invoices lookup: ' + invErr.message);

    const perCustomer = new Map();
    for (const inv of invRows || []) {
      const cust = inv.customers;
      if (!cust) continue;
      if (cust.archived_at || cust.anonymized_at) continue;
      if (cust.is_test) continue;
      const open = openAmt(inv);
      if (open <= 0) continue;
      const agg = perCustomer.get(inv.customer_id) || { customer: cust, invoices: [], total_eur: 0 };
      agg.invoices.push({ ...inv, open_eur: open });
      agg.total_eur += open;
      perCustomer.set(inv.customer_id, agg);
    }

    if (perCustomer.size === 0) {
      return res.status(200).json({
        by_invoice   : [],
        by_customer  : [],
        totals       : { customers: 0, invoices: 0, total_open_cents: 0, backlog_customers: 0 },
        generated_at : new Date().toISOString(),
      });
    }

    // 2) Pipeline-fase per klant.
    const cids = Array.from(perCustomer.keys());
    const stageByCust = new Map();
    const { data: pipeRows, error: pipeErr } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('customer_id, stage_slug')
      .in('customer_id', cids);
    if (pipeErr) throw new Error('pipeline lookup: ' + pipeErr.message);
    for (const r of pipeRows || []) {
      if (r?.customer_id) stageByCust.set(r.customer_id, r.stage_slug || 'nieuw');
    }

    // 3) Bouw beide weergaven.
    const todayMs = todayMidnightMs();
    const byInvoice = [];
    const byCustomer = [];
    let totalCustomers      = 0;
    let totalInvoices       = 0;
    let totalOpenEur        = 0;
    let backlogCustomers    = 0;

    for (const [cid, agg] of perCustomer) {
      const stageSlug = stageByCust.get(cid) || 'nieuw';
      const nOpen = agg.invoices.length;
      const hasBacklog = nOpen >= 2;
      const custName = customerDisplayName(agg.customer, '(zonder naam)');

      // Filters: backlog + stage.
      const backlogPasses = backlogOnly ? hasBacklog : true;
      const stagePasses   = stageFilter ? (stageSlug === stageFilter) : true;
      if (!backlogPasses || !stagePasses) continue;

      totalCustomers++;
      totalInvoices  += nOpen;
      totalOpenEur   += agg.total_eur;
      if (hasBacklog) backlogCustomers++;

      // Oudste vervaldatum + dagen te laat.
      let oldestIso = null;
      let oldestDays = 0;
      for (const iv of agg.invoices) {
        if (!iv.due_date) continue;
        const iso = String(iv.due_date).slice(0, 10);
        if (!oldestIso || iso < oldestIso) oldestIso = iso;
      }
      if (oldestIso) {
        const ms = dueDateMs(oldestIso);
        if (ms != null && todayMs > ms) oldestDays = Math.floor((todayMs - ms) / 86400000);
      }

      byCustomer.push({
        customer_id           : cid,
        customer_name         : custName,
        open_invoice_count    : nOpen,
        total_open_cents      : toCents(agg.total_eur),
        oldest_due_date       : oldestIso,
        oldest_days_overdue   : oldestDays,
        stage_slug            : stageSlug,
        has_backlog           : hasBacklog,
      });

      // Per-invoice rijen: alle open facturen van deze klant met > 0 dagen te laat.
      for (const iv of agg.invoices) {
        const dueMs = dueDateMs(iv.due_date);
        if (dueMs == null || dueMs >= todayMs) continue; // nog niet te laat
        byInvoice.push({
          customer_id      : cid,
          customer_name    : custName,
          invoice_id       : iv.id,
          invoice_number   : iv.invoice_number,
          open_amount_cents: toCents(iv.open_eur),
          due_date         : iv.due_date,
          days_overdue     : Math.floor((todayMs - dueMs) / 86400000),
          stage_slug       : stageSlug,
          has_backlog      : hasBacklog,
        });
      }
    }

    // Sort: per-invoice op dagen te laat DESC; per-klant op totaal open DESC.
    byInvoice.sort((a, b) => (b.days_overdue - a.days_overdue));
    byCustomer.sort((a, b) => (b.total_open_cents - a.total_open_cents));

    return res.status(200).json({
      by_invoice  : byInvoice,
      by_customer : byCustomer,
      totals: {
        customers        : totalCustomers,
        invoices         : totalInvoices,
        total_open_cents : toCents(totalOpenEur),
        backlog_customers: backlogCustomers,
      },
      generated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[wanbetalers-invoices-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
