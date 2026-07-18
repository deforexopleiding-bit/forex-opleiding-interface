// api/_lib/onboarding-start-date.js
//
// Pure helper voor de ondergrens op onboarding.start_date. Gedeeld door
// het create-endpoint (server-side validatie) en getest via unit-tests.
//
// Beleid Jeffrey (18 juli 2026): een onboarding-startdatum mag niet in het
// verleden of vandaag liggen. Minimum = vandaag + 3 KALENDERdagen in NL-tijd
// (Europe/Amsterdam). Reden: bij startdatum=vandaag belandde het abbo in
// Bubble 3 dagen in het verleden — Bubble past een payment-buffer toe die
// de membership_state_date_date terug-shift. Door aan de bron te dwingen dat
// er minimaal 3 kalenderdagen buffer zit, kan Bubble geen retro-actief abbo
// meer aanmaken.
//
// KALENDERdagen (niet werkdagen) — matcht de UI-eis en is voorspelbaar
// rondom weekend/feestdagen (geen calendar-service nodig).

export const ONBOARDING_START_DATE_MIN_OFFSET_DAYS = 3;

/**
 * Bereken de vroegst-toegestane onboarding-startdatum in NL-tijd
 * (Europe/Amsterdam), als yyyy-mm-dd. Voorbeeld: "vandaag" (18 juli 2026,
 * NL-tijd) → "2026-07-21".
 *
 * @param {Date} [now=new Date()]  — override voor tests.
 * @returns {string} yyyy-mm-dd
 */
export function getMinOnboardingStartDate(now = new Date()) {
  // Gebruik Intl-formatter om de HUIDIGE NL-lokale datum te bepalen zonder
  // afhankelijk te zijn van de server-timezone (Vercel = UTC). We formatteren
  // 'now' als yyyy-mm-dd in Europe/Amsterdam en tellen daar +3 dagen bij op
  // via een UTC-midnight-anker (voorkomt DST-drift op het optellen zelf).
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit',
  });
  const nlDateStr = fmt.format(now); // yyyy-mm-dd (en-CA locale = ISO)
  const [y, m, d] = nlDateStr.split('-').map((s) => parseInt(s, 10));
  const anchor = new Date(Date.UTC(y, m - 1, d));
  anchor.setUTCDate(anchor.getUTCDate() + ONBOARDING_START_DATE_MIN_OFFSET_DAYS);
  const yy = anchor.getUTCFullYear();
  const mm = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(anchor.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Vergelijk twee yyyy-mm-dd strings als datum. Retourneert:
 *   -1 als a < b
 *    0 als a == b
 *    1 als a > b
 *  null bij ongeldige input (mis-format).
 *
 * @param {string} a yyyy-mm-dd
 * @param {string} b yyyy-mm-dd
 * @returns {-1|0|1|null}
 */
export function compareYmd(a, b) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof a !== 'string' || typeof b !== 'string') return null;
  if (!re.test(a) || !re.test(b)) return null;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Assert dat een start_date-string >= minimum ligt. Retourneert null als OK,
 * anders een object met de foutcontext dat naar de HTTP-response gemapt kan
 * worden.
 *
 * @param {string|null|undefined} startDate  yyyy-mm-dd of falsy (leeg toegestaan)
 * @param {Date} [now=new Date()]
 * @returns {null|{code:string,message:string,min:string,got:string}}
 */
export function assertStartDateNotTooEarly(startDate, now = new Date()) {
  if (!startDate) return null; // leeg = provisioning gebruikt now (bestaand gedrag)
  const min = getMinOnboardingStartDate(now);
  const cmp = compareYmd(startDate, min);
  if (cmp === null) {
    return {
      code:    'START_DATE_INVALID',
      message: 'start_date moet yyyy-mm-dd zijn',
      min,
      got: String(startDate),
    };
  }
  if (cmp < 0) {
    return {
      code:    'START_DATE_TOO_EARLY',
      message: `start_date moet minimaal ${ONBOARDING_START_DATE_MIN_OFFSET_DAYS} kalenderdagen in de toekomst liggen (>= ${min})`,
      min,
      got: startDate,
    };
  }
  return null;
}
