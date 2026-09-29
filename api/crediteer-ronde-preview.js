// api/crediteer-ronde-preview.js
// POST → per klant een read-only preview van de crediteerronde.
//
// Body (nieuw, voorkeur):
//   { items: [{ customer_id, invoice_ids?: uuid[] }], only_overdue?: boolean }
// Body (legacy, blijft werken):
//   { customer_ids: uuid[], only_overdue?: boolean }
//
// Scope: met invoice_ids en/of only_overdue=true toont de preview EXACT de
// facturen die crediteer-ronde-execute met dezelfde scope zou crediteren
// (gedeelde selectCreditable). Zonder scope (legacy-aanroep) toont 'ie alle
// open facturen zoals voorheen — de execute accepteert dat niet meer.
//
// Read-only: alleen DB-lezen, GEEN TL-calls. Permission: finance.invoice.credit.
//
// Response:
// {
//   dry_run: boolean,               // app_settings.crediteer_ronde_dry_run (default AAN)
//   scope: { only_overdue, per_customer_invoice_ids: boolean },
//   items: [{
//     customer_id, customer_name, email,
//     invoices:[{ id, invoice_number, issue_date, due_date, amount_total, amount_paid,
//                 credited_amount, open_amount, vat_amount, days_overdue, has_tl_id }],
//     rejected:[{ invoice_id, invoice_number, reden }],     // alleen bij invoice_ids
//     totals: { count, open_incl, open_vat },
//     subscriptions: [{ id, description, amount, term_count, start_date, end_date,
//                       teamleader_subscription_id, status, postponed_months,
//                       billing_cycle, usable, extension_plan: { months, basis, error, cycle } }],
//   }]
// }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import {
  isCrediteerRondeDryRun, selectCreditable, openAmountEur, daysOverdue,
  todayAmsterdam, planExtension, isUsableSubscription, OPEN_STATUSES,
} from './_lib/crediteer-ronde-core.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.credit'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.invoice.credit)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const onlyOverdue = body.only_overdue === true;
  // Normaliseer beide body-vormen naar Map<customer_id, invoice_ids|null>.
  const scopeByCustomer = new Map();
  if (Array.isArray(body.items)) {
    for (const it of body.items) {
      const cid = typeof it?.customer_id === 'string' && UUID_RE.test(it.customer_id) ? it.customer_id : null;
      if (!cid) continue;
      const ids = Array.isArray(it.invoice_ids) ? it.invoice_ids.filter((x) => typeof x === 'string' && UUID_RE.test(x)) : null;
      scopeByCustomer.set(cid, ids && ids.length ? ids : null);
    }
  } else if (Array.isArray(body.customer_ids)) {
    for (const cid of body.customer_ids) if (typeof cid === 'string' && UUID_RE.test(cid)) scopeByCustomer.set(cid, null);
  } else {
    return res.status(400).json({ error: 'items (array) of customer_ids (array) verplicht' });
  }
  const customerIds = [...scopeByCustomer.keys()];
  if (customerIds.length === 0) return res.status(400).json({ error: 'Geen geldige customer_ids' });
  if (customerIds.length > 200) return res.status(400).json({ error: 'Te veel klanten in één preview (max 200)' });

  try {
    const dryRun = await isCrediteerRondeDryRun();
    const today = todayAmsterdam();

    // 1) Klanten (archived/anonymized/test eruit — execute weigert die ook).
    const { data: customers, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test')
      .in('id', customerIds);
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    const custMap = new Map();
    for (const c of customers || []) {
      if (c.archived_at || c.anonymized_at || c.is_test) continue;
      custMap.set(c.id, c);
    }
    if (custMap.size === 0) {
      return res.status(200).json({ dry_run: dryRun, scope: { only_overdue: onlyOverdue }, items: [] });
    }
    const activeIds = Array.from(custMap.keys());

    // 2) Open facturen van deze klanten.
    const { data: invRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, vat_amount, issue_date, due_date, status, tl_invoice_id, is_test')
      .in('customer_id', activeIds)
      .in('status', OPEN_STATUSES)
      .order('due_date', { ascending: true });
    if (invErr) throw new Error('invoices lookup: ' + invErr.message);

    // 3) Deals + subscriptions per klant.
    const { data: deals } = await supabaseAdmin
      .from('deals').select('id, customer_id').in('customer_id', activeIds).is('archived_at', null);
    const dealToCustomer = new Map((deals || []).map((d) => [d.id, d.customer_id]));
    let subs = [];
    if (dealToCustomer.size) {
      const { data: subRows, error: sErr } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id, description, amount, term_count, start_date, end_date, teamleader_subscription_id, status, postponed_months, billing_cycle')
        .in('deal_id', [...dealToCustomer.keys()])
        .order('start_date', { ascending: false });
      if (sErr) throw new Error('subscriptions lookup: ' + sErr.message);
      subs = subRows || [];
    }
    const subsByCustomer = new Map();
    for (const s of subs) {
      const cid = dealToCustomer.get(s.deal_id);
      if (!cid) continue;
      (subsByCustomer.get(cid) || subsByCustomer.set(cid, []).get(cid)).push(s);
    }

    // 4) Per klant: exact dezelfde selectie als de execute.
    const items = [];
    for (const cid of activeIds) {
      const cust = custMap.get(cid);
      const invs = (invRows || []).filter((iv) => iv.customer_id === cid);
      const { creditable, rejected } = selectCreditable(invs, {
        invoiceIds: scopeByCustomer.get(cid), onlyOverdue, today,
      });
      const invItems = creditable.map((iv) => ({
        id              : iv.id,
        invoice_number  : iv.invoice_number,
        issue_date      : iv.issue_date,
        due_date        : iv.due_date,
        amount_total    : Number(iv.amount_total) || 0,
        amount_paid     : Number(iv.amount_paid) || 0,
        credited_amount : Number(iv.credited_amount) || 0,
        open_amount     : openAmountEur(iv),
        // TL crediteert de HELE factuur → volledig vat_amount.
        vat_amount      : r2(Number(iv.vat_amount) || 0),
        days_overdue    : daysOverdue(iv.due_date, today),
        has_tl_id       : !!iv.tl_invoice_id,
      }));
      const custSubs = (subsByCustomer.get(cid) || []).map((s) => ({
        id                        : s.id,
        description               : s.description || '(zonder omschrijving)',
        amount                    : Number(s.amount) || 0,
        term_count                : Number(s.term_count) || 0,
        start_date                : s.start_date,
        end_date                  : s.end_date,
        teamleader_subscription_id: s.teamleader_subscription_id || null,
        status                    : s.status || null,
        postponed_months          : Number(s.postponed_months) || 0,
        billing_cycle             : s.billing_cycle || null,
        usable                    : isUsableSubscription(s),
        extension_plan            : planExtension(s, invItems.length, null),
      }));
      items.push({
        customer_id  : cid,
        customer_name: customerDisplayName(cust, '(zonder naam)'),
        email        : cust.email || null,
        invoices     : invItems,
        rejected,
        totals: {
          count    : invItems.length,
          open_incl: r2(invItems.reduce((s, i) => s + i.open_amount, 0)),
          open_vat : r2(invItems.reduce((s, i) => s + i.vat_amount, 0)),
        },
        subscriptions: custSubs,
      });
    }

    return res.status(200).json({
      dry_run: dryRun,
      scope  : { only_overdue: onlyOverdue, per_customer_invoice_ids: [...scopeByCustomer.values()].some(Boolean) },
      items,
    });
  } catch (e) {
    console.error('[crediteer-ronde-preview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
