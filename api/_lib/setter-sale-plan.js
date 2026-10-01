// api/_lib/setter-sale-plan.js
//
// Pure functies (geen DB) voor het setter-salesoverzicht: welke deals tellen
// mee, wat is het betaalplan van een sale, wat levert dat de setter op, en
// klopt het plan met het offertebedrag.
//
// ── BEDRAGEN ─────────────────────────────────────────────────────────────
// deals.total_amount is INCL. BTW (de deal_line_items hebben
// price_includes_vat = true). Alle bedragen hier zijn dus incl. BTW, net als
// de commissiebasis (setter_ledger_entries.basis_incl_btw = true).
//
// ── BETAALPLAN ───────────────────────────────────────────────────────────
// Uit de deal (ingevuld in de sales-wizard):
//   - reserveringsfee: € 100 incl. btw als de deal een goedgekeurde
//     uitzondering 'late_start' heeft én de klant akkoord gaf
//     (exception_flagged + exception_reasons ∋ late_start +
//     exception_fee_agreed). Zelfde regel als de offerte-tekst
//     (_lib/teamleader-quotation.js) en de fee-factuur
//     (sales-subscription-create.js, RESERVATION_FEE_INCL). De factuur wordt
//     pas geboekt bij het aanmaken van het abonnement → deals.
//     reservation_fee_invoice_id; tot die tijd heeft de fee geen datum.
//   - aanbetaling: payment_downpayment_amount op payment_downpayment_date.
//   - termijnen: payment_term_count × payment_term_amount, maandelijks vanaf
//     payment_term_start_date.
// De wizard rekent het termijnbedrag als floor2((totaal − fee − aanbetaling)
// / aantal) → het plan kan een paar cent ONDER het totaal uitkomen. Dat is
// een afrondingsverschil, geen fout; alles daarboven is een echte mismatch.

export const RESERVATION_FEE_INCL = 100;
const EPS = 0.005;

// deals-kolommen die bouwBetaalplan/bouwSaleRegel/isUitgeslotenDeal lezen.
export const SETTER_DEAL_COLS = [
  'id', 'customer_id', 'status', 'quote_reference', 'created_at', 'start_date',
  'total_amount', 'archived_at', 'traject_variant_id', 'setter_user_id',
  'tl_quotation_status', 'tl_quotation_accepted_at',
  'payment_start_date', 'payment_downpayment_amount', 'payment_downpayment_date',
  'payment_term_count', 'payment_term_amount', 'payment_term_start_date',
  'exception_flagged', 'exception_reasons', 'exception_fee_agreed',
  'reservation_fee_invoice_id',
].join(', ');

const n = (v) => Number(v) || 0;
export const round2 = (v) => Math.round(n(v) * 100) / 100;

const QUOTATION_LABELS = {
  accepted:     'geaccepteerd',
  sent:         'verstuurd',
  draft:        'concept',
  declined:     'afgewezen',
  no_quotation: 'geen offerte',
};

/** Offertestatus → { key, label, pending } (pending = nog niet geaccepteerd). */
export function quotationStatus(deal) {
  const key = String(deal?.tl_quotation_status || 'no_quotation');
  return {
    key,
    label: QUOTATION_LABELS[key] || key,
    pending: key !== 'accepted',
  };
}

/**
 * Telt deze deal NIET mee in het setter-overzicht? Gearchiveerde deals en
 * afgewezen offertes vallen eruit (bv. een testdeal die direct is
 * gearchiveerd). Archiveren zet ook tl_quotation_declined_at, maar die kolom
 * staat óók op ~60 niet-afgewezen deals — daarom sturen we op archived_at en
 * de status, niet op declined_at.
 */
export function isUitgeslotenDeal(deal) {
  if (!deal) return true;
  if (deal.archived_at) return true;
  return String(deal.tl_quotation_status || '') === 'declined';
}

