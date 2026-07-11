// api/crediteer-overzicht.js
// GET → read-only dashboard voor de kwartaal-crediteerronde.
// Permission: finance.dunning.view (zelfde als wanbetalers-endpoints).
//
// Aggregeert per klant met ≥1 openstaande factuur (status open/partially_paid/
// overdue). Sluit is_test-rijen + archived/anonymized klanten uit.
//
// Response: {
//   items: [{
//     customer_id, naam, aantal_open_facturen, totaal_open_cents,
//     totaal_open_eur, oudste_factuur_dagen_te_laat, oudste_factuur_iso,
//     pipeline_fase, heeft_2plus,
//   }],
//   totals: { customers, invoices, total_open_cents, tweeplus_customers }
// }
//
// Sort: default totaal_open desc; via ?sort=... aanpasbaar.
//   allowed sort keys: totaal_open (default), aantal, oudste, naam
//   allowed dir: asc | desc (default desc voor totaal_open/aantal/oudste,
//                            asc voor naam)

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

const SORT_KEYS = new Set(['totaal_open', 'aantal', 'oudste', 'naam']);

function todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function dueDateMs(isoDate) {
  if (!isoDate) return null;
  const ymd = String(isoDate).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}
function openAmountEur(inv) {
  const total = Number(inv?.amount_total)    || 0;
  const paid  = Number(inv?.amount_paid)     || 0;
  const cred  = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - cred);
}
function toCents(eur) { return Math.round((Number(eur) || 0) * 100); }

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

  // Sort-params (zelfde defensieve stijl als andere finance-endpoints).
  let sortKey = String(req.query?.sort || 'totaal_open').toLowerCase();
  if (!SORT_KEYS.has(sortKey)) sortKey = 'totaal_open';
  let sortDir = String(req.query?.dir || (sortKey === 'naam' ? 'asc' : 'desc')).toLowerCase();
  if (sortDir !== 'asc' && sortDir !== 'desc') sortDir = 'desc';

  try {
    // 1) Alle open facturen + joined customer + is_test filter.
    //    Zelfde guardrail als problem-customers: sluit test-rows uit op zowel
    //    factuur- als klant-niveau.
    const { data: invRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select(`
        id, customer_id, amount_total, amount_paid, credited_amount, due_date, status, is_test,
        customers:customer_id ( id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test )
      `)
      .in('status', OPEN_STATUSES)
      .eq('is_test', false);
    if (invErr) throw new Error('invoices: ' + invErr.message);

    // 2) Per-customer aggregatie.
    const todayMs = todayMidnightMs();
    const perCustomer = new Map();
    for (const inv of invRows || []) {
      const cust = inv.customers;
      if (!cust) continue;
      if (cust.archived_at || cust.anonymized_at) continue;
      if (cust.is_test) continue;
      const open = openAmountEur(inv);
      if (open <= 0) continue;

      const agg = perCustomer.get(inv.customer_id) || {
        customer: cust,
        aantal: 0,
        totaal_eur: 0,
        oudste_iso: null,
      };
      agg.aantal      += 1;
      agg.totaal_eur  += open;
      if (inv.due_date) {
        const iso = String(inv.due_date).slice(0, 10);
        if (!agg.oudste_iso || iso < agg.oudste_iso) agg.oudste_iso = iso;
      }
      perCustomer.set(inv.customer_id, agg);
    }

    if (perCustomer.size === 0) {
      return res.status(200).json({
        items: [],
        totals: { customers: 0, invoices: 0, total_open_cents: 0, tweeplus_customers: 0 },
        sort: { key: sortKey, dir: sortDir },
      });
    }

    // 3) Pipeline-fase per klant (1 query op dunning_pipeline_customers).
    const cids = Array.from(perCustomer.keys());
    const stageByCustomer = new Map();
    const { data: pipeRows, error: pipeErr } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('customer_id, stage_slug')
      .in('customer_id', cids);
    if (pipeErr) throw new Error('pipeline customers: ' + pipeErr.message);
    for (const r of pipeRows || []) {
      if (r?.customer_id) stageByCustomer.set(r.customer_id, r.stage_slug || 'nieuw');
    }

    // 4) Bouw items + KPI-totals.
    let totalInvoices        = 0;
    let totalOpenEur         = 0;
    let tweeplusCustomerCount = 0;
    const items = [];
    for (const [customerId, agg] of perCustomer) {
      totalInvoices += agg.aantal;
      totalOpenEur  += agg.totaal_eur;
      const heeftTweePlus = agg.aantal >= 2;
      if (heeftTweePlus) tweeplusCustomerCount++;
      const oudsteMs = dueDateMs(agg.oudste_iso);
      let dagenTeLaat = 0;
      if (oudsteMs != null && todayMs > oudsteMs) {
        dagenTeLaat = Math.floor((todayMs - oudsteMs) / 86400000);
      }
      items.push({
        customer_id                   : customerId,
        naam                          : customerDisplayName(agg.customer, '(zonder naam)'),
        email                         : agg.customer.email || null,
        aantal_open_facturen          : agg.aantal,
        totaal_open_cents             : toCents(agg.totaal_eur),
        totaal_open_eur               : Math.round(agg.totaal_eur * 100) / 100,
        oudste_factuur_iso            : agg.oudste_iso,
        oudste_factuur_dagen_te_laat  : dagenTeLaat,
        pipeline_fase                 : stageByCustomer.get(customerId) || 'nieuw',
        heeft_2plus                   : heeftTweePlus,
      });
    }

    // 5) Sort-toepassing.
    const cmp = (a, b) => {
      if (sortKey === 'naam') {
        return String(a.naam || '').localeCompare(String(b.naam || ''), 'nl');
      }
      if (sortKey === 'aantal') return a.aantal_open_facturen - b.aantal_open_facturen;
      if (sortKey === 'oudste') return a.oudste_factuur_dagen_te_laat - b.oudste_factuur_dagen_te_laat;
      // default: totaal_open (in cents om float-precision te vermijden)
      return a.totaal_open_cents - b.totaal_open_cents;
    };
    items.sort((a, b) => (sortDir === 'asc' ? cmp(a, b) : cmp(b, a)));

    return res.status(200).json({
      items,
      totals: {
        customers          : perCustomer.size,
        invoices           : totalInvoices,
        total_open_cents   : toCents(totalOpenEur),
        tweeplus_customers : tweeplusCustomerCount,
      },
      sort: { key: sortKey, dir: sortDir },
    });
  } catch (e) {
    console.error('[crediteer-overzicht]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
