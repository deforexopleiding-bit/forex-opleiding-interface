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
import { getOrCreateContact, getOrCreateTlCustomer, createDeal } from './teamleader-contact.js';

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

// Titel is nu SCHOON: alleen het trajectlabel (of null → caller gebruikt
// klantnaam als fallback). De betalingsvoorwaarden zijn verhuisd naar
// buildPaymentSummaryText → verschijnen op de offerte als €0-regel én
// (bij Route B) in de begeleidende tekst.
function buildQuotationTitle(deal, trajectLabel) {
  return trajectLabel || null;
}

// Formatteert YYYY-MM-DD → dd-mm-jjjj zonder UTC-verschuiving (kale datum).
function _fmtDateNL(iso) {
  const s = String(iso || '');
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return '';
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

// Multiline betaal-samenvatting voor de klant. Alleen regels tonen die
// daadwerkelijk ingevuld zijn. Reserveringsfee-regel alleen bij een
// goedgekeurde late-start-uitzondering met fee-akkoord (bouwstap 2/2
// offerte-beveiliging). Returnt null als er niks te tonen valt.
function buildPaymentSummaryText(deal) {
  const parts = [];
  if (deal.payment_start_date) {
    parts.push(`- Startdatum: ${_fmtDateNL(deal.payment_start_date)}`);
  }
  const down = Number(deal.payment_downpayment_amount) || 0;
  if (down > 0) {
    parts.push(`- Aanbetaling: € ${down.toLocaleString('nl-NL')}`);
  }
  const tc = Number(deal.payment_term_count) || 0;
  if (tc > 0) {
    const amt = Number(deal.payment_term_amount) || 0;
    const amtLabel = amt > 0 ? ` à € ${amt.toLocaleString('nl-NL')} per maand` : '';
    parts.push(`- ${tc} termijnen${amtLabel}`);
  }
  if (deal.payment_term_start_date) {
    parts.push(`- Eerste termijn: ${_fmtDateNL(deal.payment_term_start_date)}`);
  }
  const reasons = String(deal.exception_reasons || '');
  const feeApplies = deal.exception_flagged
                  && reasons.split(',').map(s => s.trim()).includes('late_start')
                  && deal.exception_fee_agreed;
  if (feeApplies) {
    parts.push('- Reserveringsfee (reservering startdatum): € 100,00');
  }
  if (!parts.length) return null;
  return 'Betaalregeling:\n' + parts.join('\n');
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

    // 1. Customer (B2C contact of B2B company) + 2. Deal (quotation vereist deal_id).
    const tlCustomerRef = await getOrCreateTlCustomer(customer);
    const tlContactId = tlCustomerRef.type === 'contact' ? tlCustomerRef.id : null;
    let tlDealId = deal.tl_deal_id;
    if (!tlDealId) {
      tlDealId = await createDeal(deal, tlCustomerRef, departmentId, title);
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
    // Route A: betaalregeling als extra €0-regel onderaan (naast producten).
    // Hergebruikt tax_rate_id van de eerste regel (irrelevant voor €0-lijn,
    // maar TL vereist een geldig tax_rate_id per line_item). Bij ontbrekende
    // regels fallback naar 21%-domestic (kan niet vóórkomen — er is
    // hierboven al een throw op 0 regels — maar defensief).
    const paymentText = buildPaymentSummaryText(deal);
    if (paymentText) {
      const fallbackRateId = lineItems[0]?.tax_rate_id
        || taxRateIdFor(21, departmentId, deal.sale_type);
      lineItems.push({
        quantity:    1,
        description: paymentText,
        unit_price:  { amount: 0, currency: CURRENCY, tax: 'excluding' },
        tax_rate_id: fallbackRateId,
      });
    }

    const quotationBody = {
      deal_id:       tlDealId,
      department_id: departmentId,
      grouped_lines: [{ line_items: lineItems }],
    };
    // Route B: begeleidende tekst → $QUOTATION_TEXT$ in de mail-template.
    // Veldnaam best-effort geraden op basis van doc-conventie (klant-
    // template heeft $QUOTATION_TEXT$ shortcode → text-veld). Als TL 'text'
    // niet accepteert (HTTP 400), doen we ÉÉN retry zonder text zodat de
    // push niet stukloopt op deze diagnostische toevoeging — Route A staat
    // dan alsnog. De fout wordt duidelijk gelogd zodat we bij de handmatige
    // test kunnen zien of we een ander veldnaam moeten proberen.
    if (paymentText) quotationBody.text = paymentText;

    let qr = await tlFetch('/quotations.create', { method: 'POST', body: JSON.stringify(quotationBody) });
    if (!qr.ok && paymentText && quotationBody.text) {
      const failText = await qr.text().catch(() => '');
      const looksLikeTextFieldError = /"?text"?/i.test(failText);
      console.warn('[tl-quotation] quotations.create met text-veld faalde',
        { status: qr.status, body: failText.slice(0, 300), retryingWithoutText: looksLikeTextFieldError });
      if (looksLikeTextFieldError) {
        delete quotationBody.text;
        qr = await tlFetch('/quotations.create', { method: 'POST', body: JSON.stringify(quotationBody) });
      }
    }
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
