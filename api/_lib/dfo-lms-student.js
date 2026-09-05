// api/_lib/dfo-lms-student.js
//
// Fase 1 — studentrij aanmaken in het NIEUWE LMS (dfo-lms, hlms_student)
// bij het starten van een onboarding. Vervangt NIETS aan de bestaande
// Bubble-flow en raakt de trial-site (lms_gebruikers / lms_provision) niet;
// zie de naamgevingsnotitie in api/_lib/dfo-lms-db.js.
//
// IDEMPOTENTIE is de hoofdeis. Dezelfde onboarding twee keer verwerken mag
// nooit een tweede studentrij opleveren. Drie lagen, van goedkoop naar hard:
//
//   1. CRM-vlag       — onboardings.dfo_lms_provisioned + dfo_lms_student_id.
//   2. Zoeken vóór schrijven — eerst op crm_onboarding_id, dan op
//                       lower(email). Gevonden = overnemen, niet aanmaken.
//   3. Databank-vangnet — dfo-lms heeft twee unieke indexen:
//                       hlms_student_email_uidx op lower(email) en
//                       hlms_student_crm_onboarding_uidx op crm_onboarding_id.
//                       Twee gelijktijdige pogingen kunnen dus nooit twee
//                       rijen opleveren; de verliezer krijgt 23505 en wij
//                       behandelen dat als "bestond al" — niet als fout.
//
// Wat we NIET aanraken in hlms_student: calls_gedaan, calls_startsaldo,
// no_show_count, auth_id, bubble_user_id, membership_type, overrides,
// onboarding_status, uitnodiging_* en aangemaakt_door. Fase 1 legt alleen
// het studentfeit vast; inloggen/uitnodigen is een latere fase.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient, isUniqueViolation } from './dfo-lms-db.js';
import { berekenLmsVenster } from './onboarding-window.js';

// Kolommen die we op onboardings lezen/schrijven voor deze koppeling.
const CRM_KOLOMMEN =
  'id, customer_id, traject_id, status, start_date, mentor_user_id, ' +
  'dfo_lms_student_id, dfo_lms_provisioned, dfo_lms_provisioned_at, dfo_lms_provision_error';

// hlms_student.product_soort — vocabulaire aan LMS-kant is niet vastgelegd in
// dit repo. We sturen het traject-type door (bv. 'membership' / '1op1') met
// terugval op de traject-key. Blijkt er aan LMS-kant een vaste woordenlijst
// of CHECK te staan, dan is dit de enige plek die aangepast hoeft te worden.
function bepaalProductSoort(traject) {
  const t = traject || {};
  const v = (t.type || t.key || '').toString().trim();
  return v || null;
}

