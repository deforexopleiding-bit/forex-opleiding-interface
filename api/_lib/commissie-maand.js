// api/_lib/commissie-maand.js
//
// In welke MAAND telt de commissie van een termijn? Pure functies, geen DB.
//
// ── DE REGEL (vanaf 22 okt 2026) ─────────────────────────────────────────
// Commissie telt in de maand waarin de klant de termijn EFFECTIEF betaalt —
// niet in de vervalmaand. Een onbetaalde termijn die over de vervaldag is,
// schuift mee naar de huidige maand ("verwacht · achterstallig sinds …") en
// komt nooit in een gesloten maand terecht.
//
// ── WAAROM ───────────────────────────────────────────────────────────────
// Het oude model zette een betaalde termijn in de vervalmaand. Het rapport
// van maand M neemt de bonus van M-1 (payout-generate-core). Vervalt een
// termijn in september en betaalt de klant pas in oktober, dan was hij bij
// het septemberrapport (begin oktober) nog onbetaald = €0; daarna viel hij
// met terugwerkende kracht in september, en het volgende rapport keek al naar
// oktober → nooit uitbetaald.
//
// ── CUTOVER (geen dubbele uitbetaling) ───────────────────────────────────
// Een maand is GESLOTEN zodra het rapport dat haar uitbetaalt definitief is
// (goedgekeurd/uitbetaald), en ook elke maand daarvóór (oude concepten van
// vóór het laatste definitieve rapport worden niet meer gebruikt; voor
// maanden vóór okt 2026 kan er zelfs geen nieuw rapport meer gemaakt worden).
//   1. Termijn betaald vóór de generatie van het definitieve rapport van zijn
//      VERVALmaand → zat al in dat rapport (oud model). Blijft daar staan,
//      telt nooit opnieuw (`uitbetaald_in`).
//   2. Anders telt hij in de betaalmaand — tenzij die maand al gesloten is:
//      dan is het INHAALcommissie. Niet automatisch uitbetalen; Maxim zet
//      een correctie op het volgende rapport.
//   3. Onbetaald + vervaldag voorbij → huidige maand, status achterstallig.
// Zo raakt de wijziging alleen maanden waarvan nog geen definitief rapport
// bestaat; elk bedrag dat al in een definitief rapport zat, blijft exact
// staan.

import { telAlsBetaald, isVolledigGecrediteerd, EPS } from './factuur-betaald.js';

export const ym = (d) => (d ? String(d).slice(0, 7) : null);

/** 'YYYY-MM' + n maanden. */
export function addYm(ymStr, n) {
  const [y, m] = String(ymStr).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Datum waarop de factuur EFFECTIEF betaald werd. Bij deelbetalingen: de dag
 * waarop de som van de betalingen het te betalen bedrag (totaal −
 * gecrediteerd) dekt. Zonder (voldoende) betalingsregels: paid_date.
 * Niet betaald of volledig gecrediteerd → null.
 */
export function effectieveBetaaldatum(inv, betalingen = []) {
  if (!inv || isVolledigGecrediteerd(inv) || !telAlsBetaald(inv)) return null;
  const nodig = (Number(inv.amount_total) || 0) - (Number(inv.credited_amount) || 0);
  const rijen = (betalingen || [])
    .filter((p) => p && p.payment_date && Number(p.amount) > 0)
    .sort((a, b) => String(a.payment_date).localeCompare(String(b.payment_date)));
  let som = 0;
  for (const p of rijen) {
    som += Number(p.amount) || 0;
    if (som >= nodig - EPS) return String(p.payment_date).slice(0, 10);
  }
  return inv.paid_date ? String(inv.paid_date).slice(0, 10) : null;
}

/**
 * Afsluiting per mentor uit zijn rapporten (mentor_payouts).
 * Rapport periode P betaalt de bonus van maand P-1.
 * Returnt { gesloten(ym), definitiefVoor(ym) → rapport|null, rapportVoor(ym)
 * → rapport|null (elke status), laatsteGesloten }.
 */
export function maakAfsluiting(rapporten = []) {
  const perBonusMaand = new Map();
  let laatsteDefinitief = null; // period 'YYYY-MM'
  for (const r of rapporten || []) {
    const periode = ym(r.period_month);
    if (!periode) continue;
    const bonusMaand = addYm(periode, -1);
    perBonusMaand.set(bonusMaand, { ...r, periode, bonusMaand });
    if (r.status === 'goedgekeurd' || r.status === 'uitbetaald') {
      if (!laatsteDefinitief || periode > laatsteDefinitief) laatsteDefinitief = periode;
    }
  }
  const laatsteGesloten = laatsteDefinitief ? addYm(laatsteDefinitief, -1) : null;
  return {
    laatsteGesloten,
    gesloten: (m) => !!(laatsteGesloten && m && m <= laatsteGesloten),
    rapportVoor: (m) => perBonusMaand.get(m) || null,
    definitiefVoor: (m) => {
      const r = perBonusMaand.get(m);
      return r && (r.status === 'goedgekeurd' || r.status === 'uitbetaald') ? r : null;
    },
  };
}

/**
 * Plaats één termijn in een maand.
 * @param {object} p
 * @param {string} p.dueYmd       vervaldag (YYYY-MM-DD)
 * @param {boolean} p.betaald     telt als betaald
 * @param {boolean} p.gecrediteerd
 * @param {string|null} p.betaaldatum effectieve betaaldatum (YYYY-MM-DD)
 * @param {string} p.vandaag      YYYY-MM-DD
 * @param {object} p.afsluiting   uit maakAfsluiting()
 * @returns {{ maand, status, telt, uitbetaald_in, inhaal, verschoven, achterstallig_sinds, betaaldatum }}
 *   telt=false → hoort in geen enkele maand van de projectie (gecrediteerd of inhaal).
 */
export function plaatsTermijn({ dueYmd, betaald, gecrediteerd, betaaldatum, vandaag, afsluiting }) {
  const dueYm = ym(dueYmd);
  const nuYm = ym(vandaag);
  const leeg = { uitbetaald_in: null, inhaal: false, verschoven: false, achterstallig_sinds: null, betaaldatum: betaaldatum || null };
  if (gecrediteerd) return { ...leeg, maand: dueYm, status: 'gecrediteerd', telt: false };

  if (betaald) {
    // Betaaldatum onbekend → oude gedrag (vervalmaand).
    const datum = betaaldatum || dueYmd;
    // 1) Zat al in het definitieve rapport van de vervalmaand?
    const oud = afsluiting.definitiefVoor(dueYm);
    const genDatum = oud?.generated_at ? String(oud.generated_at).slice(0, 10) : null;
    if (oud && genDatum && datum <= genDatum) {
      return { ...leeg, maand: dueYm, status: 'betaald', telt: true, uitbetaald_in: oud.periode };
    }
    // 2) Betaalmaand — tenzij al gesloten (dan inhaal).
    const maand = ym(datum);
    if (afsluiting.gesloten(maand)) {
      return { ...leeg, maand, status: 'betaald', telt: false, inhaal: true, verschoven: maand !== dueYm };
    }
    return { ...leeg, maand, status: 'betaald', telt: true, verschoven: maand !== dueYm };
  }

  // 3) Onbetaald.
  if (dueYmd && dueYmd < vandaag) {
    return { ...leeg, maand: nuYm, status: 'achterstallig', telt: true, verschoven: dueYm !== nuYm, achterstallig_sinds: dueYmd };
  }
  return { ...leeg, maand: dueYm, status: 'open', telt: true };
}
