// api/crediteer-ronde-preview.js
// POST { customer_ids: string[] } → per klant een read-only preview met:
//   - te crediteren facturen (open + overdue, is_test=false),
//   - totaal_incl / totaal_vat / aantal,
//   - beschikbare abonnementen (voor UI-keuze: 0 / 1 / ≥2).
//
// Read-only. Doet GEEN TL-calls. Alleen DB-lezing. Permission:
// finance.invoice.credit (zelfde als execute — leverbaar aan managers die
// zowel de scope mogen beoordelen als straks mogen crediteren).
//
// Response:
// {
//   dry_run: boolean,
//   items: [{
//     customer_id, customer_name, invoices:[{
//       id, invoice_number, issue_date, due_date, amount_total,
//       amount_paid, credited_amount, open_amount, vat_amount, days_overdue
//     }],
//     totals: { count, open_incl, open_vat },
//     subscriptions: [{ id, description, amount, term_count, start_date, end_date, teamleader_subscription_id }],
//   }]
// }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { isDryRunEnabled } from './_lib/dunning-dry-run.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

function todayMidnightMs() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
function dueDateMs(iso) {
  if (!iso) return null;
  const ymd = String(iso).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}
function openAmountEur(inv) {
  const t = Number(inv?.amount_total) || 0;
  const p = Number(inv?.amount_paid)  || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}
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
  const rawIds = Array.isArray(body.customer_ids) ? body.customer_ids : null;
  if (!rawIds || rawIds.length === 0) {
    return res.status(400).json({ error: 'customer_ids (array) verplicht' });
  }
  const customerIds = [...new Set(rawIds.filter((x) => typeof x === 'string' && UUID_RE.test(x)))];
  if (customerIds.length === 0) {
    return res.status(400).json({ error: 'Geen geldige customer_ids' });
  }
  if (customerIds.length > 200) {
    return res.status(400).json({ error: 'Te veel klanten in één preview (max 200)' });
  }

  try {
    const dryRun = await isDryRunEnabled();

    // 1) Customers ophalen (met archived/anonymized/is_test guard).
    const { data: customers, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test')
      .in('id', customerIds);
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    const custMap = new Map();
    for (const c of customers || []) {
      if (c.archived_at || c.anonymized_at) continue;
      if (c.is_test) continue;
      custMap.set(c.id, c);
    }
    if (custMap.size === 0) {
      return res.status(200).json({ dry_run: dryRun, items: [] });
    }

    const activeIds = Array.from(custMap.keys());

    // 2) Open facturen (met is_test-guard op factuur-niveau).
    const { data: invRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, vat_amount, issue_date, due_date, status, tl_invoice_id, is_test')
      .in('customer_id', activeIds)
      .in('status', OPEN_STATUSES)
      .eq('is_test', false)
      .order('due_date', { ascending: true });
    if (invErr) throw new Error('invoices lookup: ' + invErr.message);

    // 3) Deals + subscriptions per klant.
    //    Deals eerst, dan subs op deal_id (zelfde pattern als
    //    sales-customer-subscriptions.js).
    const { data: deals } = await supabaseAdmin
      .from('deals')
      .select('id, customer_id')
      .in('customer_id', activeIds)
      .is('archived_at', null);
    const dealsByCustomer = new Map();
    const allDealIds = [];
    for (const d of deals || []) {
      allDealIds.push(d.id);
      const arr = dealsByCustomer.get(d.customer_id) || [];
      arr.push(d.id);
      dealsByCustomer.set(d.customer_id, arr);
    }
    let subs = [];
    if (allDealIds.length) {
      const { data: subRows, error: sErr } = await supabaseAdmin
        .from('subscriptions')
        .select('id, deal_id, description, amount, term_count, start_date, end_date, teamleader_subscription_id, status, postponed_months')
        .in('deal_id', allDealIds)
        .order('start_date', { ascending: false });
      if (sErr) throw new Error('subscriptions lookup: ' + sErr.message);
      subs = subRows || [];
    }
    // Bind subs terug per customer via deal_id → customer_id lookup.
    const dealToCustomer = new Map();
    for (const [cid, dids] of dealsByCustomer) for (const did of dids) dealToCustomer.set(did, cid);
    const subsByCustomer = new Map();
    for (const s of subs) {
      const cid = dealToCustomer.get(s.deal_id);
      if (!cid) continue;
      // Skip subs zonder TL-id (kunnen we sowieso niet extenden in TL). Frontend
      // toont ze wel; we filteren op de execute-kant. Voor de preview laten we
      // ze staan zodat de gebruiker begrijpt waarom er niets is om te kiezen.
      const arr = subsByCustomer.get(cid) || [];
      arr.push(s);
      subsByCustomer.set(cid, arr);
    }

    // 4) Bouw response per klant.
    const todayMs = todayMidnightMs();
    const items = [];
    for (const cid of activeIds) {
      const cust = custMap.get(cid);
      const invs = (invRows || []).filter((iv) => iv.customer_id === cid);
      const invItems = [];
      let openInclSum = 0;
      let openVatSum  = 0;
      for (const iv of invs) {
        const open = openAmountEur(iv);
        if (open <= 0) continue;
        const dueMs = dueDateMs(iv.due_date);
        let daysOverdue = 0;
        if (dueMs != null && todayMs > dueMs) daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
        // BTW-bedrag van de te crediteren scope: bij een volledige credit-call
        // op TL wordt de HELE factuur gecrediteerd (inclusief eventueel al
        // betaalde delen — die worden dan boekhoudkundig teruggezet). We nemen
        // voor de preview het volledige vat_amount van de factuur.
        const vatFull = Number(iv.vat_amount) || 0;
        openInclSum += open;
        openVatSum  += vatFull;
        invItems.push({
          id                 : iv.id,
          invoice_number     : iv.invoice_number,
          issue_date         : iv.issue_date,
          due_date           : iv.due_date,
          amount_total       : Number(iv.amount_total) || 0,
          amount_paid        : Number(iv.amount_paid)  || 0,
          credited_amount    : Number(iv.credited_amount) || 0,
          open_amount        : r2(open),
          vat_amount         : r2(vatFull),
          days_overdue       : daysOverdue,
          has_tl_id          : !!iv.tl_invoice_id,
        });
      }
      const custSubs = (subsByCustomer.get(cid) || []).map((s) => ({
        id                       : s.id,
        description              : s.description || '(zonder omschrijving)',
        amount                   : Number(s.amount) || 0,
        term_count               : Number(s.term_count) || 0,
        start_date               : s.start_date,
        end_date                 : s.end_date,
        teamleader_subscription_id: s.teamleader_subscription_id || null,
        status                   : s.status || null,
        postponed_months         : Number(s.postponed_months) || 0,
      }));
      items.push({
        customer_id   : cid,
        customer_name : customerDisplayName(cust, '(zonder naam)'),
        email         : cust.email || null,
        invoices      : invItems,
        totals: {
          count     : invItems.length,
          open_incl : r2(openInclSum),
          open_vat  : r2(openVatSum),
        },
        subscriptions : custSubs,
      });
    }

    return res.status(200).json({
      dry_run: dryRun,
      items,
    });
  } catch (e) {
    console.error('[crediteer-ronde-preview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