// Aantal sessies → hlms_student.calls_totaal. `calls` is het veld dat de rest
// van het CRM toont (zie api/onboarding-detail.js); alpha_calls_total is de
// Alpha-specifieke variant en dient als terugval.
function bepaalCallsTotaal(traject) {
  const t = traject || {};
  for (const v of [t.calls, t.alpha_calls_total]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

/** Foutmelding wegschrijven op de onboarding. Best-effort. */
async function schrijfFout(onboardingId, msg) {
  try {
    await supabaseAdmin
      .from('onboardings')
      .update({
        dfo_lms_provisioned    : false,
        dfo_lms_provision_error: String(msg || '').slice(0, 1000),
      })
      .eq('id', onboardingId);
  } catch (e) {
    console.error('[dfo-lms-student] fout-write mislukt:', e?.message || e);
  }
}

/**
 * Zoek de mentor in dfo-lms op e-mailadres.
 *
 * hlms_personeel is klein (11 rijen), dus we halen 'm op en vergelijken in JS
 * op lower(email). Bewust GEEN .ilike(): in een LIKE-patroon zijn `_` en `%`
 * jokertekens en `_` is een geldig teken in een e-mailadres — dat zou de
 * verkeerde mentor kunnen matchen.
 *
 * @returns {Promise<{ id: string|null, reden: string|null }>}
 */
export async function vindDfoLmsMentorId(mentorEmail) {
  const mail = String(mentorEmail || '').trim().toLowerCase();
  if (!mail) return { id: null, reden: 'mentor-zonder-email' };

  const lms = getDfoLmsClient();
  if (!lms) return { id: null, reden: 'dfo-lms-niet-geconfigureerd' };

  const { data, error } = await lms
    .from('hlms_personeel')
    .select('id, email, actief');
  if (error) {
    console.warn('[dfo-lms-student] hlms_personeel ophalen:', error.message);
    return { id: null, reden: 'personeel-fetch-fout' };
  }

  const treffers = (data || []).filter(
    (r) => String(r?.email || '').trim().toLowerCase() === mail && r?.actief !== false
  );
  if (treffers.length === 1) return { id: treffers[0].id, reden: null };
  if (treffers.length === 0) return { id: null, reden: 'geen-lms-mentor-voor-' + mail };

  // Kan niet bij een correcte dataset, maar gokken doen we nooit.
  console.warn('[dfo-lms-student] meerdere mentors met e-mail', mail, '— mentor_id leeg gelaten');
  return { id: null, reden: 'meerdere-lms-mentors' };
}

/** E-mailadres van de CRM-mentor ophalen (team_members). */
async function haalMentorEmail(mentorUserId) {
  if (!mentorUserId) return null;
  const { data, error } = await supabaseAdmin
    .from('team_members')
    .select('user_id, email, is_active')
    .eq('user_id', mentorUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    console.warn('[dfo-lms-student] team_members ophalen:', error.message);
    return null;
  }
  return data?.email ? String(data.email).trim().toLowerCase() : null;
}

/**
 * Zoek een bestaande studentrij. Eerst op de onboarding-verwijzing, dan op
 * e-mail (hoofdletterongevoelig, met exacte na-controle in JS).
 *
 * @returns {Promise<{ rij: object|null, via: 'onboarding'|'email'|null }>}
 */
async function zoekBestaandeStudent(lms, { onboardingId, email }) {
  {
    const { data, error } = await lms
      .from('hlms_student')
      .select('id, email, crm_onboarding_id, mentor_id')
      .eq('crm_onboarding_id', onboardingId)
      .maybeSingle();
    if (error) throw new Error('hlms_student zoeken op onboarding: ' + error.message);
    if (data) return { rij: data, via: 'onboarding' };
  }

  // `%` en `_` in het patroon zouden te veel matchen; we filteren daarom
  // achteraf op exacte lower()-gelijkheid. Door de unieke index op
  // lower(email) blijft er daarna hooguit één over.
  const { data, error } = await lms
    .from('hlms_student')
    .select('id, email, crm_onboarding_id, mentor_id')
    .ilike('email', email);
  if (error) throw new Error('hlms_student zoeken op e-mail: ' + error.message);

  const exact = (data || []).filter(
    (r) => String(r?.email || '').trim().toLowerCase() === email
  );
  if (exact.length === 1) return { rij: exact[0], via: 'email' };
  if (exact.length > 1) throw new Error('meerdere studentrijen met e-mail ' + email);
  return { rij: null, via: null };
}

/** dfo_lms_student_id + vlaggen wegschrijven op de onboarding. */
async function markeerGekoppeld(onboardingId, studentId) {
  const { error } = await supabaseAdmin
    .from('onboardings')
    .update({
      dfo_lms_student_id     : studentId,
      dfo_lms_provisioned    : true,
      dfo_lms_provisioned_at : new Date().toISOString(),
      dfo_lms_provision_error: null,
    })
    .eq('id', onboardingId);
  if (error) throw new Error('onboardings bijwerken: ' + error.message);
}

/**
 * Maak (of hergebruik) de studentrij in dfo-lms voor deze onboarding.
 *
 * Fail-soft: gooit nooit door naar de aanroeper. Bij een fout blijft
 * dfo_lms_provisioned false en staat de reden in dfo_lms_provision_error,
 * zodat een mislukking zichtbaar is en niet stil.
 *
 * @param {string} onboardingId
 * @returns {Promise<{ok:boolean, skipped?:boolean, created?:boolean,
 *   adopted?:boolean, student_id?:string, mentor_id?:string|null,
 *   mentor_warning?:string|null, reason?:string, error?:string}>}
 */
export async function provisionDfoLmsStudent(onboardingId) {
  if (!onboardingId || typeof onboardingId !== 'string') {
    return { ok: false, error: 'onboardingId ontbreekt' };
  }

  const lms = getDfoLmsClient();
  if (!lms) {
    // Geen fout op de onboarding schrijven: dit is een configuratie-
    // toestand van de omgeving, geen mislukking van deze klant.
    return { ok: false, skipped: true, reason: 'dfo-lms-niet-geconfigureerd' };
  }

  // 1) Onboarding laden.
  let onboarding;
  try {
    const { data, error } = await supabaseAdmin
      .from('onboardings')
      .select(CRM_KOLOMMEN)
      .eq('id', onboardingId)
      .maybeSingle();
    if (error) {
      if (/dfo_lms_/i.test(error.message || '')) {
        const msg = 'Migratie niet gedraaid: de dfo_lms_-kolommen ontbreken op onboardings';
        console.error('[dfo-lms-student] ' + msg);
        return { ok: false, error: msg };
      }
      throw error;
    }
    if (!data) return { ok: false, error: 'Onboarding niet gevonden' };
    onboarding = data;
  } catch (e) {
    const msg = 'onboarding ophalen: ' + (e?.message || e);
    console.error('[dfo-lms-student]', msg);
    return { ok: false, error: msg };
  }

  // 2) Al gekoppeld → niets doen. Goedkoopste idempotentie-laag.
  if (onboarding.dfo_lms_provisioned === true && onboarding.dfo_lms_student_id) {
    return { ok: true, skipped: true, student_id: onboarding.dfo_lms_student_id };
  }

  // 3) Klant + traject.
  let customer, traject;
  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, email, phone')
      .eq('id', onboarding.customer_id)
      .maybeSingle();
    if (error) throw new Error('customers: ' + error.message);
    customer = data;

    const t = await supabaseAdmin
      .from('onboarding_trajecten')
      .select('id, key, type, label, duur_maanden, calls, alpha_calls_total')
      .eq('id', onboarding.traject_id)
      .maybeSingle();
    if (t.error) throw new Error('onboarding_trajecten: ' + t.error.message);
    traject = t.data;
  } catch (e) {
    const msg = (e?.message || String(e));
    console.error('[dfo-lms-student]', msg);
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }

  const email = String(customer?.email || '').trim().toLowerCase();
  if (!email) {
    const msg = 'Klant zonder e-mail — kan geen studentrij in dfo-lms aanmaken';
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }
  if (!traject) {
    const msg = 'Traject niet gevonden voor onboarding';
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }

  // 4) Mentor opzoeken. Nooit blokkerend: geen match → leeg laten + melden.
  let mentorId = null;
  let mentorWarning = null;
  if (onboarding.mentor_user_id) {
    const mentorEmail = await haalMentorEmail(onboarding.mentor_user_id);
    const res = await vindDfoLmsMentorId(mentorEmail);
    mentorId = res.id;
    if (!mentorId) {
      mentorWarning = res.reden;
      console.warn('[dfo-lms-student] mentor niet gekoppeld:', res.reden);
    }
  }

  const { startIso, eindIso } = berekenLmsVenster({
    startDate:   onboarding.start_date,
    duurMaanden: traject.duur_maanden,
  });

  try {
    // 5) Zoeken vóór schrijven.
    const { rij, via } = await zoekBestaandeStudent(lms, { onboardingId, email });

    if (rij) {
      // Bestaat al. Hoort 'ie bij een ANDERE onboarding, dan kapen we 'm niet.
      if (rij.crm_onboarding_id && rij.crm_onboarding_id !== onboardingId) {
        const msg = 'Student met dit e-mailadres hangt al aan onboarding '
          + rij.crm_onboarding_id + ' — handmatig nakijken';
        await schrijfFout(onboardingId, msg);
        return { ok: false, error: msg };
      }

      // Draad vastknopen aan de LMS-kant + mentor invullen als die daar
      // nog leeg is. Een mentor die daar al staat overschrijven we niet:
      // die kan met opzet in het LMS gezet zijn.
      const patch = {};
      if (!rij.crm_onboarding_id) patch.crm_onboarding_id = onboardingId;
      if (mentorId && !rij.mentor_id) patch.mentor_id = mentorId;
      if (Object.keys(patch).length > 0) {
        const { error } = await lms.from('hlms_student').update(patch).eq('id', rij.id);
        if (error) throw new Error('hlms_student bijwerken: ' + error.message);
      }

      await markeerGekoppeld(onboardingId, rij.id);
      return {
        ok: true, adopted: true, student_id: rij.id,
        mentor_id: mentorId, mentor_warning: mentorWarning,
        reason: 'bestond-al-via-' + via,
      };
    }

    // 6) Aanmaken.
    const nieuw = {
      voornaam         : String(customer.first_name || '').trim() || null,
      achternaam       : String(customer.last_name  || '').trim() || null,
      email,
      telefoon         : String(customer.phone || '').trim() || null,
      product_soort    : bepaalProductSoort(traject),
      traject_maanden  : Number.isFinite(Number(traject.duur_maanden))
        ? Number(traject.duur_maanden) : null,
      start_datum      : startIso,
      eind_datum       : eindIso,
      calls_totaal     : bepaalCallsTotaal(traject),
      mentor_id        : mentorId,
      crm_onboarding_id: onboardingId,
    };

    const { data: gemaakt, error: insErr } = await lms
      .from('hlms_student')
      .insert(nieuw)
      .select('id')
      .single();

    if (insErr) {
      // Databank-vangnet: iemand was ons voor (of de rij bestond toch al).
      // Dat is GEEN mislukking — opnieuw zoeken en die rij overnemen.
      if (isUniqueViolation(insErr)) {
        console.warn('[dfo-lms-student] unieke index sloeg aan — bestaande rij overnemen');
        const opnieuw = await zoekBestaandeStudent(lms, { onboardingId, email });
        if (opnieuw.rij) {
          if (!opnieuw.rij.crm_onboarding_id) {
            await lms.from('hlms_student')
              .update({ crm_onboarding_id: onboardingId })
              .eq('id', opnieuw.rij.id);
          }
          await markeerGekoppeld(onboardingId, opnieuw.rij.id);
          return {
            ok: true, adopted: true, student_id: opnieuw.rij.id,
            mentor_id: mentorId, mentor_warning: mentorWarning,
            reason: 'race-opgevangen',
          };
        }
      }
      throw new Error('hlms_student aanmaken: ' + insErr.message);
    }

    await markeerGekoppeld(onboardingId, gemaakt.id);
    return {
      ok: true, created: true, student_id: gemaakt.id,
      mentor_id: mentorId, mentor_warning: mentorWarning,
    };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[dfo-lms-student]', msg);
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Mentorwijziging doorschrijven naar dfo-lms. Aangeroepen vanuit
 * api/onboarding-assign-mentor.js NADAT het CRM is bijgewerkt.
 *
 * Fail-soft en niet-blokkerend: de toewijzing in het CRM staat al. Doet
 * niets wanneer de onboarding nog geen studentrij in dfo-lms heeft — die
 * krijgt de mentor vanzelf mee zodra hij aangemaakt wordt.
 *
 * @param {string} onboardingId
 * @param {string|null} mentorUserId  null = ontkoppelen
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string,
 *   mentor_id?:string|null, error?:string}>}
 */
export async function syncDfoLmsMentor(onboardingId, mentorUserId) {
  const lms = getDfoLmsClient();
  if (!lms) return { ok: false, skipped: true, reason: 'dfo-lms-niet-geconfigureerd' };

  try {
    const { data: ob, error } = await supabaseAdmin
      .from('onboardings')
      .select('id, dfo_lms_student_id')
      .eq('id', onboardingId)
      .maybeSingle();
    if (error) {
      if (/dfo_lms_/i.test(error.message || '')) {
        return { ok: false, skipped: true, reason: 'migratie-niet-gedraaid' };
      }
      throw error;
    }
    if (!ob?.dfo_lms_student_id) {
      return { ok: false, skipped: true, reason: 'nog-geen-lms-student' };
    }

    let mentorId = null;
    if (mentorUserId) {
      const mentorEmail = await haalMentorEmail(mentorUserId);
      const res = await vindDfoLmsMentorId(mentorEmail);
      mentorId = res.id;
      if (!mentorId) {
        // Geen match: dan liever de bestaande mentor in het LMS laten staan
        // dan hem wissen op grond van een mislukte vertaling.
        return { ok: false, skipped: true, reason: res.reden };
      }
    }

    const { error: updErr } = await lms
      .from('hlms_student')
      .update({ mentor_id: mentorId })
      .eq('id', ob.dfo_lms_student_id);
    if (updErr) throw new Error('hlms_student mentor bijwerken: ' + updErr.message);

    return { ok: true, mentor_id: mentorId };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[dfo-lms-student] mentor-sync:', msg);
    return { ok: false, error: msg };
  }
}
