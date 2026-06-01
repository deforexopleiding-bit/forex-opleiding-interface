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

// Bouwt een leesbare titel-string uit traject + optionele betalingsvoorwaarden.
// Returnt null als er niets is ingevuld (caller gebruikt dan een fallback).
function buildQuotationTitle(deal, trajectLabel) {
  const seg = [];
  if (trajectLabel) seg.push(trajectLabel);
  if (deal.payment_start_date) {
    const d = new Date(deal.payment_start_date);
    seg.push(`Start: ${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`);
  }
  if (deal.payment_downpayment_amount) {
    seg.push(`Aanbetaling €${Number(deal.payment_downpayment_amount).toLocaleString('nl-NL')}`);
  }
  if (deal.payment_term_count) {
    const amt = deal.payment_term_amount ? ` van €${Number(deal.payment_term_amount).toLocaleString('nl-NL')}` : '';
    seg.push(`${deal.payment_term_count} termijnen${amt}`);
  }
  return seg.length ? seg.join(' | ') : null;
}

// TL department-UUID → korte naam voor per-department env-vars.
const DEPT_NAME = {
  '09d67371-6947-03f6-bd5e-410dd8636344': 'ONLINE',
  '0da396bf-1074-0425-ac5c-fa1141b41cb1': 'FYSIEK',
  '9adca043-0ebc-09da-a45e-f21798841cb2': 'RETENTIE',
};

// Map vat_percentage (+ department + type verkoop) → TL tax_rate_id.
// - Type verkoop intracommunautair/buiten-EU → eigen 0%/verlegd tarief:
//     TEAMLEADER_TAX_RATE_ID_INTRA_{DEPT} / _INTRA   (fallback)
//     TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU_{DEPT} / _OUTSIDE_EU
// - Binnenlands → per BTW%-tarief, met per-department override:
//     TEAMLEADER_TAX_RATE_ID_21_{DEPT} / TEAMLEADER_TAX_RATE_ID_21
export function taxRateIdFor(vatPercentage, departmentId, saleType) {
  const dept = DEPT_NAME[departmentId];
  const pickEnv = (...keys) => { for (const k of keys) if (process.env[k]) return process.env[k]; return null; };

  if (saleType === 'intracommunautair') {
    const id = pickEnv(dept ? `TEAMLEADER_TAX_RATE_ID_INTRA_${dept}` : null, 'TEAMLEADER_TAX_RATE_ID_INTRA');
    if (!id) throw new Error('Geen TEAMLEADER_TAX_RATE_ID_INTRA geconfigureerd');
    return id;
  }
  if (saleType === 'outside_eu') {
    const id = pickEnv(dept ? `TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU_${dept}` : null, 'TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU');
    if (!id) throw new Error('Geen TEAMLEADER_TAX_RATE_ID_OUTSIDE_EU geconfigureerd (bv. Retentie heeft mogelijk geen buiten-EU tarief)');
    return id;
  }
  // domestic
  if (dept) {
    const specific = process.env[`TEAMLEADER_TAX_RATE_ID_${vatPercentage}_${dept}`];
    if (specific) return specific;
  }
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

    // Traject-label (optioneel): "Traject > Variant".
    let trajectLabel = null;
    if (deal.traject_variant_id) {
      const { data: variant } = await supabaseAdmin.from('traject_variants')
        .select('name, traject_id').eq('id', deal.traject_variant_id).maybeSingle();
      if (variant) {
        const { data: traject } = await supabaseAdmin.from('trajects').select('name').eq('id', variant.traject_id).maybeSingle();
        trajectLabel = [traject?.name, variant.name].filter(Boolean).join(' > ');
      }
    }

    // Leesbare titel uit traject + betalingsvoorwaarden, anders klantnaam.
    const title = buildQuotationTitle(deal, trajectLabel)
      || `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim()
      || `Offerte ${String(dealId).slice(0, 8)}`;

    // 1. Contact + 2. Deal (quotation vereist deal_id).
    const tlContactId = await getOrCreateContact(customer);
    let tlDealId = deal.tl_deal_id;
    if (!tlDealId) {
      tlDealId = await createDeal(deal, tlContactId, departmentId, title);
      // KRITIEK: tl_deal_id direct persisteren. Als quotations.create hierna
      // faalt, pakt een retry deze deal op i.p.v. een duplicate aan te maken.
      await supabaseAdmin.from('deals').update({ tl_deal_id: tlDealId }).eq('id', dealId);
    }

    // 3. Quotation samenstellen.
    // Deal-niveau korting: TL quotations.create kent geen deal-level discount.
    // We verlagen per-regel de unit_price met het kortingspercentage. Dit houdt
    // de BTW-uitsplitsing correct bij gemengde tarieven (een enkele negatieve
    // korting-regel kan dat niet). De klant ziet dus lagere stukprijzen.
    const discFactor = 1 - (Number(deal.discount_percentage) || 0) / 100;
    // TL accepteert ALLEEN unit_price.tax = 'excluding'. Incl-BTW regels worden
    // omgerekend naar excl (incl / (1 + vat%)). Bij intra/buiten-EU is het tarief
    // 0% → excl = incl (geen omrekening). TL berekent de BTW zelf uit excl +
    // tax_rate_id, dus de eindbedragen blijven identiek.
    const zeroVat = deal.sale_type && deal.sale_type !== 'domestic';
    const lineItems = lines.map(l => {
      const rate = zeroVat ? 0 : (Number(l.vat_percentage) || 0) / 100;
      let amount = Number(l.unit_price);
      if (l.price_includes_vat && rate > 0) amount = amount / (1 + rate);
      amount = Math.round(amount * discFactor * 100) / 100;
      return {
        quantity:    Number(l.quantity),
        description: l.product_name,
        unit_price:  { amount, currency: CURRENCY, tax: 'excluding' },
        tax_rate_id: taxRateIdFor(l.vat_percentage, departmentId, deal.sale_type),
      };
    });
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
    // Poging is gedaan maar gefaald → tl_push_status='failed' (retry mogelijk).
    // tl_quotation_status blijft 'draft' (constraint kent geen 'failed').
    // tl_deal_id is hierboven al persistent bij een gedeeltelijke push.
    await supabaseAdmin.from('deals').update({
      tl_push_status:      'failed',
      tl_quotation_status: 'draft',
      tl_push_error:       e.message.slice(0, 500),
    }).eq('id', dealId);
    return { success: false, error: e.message };
  }
}
