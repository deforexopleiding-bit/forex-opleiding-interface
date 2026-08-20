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

// Nette offerte-titel op basis van de trajectnaam. Detecteert het type
// (Membership / 1-op-1) en de looptijd ("(X maanden)") en levert één
// schone label:
//   "Membership (X maanden)" of "1-op-1 begeleidingstraject (X maanden)"
// Onbekende trajecten (geen match op keyword) → fallback op de rauwe
// trajectnaam zodat we nooit een lege of misleidende titel produceren.
// De looptijd wordt genormaliseerd naar kleine letter ("maanden").
function formatQuotationLabelFromTraject(trajectName) {
  const raw = String(trajectName || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const m = raw.match(/\((\d+)\s*maanden?\)/i);
  const months = m ? Number(m[1]) : null;
  const suffix = months ? ` (${months} ${months === 1 ? 'maand' : 'maanden'})` : '';
  if (lower.includes('membership')) {
    return `Membership${suffix}`;
  }
  if (lower.includes('1-op-1') || lower.includes('begeleiding')) {
    return `1-op-1 begeleidingstraject${suffix}`;
  }
  // Onbekend type → gebruik trajectnaam zoals 'ie is (geen dubbeling).
  return raw;
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

// ── Self-heal helpers (Optie B, 2026-08-12) ────────────────────────────
// TL geeft bij een verwezen-maar-verwijderd contact/company een 400 terug
// met body "Customer <UUID> not found." (soms met/zonder punt). We
// detecteren die fout ONgeacht welk TL-endpoint hem gooit (deals.create,
// quotations.create) zodat we de gecachte tl_contact_id/tl_company_id
// kunnen wissen + re-resolven.
// BROK A (2026-08-19): geëxporteerd zodat invoice-create-core hetzelfde
// self-heal patroon kan hergebruiken (i.p.v. duplicaten). Signatuur
// ongewijzigd — 2e arg `deal` is optioneel voor callers zonder deal.
export function _isTlCustomerNotFound(err) {
  const msg = String(err?.message || '');
  // Match "Customer <uuid> not found" of "Customer with id X not found".
  return /customer[^"]{0,80}not\s+found/i.test(msg);
}
// Wis de gecachte TL-id op de klant + optionele stale tl_deal_id op de
// deal. Muteert ook het in-memory customer/deal-object zodat de caller
// direct met verse state werkt.
export async function _healStaleTlCache(customer, deal) {
  const wipeField = customer.is_company ? 'tl_company_id' : 'tl_contact_id';
  try {
    await supabaseAdmin.from('customers').update({ [wipeField]: null }).eq('id', customer.id);
  } catch (e) {
    console.warn('[tl-quotation] heal: cache-wipe DB-write faalde (fail-soft):', e?.message);
  }
  customer[wipeField] = null;
  // Als er een tl_deal_id op de deal staat, hangt die aan het niet-bestaande
  // TL-object → ook wissen zodat de retry een verse deal aanmaakt.
  if (deal && deal.tl_deal_id) {
    try {
      await supabaseAdmin.from('deals').update({ tl_deal_id: null }).eq('id', deal.id);
    } catch (e) {
      console.warn('[tl-quotation] heal: deal tl_deal_id-wipe faalde (fail-soft):', e?.message);
    }
    deal.tl_deal_id = null;
  }
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

    // Traject-label (optioneel): nette omschrijving op basis van de
    // trajectnaam. Historisch was dit "Traject > Variant", maar omdat
    // traject en variant identiek heten ontstond dubbeling zoals
    // "1-op-1 begeleiding (12 maanden) > 1-op-1 begeleiding (12 maanden)".
    // We detecteren nu het type op de trajectnaam en bouwen één schone
    // titel. Onbekende trajecten → fallback op traject.name zonder
    // variant-suffix (geen dubbeling meer).
    let trajectLabel = null;
    if (deal.traject_variant_id) {
      const { data: variant } = await supabaseAdmin.from('traject_variants')
        .select('name, traject_id').eq('id', deal.traject_variant_id).maybeSingle();
      if (variant) {
        const { data: traject } = await supabaseAdmin.from('trajects').select('name').eq('id', variant.traject_id).maybeSingle();
        trajectLabel = formatQuotationLabelFromTraject(traject?.name || null);
      }
    }

    // Leesbare titel uit traject + betalingsvoorwaarden, anders klantnaam.
    const title = buildQuotationTitle(deal, trajectLabel)
      || `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim()
      || `Offerte ${String(dealId).slice(0, 8)}`;

    // Reken-invarianten voor line-items (departmentId-afhankelijk maar
    // niet customer/deal-afhankelijk — dus ÉÉN keer berekend, buiten de
    // heal-retry-loop).
    const discFactor = 1 - (Number(deal.discount_percentage) || 0) / 100;
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
    const paymentText = buildPaymentSummaryText(deal);

    // ─── SELF-HEAL retry-loop (Optie B — 2026-08-12, uitgebreid) ────────
    // Wrap HELE TL-push-keten (customer-resolve → deals.create →
    // quotations.create) in max 2 attempts. Bij een "Customer not found"
    // op WELKE TL-sub-call dan ook: wis de gecachte tl_contact_id /
    // tl_company_id + stale tl_deal_id, re-resolve getOrCreateTlCustomer
    // (die maakt vers TL-object aan), en re-attempt de hele keten.
    //
    // Happy-path met geldige cache: 1e attempt slaagt, break-uit-loop,
    // 0 extra TL-calls, geen DB-writes voor heal.
    //
    // De text-veld-retry op quotations.create blijft binnen 1 attempt
    // (kan NAAST de customer-heal draaien; ze zijn orthogonaal).
    let tlCustomerRef, tlContactId, tlDealId, tlQuotationId, qData;
    let quotationBody;
    let healedTlCache = false;
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 1. Customer resolven (contact of company).
        tlCustomerRef = await getOrCreateTlCustomer(customer);
        tlContactId = tlCustomerRef.type === 'contact' ? tlCustomerRef.id : null;

        // 2. Deal aanmaken indien nodig (tl_deal_id wordt bij heal gewist
        //    → 2e attempt maakt verse deal aan bij verse contact).
        tlDealId = deal.tl_deal_id;
        if (!tlDealId) {
          tlDealId = await createDeal(deal, tlCustomerRef, departmentId, title);
          // KRITIEK: tl_deal_id persisteren zodat een quotations.create-
          // retry (bv. bij text-veld-fout) niet een duplicate deal maakt.
          await supabaseAdmin.from('deals').update({ tl_deal_id: tlDealId }).eq('id', dealId);
        }

        // 3. Quotation-body samenstellen (deal_id ligt nu vast).
        quotationBody = {
          deal_id:       tlDealId,
          department_id: departmentId,
          grouped_lines: [{ line_items: lineItems }],
        };
        if (paymentText) quotationBody.text = paymentText;

        // 4. quotations.create + text-veld-fallback (behouden zoals eerder).
        let qr = await tlFetch('/quotations.create', { method: 'POST', body: JSON.stringify(quotationBody) });
        let firstErrorText = null;
        if (!qr.ok && paymentText && quotationBody.text) {
          firstErrorText = await qr.text().catch(() => '');
          const looksLikeTextFieldError = /"?text"?/i.test(firstErrorText);
          console.warn('[tl-quotation] quotations.create met text-veld faalde',
            { status: qr.status, body: firstErrorText.slice(0, 300), retryingWithoutText: looksLikeTextFieldError });
          if (looksLikeTextFieldError) {
            delete quotationBody.text;
            qr = await tlFetch('/quotations.create', { method: 'POST', body: JSON.stringify(quotationBody) });
            firstErrorText = null;
          }
        }
        if (!qr.ok) {
          const txt = firstErrorText != null ? firstErrorText : await qr.text().catch(() => '');
          throw new Error(`TL quotations.create HTTP ${qr.status}: ${(txt || '').slice(0, 200)}`);
        }
        qData = await qr.json();
        tlQuotationId = qData.data?.id;

        // Alles gelukt → uit de loop.
        lastError = null;
        break;
      } catch (e) {
        lastError = e;
        // Heal + retry ALLEEN bij customer-not-found + max 1× (healed-flag).
        if (!_isTlCustomerNotFound(e) || healedTlCache) throw e;
        // Bepaal welke stap faalde (voor log-diagnose).
        const failedIn = /quotations\.create/i.test(e?.message || '') ? 'quotations.create'
                       : /deals\.create/i.test(e?.message || '')      ? 'deals.create'
                       : 'unknown-tl-call';
        console.warn('[tl-quotation] auto-heal: TL customer not found — wis cache + retry hele push-keten', {
          failed_in:            failedIn,
          customer_id:          customer.id,
          is_company:           !!customer.is_company,
          stale_tl_contact_id:  customer.tl_contact_id || null,
          stale_tl_company_id:  customer.tl_company_id || null,
          stale_tl_deal_id:     deal.tl_deal_id || null,
          tl_msg:               (e?.message || '').slice(0, 200),
        });
        await _healStaleTlCache(customer, deal);
        healedTlCache = true;
        // Loop draait door naar attempt=1. Alle state (tlCustomerRef,
        // tlDealId, quotationBody) wordt aan het begin van de volgende
        // iteratie vers berekend met de zojuist-vernieuwde customer.
      }
    }
    // Als loop eindigde zonder success (throw is al gebeurd in de laatste
    // catch), maar defensieve check: als break werd overgeslagen door een
    // onvoorziene bug, gooi lastError.
    if (!tlQuotationId && lastError) throw lastError;

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
