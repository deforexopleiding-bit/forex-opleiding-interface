// api/_lib/splitsing-start-grens.js
//
// #809 — één bron voor de grens "hoe ver mag de eerste termijn van een
// SPLITSING in de toekomst liggen?". Gelezen door:
//   * api/joost-autonomy-evaluate.js  — check op proposal_eerste_termijn_datum
//                                        (blokkeert autonome send bij
//                                        overschrijding)
//   * api/arrangements-propose.js     — check op details.parts[0].due_date
//                                        (server-side vangnet als de LLM
//                                        zich niet aan de prompt houdt)
//
// Les uit #808: één helper, één semantiek. Twee plekken die elk hun eigen
// rekensom doen op dezelfde grens leidt tot afwijkingen.
//
// Default: 45 dagen. Beleid Jeffrey: een regeling die pas na 6 weken start
// is geen regeling meer, dat is uitstel — en uitstel valt onder
// mandate.uitstel.max_dagen_total (=90, bewust ruimer).

const DEFAULT_MAX_DAGEN_TOT_EERSTE_TERMIJN = 45;
const MS_PER_DAG = 24 * 60 * 60 * 1000;

/**
 * Lees max_dagen_tot_eerste_termijn uit mandate.splitsing. Fallback naar 45.
 *
 * @param {object|null|undefined} mandate  arrangement_mandate blob uit joost_config
 * @returns {number} positieve integer (default 45)
 */
export function getMaxDagenTotEersteTermijn(mandate) {
  const raw = mandate && mandate.splitsing && mandate.splitsing.max_dagen_tot_eerste_termijn;
  const n = Number(raw);
  if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
  return DEFAULT_MAX_DAGEN_TOT_EERSTE_TERMIJN;
}

/**
 * Aantal hele dagen tussen vandaag (UTC-cutoff Europe/Amsterdam) en een
 * YYYY-MM-DD-datum. Negatief als de datum in het verleden ligt.
 *
 * @param {string} dueDateYmd  YYYY-MM-DD
 * @param {Date} [now]         override voor tests
 * @returns {number|null}      integer, of null als dueDateYmd niet parseert
 */
export function daysUntil(dueDateYmd, now) {
  if (typeof dueDateYmd !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDateYmd.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  // Doel-datum als UTC-midnight zodat we DST-drift vermijden. De klant zit
  // in NL; kleine tijdzone-drift op de dag-berekening zelf accepteren we
  // (0.5 dag rand-case is niet materieel voor een 45-dagen grens).
  const target = Date.UTC(y, mo - 1, d);
  if (isNaN(target)) return null;
  const ref = now instanceof Date ? now : new Date();
  const refUtc = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  return Math.round((target - refUtc) / MS_PER_DAG);
}

/**
 * Bereken de UITERLIJKE datum (YYYY-MM-DD) waarop de eerste termijn mag
 * vallen, gegeven het mandate. Handig voor prompt-context.
 *
 * @param {object|null|undefined} mandate
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
export function uiterlijkeEersteTermijnDatum(mandate, now) {
  const maxDagen = getMaxDagenTotEersteTermijn(mandate);
  const ref = now instanceof Date ? now : new Date();
  const target = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate()));
  target.setUTCDate(target.getUTCDate() + maxDagen);
  return target.toISOString().slice(0, 10);
}
