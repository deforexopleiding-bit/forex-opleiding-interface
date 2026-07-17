// api/arrangements-propose.js
// POST -> nieuwe payment_arrangement aanmaken (status='VOORGESTELD') incl. bijbehorende
// pending_actions per type. Permission: finance.arrangements.propose.
//
// Body (JSON):
//   {
//     customer_id:     uuid,
//     invoice_ids:     uuid[],   // verplicht behalve bij ABONNEMENT_PAUZE / ABONNEMENT_STOP
//     type:            'UITSTEL' | 'SPLITSING' | 'ABONNEMENT_PAUZE' | 'ABONNEMENT_STOP' | 'KWIJTSCHELDING',
//     details:         object,   // type-specifiek (zie validatie hieronder)
//     rationale:       string,   // vrije tekst (opgeslagen in notes + in pending_actions.payload)
//     effective_from:  date,     // optioneel — meta in details.effective_from
//     effective_until: date      // optioneel — meta in details.effective_until
//   }
//
// Lowercase / legacy synoniemen worden geaccepteerd voor backward-compat
// (uitstel -> UITSTEL, gespreid -> SPLITSING, pauze -> ABONNEMENT_PAUZE,
//  overig  -> ABONNEMENT_STOP, kwijtschelding -> KWIJTSCHELDING).
//
// Details-validatie per type:
//   UITSTEL           : { termijnen: int 2-60, starts_on?: 'YYYY-MM-DD',
//                         amount_per_invoice_excl_vat?: number > 0 (sanity check, server overschrijft) }
//                       -- 1 atomic pending_action (TL_INVOICE_CONSOLIDATE_AND_RESTART) voor het hele
//                       arrangement. Server bouwt vat_distribution + totals via _lib/invoice-vat-mix.js
//                       (live TL invoices.info per factuur).
//   SPLITSING         : { parts: [ { amount: number, due_date: 'YYYY-MM-DD' } ] } -- per factuur 1 pending_action.
//                       parts.length >= 2 EN sum(parts.amount) == sum(invoice.amount_total) (1ct tolerantie).
//   ABONNEMENT_PAUZE  : { subscription_id: uuid, pause_from, pause_until, reason } -- 1 pending_action.
//   ABONNEMENT_STOP   : { subscription_id: uuid, stop_date, reason }              -- 1 pending_action.
//   KWIJTSCHELDING    : { write_off_amount: number > 0, reason: string }          -- per factuur 1 pending_action.
//
// Response 201: { arrangement, pending_actions: [...] }
// Bij INSERT-fout op pending_actions: best-effort rollback (DELETE arrangement) + 500.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { buildVatDistribution, computeTermijnAmounts } from './_lib/invoice-vat-mix.js';
import { getMaxDagenTotEersteTermijn, daysUntil } from './_lib/splitsing-start-grens.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Uppercase enum-keys zijn canoniek. Legacy lowercase / oude 'overig' worden
// gemapt zodat oude callers blijven werken.
const TYPE_ALIASES = {
  // Canonieke uppercase keys
  UITSTEL:          'UITSTEL',
  SPLITSING:        'SPLITSING',
  ABONNEMENT_PAUZE: 'ABONNEMENT_PAUZE',
  ABONNEMENT_STOP:  'ABONNEMENT_STOP',
  KWIJTSCHELDING:   'KWIJTSCHELDING',
  // Fase 1 (2026-07-14): licht type voor betaalafspraak zonder TL-actie.
  TOEZEGGING:       'TOEZEGGING',
  // Legacy lowercase (backward compat)
  uitstel:        'UITSTEL',
  gespreid:       'SPLITSING',
  pauze:          'ABONNEMENT_PAUZE',
  overig:         'ABONNEMENT_STOP',
  kwijtschelding: 'KWIJTSCHELDING',
  toezegging:     'TOEZEGGING',
};

