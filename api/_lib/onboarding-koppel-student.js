// api/_lib/onboarding-koppel-student.js
//
// EEN ONBOARDING MET DE HAND AAN EEN LMS-STUDENT KOPPELEN (Maxim, 7 okt 2026).
//
// ── WAAROM ────────────────────────────────────────────────────────────────
// De koppeling CRM-onboarding → hlms_student gebeurt automatisch op het
// e-mailadres van de klant (dfo-lms-student.js). Bij een BEDRIJF is dat het
// adres van de zaak, terwijl de student de contactpersoon is: ER
// Schilderwerken vond Emile Rabaut niet. Zonder koppeling heeft de onboarding
// geen spiegelrij in het LMS, en dan bereiken incasso, afronden en annuleren
// de kaart bij de mentor niet.
//
// Deze koppeling hergebruikt koppelBestaandeStudent() (schrijft alleen
// hlms_student.crm_onboarding_id en de vlaggen op de onboarding), zet een
// regel in de tijdlijn met wie koppelde, en spiegelt meteen. Er gaat niets
// naar de student: geen uitnodiging, geen bericht.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { koppelBestaandeStudent } from './dfo-lms-student.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @returns {Promise<{status: number, body: object}>}
 */
export async function koppelOnboardingAanStudent({ onboardingId, studentId, door, doorUserId = null, db = supabaseAdmin, lms = getDfoLmsClient(), koppel = koppelBestaandeStudent }) {
  if (!UUID.test(String(onboardingId || '')) || !UUID.test(String(studentId || ''))) {
    return { status: 400, body: { error: 'onboarding en student zijn allebei verplicht', code: 'ongeldig_verzoek' } };
  }
  if (!lms) return { status: 503, body: { error: 'Het LMS is niet bereikbaar vanuit het CRM.', code: 'lms_niet_geconfigureerd' } };

  const { data: ob, error: obErr } = await db.from('onboardings')
    .select('id, dfo_lms_student_id, status').eq('id', onboardingId).maybeSingle();
  if (obErr) return { status: 500, body: { error: 'Onboarding lezen: ' + obErr.message } };
  if (!ob) return { status: 404, body: { error: 'Deze onboarding bestaat niet.', code: 'onbekend' } };
  if (ob.dfo_lms_student_id && String(ob.dfo_lms_student_id) !== String(studentId)) {
    return { status: 409, body: { error: 'Deze onboarding hangt al aan een andere LMS-student. Er is niets gewijzigd.', code: 'al_gekoppeld' } };
  }

  const { data: st, error: stErr } = await lms.from('hlms_student')
    .select('id, voornaam, achternaam, email').eq('id', studentId).maybeSingle();
  if (stErr) return { status: 502, body: { error: 'LMS-student lezen: ' + stErr.message } };
  if (!st) return { status: 404, body: { error: 'Deze LMS-student bestaat niet.', code: 'student_onbekend' } };

  if (String(ob.dfo_lms_student_id || '') !== String(studentId)) {
    const r = await koppel(onboardingId, studentId);
    if (!r?.ok) {
      return { status: 409, body: { error: (r?.error || 'Koppelen lukte niet') + '. Er is niets gewijzigd.', code: 'koppelen_mislukt' } };
    }
  }

  const naam = [st.voornaam, st.achternaam].filter(Boolean).join(' ').trim() || st.email || studentId;
  const { error: tlErr } = await db.from('onboarding_mentor_updates').insert({
    onboarding_id: onboardingId,
    kind:          'note',
    status:        null,
    note:          'Gekoppeld aan LMS-student ' + naam + ' door ' + (door || 'onbekend') + '.',
    created_by:    doorUserId,
  });
  if (tlErr) console.error('[onboarding-koppel-student] tijdlijn ' + onboardingId + ': ' + tlErr.message);

  const { spiegelNaActie } = await import('./onboarding-spiegel.js');
  await spiegelNaActie(onboardingId, 'gekoppeld-aan-student');
  return { status: 200, body: { ok: true, student_id: studentId, student_naam: naam } };
}

/**
 * De namen van de gekoppelde LMS-studenten, voor het overzicht
 * ("ER Schilderwerken — student: Emile Rabaut"). Faalzacht: `null` = niet
 * gelezen (dan zegt het scherm niets over de naam).
 * @returns {Promise<Map<string, string>|null>}
 */
export async function lmsStudentNamen(ids, lms = getDfoLmsClient()) {
  const uniek = [...new Set((ids || []).filter(Boolean).map(String))];
  const kaart = new Map();
  if (!uniek.length) return kaart;
  if (!lms) return null;
  try {
    for (let i = 0; i < uniek.length; i += 200) {
      const { data, error } = await lms.from('hlms_student')
        .select('id, voornaam, achternaam, email').in('id', uniek.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const r of data || []) {
        kaart.set(String(r.id), [r.voornaam, r.achternaam].filter(Boolean).join(' ').trim() || r.email || '');
      }
    }
    return kaart;
  } catch (e) {
    console.warn('[onboarding-koppel-student] namen:', e?.message || e);
    return null;
  }
}