/** Zelfde regel als de offerte-PDF en de fee-factuur. */
export function reserveringsfeeVanToepassing(deal) {
  if (!deal?.exception_flagged || !deal?.exception_fee_agreed) return false;
  return String(deal.exception_reasons || '').split(',').map((s) => s.trim()).includes('late_start');
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** 'YYYY-MM-DD' + k maanden, dag geclampt op het maandeinde (30 jan + 1 → 28 feb). */
export function addMonthsIso(iso, k) {
  const m = DATE_RE.exec(String(iso || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const target = new Date(Date.UTC(y, mo + k, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Het geplande betaalschema + de commissie per betaling + de aansluiting op
 * total_amount.
 *
 * @param {object} deal  deals-rij (total_amount, payment_*, exception_*, reservation_fee_invoice_id)
 * @param {object} opts  { pct }  commissie-% van de setter
 * @returns {{
 *   totaal:number, pct:number,
 *   reserveringsfee:{ van_toepassing:boolean, bedrag:number, factuur_id:string|null },
 *   aanbetaling:{ bedrag:number, datum:string|null },
 *   termijnen:{ aantal:number, bedrag:number, eerste_datum:string|null },
 *   schema:Array<{ soort:'reserveringsfee'|'aanbetaling'|'termijn', nr:number|null,
 *                  datum:string|null, bedrag:number, commissie:number }>,
 *   aansluiting:{ som:number, totaal:number, verschil:number,
 *                 status:'ok'|'afronding'|'mismatch'|'geen_plan', melding:string|null },
 *   commissie_totaal:number,
 * }}
 */
export function bouwBetaalplan(deal, { pct = 0 } = {}) {
  const p = n(pct);
  const commissie = (b) => round2(b * p / 100);
  const totaal = round2(deal?.total_amount);

  const feeVanToepassing = reserveringsfeeVanToepassing(deal);
  const feeBedrag = feeVanToepassing ? RESERVATION_FEE_INCL : 0;
  const aanbetaling = round2(deal?.payment_downpayment_amount);
  const aantal = Math.max(0, Math.trunc(n(deal?.payment_term_count)));
  const termijnBedrag = round2(deal?.payment_term_amount);
  const eersteDatum = DATE_RE.test(String(deal?.payment_term_start_date || ''))
    ? String(deal.payment_term_start_date).slice(0, 10) : null;

  const schema = [];
  if (feeVanToepassing) {
    // Datum onbekend tot de fee-factuur bij het aanmaken van het abonnement
    // wordt geboekt (factuurdatum komt in B uit de factuur zelf).
    schema.push({ soort: 'reserveringsfee', nr: null, datum: null, bedrag: feeBedrag, commissie: commissie(feeBedrag) });
  }
  if (aanbetaling > 0) {
    const d = String(deal?.payment_downpayment_date || '').slice(0, 10) || null;
    schema.push({ soort: 'aanbetaling', nr: null, datum: d, bedrag: aanbetaling, commissie: commissie(aanbetaling) });
  }
  if (aantal > 0 && termijnBedrag > 0) {
    for (let i = 0; i < aantal; i++) {
      schema.push({
        soort: 'termijn', nr: i + 1,
        datum: eersteDatum ? addMonthsIso(eersteDatum, i) : null,
        bedrag: termijnBedrag, commissie: commissie(termijnBedrag),
      });
    }
  }

  const som = round2(feeBedrag + aanbetaling + aantal * termijnBedrag);
  const verschil = round2(totaal - som);
  let status; let melding = null;
  if (!schema.length) {
    status = 'geen_plan';
    melding = 'Geen betaalplan op de deal (geen aanbetaling of termijnen ingevuld).';
  } else if (Math.abs(verschil) < EPS) {
    status = 'ok';
  } else if (verschil > 0 && verschil <= aantal * 0.01 + EPS) {
    // floor2 in de wizard: max 1 cent per termijn onder het totaal.
    status = 'afronding';
    melding = `Afrondingsverschil van € ${verschil.toFixed(2).replace('.', ',')}: het termijnbedrag is naar beneden afgerond op centen.`;
  } else {
    status = 'mismatch';
    melding = verschil > 0
      ? `Het betaalplan dekt € ${verschil.toFixed(2).replace('.', ',')} MINDER dan het offertebedrag (overig, niet ingepland).`
      : `Het betaalplan is € ${Math.abs(verschil).toFixed(2).replace('.', ',')} HOGER dan het offertebedrag.`;
  }

  return {
    totaal,
    pct: p,
    reserveringsfee: { van_toepassing: feeVanToepassing, bedrag: feeBedrag, factuur_id: deal?.reservation_fee_invoice_id || null },
    aanbetaling: { bedrag: aanbetaling, datum: aanbetaling > 0 ? (String(deal?.payment_downpayment_date || '').slice(0, 10) || null) : null },
    termijnen: { aantal, bedrag: termijnBedrag, eerste_datum: eersteDatum },
    schema,
    aansluiting: { som, totaal, verschil, status, melding },
    commissie_totaal: round2(schema.reduce((s, r) => s + r.commissie, 0)),
  };
}

/**
 * Forecast-buckets per maand uit het betaalplan, voor wat nog NIET ontvangen
 * is. Ontvangen geld wordt van voren af aan op het schema afgeboekt; een
 * gepland moment dat al voorbij is (achterstand) of geen datum heeft, schuift
 * naar de volgende maand.
 *
 * @returns {Array<{ ym:string, bedrag:number, commissie:number }>}
 */
export function forecastUitPlan(plan, { ontvangen = 0, now = new Date() } = {}) {
  let rest = n(ontvangen);
  const volgendeMaand = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 7);
  const huidigeMaand = now.toISOString().slice(0, 7);
  const out = new Map();
  for (const item of (plan?.schema || [])) {
    let open = item.bedrag;
    if (rest > EPS) { const af = Math.min(rest, open); rest -= af; open = round2(open - af); }
    if (open <= EPS) continue;
    let ym = item.datum ? item.datum.slice(0, 7) : volgendeMaand;
    if (ym < huidigeMaand) ym = volgendeMaand;
    const cur = out.get(ym) || { ym, bedrag: 0, commissie: 0 };
    cur.bedrag = round2(cur.bedrag + open);
    cur.commissie = round2(cur.commissie + open * n(plan.pct) / 100);
    out.set(ym, cur);
  }
  return [...out.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

/** Klantnaam zoals overal in het CRM. */
export function klantNaam(c) {
  if (!c) return null;
  return c.is_company
    ? (c.company_name || '—')
    : ([c.first_name, c.last_name].filter(Boolean).join(' ') || '—');
}

/**
 * Eén regel voor de saleslijst + het detail. `ontvangen` (bedrag) en
 * `ontvangen_regels` worden in fase B gevuld uit de gekoppelde facturen;
 * zonder die data blijft het plan puur "gepland".
 */
export function bouwSaleRegel({ deal, klant, traject, pct, ontvangen = 0, ontvangenRegels = null }) {
  const plan = bouwBetaalplan(deal, { pct });
  const qs = quotationStatus(deal);
  const betaald = round2(ontvangen);
  let betaalStatus = 'geen';
  if (betaald > EPS && betaald + 0.01 < plan.totaal) betaalStatus = 'gedeeltelijk';
  else if (betaald > EPS) betaalStatus = 'volledig';
  return {
    deal_id: deal.id,
    deal_ref: deal.quote_reference || null,
    customer_id: deal.customer_id || null,
    customer: klantNaam(klant),
    bedrag: plan.totaal,
    traject: traject || null,
    deal_datum: deal.start_date ? String(deal.start_date).slice(0, 10) : null,
    start_cursus: deal.payment_start_date ? String(deal.payment_start_date).slice(0, 10) : null,
    eerste_termijn: plan.termijnen.eerste_datum,
    aantal_termijnen: plan.termijnen.aantal,
    offerte_status: qs.key,
    offerte_status_label: qs.label,
    in_afwachting: qs.pending,
    geaccepteerd_op: deal.tl_quotation_accepted_at || null,
    betaald,
    betaal_status: betaalStatus,
    verwachte_commissie: plan.commissie_totaal,
    plan,
    ontvangen_regels: ontvangenRegels,
    created_at: deal.created_at,
  };
}
