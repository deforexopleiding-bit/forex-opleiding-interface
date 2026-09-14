// api/_lib/geen-gehoor-deadline.js
//
// DE DEADLINE VAN DE LAATSTE-KANS-MAIL — ÉÉN DEFINITIE.
//
// Maxims derde beslissing: 48 uur, maar nooit later dan 48 uur vóór het event
// zelf. Dat getal staat op drie plekken in de flow:
//
//   1. de wachtstap van de automatisatie (applyWaitCeiling in
//      _lib/events-automation-engine.js) — die bepaalt WANNEER de plek
//      daadwerkelijk vervalt;
//   2. de mailtekst ({{attendee.geen_gehoor_deadline}} in
//      _lib/template-variables.js) — die vertelt de deelnemer wanneer;
//   3. de antwoord-melding aan Maxim (api/cron-events-geen-gehoor-reacties.js)
//      — die zegt wat de deadline was.
//
// Lopen die drie uiteen, dan belooft de mail een moment waarop de automatisatie
// al gehandeld heeft, of omgekeerd. Vandaar dit bestand: puur, zonder imports,
// zonder databank. plafondMs is de enige plek waar 'nooit later dan X uur voor
// het event' wordt uitgerekend.

/** De wachttijd na de belstatus, in uren. */
export const GEEN_GEHOOR_UREN_NA_BELSTATUS = 48;
/** En de harde bovengrens: zo veel uur vóór de start van het event. */
export const GEEN_GEHOOR_UITERLIJK_UREN_VOOR_EVENT = 48;

/**
 * Het plafond: het moment dat `uren` vóór de start van het event ligt.
 *
 * @returns {?number} ms, of null als er geen plafond te berekenen is
 *                    (geen leesbare startdatum, of geen leesbaar aantal uren).
 */
export function plafondMs(eventStartsAt, uren) {
  // TYPE EERST, PAS DAN Number(). Number([]) is 0 en Number('') ook — een
  // corrupte config zou daarmee 'uiterlijk op het moment dat het event begint'
  // betekenen, en dat is iets heel anders dan 'geen grens'.
  const isGetal = typeof uren === 'number'
    || (typeof uren === 'string' && uren.trim() !== '' && Number.isFinite(Number(uren)));
  if (!isGetal) return null;
  const u = Number(uren);
  if (!Number.isFinite(u) || u < 0) return null;

  const startMs = eventStartsAt == null ? NaN : Date.parse(eventStartsAt);
  if (!Number.isFinite(startMs)) return null;

  return startMs - u * 3_600_000;
}

/**
 * De deadline zoals die in de mail hoort te staan.
 *
 * @param {object}  o
 * @param {?string} o.callStatusAt   het nulpunt (event_attendees.call_status_at)
 * @param {?string} o.eventStartsAt  de start van het event
 * @param {number}  [o.urenNa]       wachttijd na de belstatus
 * @param {number}  [o.uiterlijkUren] bovengrens vóór het event
 * @returns {?Date} null als er geen nulpunt is — dan hoort er ook geen
 *                  deadline in de tekst te staan.
 */
export function geenGehoorDeadline({
  callStatusAt, eventStartsAt,
  urenNa = GEEN_GEHOOR_UREN_NA_BELSTATUS,
  uiterlijkUren = GEEN_GEHOOR_UITERLIJK_UREN_VOOR_EVENT,
} = {}) {
  const vanafMs = callStatusAt == null ? NaN : Date.parse(callStatusAt);
  // GEEN NULPUNT IS GEEN DEADLINE. Een datum verzinnen zou een belofte zijn
  // die de automatisatie niet nakomt: die rekent vanaf call_status_at.
  if (!Number.isFinite(vanafMs)) return null;

  const gepland = vanafMs + Number(urenNa || 0) * 3_600_000;
  const plafond = plafondMs(eventStartsAt, uiterlijkUren);
  if (plafond == null) return new Date(gepland);

  // Ligt het plafond al vóór het nulpunt, dan was de deadline verstreken op het
  // moment dat ze gesteld werd. De automatisatie gaat dan meteen door, en de
  // tekst hoort dat ook te zeggen: het nulpunt zelf is het laatste moment.
  if (plafond <= vanafMs) return new Date(vanafMs);

  return new Date(Math.min(gepland, plafond));
}

/**
 * De deadline als Nederlandse tekst voor een mail: 'woensdag 16 september
 * om 13:05'. Amsterdamse tijd, nooit via toISOString() — dat is UTC, en dan
 * staat een deadline van 00:30 een dag te vroeg in de mail.
 */
export function formatDeadlineNl(date) {
  const ms = date instanceof Date ? date.getTime() : Date.parse(date);
  if (!Number.isFinite(ms)) return '';
  try {
    const d = new Date(ms);
    const dag = new Intl.DateTimeFormat('nl-NL', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam',
    }).format(d);
    const tijd = new Intl.DateTimeFormat('nl-NL', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Amsterdam',
    }).format(d);
    return `${dag} om ${tijd}`;
  } catch (_e) { return ''; }
}
