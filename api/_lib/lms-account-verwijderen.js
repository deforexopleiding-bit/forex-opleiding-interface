// api/_lib/lms-account-verwijderen.js
//
// ACCOUNT VERWIJDEREN BIJ ANNULEREN — de CRM-kant (Maxim, 2 november 2026).
//
// Sinds 29 okt kan het studentdossier in het LMS bij "Student annuleren" ook
// het account verwijderen. Nu volgen ALLE DRIE de annuleerknoppen dezelfde
// regel (dossier, Hoofdmentor › Onboarding, het CRM-detailscherm):
//   - standaard aan;
//   - pas NA een geslaagde annulering;
//   - nooit bij incasso (het merkteken en de incasso-kaart hangen aan het
//     dossier en zouden met de cascade verdwijnen — het LMS weigert het ook zelf);
//   - een al geannuleerde student: meteen verwijderen kan, zonder opnieuw te annuleren.
//
// GEEN TWEEDE IMPLEMENTATIE: het verwijderen zelf doet het LMS
// (lib/admin/student-verwijderen.ts, dezelfde uitvoering als de knop in
// Studentenbeheer), via zijn machine-ingang
//   POST <LMS>/api/admin/studenten/<id>/verwijderen/  (x-dfo-secret = DFO_LMS_PUSH_SECRET)
// Het CRM leest vooraf alleen de stand (hlms_student_verwijder_voorbeeld,
// service-role, leest alleen).

import { getDfoLmsClient } from './dfo-lms-db.js';
import { bouwUrl } from './dfo-lms-uitnodiging.js';
import { ontkoppelVerwijderdeStudent } from './lms-student-ontkoppelen.js';

const TIMEOUT_MS = 45000;

/**
 * Mag het account na deze annulering mee weg? PURE — dezelfde regel als
 * accountMagMeeWeg + de route in het LMS (src/app/api/dossier/annuleren).
 * @returns {{ mag: boolean, reason: string|null, message: string|null }}
 */
export function accountMagMeeWeg({ annuleringGeslaagd, incasso, studentId }) {
  if (!annuleringGeslaagd) {
    return { mag: false, reason: 'annulering-mislukt', message: 'De annulering lukte niet: het account is NIET verwijderd.' };
  }
  if (incasso) {
    return { mag: false, reason: 'niet-gekozen-incasso', message: 'Bij incasso blijft het account: verwijder het later in Studentenbeheer, als de incasso is afgehandeld.' };
  }
  if (!studentId) return { mag: false, reason: 'geen-lms-student', message: 'Geen LMS-account gekoppeld: er is niets te verwijderen.' };
  return { mag: true, reason: null, message: null };
}

/**
 * De stand van het account in het LMS — leest alleen.
 * @returns {Promise<null | { student_id, bestaat: boolean, naam?, email?, heeft_account?, blokkade?,
 *   sessies?, sessies_afgerond?, verwijderd_op?, fout? }>}
 */
export async function accountStand(studentId) {
  if (!studentId) return null;
  const lms = getDfoLmsClient();
  if (!lms) return { student_id: studentId, bestaat: null, fout: 'LMS-koppeling niet geconfigureerd' };
  try {
    const { data, error } = await lms.rpc('hlms_student_verwijder_voorbeeld', { p_student: studentId });
    if (error) {
      const code = String(error.code || '');
      if (code === 'PGRST202' || code === '42883') {
        return { student_id: studentId, bestaat: null, fout: 'migratie hlms_student_verwijderd.sql (RUN_ME_29okt.sql) ontbreekt in het LMS' };
      }
      return { student_id: studentId, bestaat: null, fout: error.message || 'onbekende fout' };
    }
    if (!data?.gevonden) {
      const { data: weg } = await lms.from('hlms_student_verwijderd')
        .select('verwijderd_op').eq('student_id', studentId)
        .order('verwijderd_op', { ascending: false }).limit(1).maybeSingle();
      return { student_id: studentId, bestaat: false, verwijderd_op: weg?.verwijderd_op || null };
    }
    return {
      student_id: studentId, bestaat: true, naam: data.naam || null, email: data.email || null,
      heeft_account: !!data.heeft_account, blokkade: data.blokkade || null,
      sessies: Number(data.sessies) || 0, sessies_afgerond: Number(data.sessies_afgerond) || 0,
    };
  } catch (e) {
    return { student_id: studentId, bestaat: null, fout: e?.message || String(e) };
  }
}

