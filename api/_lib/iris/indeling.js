// api/_lib/iris/indeling.js
//
// Een indeling met de hand rechtzetten.
//
// ── WAAROM DIT EEN EIGEN BESTANDJE IS ────────────────────────────────────────
// De regel "wat gebeurt er met de status als de categorie verandert" is klein
// maar niet vanzelfsprekend, en hij heeft twee richtingen die niet elkaars
// spiegelbeeld zijn. Zo'n regel hoort in een zuivere functie te staan die
// nagerekend kan worden zonder databank, niet halverwege een endpoint.
//
// ── DE TWEE RICHTINGEN ───────────────────────────────────────────────────────
// NAAR spam toe: de status blijft staan. Het categoriefilter haalt het gesprek
// al uit de werkbak, en de status ergens anders heen duwen zou informatie
// weggooien die klopte — "hier wachtte iemand op ons" blijft waar als het
// bericht zelf reclame was.
//
// VAN spam terug: de status moet WEL mee, want anders komt het gesprek nergens
// terug. Iris had het op 'nieuw' laten staan en 'nieuw' is een stand die
// niemand aanklikt. Vandaar 'wacht_op_ons'.
//
// Behalve als er al iets afgesproken is. `belofte_loopt` en `geregeld` zijn
// standen die een mens bewust gezet heeft; die overschrijven omdat een
// categorie verandert, zou dat werk uitwissen.

import { GEEN_WERK, CATEGORIEEN } from './instellingen.js';

/** Standen die een mens bewust gezet heeft en die we niet terugdraaien. */
export const BEWUSTE_STANDEN = Object.freeze(['belofte_loopt', 'geregeld']);

/**
 * Wat er aan het gesprek moet veranderen.
 *
 * @param {{huidigeCategorie: string|null, huidigeStatus: string}} nu
 * @param {string} nieuweCategorie
 * @returns {{ok: false, reden: string} | {ok: true, velden: object, verandert: boolean}}
 */
export function bepaalIndeling(nu, nieuweCategorie) {
  const cat = String(nieuweCategorie || '').trim();
  if (!CATEGORIEEN.includes(cat)) {
    return { ok: false, reden: `onbekende categorie: ${cat || '(leeg)'}` };
  }

  const huidig = String(nu?.huidigeCategorie || '').trim() || null;
  const status = String(nu?.huidigeStatus || '').trim();

  const velden = { categorie: cat };

  const wasWerk = huidig !== null && !GEEN_WERK.includes(huidig);
  const wordtWerk = !GEEN_WERK.includes(cat);

  // Alleen bij de overgang NAAR werk toe raken we de status aan, en alleen als
  // er nog geen stand staat die een mens bewust gezet heeft.
  if (wordtWerk && !wasWerk && !BEWUSTE_STANDEN.includes(status)) {
    velden.status = 'wacht_op_ons';
  }

  return { ok: true, velden, verandert: huidig !== cat };
}
