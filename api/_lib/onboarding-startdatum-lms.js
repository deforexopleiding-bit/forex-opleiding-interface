// api/_lib/onboarding-startdatum-lms.js
//
// "START LATER OP" UIT HET LMS — de nieuwe startdatum op de onboarding.
//
// De hoofdmentor keurt in het LMS goed dat een student later start. In het LMS
// gaat de student dan on hold tot die dag (en schuift zijn einddatum mee bij
// het opheffen). Hier komt de andere helft: de onboarding in het CRM krijgt
// dezelfde startdatum, anders telt het CRM af naar een dag die niet meer
// geldt en staat de student in het LMS onder "Klaar voor onboarding" met de
// oude datum.
//
// DEZELFDE ONDERGRENS ALS DE KNOP IN HET CRM: minstens vandaag + 3
// kalenderdagen (assertStartDateNotTooEarly). Het LMS toont die grens al
// vóór het versturen; deze route weigert hem toch zelf, want de grens hoort
// bij het CRM en niet bij wie het vraagt.
//
// ER GAAT NIETS NAAR DE KLANT. De wijziging raakt alleen `onboardings.start_date`
// en een regel op de interne tijdlijn. De dagelijkse taak "plan eerste call"
// voor de mentor volgt de nieuwe datum vanzelf.

import { assertStartDateNotTooEarly } from './onboarding-start-date.js';
import { NIET_MEER_AANRAKEN } from './onboarding-afsluiten-na-sessie.js';
import { onboardingAfgesloten } from './onboarding-einde.js';

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const SD_WIJZIGEN        = 'gewijzigd';
export const SD_ONGEWIJZIGD     = 'ongewijzigd';
export const SD_GEEN_ONBOARDING = 'geen_onboarding';
export const SD_NIET_AANRAKEN   = 'niet_aanraken';
export const SD_AL_AFGEROND     = 'al_afgerond';
export const SD_TE_VROEG        = 'startdatum_te_vroeg';
export const SD_ONGELDIG        = 'startdatum_ongeldig';

/**
 * Wat er met deze onboarding en deze datum moet gebeuren. PURE.
 *
 * Een AFGERONDE onboarding krijgt geen nieuwe startdatum: de student heeft
 * zijn eerste sessie al gehad, en een latere start is dan een pauze in het
 * traject - die staat in het LMS (de hold), niet op een onboarding die dicht is.
 *
 * @returns {{ besluit: string, min?: string }}
 */
export function besluitStartdatum(ob, startDatum, now = new Date()) {
  if (typeof startDatum !== 'string' || !DATE_RE.test(startDatum)) return { besluit: SD_ONGELDIG };
  if (!ob?.id) return { besluit: SD_GEEN_ONBOARDING };
  if (ob.archived_at || NIET_MEER_AANRAKEN.has(String(ob.status || '').toLowerCase())) {
    return { besluit: SD_NIET_AANRAKEN };
  }
  // Alleen een onboarding die een SESSIE afsloot; wizard voltooid krijgt
  // gewoon een nieuwe startdatum (zie onboarding-einde.js).
  if (onboardingAfgesloten(ob)) return { besluit: SD_AL_AFGEROND };
  const teVroeg = assertStartDateNotTooEarly(startDatum, now);
  if (teVroeg) {
    return { besluit: teVroeg.code === 'START_DATE_TOO_EARLY' ? SD_TE_VROEG : SD_ONGELDIG, min: teVroeg.min };
  }
  if (String(ob.start_date || '').slice(0, 10) === startDatum) return { besluit: SD_ONGEWIJZIGD };
  return { besluit: SD_WIJZIGEN };
}

/** "4 jan 2027" — dezelfde schrijfwijze als de knop in het CRM. */
export function datumNL(ymd) {
  try {
    return new Date(ymd + 'T00:00:00Z').toLocaleDateString('nl-NL',
      { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  } catch { return ymd; }
}
