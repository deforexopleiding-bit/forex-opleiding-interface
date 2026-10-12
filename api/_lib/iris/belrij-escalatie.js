// api/_lib/iris/belrij-escalatie.js
//
// Taak 6, deel 3 (kern) — wat er gebeurt als iemand drie keer niet opnam.
//
// `moetEscaleren()` in belrij.js zegt of de DREMPEL gehaald is: drie pogingen
// op drie verschillende dagen, zonder contact. Dit bestand zegt wat er dan mag
// gebeuren, en dat is iets anders. De drempel is een meting; dit is een mandaat.
//
// ── PUUR, EN WAAROM DAT HIER UITMAAKT ────────────────────────────────────────
// Geen databank, geen klok buiten wat je meegeeft, geen netwerk. Een functie die
// beslist of er namens het bedrijf een bericht naar een klant gaat, moet in een
// toets op elk geval te zetten zijn — niet alleen op het geval dat je in
// productie toevallig tegenkomt. Zelfde reden als bij evaluateAutonomy() voor
// Joost.
//
// ── DE STANDEN ───────────────────────────────────────────────────────────────
//   'uit'     — er gebeurt niets. Iemand kijkt in de belrij en doet het zelf.
//   'concept' — STANDAARD. Iris zet een WhatsApp (buiten 24 u een template) en
//               een mail als CONCEPT in de Post. Eén klik van Maxim of Dave en
//               het gaat weg. Dat is wat de opdracht vraagt.
//   'zelf'    — Iris stuurt zelf. GEBOUWD MAAR STAAT UIT. Pas als hij ooit aan
//               gaat, gelden de vier poorten hieronder, en die zitten in CODE,
//               niet in een prompt: een model dat overtuigd wordt om buiten zijn
//               mandaat te treden is geen theorie (les 24 bij Joost E2).
//
// ── DE VIER POORTEN VOOR 'zelf' ──────────────────────────────────────────────
//   1. kantooruren   — 08:00-20:00. Een aanmaning om kwart over elf 's nachts
//                      is geen aanmaning, dat is een incident.
//   2. afkoeling     — maximaal één bericht per persoon per drie dagen.
//   3. afspraak      — nooit tijdens een actieve betaalafspraak of toezegging.
//                      Wie een regeling heeft en zich eraan houdt, hoort geen
//                      "we proberen je te bereiken" te krijgen.
//   4. idempotentie  — staat er al een onverstuurd concept voor deze persoon,
//                      dan komt er geen tweede bij. Zelfde gedachte als de
//                      claim-vóór-versturen in G2: twee ronden die elkaar
//                      kruisen mogen niet twee berichten opleveren.
//
// Een poort die DICHT staat valt terug op 'concept', niet op 'niets'. Het werk
// verdwijnt dus nooit; het wacht alleen op een mens.

/** De standen, in oplopende vrijheid. Zelfde vorm als STANDEN in instellingen.js. */
export const BELRIJ_STANDEN = Object.freeze(['uit', 'concept', 'zelf']);

/** Standaard voor elke bron. 'concept' is wat de opdracht vraagt; 'zelf' zet een mens aan. */
export const STANDAARD_STAND = 'concept';

/** Kantooruren voor stand 'zelf'. Buiten dit venster wordt het een concept. */
export const UREN = Object.freeze({ van: 8, tot: 20 });

/** Minimale rust tussen twee berichten aan dezelfde persoon, in uren. */
export const AFKOELING_UREN = 72;

/** De bronnen waar een stand op ingesteld kan worden. Gelijk aan iris_belrij.bron. */
export const BRONNEN = Object.freeze(['wanbetaler', 'onboarding', 'mentorsignaal', 'geen_reactie', 'hand']);

/** Alles wat geen geldige stand is, leest als de standaard — nooit als 'zelf'. */
export function leesStand(ruw) {
  const s = String(ruw ?? '').trim().toLowerCase();
  return BELRIJ_STANDEN.includes(s) ? s : STANDAARD_STAND;
}

/**
 * De stand voor één bron.
 *
 * Een ontbrekende instelling is 'concept', niet 'zelf'. Dat is het verschil
 * tussen "nog niet ingesteld" en "mag zelfstandig naar klanten mailen".
 */
export function standVoorBron(instelling, bron) {
  const kaart = (instelling && typeof instelling === 'object') ? instelling : {};
  if (!BRONNEN.includes(String(bron))) return STANDAARD_STAND;
  return leesStand(kaart[bron]);
}

