// api/incasso-maandlijst.js
//
// GET [?customer_id=<uuid>] → { ok, klanten: [{ customer_id, klant, status,
//   abonnementen, maanden: [{ maand, verwacht, ontvangen, achterstand,
//   facturen }], totaal }] }
//
// Maandlijst incasso-abonnementen (PR 4 mentorcommissie): klanten met status
// incasso_regeling of een abonnement van soort incasso_regeling. Rekenkern:
// api/_lib/incasso-maandlijst.js. Alleen lezen; "betaling ontvangen" gaat via
// de bestaande betaalflow (/api/finance-invoice-register-payment).
// Recht: finance.dunning.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { laadIncassoRijen, huidigeStatus, statusVan } from './_lib/klant-incassostatus.js';
import { soortKolomOntbreekt } from './_lib/subscription-soort.js';
import { trajectFacturen, bouwMaandlijst } from './_lib/incasso-maandlijst.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUB_KOLOMMEN = 'id, deal_id, description, amount, vat_percentage, line_items, term_count, start_date, end_date, billing_cycle, status, teamleader_subscription_id, soort, sale_deal_id';
const vandaagNl = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());

async function alle(q, wat) {
  const { data, error } = await q;
  if (error) throw new Error(`${wat}: ${error.message}`);
  return data || [];
}

export async function bouwIncassoMaandlijst(db, { customerId = null, vandaag = vandaagNl() } = {}) {
  // 1) Klanten in scope.
  let regelingSubs = [];
  {
    let q = db.from('subscriptions').select(SUB_KOLOMMEN).eq('soort', 'incasso_regeling');
    const { data, error } = await q;
    if (error && !soortKolomOntbreekt(error)) throw new Error('subscriptions: ' + error.message);
    regelingSubs = data || [];
  }
  const dealIds = [...new Set(regelingSubs.map((s) => s.deal_id).filter(Boolean))];
  const dealKlant = new Map((dealIds.length ? await alle(db.from('deals').select('id, customer_id').in('id', dealIds), 'deals') : []).map((d) => [d.id, d.customer_id]));
  const klantSet = new Set(regelingSubs.map((s) => dealKlant.get(s.deal_id)).filter(Boolean));
  {
    let { data, error } = await db.from('mentor_commissie_incasso').select('customer_id, deal_id, status, opgeheven_op').is('opgeheven_op', null).is('deal_id', null);
    if (error) ({ data } = await db.from('mentor_commissie_incasso').select('customer_id, deal_id, opgeheven_op').is('opgeheven_op', null).is('deal_id', null));
    for (const r of data || []) if (statusVan(r) === 'incasso_regeling') klantSet.add(r.customer_id);
  }
  let klanten = [...klantSet];
  if (customerId) klanten = klanten.filter((c) => c === customerId);
  if (!klanten.length) return { klanten: [] };

  // 2) Context per klant.
  const [custs, facturen, statusRijen] = await Promise.all([
    alle(db.from('customers').select('id, is_company, company_name, first_name, last_name, email').in('id', klanten), 'customers'),
    alle(db.from('invoices').select('id, customer_id, deal_id, tl_subscription_id, invoice_number, amount_total, amount_paid, credited_amount, status, issue_date, due_date, paid_date, created_at').in('customer_id', klanten), 'invoices'),
    laadIncassoRijen(db, klanten, { alleenActief: true }),
  ]);
  const ids = facturen.map((f) => f.id);
  const betalingen = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const { data: pays, error } = await db.from('payments').select('invoice_id, amount, payment_date, payment_method, source').in('invoice_id', ids.slice(i, i + 150));
    if (error) { console.warn('[incasso-maandlijst] payments:', error.message); break; }
    for (const p of pays || []) {
      if (!betalingen.has(p.invoice_id)) betalingen.set(p.invoice_id, []);
      betalingen.get(p.invoice_id).push(p);
    }
  }
  const custById = new Map(custs.map((c) => [c.id, c]));
  const uit = [];
  for (const cid of klanten) {
    const subs = regelingSubs.filter((s) => dealKlant.get(s.deal_id) === cid);
    const status = huidigeStatus(statusRijen.rijen, cid);
    const traject = trajectFacturen({ facturen: facturen.filter((f) => f.customer_id === cid), subs, status });
    const m = bouwMaandlijst({ facturen: traject, subs, betalingen, vandaag });
    const { rij, ...st } = status;
    uit.push({
      customer_id: cid,
      klant: customerDisplayName(custById.get(cid), '(klant)'),
      status: st,
      abonnementen: subs.map((s) => ({ id: s.id, description: s.description, start_date: s.start_date, term_count: s.term_count, status: s.status, sale_deal_id: s.sale_deal_id })),
      zonder_abonnement: !subs.length,
      ...m,
    });
  }
  uit.sort((a, b) => b.totaal.achterstand - a.totaal.achterstand || a.klant.localeCompare(b.klant));
  return { klanten: uit, vandaag };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.view'))) return res.status(403).json({ error: 'Geen rechten (finance.dunning.view)' });
  const customerId = req.query?.customer_id ? String(req.query.customer_id) : null;
  if (customerId && !UUID_RE.test(customerId)) return res.status(400).json({ error: 'customer_id ongeldig' });
  try {
    const out = await bouwIncassoMaandlijst(supabaseAdmin, { customerId });
    return res.status(200).json({ ok: true, ...out });
  } catch (e) {
    console.error('[incasso-maandlijst]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
