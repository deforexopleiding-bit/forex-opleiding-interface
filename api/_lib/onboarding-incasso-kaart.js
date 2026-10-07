// api/_lib/onboarding-incasso-kaart.js
//
// DE INCASSO-KAART VOOR DAVE (Maxim, 7 oktober 2026 — "een dossier per klant,
// alles vloeit naar Dave").
//
// Zet de hoofdmentor in Hoofdmentor > Onboarding iemand naar incasso, dan
// krijgt de administratie in het LMS automatisch een kaart in de bak `admin`
// (soort `incasso_opvolging`). Zet iemand hem terug actief, dan gaat die
// kaart dicht. Zelfde vorm als de Discord-kaart bij annuleren.
//
// Fail-soft: lukt de kaart niet (LMS niet bereikbaar, migratie nog niet
// gedraaid), dan blijft de incasso-stap gewoon staan; de fout komt in de log
// en in het antwoord, nooit als een 500. Er gaat NIETS naar de klant.

import { getDfoLmsClient } from './dfo-lms-db.js';

export const INCASSO_SOORT = 'incasso_opvolging';
const OPEN = ['nieuw', 'opgepakt', 'wacht_op_mentor', 'on_hold', 'wacht'];

/** Het filter op "deze klant": de LMS-student als die er is, anders de onboarding. */
function klantFilter(onboardingId, studentId) {
  return studentId
    ? 'crm_onboarding_id.eq.' + onboardingId + ',student_id.eq.' + studentId
    : 'crm_onboarding_id.eq.' + onboardingId;
}

async function openKaarten(lms, onboardingId, studentId) {
  const { data, error } = await lms.from('hlms_signaal')
    .select('id').eq('onderwerp', 'student').eq('soort', INCASSO_SOORT)
    .in('status', OPEN).or(klantFilter(onboardingId, studentId));
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.id);
}

/**
 * Opent de kaart. Idempotent: staat er al een open incasso-kaart voor deze
 * klant, dan komt er geen tweede.
 * @returns {Promise<{ok: boolean, signaal_id?: string, al_open?: boolean, error?: string}>}
 */
export async function openIncassoKaart({ onboardingId, studentId = null, naam = null, reden, door, lms = getDfoLmsClient() }) {
  try {
    if (!lms) return { ok: false, error: 'LMS-koppeling niet geconfigureerd' };
    const al = await openKaarten(lms, onboardingId, studentId);
    if (al.length) return { ok: true, al_open: true, signaal_id: al[0] };
    const nu = new Date().toISOString();
    const tekst = (naam || 'Deze klant') + ' staat in incasso-opvolging, gezet door ' + (door || 'onbekend')
      + '. Reden: ' + String(reden || '').slice(0, 1000)
      + ' — niet geannuleerd: facturen, toegang en aanmaningen lopen door.';
    const { data, error } = await lms.from('hlms_signaal').insert({
      onderwerp: 'student', student_id: studentId || null, crm_onboarding_id: onboardingId,
      soort: INCASSO_SOORT, zwaarte: 'oranje', status: 'nieuw', bron: 'handmatig', bak: 'admin',
      eerste_op: nu, laatst_gezien_op: nu,
      bewijs: { reden: tekst, gemeld_op: nu, melding: INCASSO_SOORT, naam: naam || null, door: door || null },
    }).select('id').single();
    if (error) {
      //  23505: de unieke index op open onboarding-kaarten — er stond er al een.
      if (error.code === '23505') return { ok: true, al_open: true };
      throw new Error(error.message);
    }
    const { error: gErr } = await lms.from('hlms_signaal_gebeurtenis').insert({ signaal_id: data.id, soort: 'geopend', tekst });
    if (gErr) console.warn('[onboarding-incasso-kaart] tijdlijn van de kaart: ' + gErr.message);
    return { ok: true, signaal_id: data.id };
  } catch (e) {
    console.error('[onboarding-incasso-kaart] openen ' + onboardingId + ': ' + (e?.message || e));
    return { ok: false, error: e?.message || String(e) };
  }
}

/**
 * Sluit elke open incasso-kaart van deze klant ("terug actief").
 * @returns {Promise<{ok: boolean, gesloten?: number, error?: string}>}
 */
export async function sluitIncassoKaart({ onboardingId, studentId = null, startDatum = null, door, lms = getDfoLmsClient() }) {
  try {
    if (!lms) return { ok: false, error: 'LMS-koppeling niet geconfigureerd' };
    const ids = await openKaarten(lms, onboardingId, studentId);
    if (!ids.length) return { ok: true, gesloten: 0 };
    const nu = new Date().toISOString();
    const tekst = 'Terug actief uit incasso-opvolging, gezet door ' + (door || 'onbekend')
      + (startDatum ? '. Nieuwe startdatum: ' + startDatum + '.' : '.');
    const { error } = await lms.from('hlms_signaal')
      .update({ status: 'afgehandeld', uitkomst: 'terug_actief', gesloten_op: nu, gesloten_reden: tekst })
      .in('id', ids);
    if (error) throw new Error(error.message);
    for (const id of ids) {
      const { error: gErr } = await lms.from('hlms_signaal_gebeurtenis').insert({ signaal_id: id, soort: 'afgehandeld', tekst });
      if (gErr) console.warn('[onboarding-incasso-kaart] tijdlijn ' + id + ': ' + gErr.message);
    }
    return { ok: true, gesloten: ids.length };
  } catch (e) {
    console.error('[onboarding-incasso-kaart] sluiten ' + onboardingId + ': ' + (e?.message || e));
    return { ok: false, error: e?.message || String(e) };
  }
}