// Mapping naar pending_actions.action_type. TL_ prefix markeert acties die
// in D2 door de TeamLeader-executor opgepakt worden.
//
// NB (D1.5): UITSTEL is per 2026-06-09 herschreven naar consolidate + restart.
// Nieuwe arrangements -> 1 atomic TL_INVOICE_CONSOLIDATE_AND_RESTART action.
// Bestaande arrangements in DB met TL_INVOICE_UPDATE_DUE blijven leesbaar +
// afhandelbaar door de D2-executor (legacy 1-per-invoice update-due pad).
// Zie LEGACY_ACTION_TYPE_FOR hieronder voor de oude mapping.
const ACTION_TYPE_FOR = {
  UITSTEL:          'TL_INVOICE_CONSOLIDATE_AND_RESTART',
  SPLITSING:        'TL_INVOICE_SPLIT',
  ABONNEMENT_PAUZE: 'TL_SUBSCRIPTION_PAUSE',
  ABONNEMENT_STOP:  'TL_SUBSCRIPTION_STOP',
  KWIJTSCHELDING:   'TL_INVOICE_WRITEOFF',
  // TOEZEGGING is een light type ZONDER pending_actions: geen TL-mutatie, dus
  // action-type expliciet null. De propose-flow slaat de pending-actions-branch
  // over voor TOEZEGGING en insert direct met status='ACTIEF'.
  TOEZEGGING:       null,
};

// Legacy mapping (pre-D1.5). Niet gebruikt voor nieuwe inserts; alleen ter
// referentie voor D2-executor / migrations / leesbaarheid van bestaande rows.
// eslint-disable-next-line no-unused-vars
const LEGACY_ACTION_TYPE_FOR = {
  UITSTEL: 'TL_INVOICE_UPDATE_DUE', // pre-2026-06-09: 1 update-due action per invoice
};

function isUuid(s)  { return typeof s === 'string' && UUID_RE.test(s); }
function isDate(s)  { return typeof s === 'string' && DATE_RE.test(s); }
function isPosNum(n){ return typeof n === 'number' && Number.isFinite(n) && n > 0; }
function isIntInRange(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max;
}

// Eerste dag van de volgende maand in YYYY-MM-DD (UTC-veilig, geen TZ-drift).
function firstDayOfNextMonth(today = new Date()) {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // 0-based
  const next = new Date(Date.UTC(y, m + 1, 1));
  return next.toISOString().slice(0, 10);
}

