// api/_lib/onboarding-bedenktijd.js
//
// DE bedenktijd-berekening. Eén plek, want er stonden er VIER.
//
// ── WAAROM DIT BESTAAT ────────────────────────────────────────────────────
// `computeBedenktijd` + `findWaiverConsentKey` stonden op 7 september 2026
// gekopieerd in vier endpoints: admin-future-students-list.js,
// onboardings-admin-list.js, onboarding-detail.js en
// mentor-future-students-self.js. Elke kopie droeg een comment dat ze
// "identiek" waren. Dat waren ze niet.
//
// Twee verschillen, allebei tweeëntwee gesplitst:
//
//   1. DE VERVALDATUM. Twee kopieën deden `d.setDate(d.getDate() + 14)`
//      (veertien KALENDERdagen), twee deden `+ 14*24*60*60*1000` (exact 336
//      uur). Over een zomertijd-grens schelen die een uur, en precies op de
//      grens kan dat de uitkomst omklappen van `lopend` naar `vervallen`.
//      GEKOZEN: kalenderdagen. De wet spreekt over veertien dagen, niet over
//      336 uur.
//
//   2. DE WAIVER ZONDER OFFERTEDATUM. Twee kopieën gaven `vervallen/afstand`
//      zodra de klant getekend had; twee eisten óók een offertedatum en
//      gaven anders `onbekend`.
//      GEKOZEN: getekend is getekend. Een klant die uitdrukkelijk afstand
//      heeft gedaan van zijn bedenktijd `onbekend` noemen omdat wij de
//      offertedatum niet konden vinden, is een bekend feit weggooien. De
//      vervaldatum blijft in dat geval leeg — die weten we namelijk echt niet.
//
// Deze twee keuzes VERANDEREN het gedrag van admin-future-students-list.js en
// mentor-future-students-self.js in de randgevallen hierboven. Dat is bewust
// en het staat in de PR-tekst; stilzwijgend één van de vier winnaar maken zou
// erger zijn dan de duplicatie.
//
// De uitkomst-shape blijft exact gelijk aan wat alle vier de kopieën
// teruggaven, zodat geen enkele aanroeper hoeft te wijzigen.

/** Veertien KALENDERdagen later, of null als er geen begindatum is. */
function veertienDagenNa(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + 14);
  return d.toISOString();
}

/**
 * De bedenktijd-stand van één onboarding.
 *
 * @param {{agreed?: boolean, at?: string|null}|null} waiver
 *   De waiver-consent uit `onboardings.answers`, of null als de wizard er
 *   geen waiver-blok in heeft.
 * @param {string|null} offerteOp
 *   `deals.tl_quotation_signed_at` of `.tl_quotation_accepted_at` — het
 *   moment waarop de bedenktijd begon te lopen.
 * @param {number} [nu] alleen voor tests; standaard Date.now()
 * @returns {{status: 'lopend'|'vervallen'|'onbekend',
 *            reason: 'afstand'|'verstreken'|null,
 *            waived_at: string|null,
 *            offerte_op: string|null,
 *            vervalt_op: string|null}}
 */
export function computeBedenktijd(waiver, offerteOp, nu = Date.now()) {
  const vervaltOp = veertienDagenNa(offerteOp);
  const waived = !!(waiver && waiver.agreed === true);

  // 1) Afstand gedaan — dan is de bedenktijd voorbij, ook zonder offertedatum.
  if (waived) {
    return {
      status: 'vervallen', reason: 'afstand',
      waived_at: waiver.at || null,
      offerte_op: offerteOp || null, vervalt_op: vervaltOp,
    };
  }
  // 2) Verstreken — alleen te weten mét een offertedatum.
  if (vervaltOp && nu > new Date(vervaltOp).getTime()) {
    return {
      status: 'vervallen', reason: 'verstreken',
      waived_at: null, offerte_op: offerteOp, vervalt_op: vervaltOp,
    };
  }
  // 3) Loopt nog.
  if (vervaltOp) {
    return {
      status: 'lopend', reason: null,
      waived_at: null, offerte_op: offerteOp, vervalt_op: vervaltOp,
    };
  }
  // 4) Geen offertedatum en niet getekend — we weten het niet. En dat is iets
  //    anders dan "de bedenktijd is voorbij"; zie de regel van Maxim: de
  //    mentor belt niet door zolang de bedenktijd loopt, dus `onbekend` mag
  //    nooit als `vervallen` gelezen worden.
  return {
    status: 'onbekend', reason: null,
    waived_at: null, offerte_op: null, vervalt_op: null,
  };
}

/**
 * De consent-sleutel van het waiver-blok in een wizard-structuur.
 * Stond eveneens in viervoud; hier woordelijk overgenomen (die vier waren
 * wél identiek).
 */
export function findWaiverConsentKey(structure) {
  if (!structure || typeof structure !== 'object') return null;
  const pages = Array.isArray(structure.pages) ? structure.pages : [];
  for (const p of pages) {
    for (const b of (p?.blocks || [])) {
      if (!b || !b.is_waiver) continue;
      if (b.type === 'file_download' && b.consent_key) return b.consent_key;
      if (b.type === 'consent'       && b.key)         return b.key;
    }
  }
  return null;
}

/**
 * De waiver-consent uit de antwoorden halen.
 * @param {object|null} answers `onboardings.answers`
 * @param {string|null} waiverKey uit findWaiverConsentKey()
 */
export function leesWaiver(answers, waiverKey) {
  if (!waiverKey) return null;
  const ans = (answers && typeof answers === 'object') ? answers : {};
  return { agreed: ans[waiverKey] === true, at: ans[waiverKey + '_at'] || null };
}

/**
 * Het moment waarop de bedenktijd begon, uit een deals-rij.
 * Getekend gaat vóór geaccepteerd — dat is de volgorde die alle vier de
 * endpoints al hanteerden.
 */
export function leesOfferteMoment(dealRow) {
  if (!dealRow) return null;
  return dealRow.tl_quotation_signed_at || dealRow.tl_quotation_accepted_at || null;
}
