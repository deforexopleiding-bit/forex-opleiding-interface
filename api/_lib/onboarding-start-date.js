// api/_lib/onboarding-start-date.js
//
// Pure helpers voor start-date-ondergrenzen. Ondanks de historisch
// onboarding-scoped bestandsnaam wordt deze module gedeeld door:
//   - api/onboarding-create.js       — payment_start_date / start_date
//   - api/sales-deal-create.js       — payment_start_date +
//                                       payment_term_start_date +
//                                       payment_downpayment_date
// (bestandsnaam behouden om bestaande imports niet te breken; refactor
// naar `api/_lib/start-date.js` is aparte opschoning voor later).
//
// Beleid Jeffrey (18 juli 2026): een cursus/onboarding-startdatum mag
// niet in het verleden of vandaag liggen. Minimum = vandaag + 3
// KALENDERdagen in NL-tijd (Europe/Amsterdam). Reden:
//   - Onboarding: Bubble past een payment-buffer toe die terug-shift;
//     zonder 3d buffer belandt het abbo in het verleden.
//   - Sales-wizard: afgeleide betaaldatums (aanbetaling = start-3d,
//     1e termijn zonder aanbetaling = start-3d) worden anders zelf
//     al historisch bij startdatum=vandaag.
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

/**
 * Vandaag als yyyy-mm-dd in NL-tijd (Europe/Amsterdam). Gebruikt door
 * assertDateNotInPast om te vergelijken zonder server-timezone-afhankelijkheid.
 *
 * @param {Date} [now=new Date()]
 * @returns {string} yyyy-mm-dd
 */
export function getTodayNL(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(now);
}

/**
 * Assert dat een datum-string niet in het VERLEDEN ligt (t.o.v. vandaag NL).
 * Vandaag zelf is toegestaan (vergelijking is strict <, niet <=). Gebruikt door
 * sales-deal-create voor payment_term_start_date en payment_downpayment_date —
 * die mogen wél vandaag zijn (past vaak voor SEPA-buffer met start = vandaag+3),
 * maar niet gisteren of eerder.
 *
 * Retourneert null als OK / leeg, anders {code,message,today,got}.
 *
 * @param {string|null|undefined} dateStr  yyyy-mm-dd of falsy
 * @param {string} fieldLabel              menselijke veldnaam voor de foutmelding
 * @param {Date} [now=new Date()]
 * @returns {null|{code:string,message:string,today:string,got:string,field:string}}
 */
export function assertDateNotInPast(dateStr, fieldLabel, now = new Date()) {
  if (!dateStr) return null;
  const today = getTodayNL(now);
  const cmp = compareYmd(dateStr, today);
  if (cmp === null) {
    return {
      code: 'DATE_INVALID',
      message: `${fieldLabel} moet yyyy-mm-dd zijn`,
      today,
      got: String(dateStr),
      field: fieldLabel,
    };
  }
  if (cmp < 0) {
    return {
      code: 'DATE_IN_PAST',
      message: `${fieldLabel} mag niet in het verleden liggen (>= ${today})`,
      today,
      got: dateStr,
      field: fieldLabel,
    };
  }
  return null;
}