/**
 * Valt dit moment binnen kantooruren?
 *
 * Met opzet via Intl en niet via getHours(): de server staat op UTC, en in de
 * zomer is dat twee uur naast de klok van de klant. Een venster van 08:00 tot
 * 20:00 dat in juli om 06:00 opengaat, is geen venster.
 */
export function binnenKantooruren(nu = new Date(), { tz = 'Europe/Brussels', uren = UREN } = {}) {
  const d = nu instanceof Date ? nu : new Date(nu);
  if (Number.isNaN(d.getTime())) return false;
  let uur;
  try {
    uur = Number(new Intl.DateTimeFormat('nl-BE', { hour: 'numeric', hour12: false, timeZone: tz }).format(d));
  } catch {
    return false; // onbekende tijdzone: dan liever een concept dan een bericht op het verkeerde uur
  }
  if (!Number.isFinite(uur)) return false;
  return uur >= uren.van && uur < uren.tot;
}

/**
 * Wat mag er met deze escalatie gebeuren?
 *
 * De controles staan in een VASTE volgorde, zodat de reden die eruit komt ook
 * de eerste echte blokkade is en niet de laatste die toevallig gecheckt werd.
 *
 * @param {object} in
 * @param {{escaleren: boolean, reden: string}} in.escalatie  uit moetEscaleren()
 * @param {string}  in.stand                 uit standVoorBron()
 * @param {Date}    [in.nu]
 * @param {string}  [in.tz]
 * @param {string|null} [in.laatsteUitgaandOp]   laatste bericht AAN deze persoon
 * @param {boolean} [in.actieveAfspraak]         actieve betaalafspraak of toezegging
 * @param {boolean} [in.openConcept]             er staat al een onverstuurd concept
 * @returns {{doen: 'niets'|'concept'|'zelf', reden: string, poort: string|null}}
 */
export function beslisEscalatie({
  escalatie,
  stand,
  nu = new Date(),
  tz = 'Europe/Brussels',
  laatsteUitgaandOp = null,
  actieveAfspraak = false,
  openConcept = false,
} = {}) {
  // 1. De drempel. Niet gehaald is niet gehaald; de reden komt uit moetEscaleren
  //    zodat op het scherm staat waarom er nog niets gebeurt.
  if (!escalatie || escalatie.escaleren !== true) {
    return { doen: 'niets', reden: escalatie?.reden || 'de drempel is niet gehaald', poort: 'drempel' };
  }

  const s = leesStand(stand);

  // 2. Uit is uit. Dit is de enige uitkomst waarbij er ook geen concept komt:
  //    wie een bron op 'uit' zet, wil er met de hand naar kijken.
  if (s === 'uit') {
    return { doen: 'niets', reden: 'deze bron staat op uit', poort: 'stand' };
  }

  // 3. Concept is de standaard en heeft geen poorten: er gaat niets de deur uit
  //    zonder dat een mens erop klikt.
  if (s === 'concept') {
    return { doen: 'concept', reden: escalatie.reden, poort: null };
  }

  // 4. Vanaf hier is de stand 'zelf'. Elke poort die dicht staat valt terug op
  //    'concept' — het werk verdwijnt niet, het wacht op een mens.
  if (openConcept) {
    return { doen: 'niets', reden: 'er staat al een onverstuurd concept voor deze persoon', poort: 'idempotentie' };
  }
  if (actieveAfspraak) {
    return { doen: 'concept', reden: 'er loopt een betaalafspraak of toezegging', poort: 'afspraak' };
  }
  if (!binnenKantooruren(nu, { tz })) {
    return { doen: 'concept', reden: `buiten ${UREN.van}-${UREN.tot} uur`, poort: 'kantooruren' };
  }
  if (laatsteUitgaandOp) {
    const uren = (new Date(nu).getTime() - new Date(laatsteUitgaandOp).getTime()) / 3600000;
    if (!Number.isFinite(uren)) {
      return { doen: 'concept', reden: 'onleesbaar tijdstip van het laatste bericht', poort: 'afkoeling' };
    }
    if (uren < AFKOELING_UREN) {
      return {
        doen: 'concept',
        reden: `er ging ${Math.floor(uren)} uur geleden al een bericht naar deze persoon`,
        poort: 'afkoeling',
      };
    }
  }

  return { doen: 'zelf', reden: escalatie.reden, poort: null };
}
