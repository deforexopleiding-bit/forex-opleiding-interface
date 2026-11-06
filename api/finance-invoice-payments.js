// api/finance-invoice-payments.js
// GET ?invoice_id=<uuid> → de betalingen van één factuur, met betaalmethode
// en (bij cash) wie het ontving, de notitie en het ontvangstbewijs.
// Alleen lezen. Permission: finance.invoice.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { betaalmethodeCode, betaalmethodeLabel, betaalmethodenVan } from './_lib/betaalmethode.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });

  const invoiceId = String(req.query?.invoice_id || '');
  if (!UUID_RE.test(invoiceId)) return res.status(400).json({ error: 'invoice_id vereist' });

  const [{ data: inv }, { data: pays, error: pErr }] = await Promise.all([
    supabaseAdmin.from('invoices').select('id, amount_total, amount_paid, credited_amount, status').eq('id', invoiceId).maybeSingle(),
    supabaseAdmin.from('payments').select('id, amount, payment_date, payment_method, source, created_at').eq('invoice_id', invoiceId).order('payment_date', { ascending: true }),
  ]);
  if (pErr) return res.status(500).json({ error: 'payments: ' + pErr.message });

  // Cash-details: faalzacht (zonder migratie gewoon geen details).
  let cash = [];
  const { data: c, error: cErr } = await supabaseAdmin.from('cash_ontvangsten')
    .select('id, bewijsnummer, payment_id, bedrag, ontvangen_op, ontvangen_door, notitie, tl_betaalmethode_naam, created_at')
    .eq('invoice_id', invoiceId).order('created_at', { ascending: true });
  if (!cErr) cash = c || [];
  const cashPerPayment = new Map(cash.filter((x) => x.payment_id).map((x) => [x.payment_id, x]));

  const betalingen = (pays || []).map((p) => {
    const code = betaalmethodeCode(p);
    const k = cashPerPayment.get(p.id);
    return {
      id: p.id, bedrag: Number(p.amount) || 0, datum: p.payment_date, methode: code, methode_label: betaalmethodeLabel(code),
      cash: k ? { id: k.id, bewijsnummer: k.bewijsnummer, ontvangen_door: k.ontvangen_door, notitie: k.notitie, teamleader_methode: k.tl_betaalmethode_naam || null } : null,
    };
  });
  // Ontvangstbewijzen waarvan de betaling teruggedraaid is (payment weg).
  const ingetrokken = cash.filter((x) => !x.payment_id).map((x) => ({ id: x.id, bewijsnummer: x.bewijsnummer, bedrag: Number(x.bedrag), datum: x.ontvangen_op }));
  return res.status(200).json({ betalingen, ingetrokken, samenvatting: betaalmethodenVan(pays || [], inv) });
}
