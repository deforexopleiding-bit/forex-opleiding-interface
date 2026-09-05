// api/_lib/onboarding-window.js
//
// Gedeelde datum-rekenkunde voor onboarding-trajecten. Bestaat zodat de
// Bubble-provisioning (api/_lib/onboarding-provision.js) en de dfo-lms-
// koppeling (api/_lib/dfo-lms-student.js) dezelfde maand-arithmetiek
// gebruiken. Lesson learned 20-05: dubbele helper-functies in parallelle
// bestanden lopen op termijn uit elkaar.

/**
 * Maanden optellen met clamp op de laatste dag van de doelmaand.
 * 15 jan + 1 = 15 feb; 31 jan + 1 = 28/29 feb (niet 2/3 maart).
 *
 * @param {Date} date
 * @param {number} months  negatieve of niet-numerieke waarden → 0
 * @returns {Date} nieuw Date-object (input blijft ongemoeid)
 */
export function addMonths(date, months) {
  const n = Math.max(0, Math.floor(Number(months) || 0));
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + n);
  // Clamp: als de doelmaand minder dagen heeft rolt setUTCMonth door.
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d;
}

/**
 * Parse een Postgres date/timestamptz-waarde naar een Date op UTC-middernacht.
 * onboardings.start_date is een `date`-kolom en komt als 'yyyy-mm-dd' binnen;
 * zonder expliciete UTC-suffix schuift dat een dag bij negatieve offsets.
 *
 * @param {string|Date|null|undefined} raw
 * @returns {Date|null} null bij leeg of onparseerbaar
 */
export function parseDatumUtc(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return Number.isFinite(raw.getTime()) ? raw : null;
  const s = String(raw);
  const d = new Date(s + (s.includes('T') ? '' : 'T00:00:00Z'));
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Toegangsvenster voor een studentrij in dfo-lms.
 *
 * Semantiek wijkt BEWUST af van de Bubble-variant: Bubble schuift de basis
 * naar `now` wanneer start_date in het verleden ligt (het abonnement gaat
 * dan vandaag in). Een studentrij in het LMS is een administratief feit —
 * daar willen we de ECHTE startdatum vastleggen, ook als die achter ons
 * ligt. Dat is zichtbaar bij de handmatige knop op een bestaande onboarding.
 *
 * @param {{ startDate: string|Date|null, duurMaanden: number|null }} arg
 * @returns {{ startIso: string, eindIso: string|null }}
 *   eindIso is null wanneer duur_maanden ontbreekt of 0 is — dan legt het
 *   LMS geen einddatum vast in plaats van een verzonnen datum.
 */
export function berekenLmsVenster({ startDate, duurMaanden }) {
  const start = parseDatumUtc(startDate) || new Date();
  const maanden = Number(duurMaanden);
  const eind = (Number.isFinite(maanden) && maanden > 0)
    ? addMonths(start, maanden)
    : null;
  return {
    startIso: start.toISOString(),
    eindIso:  eind ? eind.toISOString() : null,
  };
}