// Voeg N maanden toe aan YYYY-MM-DD en returnt YYYY-MM-DD. Clamps op laatste
// dag van de maand wanneer de doelmaand korter is (bv. 31 jan + 1 maand -> 28/29 feb).
function addMonthsYmd(ymd, months) {
  const [y, m, d] = ymd.split('-').map(Number);
  const baseDate = new Date(Date.UTC(y, m - 1, 1));
  baseDate.setUTCMonth(baseDate.getUTCMonth() + months);
  // bepaal de laatste dag van de doelmaand
  const targetY = baseDate.getUTCFullYear();
  const targetM = baseDate.getUTCMonth();
  const lastDayTarget = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  const finalDay = Math.min(d, lastDayTarget);
  const final = new Date(Date.UTC(targetY, targetM, finalDay));
  return final.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.arrangements.propose'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.arrangements.propose)' });
  }

  const body = req.body || {};
  const customerId    = body.customer_id ? String(body.customer_id) : null;
  const invoiceIdsRaw = Array.isArray(body.invoice_ids) ? body.invoice_ids : [];
  const typeRaw       = body.type ? String(body.type) : null;
  const details       = (body.details && typeof body.details === 'object') ? body.details : {};
  const rationale     = body.rationale ? String(body.rationale) : null;
  const effFrom       = body.effective_from  ? String(body.effective_from)  : null;
  const effUntil      = body.effective_until ? String(body.effective_until) : null;

  // ---- Basis-validatie ----
  if (!isUuid(customerId))  return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  if (!typeRaw || !(typeRaw in TYPE_ALIASES)) {
    return res.status(400).json({
      error: 'type vereist (UITSTEL | SPLITSING | ABONNEMENT_PAUZE | ABONNEMENT_STOP | KWIJTSCHELDING)',
    });
  }
  const type         = TYPE_ALIASES[typeRaw];
  const invoiceIds   = invoiceIdsRaw.map(String).filter(isUuid);
  const isSubAction  = (type === 'ABONNEMENT_PAUZE' || type === 'ABONNEMENT_STOP');
  // TOEZEGGING: invoice_ids ZIJN vereist (breach-check gebruikt ze om te
  // bepalen of de afspraak is nagekomen). Als geen invoice_id per part wordt
  // gegeven, geldt de datum voor ALLE arrangement invoice_ids.
  const needsInvoices = !isSubAction;
  if (needsInvoices && invoiceIds.length === 0) {
    return res.status(400).json({ error: 'invoice_ids vereist (>=1 uuid) voor type ' + type });
  }
  if (effFrom  && !isDate(effFrom))  return res.status(400).json({ error: 'effective_from moet YYYY-MM-DD zijn' });
  if (effUntil && !isDate(effUntil)) return res.status(400).json({ error: 'effective_until moet YYYY-MM-DD zijn' });

  // ---- Type-specifieke details-validatie ----
  try {
    switch (type) {
      case 'UITSTEL': {
        // D1.5 consolidate + restart: 1 nieuwe consolidated invoice + termijn-abonnement
        // over N termijnen. Server bouwt vat_distribution server-side via TL.
        if (!isIntInRange(details.termijnen, 2, 60)) {
          throw new Error('details.termijnen (integer 2-60) vereist voor UITSTEL');
        }
        if (details.starts_on != null && !isDate(details.starts_on)) {
          throw new Error('details.starts_on moet YYYY-MM-DD zijn');
        }
        if (details.amount_per_invoice_excl_vat != null
            && !isPosNum(Number(details.amount_per_invoice_excl_vat))) {
          throw new Error('details.amount_per_invoice_excl_vat moet > 0 zijn (sanity check)');
        }
        break;
      }
      case 'SPLITSING': {
        if (!Array.isArray(details.parts) || details.parts.length < 2) {
          throw new Error('details.parts (min 2 elementen) vereist voor SPLITSING');
        }
        for (const p of details.parts) {
          if (!p || typeof p !== 'object') throw new Error('details.parts: elk part is een object {amount, due_date}');
          if (!isPosNum(Number(p.amount))) throw new Error('details.parts[].amount moet > 0 zijn');
          if (!isDate(p.due_date))         throw new Error('details.parts[].due_date moet YYYY-MM-DD zijn');
        }
        break;
      }
      case 'ABONNEMENT_PAUZE': {
        if (!isUuid(details.subscription_id)) throw new Error('details.subscription_id (uuid) vereist voor ABONNEMENT_PAUZE');
        if (!isDate(details.pause_from))      throw new Error('details.pause_from (YYYY-MM-DD) vereist voor ABONNEMENT_PAUZE');
        if (!isDate(details.pause_until))     throw new Error('details.pause_until (YYYY-MM-DD) vereist voor ABONNEMENT_PAUZE');
        if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor ABONNEMENT_PAUZE');
        break;
      }
      case 'ABONNEMENT_STOP': {
        if (!isUuid(details.subscription_id)) throw new Error('details.subscription_id (uuid) vereist voor ABONNEMENT_STOP');
        if (!isDate(details.stop_date))       throw new Error('details.stop_date (YYYY-MM-DD) vereist voor ABONNEMENT_STOP');
        if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor ABONNEMENT_STOP');
        break;
      }
      case 'KWIJTSCHELDING': {
        if (!isPosNum(Number(details.write_off_amount))) throw new Error('details.write_off_amount (>0) vereist voor KWIJTSCHELDING');
        if (!details.reason || typeof details.reason !== 'string') throw new Error('details.reason vereist voor KWIJTSCHELDING');
        break;
      }
      case 'TOEZEGGING': {
        // details.parts: min 1 part. Elk part heeft een verplichte due_date
        // (concrete kalenderdag — vage input mag niet doorkomen). invoice_id
        // en amount_cents zijn optioneel; als invoice_id ontbreekt geldt de
        // datum voor alle arrangement invoice_ids.
        if (!Array.isArray(details.parts) || details.parts.length < 1) {
          throw new Error('details.parts (min 1 element) vereist voor TOEZEGGING');
        }
        // Alle part-invoice_ids (indien gezet) moeten in arrangement.invoice_ids zitten.
        const invSet = new Set(invoiceIds);
        for (const p of details.parts) {
          if (!p || typeof p !== 'object') throw new Error('details.parts: elk part is een object {due_date, invoice_id?, amount_cents?}');
          if (!isDate(p.due_date)) throw new Error('details.parts[].due_date moet YYYY-MM-DD zijn (concrete datum vereist)');
          if (p.invoice_id != null) {
            if (!isUuid(p.invoice_id)) throw new Error('details.parts[].invoice_id moet uuid zijn');
            if (!invSet.has(p.invoice_id)) throw new Error('details.parts[].invoice_id moet in invoice_ids voorkomen');
          }
          if (p.amount_cents != null) {
            const c = Number(p.amount_cents);
            if (!Number.isFinite(c) || !Number.isInteger(c) || c <= 0) {
              throw new Error('details.parts[].amount_cents moet positief geheel getal in centen zijn');
            }
          }
        }
        break;
      }
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    // ---- Verifieer customer bestaat ----
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id')
      .eq('id', customerId)
      .maybeSingle();
    if (custErr) throw new Error('customer-lookup: ' + custErr.message);
    if (!cust)   return res.status(404).json({ error: 'Klant niet gevonden' });

    // ---- Verifieer facturen bestaan (indien van toepassing) ----
    let invoices = [];
    if (invoiceIds.length > 0) {
      const { data: invRows, error: invErr } = await supabaseAdmin
        .from('invoices')
        .select('id, customer_id, amount_total, amount_paid, credited_amount, status, invoice_number')
        .in('id', invoiceIds);
      if (invErr) throw new Error('invoice-lookup: ' + invErr.message);
      invoices = invRows || [];
      if (invoices.length !== invoiceIds.length) {
        const found = new Set(invoices.map(r => r.id));
        const missing = invoiceIds.filter(id => !found.has(id));
        return res.status(404).json({ error: 'Factuur niet gevonden', missing });
      }
      // Optionele controle: alle facturen moeten van dezelfde klant zijn.
      const wrong = invoices.find(i => i.customer_id !== customerId);
      if (wrong) return res.status(400).json({ error: `Factuur ${wrong.invoice_number || wrong.id} hoort niet bij klant` });
    }

    // ---- SPLITSING: sum(parts) == sum(amount_total) ----
    if (type === 'SPLITSING') {
      const sumParts = details.parts.reduce((a, p) => a + Number(p.amount || 0), 0);
      const sumInv   = invoices.reduce((a, i) => a + (Number(i.amount_total) || 0), 0);
      // 1-cent tolerantie tegen FP-afronding.
      if (Math.abs(sumParts - sumInv) > 0.01) {
        return res.status(400).json({
          error: `Som van parts (${sumParts.toFixed(2)}) komt niet overeen met som factuurbedrag (${sumInv.toFixed(2)})`,
        });
      }
      // #788 — DYNAMISCHE ondergrens per termijn: het maandbedrag van deze
      // klant (laagste actieve abonnement). Vervangt de vaste
      // min_termijn_bedrag_eur uit #787. Beleid Jeffrey: elke termijn moet
      // >= wat de klant al aantoonbaar per maand betaalt. Geen abo → geen
      // regeling, escaleren.
      //
      // #790 — FAIL-CLOSED (was fail-soft in #788). Deze catch bepaalt wat
      // Joost aan een klant toezegt. Bij een import-fout, timeout of andere
      // onverwachte throw MOET SPLITSING geweigerd worden — anders komt elk
      // termijnbedrag erdoor terwijl er GEEN check heeft gelopen. Beter een
      // afgewezen legitiem verzoek dan een klant met een belofte die het
      // systeem niet kan honoreren.
      //
      // De helper zelf (getCustomerMonthlyPayment) is defensief: DB-fout →
      // hasSubscription:false → 400 NO_ACTIVE_SUBSCRIPTION. Dit vangt de
      // GAPS die de helper mist (dynamic-import fail, module-eval error,
      // Vercel-cold-start hiccup).
      let mp;
      try {
        const { getCustomerMonthlyPayment } = await import('./_lib/customer-monthly-payment.js');
        mp = await getCustomerMonthlyPayment(supabaseAdmin, customerId);
      } catch (e) {
        console.error('[arrangements-propose] MANDAAT_CHECK_ONBESCHIKBAAR (fail-closed):', e?.message || e, e?.stack);
        return res.status(400).json({
          error: 'De mandaat-check kon nu niet uitgevoerd worden door een tijdelijke storing ' +
                 'in het maandbedrag-systeem. Probeer het over een paar minuten opnieuw, of ' +
                 'leg deze splitsing handmatig vast na overleg met een collega. ' +
                 '(Dit ligt aan het systeem, niet aan de klant.)',
          violation: 'MANDAAT_CHECK_ONBESCHIKBAAR',
        });
      }
      if (!mp || !mp.hasSubscription) {
        return res.status(400).json({
          error: 'Deze klant heeft geen actief abonnement — SPLITSING vereist een lopend maand-ritme. ' +
                 'Laat een medewerker deze afspraak beoordelen (bijvoorbeeld UITSTEL of KWIJTSCHELDING).',
          violation: 'NO_ACTIVE_SUBSCRIPTION',
        });
      }
      const minPerTermijn = Number(mp.monthlyAmount);
      if (Number.isFinite(minPerTermijn) && minPerTermijn > 0) {
        const tooSmall = details.parts.find(p => Number(p.amount || 0) < minPerTermijn);
        if (tooSmall) {
          return res.status(400).json({
            error: `Termijn van EUR ${Number(tooSmall.amount).toFixed(2)} ligt onder het maandbedrag ` +
                   `van deze klant (EUR ${minPerTermijn.toFixed(2)}). Splits over minder termijnen ` +
                   `of laat een medewerker deze afspraak beoordelen.`,
            violation:            'MIN_TERMIJN_ONDER_MAANDBEDRAG',
            maand_bedrag_eur:     minPerTermijn,
            offending_amount_eur: Number(tooSmall.amount),
          });
        }
      }

      // #809 — Server-side vangnet voor start-grens. Vroegste due_date over
      // alle parts wordt gemeten tegen mandate.splitsing.max_dagen_tot_
      // eerste_termijn (default 45). Zelfde helper als evaluateAutonomy →
      // één bron voor de grens (les uit #808).
      // Mandate lookup uit joost_config; bij lookup-fout valt de helper terug
      // op default 45 (fail-safe: strengere grens dan gefaalde config).
      let arrMandate = null;
      try {
        const { data: cfgRow } = await supabaseAdmin
          .from('joost_config').select('autonomy_config').eq('module', 'finance').maybeSingle();
        if (cfgRow?.autonomy_config?.arrangement_mandate) {
          arrMandate = cfgRow.autonomy_config.arrangement_mandate;
        }
      } catch (e) {
        console.warn('[arrangements-propose] joost_config lookup soft-fail — default 45:', e?.message);
      }
      const maxDagenTotEerste = getMaxDagenTotEersteTermijn(arrMandate);
      let earliestDueYmd = null;
      let earliestDueDays = null;
      for (const p of details.parts) {
        const d = typeof p.due_date === 'string' ? p.due_date.trim() : null;
        if (!d) continue;
        const days = daysUntil(d);
        if (days == null) continue;
        if (earliestDueDays == null || days < earliestDueDays) {
          earliestDueDays = days;
          earliestDueYmd  = d;
        }
      }
      if (earliestDueDays != null && earliestDueDays > maxDagenTotEerste) {
        return res.status(400).json({
          error: `Eerste termijn valt op ${earliestDueYmd} (${earliestDueDays}d in de toekomst), ` +
                 `voorbij de grens van ${maxDagenTotEerste} dagen. Een regeling die later start is uitstel — ` +
                 `laat een medewerker deze afspraak beoordelen (bijvoorbeeld als UITSTEL).`,
          violation:                'EERSTE_TERMIJN_VOORBIJ_GRENS',
          max_dagen_tot_eerste:     maxDagenTotEerste,
          eerste_termijn_datum:     earliestDueYmd,
          dagen_tot_eerste_termijn: earliestDueDays,
        });
      }
    }

    // ---- UITSTEL (consolidate + restart): server-side enrichment ----
    // Bouw vat_distribution + termijn-amounts SERVER-side via TL invoices.info.
    // Bevestig dat alle facturen openstaand zijn (open / partially_paid).
    let uitstelEnriched = null;
    if (type === 'UITSTEL') {
      const ALLOWED_STATUS = new Set(['open', 'partially_paid']);
      const wrongStatus = invoices.find(i => !ALLOWED_STATUS.has(String(i.status || '').toLowerCase()));
      if (wrongStatus) {
        return res.status(400).json({
          error: `Factuur ${wrongStatus.invoice_number || wrongStatus.id} heeft status '${wrongStatus.status}'; alleen open/partially_paid toegestaan voor UITSTEL`,
        });
      }

      const termijnen = Math.floor(Number(details.termijnen));
      // starts_on default = eerste dag van volgende maand.
      const startsOn = isDate(details.starts_on) ? details.starts_on : firstDayOfNextMonth();
      // ends_on = starts_on + (termijnen - 1) maanden (laatste termijn-datum).
      const endsOn = addMonthsYmd(startsOn, termijnen - 1);

      // SERVER is bron van waarheid voor vat_distribution: overschrijf client value.
      const vatDistribution = await buildVatDistribution(supabaseAdmin, invoiceIds);
      if (!vatDistribution.length) {
        return res.status(400).json({
          error: 'Kon geen BTW-verdeling bepalen voor de geselecteerde facturen (TL line-items leeg of niet beschikbaar)',
        });
      }
      // Per-vat_rate termijn-bedragen.
      const perRateTermijnen = computeTermijnAmounts(0, termijnen, vatDistribution);
      // Som van termijn-bedragen excl btw (de eerste termijn — laatste kan ander zijn door restant).
      const amountPerInvoiceExclVat = perRateTermijnen.reduce(
        (a, r) => a + Number(r.amount_per_invoice_excl_vat || 0),
        0,
      );

      uitstelEnriched = {
        termijnen,
        starts_on: startsOn,
        ends_on: endsOn,
        vat_distribution: vatDistribution,
        per_rate_termijnen: perRateTermijnen,
        amount_per_invoice_excl_vat: Math.round(amountPerInvoiceExclVat * 100) / 100,
        billing_cycle: { unit: 'month', period: 1 },
      };
    }

    // ---- Bouw details met effective_from/until + rationale-meta ----
    const detailsToStore = { ...details };
    if (effFrom)   detailsToStore.effective_from  = effFrom;
    if (effUntil)  detailsToStore.effective_until = effUntil;
    if (uitstelEnriched) {
      // Server-side enriched velden overschrijven client-input (bron van waarheid).
      detailsToStore.termijnen                   = uitstelEnriched.termijnen;
      detailsToStore.starts_on                   = uitstelEnriched.starts_on;
      detailsToStore.ends_on                     = uitstelEnriched.ends_on;
      detailsToStore.vat_distribution            = uitstelEnriched.vat_distribution;
      detailsToStore.per_rate_termijnen          = uitstelEnriched.per_rate_termijnen;
      detailsToStore.amount_per_invoice_excl_vat = uitstelEnriched.amount_per_invoice_excl_vat;
      detailsToStore.billing_cycle               = uitstelEnriched.billing_cycle;
    }

    // ---- INSERT payment_arrangement ----
    // TOEZEGGING gaat DIRECT naar ACTIEF: geen approval-flow (het is een
    // notitie van een afspraak, geen geld-actie). Alle andere types starten
    // op VOORGESTELD en bewegen naar ACTIEF via pending_actions executed.
    const insertRow = {
      customer_id:   customerId,
      invoice_ids:   invoiceIds,
      type,
      status:        (type === 'TOEZEGGING') ? 'ACTIEF' : 'VOORGESTELD',
      details:       detailsToStore,
      proposed_by:   user.id,
      notes:         rationale,
    };
    const { data: arr, error: arrErr } = await supabaseAdmin
      .from('payment_arrangements')
      .insert(insertRow)
      .select('id, customer_id, invoice_ids, type, status, details, proposed_by, notes, created_at, updated_at')
      .single();
    if (arrErr) throw new Error('arrangement-insert: ' + arrErr.message);

    // ---- Bouw pending_actions per type ----
    // NB: pending_actions-kolom heet proposed_by_user_id (verschilt van de
    // payment_arrangements-laag, waar de kortere alias proposed_by wel bestaat).
    const actionType = ACTION_TYPE_FOR[type];
    const baseRow = {
      customer_id:         customerId,
      arrangement_id:      arr.id,
      action_type:         actionType,
      // pending_actions.status CHECK eist UPPERCASE in deployed DB
      // (PENDING/APPROVED/REJECTED/EXECUTED/FAILED/CANCELLED/ROLLED_BACK).
      status:              'PENDING',
      proposed_by_user_id: user.id,
    };

    // TOEZEGGING heeft geen pending_actions (geen TL-mutatie). Sla de switch
    // en de INSERT-branch over — de breach-check cron bewaakt 'em direct
    // op basis van details.parts + invoice-status.
    const rows = [];
    if (type !== 'TOEZEGGING') switch (type) {
      case 'UITSTEL': {
        // D1.5: 1 atomic action voor het hele arrangement
        // (TL_INVOICE_CONSOLIDATE_AND_RESTART).
        // payload bevat alle context die de D2-executor nodig heeft om:
        //   1) de N oude facturen te crediteren / cancellen
        //   2) 1 nieuw abonnement aan te maken met de juiste termijnen + btw-mix
        rows.push({
          ...baseRow,
          payload: {
            credit_invoice_ids: [...invoiceIds],
            subscription_config: {
              term_count:                  uitstelEnriched.termijnen,
              amount_per_invoice_excl_vat: uitstelEnriched.amount_per_invoice_excl_vat,
              starts_on:                   uitstelEnriched.starts_on,
              ends_on:                     uitstelEnriched.ends_on,
              vat_distribution:            uitstelEnriched.vat_distribution,
              billing_cycle:               uitstelEnriched.billing_cycle,
            },
            source:    'manual',
            rationale,
          },
        });
        break;
      }
      case 'SPLITSING': {
        for (const invId of invoiceIds) {
          rows.push({
            ...baseRow,
            payload: { invoice_id: invId, parts: details.parts, source: 'manual', rationale },
          });
        }
        break;
      }
      case 'ABONNEMENT_PAUZE': {
        rows.push({
          ...baseRow,
          payload: {
            subscription_id: details.subscription_id,
            pause_from:      details.pause_from,
            pause_until:     details.pause_until,
            reason:          details.reason,
            source:          'manual',
            rationale,
          },
        });
        break;
      }
      case 'ABONNEMENT_STOP': {
        rows.push({
          ...baseRow,
          payload: {
            subscription_id: details.subscription_id,
            stop_date:       details.stop_date,
            reason:          details.reason,
            source:          'manual',
            rationale,
          },
        });
        break;
      }
      case 'KWIJTSCHELDING': {
        for (const invId of invoiceIds) {
          rows.push({
            ...baseRow,
            payload: {
              invoice_id:       invId,
              write_off_amount: Number(details.write_off_amount),
              reason:           details.reason,
              source:           'manual',
              rationale,
            },
          });
        }
        break;
      }
    }

    let pendingActions = [];
    if (rows.length > 0) {
      const { data: paRows, error: paErr } = await supabaseAdmin
        .from('pending_actions')
        .insert(rows)
        .select('id, customer_id, arrangement_id, action_type, status, payload, proposed_by_user_id, created_at, updated_at');
      if (paErr) {
        // Best-effort rollback: verwijder arrangement zodat we geen weeshuis-rij achterlaten.
        try {
          await supabaseAdmin.from('payment_arrangements').delete().eq('id', arr.id);
        } catch (rbErr) {
          console.error('[arrangements-propose rollback] kon arrangement niet verwijderen:', rbErr.message);
        }
        throw new Error('pending-actions-insert: ' + paErr.message);
      }
      pendingActions = paRows || [];
    }

    // ---- Fase 2b hook: pauzeer lopende aanmaan-runs bij TOEZEGGING ----
    // TOEZEGGING gaat direct naar status='ACTIEF' — de aanmaan-workflow moet
    // dus meteen pauzeren zodat de klant niet zaterdag de volgende aanmaning
    // krijgt. Andere types starten op VOORGESTELD; die pauze gebeurt bij
    // pending-actions-mark-executed cascade (VOORGESTELD -> ACTIEF).
    // Fail-soft: hook-fout blokkeert de propose-response niet.
    if (type === 'TOEZEGGING') {
      try {
        const { pauseRunsForArrangement } = await import('./_lib/dunning-arrangement-hooks.js');
        await pauseRunsForArrangement(arr.id, customerId);
      } catch (e) {
        console.warn('[arrangements-propose hook]', e?.message || e);
      }
    }

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'finance.arrangement.proposed',
        entity_type: 'payment_arrangement',
        entity_id:   arr.id,
        after_json:  {
          arrangement_id: arr.id,
          type,
          action_count:   pendingActions.length,
        },
        reason_text: rationale,
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[arrangements-propose audit]', e.message); }

    return res.status(201).json({ arrangement: arr, pending_actions: pendingActions });
  } catch (e) {
    console.error('[arrangements-propose]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