/**
 * Verwijder het account via de machine-ingang van het LMS. Gooit nooit; het
 * geheim komt nergens in een log of antwoord.
 * @returns {Promise<{ ok: boolean, code: string, message: string, error?: string, data?: object|null }>}
 */
export async function verwijderLmsAccount({ studentId, reden, door }) {
  const secret = (process.env.DFO_LMS_PUSH_SECRET || '').trim();
  if (!secret) return { ok: false, code: 'niet_geconfigureerd', message: 'DFO_LMS_PUSH_SECRET ontbreekt: het account is NIET verwijderd.', error: 'DFO_LMS_PUSH_SECRET ontbreekt' };
  // De naam die het LMS controleert, uit het LMS zelf: de bevestiging
  // gebeurde al in het annuleervenster.
  const stand = await accountStand(studentId);
  if (!stand || stand.bestaat === null) {
    const f = stand?.fout || 'stand onbekend';
    return { ok: false, code: 'stand_onbekend', message: 'De stand van het account kon niet gelezen worden (' + f + '): het account is NIET verwijderd.', error: f };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(bouwUrl('api/admin/studenten/' + encodeURIComponent(studentId) + '/verwijderen'), {
      method: 'POST',
      headers: { 'x-dfo-secret': secret, 'content-type': 'application/json' },
      body: JSON.stringify({ naam: stand.naam || '', reden: String(reden || '').slice(0, 2000), door: String(door || 'het CRM').slice(0, 200) }),
      redirect: 'manual',
      signal: ctrl.signal,
    });
    const body = await resp.json().catch(() => null);
    const ok = resp.ok && body?.ok === true;
    // Verwijderd → de CRM-onboardings wijzen niet langer naar een student die
    // niet meer bestaat (zie lms-student-ontkoppelen.js).
    const ontkoppeld = ok ? await ontkoppelVerwijderdeStudent(studentId, { verwijderdOp: new Date().toISOString() }) : null;
    return {
      ...(ontkoppeld ? { crm_ontkoppeld: ontkoppeld } : {}),
      ok,
      code: body?.code || ('http_' + resp.status),
      message: body?.message || ('HTTP ' + resp.status),
      ...(ok ? {} : { error: body?.message || ('HTTP ' + resp.status) }),
      data: body?.data ?? null,
    };
  } catch (e) {
    const m = e?.name === 'AbortError' ? 'het LMS antwoordde niet binnen ' + (TIMEOUT_MS / 1000) + ' s' : (e?.message || String(e));
    return { ok: false, code: 'onbereikbaar', message: 'Het LMS was niet bereikbaar (' + m + '): kijk in Studentenbeheer of het account weg is.', error: m };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * De stap `account_verwijderen` van het verslag na een annulering. Gooit nooit.
 */
export async function accountNaAnnulering({ annuleringGeslaagd, incasso, studentId, reden, door }) {
  const regel = accountMagMeeWeg({ annuleringGeslaagd, incasso, studentId });
  if (!regel.mag) return { ok: true, skipped: true, reason: regel.reason, message: regel.message };
  // Ook een onboarding die (buiten de annulering om) in incasso-opvolging
  // staat: nooit verwijderen. Het LMS weigert het ook; zo zegt het verslag waarom.
  const stand = await accountStand(studentId);
  if (stand?.blokkade === 'in_incasso') {
    return { ok: true, skipped: true, reason: 'niet-gekozen-incasso', message: accountMagMeeWeg({ annuleringGeslaagd: true, incasso: true, studentId }).message };
  }
  if (stand?.bestaat === false) return { ok: true, skipped: true, reason: 'al-verwijderd', message: 'Het account was al verwijderd.' };
  return verwijderLmsAccount({ studentId, reden: 'Geannuleerd: ' + String(reden || '').slice(0, 1900), door });
}
