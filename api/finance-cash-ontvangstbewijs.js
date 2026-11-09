// api/finance-cash-ontvangstbewijs.js
// GET ?id=<cash_ontvangsten.id> → PDF-download van het ontvangstbewijs.
// Niets wordt verstuurd. Permission: finance.invoice.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { bouwOntvangstbewijsPdf } from './_lib/cash-ontvangstbewijs-pdf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.invoice.view'))) return res.status(403).json({ error: 'Geen rechten (finance.invoice.view)' });

  const id = String(req.query?.id || '');
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'id vereist' });

  const { data: bewijs, error } = await supabaseAdmin.from('cash_ontvangsten')
    .select('id, bewijsnummer, payment_id, invoice_id, customer_id, bedrag, ontvangen_op, ontvangen_door').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: 'cash_ontvangsten: ' + error.message });
  if (!bewijs) return res.status(404).json({ error: 'Ontvangstbewijs niet gevonden' });

  const [{ data: factuur }, { data: klant }] = await Promise.all([
    supabaseAdmin.from('invoices').select('invoice_number, amount_total, amount_paid, credited_amount').eq('id', bewijs.invoice_id).maybeSingle(),
    bewijs.customer_id
      ? supabaseAdmin.from('customers').select('first_name, last_name, company_name, is_company').eq('id', bewijs.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  try {
    const pdf = await bouwOntvangstbewijsPdf({
      bewijs, factuur, klantNaam: customerDisplayName(klant, ''),
      ingetrokken: !bewijs.payment_id,
      bedrijf: {
        naam: process.env.COMPANY_NAME || 'De Forex Opleiding NL B.V.',
        adres: process.env.COMPANY_ADDRESS || '', kvk: process.env.COMPANY_KVK || '',
        btw: process.env.COMPANY_BTW || '', email: process.env.COMPANY_EMAIL || '',
      },
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ontvangstbewijs-${bewijs.bewijsnummer}.pdf"`);
    return res.status(200).send(pdf);
  } catch (e) {
    console.error('[finance-cash-ontvangstbewijs]', e?.message || e);
    return res.status(500).json({ error: 'PDF maken mislukt: ' + (e?.message || e) });
  }
}
