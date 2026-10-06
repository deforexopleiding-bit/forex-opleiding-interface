// api/_lib/onboarding-einde.js
//
// WANNEER IS EEN ONBOARDING ÉCHT AFGELOPEN — de enige plek die dat beslist.
//
// ── DE FOUT DIE HIER RECHTGEZET WORDT (6 oktober 2026) ───────────────────
// `onboardings.status = 'afgerond'` betekent in het CRM: de klant heeft de
// WIZARD voltooid (api/onboarding-complete.js zet status + completed_at). Het
// zegt NIETS over de eerste sessie met de mentor. Toch lazen de spiegel naar
// het LMS, de intake-pot, de automatische afsluiting en het overzicht dat
// woord als "onboarding afgelopen". Gevolg: Jonas Keppens (start 8 okt, nog
// geen sessie) en Quinten Braeckman (eerste sessie pas gepland) verdwenen uit
// "Klaar voor onboarding" bij hun mentor, met "Afgerond door sessie op …"
// erbij — terwijl er nooit een sessie was.
//
// ── DE REGEL ─────────────────────────────────────────────────────────────
// Afgesloten = status 'afgerond' ÉN een aanwijsbare sessie die het deed
// (`auto_afgerond_op` / `auto_afgerond_sessie_id`, gezet door
// onboarding-afsluiten-na-sessie.js). Alleen de status is "wizard voltooid",
// en dat is een lopende onboarding.
//
// Toets: status 'afgerond' en auto_afgerond_op null → NIET afgesloten.
//
// ── DE TWEEDE BRON: MET DE HAND AFGEROND (Maxim, 6 oktober 2026) ─────────
// Sommige trajecten lopen al zonder dat het LMS een afgeronde sessie heeft
// (calls in Bubble, sessies van vóór het watermerk). Die sluit de hoofdmentor
// met de hand af, met een reden: `handmatig_afgerond_op/_door/_reden`. Dat
// staat NAAST de automatische afsluiting, in eigen kolommen, zodat altijd te
// zien is welke van de twee het deed. Een handmatige afsluiting hangt niet af
// van de wizardstatus: een traject dat al loopt is afgelopen als onboarding,
// ook als de wizard nooit helemaal doorlopen werd.

/** De stand die de spiegel doorgeeft voor "wizard klaar, eerste sessie nog niet". */
export const STAND_WIZARD_VOLTOOID = 'wizard_voltooid';

function statusVan(ob) {
  return String(ob?.status || '').trim().toLowerCase();
}

/** Heeft de klant de wizard doorlopen? (Zegt niets over de eerste sessie.) PURE. */
export function wizardVoltooid(ob) {
  return statusVan(ob) === 'afgerond';
}

/** Afgesloten door een sessie? PURE. */
export function automatischAfgesloten(ob) {
  if (!ob || statusVan(ob) !== 'afgerond') return false;
  return !!(ob.auto_afgerond_op || ob.auto_afgerond_sessie_id);
}

/** Met de hand afgesloten (met reden)? PURE. */
export function handmatigAfgesloten(ob) {
  if (!ob) return false;
  const s = statusVan(ob);
  if (s === 'geannuleerd' || s === 'gearchiveerd') return false;
  return !!ob.handmatig_afgerond_op;
}

/** Is deze onboarding écht afgelopen — door een sessie of met de hand? PURE. */
export function onboardingAfgesloten(ob) {
  return automatischAfgesloten(ob) || handmatigAfgesloten(ob);
}

/** Wanneer hij afgesloten werd, of null als hij niet afgesloten is. PURE. */
export function afgeslotenOp(ob) {
  if (automatischAfgesloten(ob)) return ob.auto_afgerond_op || ob.auto_afgerond_sessie_op || null;
  if (handmatigAfgesloten(ob)) return ob.handmatig_afgerond_op;
  return null;
}

/** Hoe hij afgesloten werd: 'sessie', 'handmatig' of null. PURE. */
export function afgeslotenDoor(ob) {
  if (automatischAfgesloten(ob)) return 'sessie';
  if (handmatigAfgesloten(ob)) return 'handmatig';
  return null;
}

/**
 * De stand voor `hlms_crm_onboarding.onboarding_stand`. PURE.
 *
 * Alles blijft letterlijk (een nieuw CRM-woord zoals 'on hold' moet in het LMS
 * als onbekend opvallen, niet weggemapt worden) — op één woord na: 'afgerond'
 * zonder afsluitende sessie wordt 'wizard_voltooid'. Dat is geen vertaling
 * maar het rechtzetten van een woord dat twee dingen betekende.
 */
export function lmsStandVoor(ob) {
  const ruw = ob?.status;
  if (typeof ruw !== 'string' || ruw === '') return null;
  // Met de hand afgesloten terwijl de status nog 'bezig' of 'aangemeld' zegt:
  // voor het LMS is hij afgerond.
  if (handmatigAfgesloten(ob)) return 'afgerond';
  if (wizardVoltooid(ob) && !onboardingAfgesloten(ob)) return STAND_WIZARD_VOLTOOID;
  return ruw;
}
