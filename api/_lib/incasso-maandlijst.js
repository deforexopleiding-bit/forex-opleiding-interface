// api/_lib/incasso-maandlijst.js
//
// MAANDLIJST INCASSO-ABONNEMENTEN (PR 4 mentorcommissie, 3 nov 2026).
//
// Per klant met een incasso-regeling (status incasso_regeling, of een
// abonnement van soort incasso_regeling): per maand VERWACHT, ONTVANGEN en
// ACHTERSTAND. De termijnfacturen gaan niet naar de klant en niet naar het
// bureau (api/_lib/incasso-termijnfacturen.js); een betaling wordt hier
// geregistreerd via de bestaande betaalflow (finance-invoice-register-payment
// → register-payment-internal → TL + payments + invoices), waarna de
// factuurmotor de commissie vrijgeeft op wat effectief binnenkwam.
//
//   verwacht   = netto factuurbedrag (totaal − gecrediteerd) in de maand van
//                de vervaldag; voor termijnen zonder factuur: het
//                termijnbedrag van het abonnement in de maand van de termijn;
//   ontvangen  = betaald, in de maand van de betaling (betalingsregels, anders
//                paid_date); concept en volledig gecrediteerd tellen nooit;
//   achterstand= lopend: factuurbedrag met vervaldag vóór vandaag − ontvangen,
//                ≥ 0. Een termijn ZONDER factuur heeft (nog) geen vervaldag en
//                is dus nooit achterstand (12 nov 2026, Maxim).
//
// STAND PER MAAND (12 nov 2026): `stand` = gepland (toekomstige maand,
// neutraal) · te_betalen (lopende maand, niets vervallen) · achterstand (een
// factuur met vervaldag voorbij staat open) · factuur_ontbreekt (voorbije
// maand met een termijn zonder factuur) · betaald · geen.
//
// KOPPELING ZONDER tl_subscription_id (12 nov 2026): Teamleader geeft sinds
// augustus 2026 geen abonnement-id meer mee op de factuur. Een factuur van de
// klant zonder abonnement-id hoort bij een incasso-regelingsabonnement als
// periode én bedrag kloppen (koppelRegelingFacturen) — enkel bij een
// EENDUIDIGE match. Dezelfde regel in de sync (incasso-factuur-koppeling.js)
// en in de backfill (docs/sql-migrations/2026-11-12-incasso-factuur-koppeling.sql).

import { betaaldBedrag, isVolledigGecrediteerd, openBedrag } from './factuur-betaald.js';
import { betaalmethodenVan } from './betaalmethode.js';
import { isConcept } from './commissie-regeling.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const ym = (d) => (d ? String(d).slice(0, 7) : null);

