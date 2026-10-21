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
// ÉÉN WAARHEID IN HET LMS (Maxim, audit 21 oktober 2026). Sinds de migratie
// hlms_incasso_een_waarheid.sql in het LMS gaat dit via de LMS-functie
// `hlms_incasso_vanuit_crm` (alleen service_role): die zet in één transactie
// de kaart, het merkteken `incasso` in hlms_student_start (anders zette een
// pauze of herstart de student stil terug in "Klaar voor onboarding" van zijn
// mentor — gemeten bij twee studenten) en sluit de andere open kaarten
// van die student. Terug actief: de kaarten dicht, een latere start tot de
// nieuwe startdatum en het merkteken `herstart`. Staat die functie er nog
// niet (PGRST202/42883), dan de oude directe weg: alleen de kaart.
//
// Deze functies gooien nooit: ze geven { ok:false, error } terug. Of dat de
// incasso-stap tegenhoudt, beslist de aanroeper (onboarding-incasso.js: ja —
// liever zichtbaar mislukt dan half gezet). Er gaat NIETS naar de klant.

import { getDfoLmsClient } from './dfo-lms-db.js';

export const INCASSO_SOORT = 'incasso_opvolging';
const OPEN = ['nieuw', 'opgepakt', 'wacht_op_mentor', 'on_hold', 'wacht'];

/** Het filter op "deze klant": de LMS-student als die er is, anders de onboarding. */
function klantFilter(onboardingId, studentId) {
  return studentId
    ? 'crm_onboarding_id.eq.' + onboardingId + ',student_id.eq.' + studentId
    : 'crm_onboarding_id.eq.' + onboardingId;
}

/** De LMS-functie bestaat nog niet (migratie niet gedraaid). */
function functieOntbreekt(error) {
  return !!error && (error.code === 'PGRST202' || error.code === '42883');
}

/**
 * Via de LMS-kern. `null` = de functie bestaat nog niet (val terug op de oude
 * weg); anders { ok, ... }.
 */
async function viaLmsKern(lms, invoer) {
  if (typeof lms?.rpc !== 'function') return null;
  const { data, error } = await lms.rpc('hlms_incasso_vanuit_crm', {
    p_actie: invoer.actie,
    p_onboarding: invoer.onboardingId,
    p_student: invoer.studentId || null,
    p_naam: invoer.naam || null,
    p_reden: invoer.reden ? String(invoer.reden).slice(0, 1000) : null,
    p_datum: invoer.startDatum || null,
    p_door: invoer.door ? String(invoer.door).slice(0, 300) : null,
  });
  if (functieOntbreekt(error)) return null;
  if (error) throw new Error(error.message);
  return data && typeof data === 'object' ? data : { ok: true };
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
    const kern = await viaLmsKern(lms, { actie: 'naar', onboardingId, studentId, naam, reden, door });
    if (kern) return { ok: true, signaal_id: kern.signaal_id || null, merkteken: !!studentId, via: 'lms_kern' };
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
    const kern = await viaLmsKern(lms, { actie: 'terug', onboardingId, studentId, startDatum, door });
    if (kern) return { ok: true, gesloten: Number(kern.gesloten || 0), via: 'lms_kern' };
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
