// api/_lib/onboarding-afsluiten-na-sessie.js
//
// DE EERSTE AFGERONDE SESSIE SLUIT DE ONBOARDING — de gedeelde regel.
//
// Twee ingangen gebruiken dit bestand:
//   - api/cron/onboarding-eerste-sessie-afronden.js — elke ochtend om 07:00,
//     de BODEM: wat de directe weg mist, haalt de cron in;
//   - api/lms-onboarding-sessie.js — de machine-route die het LMS aanroept
//     meteen nadat een mentor een sessie afrondt. Binnen enkele seconden in
//     plaats van de volgende ochtend.
//
// Eén patch, één besluit. Zou de route zijn eigen update schrijven, dan staan
// er op een dag twee versies van "afgesloten door de eerste sessie" in de
// databank, en weet niemand meer welke kolommen er horen.
//
// ── WAAROM HET STUDENT-ID VOOROP ─────────────────────────────────────────
// De cron zocht de onboarding alleen op `bubble_user_id`. Een student die het
// CRM sinds september 2026 rechtstreeks in het LMS aanmaakt, heeft die vaak
// niet — maar wel `onboardings.dfo_lms_student_id`, de exacte verwijzing.
// Gevolg: zijn onboarding sloot nooit vanzelf. De route zoekt daarom eerst op
// het student-id en pas daarna op de Bubble-id; de cron valt erop terug als
// er geen Bubble-id is.

import { onboardingAfgesloten } from './onboarding-einde.js';

/** Statussen die niet meer aangeraakt worden. */
export const NIET_MEER_AANRAKEN = new Set(['gearchiveerd', 'geannuleerd']);

/** De uitkomsten van besluitAfsluiting(). */
export const AFSLUITEN          = 'afsluiten';
export const GEEN_ONBOARDING    = 'geen_onboarding';
export const AL_AUTOMATISCH     = 'al_automatisch';
export const NIET_AANRAKEN      = 'niet_aanraken';
export const AL_AFGEROND        = 'al_afgerond';

/**
 * Wat er met deze onboarding moet gebeuren. PURE — dezelfde volgorde als de
 * cron altijd hanteerde.
 */
export function besluitAfsluiting(ob) {
  if (!ob?.id) return GEEN_ONBOARDING;
  if (ob.auto_afgerond_sessie_id) return AL_AUTOMATISCH;
  if (ob.archived_at || NIET_MEER_AANRAKEN.has(String(ob.status || '').toLowerCase())) {
    return NIET_AANRAKEN;
  }
  // Status 'afgerond' zonder sessie is WIZARD voltooid (6 okt 2026): die
  // wordt juist wél afgesloten door de eerste sessie. Alleen een onboarding
  // die echt dicht is, slaan we over — en dat vangt de regel hierboven al
  // (auto_afgerond_sessie_id). AL_AFGEROND blijft voor een afsluiting langs
  // een andere bron die onboarding-einde.js later kan krijgen.
  if (onboardingAfgesloten(ob)) return AL_AFGEROND;
  return AFSLUITEN;
}

/**
 * De patch die een onboarding afsluit op een sessie. PURE.
 * @param {{id: string, start_tijd: string, titel?: string|null}} sess
 */
export function afsluitPatch(sess, nowIso, ob = null) {
  return {
    status: 'afgerond',
    // Was de wizard al voltooid, dan blijft DAT moment staan: `completed_at`
    // is het wizardmoment, het afsluiten zelf staat in `auto_afgerond_op`.
    completed_at: ob?.completed_at || nowIso,
    auto_afgerond_sessie_id: sess.id,
    auto_afgerond_sessie_op: sess.start_tijd,
    auto_afgerond_sessie_titel: sess.titel || null,
    auto_afgerond_op: nowIso,
    updated_at: nowIso,
  };
}

// `start_date` erbij voor de actie 'startdatum' (later opstarten vanuit het LMS).
const OB_KOLOMMEN = 'id, status, archived_at, customer_name, auto_afgerond_sessie_id, auto_afgerond_op, completed_at, created_at, start_date';

/**
 * De onboarding van een LMS-student: eerst op `dfo_lms_student_id` (exact),
 * dan op `bubble_user_id`. De jongste wint; testrijen doen niet mee.
 * Gooit bij een leesfout.
 */
export async function vindOnboardingVoorStudent(db, { studentId, bubbleUserId }) {
  if (studentId) {
    const { data, error } = await db
      .from('onboardings')
      .select(OB_KOLOMMEN)
      .eq('dfo_lms_student_id', studentId)
      .eq('is_test', false)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error('onboarding op student-id: ' + error.message);
    if (data?.id) return { ob: data, via: 'student_id' };
  }
  if (bubbleUserId) {
    const { data, error } = await db
      .from('onboardings')
      .select(OB_KOLOMMEN)
      .eq('bubble_user_id', bubbleUserId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error('onboarding op bubble-id: ' + error.message);
    if (data?.id) return { ob: data, via: 'bubble' };
  }
  return { ob: null, via: null };
}

/**
 * Sluit af, met de wacht tegen dubbel afsluiten in de query zelf: alleen een
 * rij zonder `auto_afgerond_sessie_id` wordt geraakt. Twee gelijktijdige
 * aanroepen (de route én de cron) sluiten dus samen precies één keer af.
 *
 * @returns {Promise<boolean>} true = deze aanroep heeft afgesloten
 */
export async function sluitOnboardingAf(db, ob, sess, nowIso = new Date().toISOString()) {
  const { data, error } = await db
    .from('onboardings')
    .update(afsluitPatch(sess, nowIso, ob))
    .eq('id', ob.id)
    .is('auto_afgerond_sessie_id', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error('onboarding afsluiten: ' + error.message);
  return !!data?.id;
}