export function inclPerTermijn(sub) {
  const lines = Array.isArray(sub?.line_items) ? sub.line_items : [];
  if (lines.length) {
    return round2(lines.reduce((t, l) => t + (Number(l.amount) || 0) * (1 + (Number(l.vat_percentage) || 0) / 100), 0));
  }
  const vat = sub?.vat_percentage != null ? Number(sub.vat_percentage) : 21;
  return round2((Number(sub?.amount) || 0) * (1 + vat / 100));
}
export function cyclus(c) {
  const s = String(c || '').toLowerCase();
  if (s.includes('quarter') || s === 'per_quarter') return 3;
  if (s.includes('year') || s === 'per_year') return 12;
  return 1;
}
export function plusMaanden(iso, n) {
  const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z');
  const dag = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const laatste = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(dag, laatste));
  return d.toISOString().slice(0, 10);
}
function maandenTussen(van, tot) {
  const out = [];
  if (!van || !tot || van > tot) return out;
  let [y, m] = van.split('-').map(Number);
  const [ty, tm] = tot.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Bedragtolerantie voor de koppeling: € 1 of 1 %, het grootste. */
export const koppelTolerantie = (bedrag) => Math.max(1, Math.abs(Number(bedrag) || 0) * 0.01);

/** Termijnmaanden (YYYY-MM) van een abonnement, of [] als het niet te plannen is. */
export function termijnMaanden(sub) {
  const n = Number(sub?.term_count) || 0;
  if (!sub?.start_date || !n) return [];
  const out = [];
  for (let i = 0; i < n; i++) out.push(ym(plusMaanden(sub.start_date, i * cyclus(sub.billing_cycle))));
  return out;
}

/**
 * Koppel facturen ZONDER tl_subscription_id aan een incasso-regelings-
 * abonnement van dezelfde klant (de aanroeper geeft enkel de facturen en
 * abonnementen van één klant mee):
 *   - periode: de maand van de factuurdatum (anders de vervaldag) is een
 *     termijnmaand van het abonnement;
 *   - bedrag: factuurtotaal = termijnbedrag incl. btw, ± max(€ 1, 1 %).
 * Enkel een EENDUIDIGE match telt: precies één (abonnement, termijn), en geen
 * andere factuur die al aan die termijn hangt of er ook op past. Concept en
 * volledig gecrediteerd koppelen nooit. Niets wordt overschreven: een factuur
 * met een abonnement-id blijft zoals ze is.
 *
 * @returns {Map<string, string>} invoice_id → teamleader_subscription_id
 */
export function koppelRegelingFacturen({ facturen = [], subs = [] }) {
  const plan = subs
    .filter((s) => s && s.teamleader_subscription_id && String(s.status || '').toLowerCase() !== 'cancelled')
    .map((s) => ({ tl: s.teamleader_subscription_id, per: inclPerTermijn(s), maanden: new Set(termijnMaanden(s)) }))
    .filter((p) => p.per > 0 && p.maanden.size);
  const uit = new Map();
  if (!plan.length) return uit;
  const telt = (f) => f && !isConcept(f) && !isVolledigGecrediteerd(f);
  const bezet = new Set();
  for (const f of facturen) {
    if (!telt(f) || !f.tl_subscription_id) continue;
    for (const k of [ym(f.issue_date), ym(f.due_date)]) if (k) bezet.add(`${f.tl_subscription_id}|${k}`);
  }
  const kandidaten = new Map(); // `${tl}|${ym}` → [invoice_id]
  for (const f of facturen) {
    if (!telt(f) || f.tl_subscription_id || !f.id) continue;
    const bedrag = Number(f.amount_total) || 0;
    if (!(bedrag > 0)) continue;
    let gekozen = null;
    for (const k of [...new Set([ym(f.issue_date), ym(f.due_date)].filter(Boolean))]) {
      const hits = plan.filter((p) => p.maanden.has(k) && Math.abs(bedrag - p.per) <= koppelTolerantie(p.per) + 1e-9);
      if (hits.length > 1) { gekozen = null; break; } // twee abonnementen passen: niet raden
      if (hits.length === 1) { gekozen = `${hits[0].tl}|${k}`; break; }
    }
    if (!gekozen) continue;
    if (!kandidaten.has(gekozen)) kandidaten.set(gekozen, []);
    kandidaten.get(gekozen).push(f.id);
  }
  for (const [sleutel, ids] of kandidaten) {
    if (ids.length !== 1 || bezet.has(sleutel)) continue; // twee facturen voor één termijn: niet raden
    uit.set(ids[0], sleutel.split('|')[0]);
  }
  return uit;
}

/** Welke facturen horen bij het incassotraject van deze klant? */
export function trajectFacturen({ facturen: ruw = [], subs = [], status = null }) {
  const tl = new Set(subs.map((s) => s.teamleader_subscription_id).filter(Boolean));
  const sinds = status?.status === 'incasso_regeling' ? (status.sinds || null) : null;
  // Facturen zonder abonnement-id die op periode + bedrag eenduidig bij een
  // regelingsabonnement horen, tellen als gekoppeld (zie koppelRegelingFacturen).
  const koppeling = koppelRegelingFacturen({ facturen: ruw, subs });
  const facturen = ruw.map((f) => (koppeling.has(f.id) ? { ...f, tl_subscription_id: koppeling.get(f.id), gekoppeld_op: 'periode_bedrag' } : f));
  return facturen.filter((f) => {
    if (isConcept(f)) return false; // de bureaufactuur (concept) telt nooit
    if (f.tl_subscription_id && tl.has(f.tl_subscription_id)) return true;
    // Regeling zonder (gekoppeld) abonnement: de facturen vanaf de regeling.
    if (!tl.size && sinds) {
      const d = String(f.issue_date || f.created_at || f.due_date || '').slice(0, 10);
      return d && d >= sinds && !isVolledigGecrediteerd(f);
    }
    return false;
  });
}

/**
 * @param {object} p
 * @param {Array} p.facturen     facturen van het traject (trajectFacturen)
 * @param {Array} p.subs         incasso_regeling-abonnementen
 * @param {Map}   p.betalingen   invoice_id → [{ amount, payment_date, payment_method?, source? }]
 * @param {string} p.vandaag     YYYY-MM-DD
 */
const leeg = (k) => ({ maand: k, verwacht: 0, ontvangen: 0, verwacht_vervallen: 0, facturen: [], gepland: 0, open: 0, open_vervallen: 0, gepland_voorbij: 0 });

/** Stand van één maand (zie kop): huidig = YYYY-MM van vandaag. */
export function maandStand(r, huidig) {
  if (r.maand > huidig) return 'gepland';
  if (r.open_vervallen > 0.005) return 'achterstand';
  if (r.maand === huidig && (r.open > 0.005 || r.gepland > 0.005)) return 'te_betalen';
  if (r.gepland_voorbij > 0.005) return 'factuur_ontbreekt';
  if (r.open > 0.005 || r.gepland > 0.005) return 'te_betalen';
  if (r.verwacht > 0.005) return 'betaald';
  return 'geen';
}

export function bouwMaandlijst({ facturen = [], subs = [], betalingen = new Map(), vandaag }) {
  const huidig = ym(vandaag);
  const maanden = new Map(); // ym → { verwacht, ontvangen, verwacht_vervallen, facturen: [] }
  const rij = (k) => {
    if (!maanden.has(k)) maanden.set(k, leeg(k));
    return maanden.get(k);
  };
  const metFactuur = new Set(); // `${sub_tl}|${ym}` — termijnen die al een factuur hebben

  for (const f of facturen) {
    const netto = Math.max(0, round2((Number(f.amount_total) || 0) - (Number(f.credited_amount) || 0)));
    const k = ym(f.due_date) || ym(f.issue_date) || ym(f.created_at);
    if (!k) continue;
    if (f.tl_subscription_id) metFactuur.add(`${f.tl_subscription_id}|${k}`);
    const r = rij(k);
    if (!isVolledigGecrediteerd(f)) {
      r.verwacht = round2(r.verwacht + netto);
      const vervallen = !!(f.due_date && String(f.due_date).slice(0, 10) < vandaag);
      if (vervallen) r.verwacht_vervallen = round2(r.verwacht_vervallen + netto);
      const open = openBedrag(f);
      r.open = round2(r.open + open);
      if (vervallen) r.open_vervallen = round2(r.open_vervallen + open);
    }
    r.facturen.push({
      id: f.id, nummer: f.invoice_number || null, bedrag: netto, open: openBedrag(f),
      due_date: f.due_date || null, betaald: betaaldBedrag(f), status: f.status,
      gecrediteerd: isVolledigGecrediteerd(f),
      // 'periode_bedrag' = gekoppeld op klant + periode + bedrag (geen abonnement-id van Teamleader).
      gekoppeld_op: f.gekoppeld_op || null,
      // Hoe betaald (Contant / Bank / Teamleader …); null zolang niets betaald.
      betaalmethode: betaalmethodenVan(betalingen.get(f.id) || [], f).label,
    });
    // Ontvangen in de maand van de betaling.
    const pays = (betalingen.get(f.id) || []).filter((p) => p && Number(p.amount) > 0 && p.payment_date);
    const betaald = betaaldBedrag(f);
    if (pays.length) {
      let rest = betaald;
      for (const p of pays.sort((a, b) => String(a.payment_date).localeCompare(String(b.payment_date)))) {
        const a = Math.min(rest, Number(p.amount) || 0);
        if (a <= 0) break;
        rest = round2(rest - a);
        const rp = rij(ym(p.payment_date));
        rp.ontvangen = round2(rp.ontvangen + a);
      }
    } else if (betaald > 0) {
      const rp = rij(ym(f.paid_date) || k);
      rp.ontvangen = round2(rp.ontvangen + betaald);
    }
  }
  // Nog niet gefactureerde termijnen van de abonnementen.
  for (const s of subs) {
    if (String(s.status || '').toLowerCase() === 'cancelled') continue;
    const n = Number(s.term_count) || 0;
    const per = inclPerTermijn(s);
    if (!s.start_date || !n || !(per > 0)) continue;
    for (let i = 0; i < n; i++) {
      const due = plusMaanden(s.start_date, i * cyclus(s.billing_cycle));
      const k = ym(due);
      if (s.teamleader_subscription_id && metFactuur.has(`${s.teamleader_subscription_id}|${k}`)) continue;
      const r = rij(k);
      r.verwacht = round2(r.verwacht + per);
      r.gepland = round2(r.gepland + per);
      // Geen factuur = geen vervaldag: nooit achterstand, wel zichtbaar als
      // de termijndatum voorbij is (factuur_ontbreekt).
      if (due < vandaag) r.gepland_voorbij = round2(r.gepland_voorbij + per);
    }
  }

  const sleutels = [...maanden.keys()].sort();
  if (!sleutels.length) return { maanden: [], totaal: { verwacht: 0, ontvangen: 0, achterstand: 0 } };
  const lijst = [];
  let cumV = 0, cumO = 0;
  for (const k of maandenTussen(sleutels[0], sleutels[sleutels.length - 1])) {
    const r = maanden.get(k) || leeg(k);
    cumV = round2(cumV + r.verwacht_vervallen);
    cumO = round2(cumO + r.ontvangen);
    const stand = maandStand(r, huidig);
    // Een toekomstige maand draagt geen achterstand (neutraal 'gepland').
    lijst.push({ ...r, stand, achterstand: stand === 'gepland' ? 0 : round2(Math.max(0, cumV - cumO)) });
  }
  const totV = round2(lijst.reduce((t, r) => t + r.verwacht, 0));
  const totO = round2(lijst.reduce((t, r) => t + r.ontvangen, 0));
  const vervallen = round2(lijst.reduce((t, r) => t + r.verwacht_vervallen, 0));
  return { maanden: lijst, totaal: { verwacht: totV, ontvangen: totO, achterstand: round2(Math.max(0, vervallen - totO)) } };
}
