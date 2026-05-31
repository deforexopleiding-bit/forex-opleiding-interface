// api/_lib/teamleader-quotation.js
// Wizard 1 (offerte-flow): push deal → TL quotation.
//
// TL-flow: contact → deal (opportunity) → quotation (vereist deal_id).
// De offerte wordt standaard als CONCEPT in TL aangemaakt; versturen naar de
// klant gebeurt door de salesmedewerker in TL, tenzij TEAMLEADER_QUOTATION_AUTOSEND
// === 'true' (dan probeert deze functie /quotations.send en zet status 'sent').
//
// CONFIG (env, te zetten in Vercel):
//   TEAMLEADER_DEPARTMENT_ID        (optioneel; anders eerste actieve department)
//   TEAMLEADER_TAX_RATE_ID_21 / _9 / _0   (verplicht per gebruikt BTW-tarief)
//   TEAMLEADER_QUOTATION_AUTOSEND   (optioneel, 'true' om automatisch te versturen)

import { tlFetch, getActiveToken } from './teamleader-token.js';
import { supabaseAdmin } from '../supabase.js';
import { getOrCreateContact, createDeal } from './teamleader-contact.js';

const CURRENCY = 'EUR';

// Resolve department: gekozen entiteit (deal) → env-override → eerste actieve.
async function resolveDepartmentId(preferred) {
  if (preferred) return preferred;
  if (process.env.TEAMLEADER_DEPARTMENT_ID) return process.env.TEAMLEADER_DEPARTMENT_ID;
  const r = await tlFetch('/departments.list', { method: 'POST', body: JSON.stringify({}) });
  if (!r.ok) throw new Error(`TL departments.list HTTP ${r.status}`);
  const data = await r.json();
  const depts = data.data || [];
  const active = depts.find(d => d.status === 'active') || depts[0];
  if (!active) throw new Error('Geen TL-department gevonden');
  return active.id;
}

// Map onze vat_percentage → geconfigureerde TL tax_rate_id (env).
function taxRateIdFor(vatPercentage) {
  const id = process.env[`TEAMLEADER_TAX_RATE_ID_${vatPercentage}`];
  if (!id) throw new Error(`Geen TEAMLEADER_TAX_RATE_ID_${vatPercentage} geconfigureerd`);
  return id;
}

export async function pushQuotationToTl(dealId) {
  try {
    const tok = await getActiveToken();
    if (!tok) throw new Error('Geen TL-token actief');

    const { data: deal, error: dErr } = await supabaseAdmin.from('deals').select('*').eq('id', dealId).maybeSingle();
    if (dErr || !deal) throw new Error('Deal niet gevonden');

    // Idempotency: al-verzonden offerte niet opnieuw aanmaken.
    if (deal.tl_quotation_id) {
      const { data: cust } = await supabaseAdmin.from('customers').select('tl_contact_id').eq('id', deal.customer_id).maybeSingle();
      return {
        success:           true,
        already_synced:    true,
        tl_contact_id:     cust?.tl_contact_id || null,
        tl_deal_id:        deal.tl_deal_id || null,
        tl_quotation_id:   deal.tl_quotation_id,
        tl_quotation_status: deal.tl_quotation_status || 'draft',
        message:           'Offerte was al naar Teamleader gepusht, duplicate overgeslagen',
      };
    }

    const { data: customer } = await supabaseAdmin.from('customers').select('*').eq('id', deal.customer_id).maybeSingle();
    const { data: lines } = await supabaseAdmin.from('deal_line_items').select('*').eq('deal_id', dealId).order('position', { ascending: true });
    if (!lines || lines.length === 0) throw new Error('Geen offerte-regels (deal_line_items) gevonden');

    // Bedrijfsentiteit: gekozen department (deal) → env → eerste actieve.
    const departmentId = await resolveDepartmentId(deal.tl_department_id);

    // 1. Contact + 2. Deal (quotation vereist deal_id).
    const tlContactId = await getOrCreateContact(customer);
    let tlDealId = deal.tl_deal_id;
    if (!tlDealId) tlDealId = await createDeal(deal, tlContactId, departmentId);

    // 3. Quotation samenstellen.
    const lineItems = lines.map(l => ({
      quantity:    Number(l.quantity),
      description: l.product_name,
      unit_price:  { amount: Number(l.unit_price), currency: CURRENCY, tax: 'excluding' },
      tax_rate_id: taxRateIdFor(l.vat_percentage),
    }));
    const quotationBody = {
      deal_id:       tlDealId,
      department_id: departmentId,
      grouped_lines: [{ line_items: lineItems }],
    };
    const qr = await tlFetch('/quotations.create', { method: 'POST', body: JSON.stringify(quotationBody) });
    if (!qr.ok) {
      const txt = await qr.text();
      throw new Error(`TL quotations.create HTTP ${qr.status}: ${txt.slice(0, 200)}`);
    }
    const qData = await qr.json();
    const tlQuotationId = qData.data?.id;

    // 4. Optioneel versturen (alleen als expliciet aangezet; voorkomt per ongeluk
    //    mailen van echte klanten met nog-niet-geverifieerde output).
    let quotationStatus = 'draft';
    let sentAt = null;
    if (process.env.TEAMLEADER_QUOTATION_AUTOSEND === 'true' && tlQuotationId) {
      try {
        const sr = await tlFetch('/quotations.send', { method: 'POST', body: JSON.stringify({ id: tlQuotationId }) });
        if (sr.ok) { quotationStatus = 'sent'; sentAt = new Date().toISOString(); }
        else { console.error('[tl-quotation] send fail HTTP', sr.status); }
      } catch (e) {
        console.error('[tl-quotation] send exception:', e.message);
      }
    }

    await supabaseAdmin.from('deals').update({
      tl_deal_id:           tlDealId,
      tl_pushed_at:         new Date().toISOString(),
      tl_push_status:       'synced',
      tl_push_error:        null,
      tl_quotation_id:      tlQuotationId,
      tl_quotation_status:  quotationStatus,
      tl_quotation_sent_at: sentAt,
    }).eq('id', dealId);

    return {
      success:             true,
      tl_contact_id:       tlContactId,
      tl_deal_id:          tlDealId,
      tl_quotation_id:     tlQuotationId,
      tl_quotation_status: quotationStatus,
    };
  } catch (e) {
    await supabaseAdmin.from('deals').update({
      tl_quotation_status: 'draft',
      tl_push_error:       e.message.slice(0, 500),
    }).eq('id', dealId);
    return { success: false, error: e.message };
  }
}
