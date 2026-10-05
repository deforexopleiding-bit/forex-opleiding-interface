// api/_lib/onboarding-acties.js
//
// DE SCHRIJFACTIES OP EEN ONBOARDING — één uitvoering voor twee ingangen:
//   - de CRM-schermen (gebruikers-JWT + rechten, in de eigen endpoints);
//   - het LMS (Hoofdmentor > Onboarding), via de machine-route
//     api/lms-onboarding-sessie.js met x-dfo-secret.
//
// Verhuisd uit onboarding-assign-mentor.js, admin-onboarding-start-date.js en
// admin-onboarding-note.js (5 oktober 2026) ZONDER gedragswijziging: dezelfde
// controles, dezelfde meldingen aan mentoren, dezelfde spiegel naar het LMS.
// Het CRM blijft de bron; het LMS schrijft hier, nooit rechtstreeks.
//
// ER GAAT NIETS NAAR DE KLANT. Meldingen gaan naar mentoren en management
// (interne bel), de Bubble-koppeling is de interne leeromgeving.
//
// Elke functie geeft { status, body } terug — de endpoints maken daar een
// HTTP-antwoord van. Een onverwachte fout gooit; de aanroeper maakt er 500 van.
//
// `doorUserId` is wie het deed (CRM-gebruiker), of null bij een machine-
// aanroep waarvan de persoon niet in het CRM gevonden is.

import { supabaseAdmin } from '../supabase.js';
import { bubblePatch } from './bubble.js';
import { createNotification } from './notify.js';
import { syncDfoLmsMentor } from './dfo-lms-student.js';
import { spiegelNaActie } from './onboarding-spiegel.js';
import { assertStartDateNotTooEarly } from './onboarding-start-date.js';

function uit(status, body) {
  return { status, body };
}

function fmtDateNL(ymd) {
  if (!ymd) return '—';
  try {
    const d = new Date(ymd + 'T00:00:00Z');
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return ymd; }
}

/** Een mentor toewijzen (uuid van team_members.user_id) of ontkoppelen (null). */
export async function wijsMentorToe({ onboardingId, mentorUserId, doorUserId = null }) {
    // 1) Onboarding-staat valideren. customer_name + huidige mentor_user_id
    // worden óók gelezen — beide nodig voor de reassigned_away-notificatie
    // aan de oude mentor (Fase 3b: zie blok onderaan).
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, status, bubble_user_id, mentor_user_id, customer_name, start_date, traject:onboarding_trajecten(label)')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)  return uit(404, { error: 'Onboarding niet gevonden' });
    if (ob.status === 'gearchiveerd') {
      return uit(409, { error: 'Onboarding is gearchiveerd — eerst herstellen' });
    }

    // 2) Indien set: valideer actieve mentor + haal bubble_user_id.
    let mentorBubbleUserId = null;
    if (mentorUserId) {
      const { data: tm, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, type, is_active, bubble_user_id')
        .eq('user_id', mentorUserId)
        .eq('type', 'mentor')
        .eq('is_active', true)
        .maybeSingle();
      if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
      if (!tm)  return uit(400, { error: 'mentor_user_id is geen actieve mentor' });
      mentorBubbleUserId = typeof tm.bubble_user_id === 'string' && tm.bubble_user_id.trim()
        ? tm.bubble_user_id.trim()
        : null;
    }

    // 3) Update.
    const nowIso = new Date().toISOString();
    const patch = mentorUserId
      ? { mentor_user_id: mentorUserId, assigned_at: nowIso }
      : { mentor_user_id: null,          assigned_at: null   };
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update(patch)
      .eq('id', onboardingId)
      .select('mentor_user_id, assigned_at')
      .single();
    if (updErr) throw new Error('onboarding update: ' + updErr.message);

    // 4) Bubble-side koppelen — alleen als zowel student als mentor een
    // bubble_user_id hebben. Fail-soft: DB-koppeling staat al, een Bubble-
    // fout mag de 200 niet kapot maken; we melden het wel in de response.
    // Ontkoppelen (mentor_user_id=null) doen we hier NIET in Bubble (geen
    // harde eis); een handmatige actie of admin-tool kan dat later opruimen.
    let bubble = null;
    if (mentorUserId && mentorBubbleUserId && ob.bubble_user_id) {
      try {
        await bubblePatch('user', ob.bubble_user_id, { mentor_user: mentorBubbleUserId });
        bubble = { ok: true };
      } catch (e) {
        const msg = (e?.code || '') + ' ' + (e?.message || e);
        console.error('[onboarding-assign-mentor] bubble patch fail:', msg);
        bubble = { ok: false, error: msg.trim() };
      }
    } else if (mentorUserId) {
      // Toelichting in response zodat de admin-UI kan tonen WAAROM Bubble
      // niet bijgewerkt is (bv. mentor heeft geen bubble-koppeling, of de
      // student is nog niet geprovisioned).
      const reasons = [];
      if (!ob.bubble_user_id)     reasons.push('student-niet-geprovisioned');
      if (!mentorBubbleUserId)    reasons.push('mentor-zonder-bubble-koppeling');
      bubble = { ok: false, skipped: true, reason: reasons.join(',') };
    }

    // 4b) dfo-lms — mentor doorschrijven naar hlms_student.mentor_id. Zelfde
    // faalzachte opzet als het Bubble-blok hierboven: de toewijzing in het
    // CRM staat al, dus een LMS-fout mag de 200 niet breken. Doet niets
    // wanneer deze onboarding nog geen studentrij in dfo-lms heeft — die
    // krijgt de mentor vanzelf mee bij het aanmaken.
    let dfoLms = null;
    try {
      dfoLms = await syncDfoLmsMentor(onboardingId, mentorUserId);
    } catch (e) {
      const msg = e?.message || String(e);
      console.error('[onboarding-assign-mentor] dfo-lms mentor-sync fail:', msg);
      dfoLms = { ok: false, error: msg };
    }

    // 5) Fase 3b — reassign-notificaties. ALLEEN wanneer er daadwerkelijk
    // gewisseld is van mentor (oldMentor != nieuwe), én er was een vorige
    // mentor: laat 'm weten dat de student is overgedragen via het unified
    // notifications-systeem. De oude mentor verliest toegang tot de
    // onboarding zelf, maar ziet de melding wél in de sidebar-bel.
    const oldMentor = ob.mentor_user_id || null;
    const newMentor = updated.mentor_user_id || null;
    if (oldMentor && oldMentor !== newMentor) {
      let newMentorName = 'geen mentor';
      if (newMentor) {
        try {
          const { data: newTm } = await supabaseAdmin
            .from('team_members')
            .select('name')
            .eq('user_id', newMentor)
            .maybeSingle();
          if (newTm?.name) newMentorName = newTm.name;
        } catch (e) {
          console.warn('[onboarding-assign-mentor] new mentor name lookup (soft):', e?.message || e);
        }
      }
      const custName = ob.customer_name || 'Een student';
      createNotification({
        toUserId:   oldMentor,
        type:       'onboarding.reassigned_away',
        title:      'Student overgedragen · ' + custName,
        body:       custName + ' is overgedragen aan ' + newMentorName + '.',
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  doorUserId,
      }).catch(() => {});
    }
    if (newMentor && newMentor !== oldMentor) {
      const custName = ob.customer_name || 'Een student';
      // Notify de nieuwe mentor via unified notifications-systeem (fail-soft).
      const trajectLabel = ob.traject?.label || null;
      const startDateNL  = (() => {
        if (typeof ob.start_date !== 'string') return null;
        const m = ob.start_date.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return null;
        return m[3] + '-' + m[2] + '-' + m[1];
      })();
      const bodyParts = [];
      if (trajectLabel) bodyParts.push(trajectLabel);
      if (startDateNL)  bodyParts.push('start ' + startDateNL);
      createNotification({
        toUserId:   newMentor,
        type:       'onboarding.new_student',
        title:      'Nieuwe student · ' + custName,
        body:       bodyParts.length ? bodyParts.join(' · ') : custName,
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  doorUserId,
      }).catch(() => {});
    }

    // Spiegel naar het LMS — faalzacht, na de geslaagde hoofdactie.
    await spiegelNaActie(onboardingId, 'onboarding-assign-mentor');

    return uit(200, {
      ok            : true,
      mentor_user_id: updated.mentor_user_id,
      assigned_at   : updated.assigned_at,
      bubble        : bubble,
      dfo_lms       : dfoLms,
    });
}

/**
 * DE STARTDATUM. Dezelfde ondergrens als altijd: vandaag + 3 (NL-tijd).
 * Geeft 400 met `code: START_DATE_TOO_EARLY` en `min` als het te vroeg is.
 */
export async function zetStartdatumOnboarding({ onboardingId, startDatum, doorUserId = null }) {
    //  DE GRENS STAAT OOK HIER, niet alleen in het endpoint: de machine-route
    //  uit het LMS komt via deze functie binnen en mag hem niet overslaan.
    if (typeof startDatum !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDatum)) {
      return uit(400, { error: 'start_date (YYYY-MM-DD) is verplicht.' });
    }
    const startTooEarly = assertStartDateNotTooEarly(startDatum);
    if (startTooEarly) {
      return uit(400, {
        error: startTooEarly.message,
        code:  startTooEarly.code,
        field: 'start_date',
        min:   startTooEarly.min,
        got:   startTooEarly.got,
      });
    }
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, mentor_user_id, start_date, customer_name')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob)  return uit(404, { error: 'Onboarding niet gevonden.' });

    const { data: upd, error: updErr } = await supabaseAdmin
      .from('onboardings')
      .update({ start_date: startDatum })
      .eq('id', onboardingId)
      .select('start_date')
      .single();
    if (updErr) throw new Error('start_date update: ' + updErr.message);

    const noteText = 'Startdatum gewijzigd naar ' + fmtDateNL(startDatum);
    const { data: tlrow, error: tlErr } = await supabaseAdmin
      .from('onboarding_mentor_updates')
      .insert({
        onboarding_id: onboardingId,
        kind:          'note',
        status:        null,
        note:          noteText,
        created_by:    doorUserId,
      })
      .select('kind, note, created_at, created_by')
      .single();
    if (tlErr) throw new Error('mentor_update insert: ' + tlErr.message);

    // Mentor-notificatie via unified notifications-systeem (fail-soft).
    if (ob.mentor_user_id) {
      createNotification({
        toUserId:   ob.mentor_user_id,
        type:       'onboarding.start_date_changed',
        title:      'Startdatum gewijzigd' + (ob.customer_name ? (' · ' + ob.customer_name) : ''),
        body:       'Nieuwe startdatum: ' + fmtDateNL(startDatum),
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  doorUserId,
      }).catch(() => {});
    }

    // Spiegel naar het LMS — faalzacht, na de geslaagde hoofdactie.
    await spiegelNaActie(onboardingId, 'admin-onboarding-start-date');

    return uit(200, {
      ok:         true,
      start_date: upd.start_date,
      update:     tlrow,
    });
}

/** Een notitie op de tijdlijn, met een melding aan de mentor als die er is. */
export async function schrijfOnboardingNotitie({ onboardingId, note, doorUserId = null }) {
    // 1) Onboarding lookup voor mentor_user_id (mentor-aware notificatie).
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings')
      .select('id, mentor_user_id, customer_name, status')
      .eq('id', onboardingId)
      .maybeSingle();
    if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
    if (!ob) return uit(404, { error: 'Onboarding niet gevonden.' });

    // 2) Schrijf tijdlijn-rij. Bij fout breken we direct — er mag GEEN
    // melding zonder bijbehorende tijdlijn-entry ontstaan.
    const { data: upd, error: upErr } = await supabaseAdmin
      .from('onboarding_mentor_updates')
      .insert({
        onboarding_id: onboardingId,
        kind:          'note',
        status:        null,
        note,
        created_by:    doorUserId,
      })
      .select('kind, note, created_at, created_by')
      .single();
    if (upErr) throw new Error('mentor_update insert: ' + upErr.message);

    // 3) Mentor-notificatie via unified notifications-systeem (fail-soft).
    // Alleen als er een mentor is; geen mentor → alleen tijdlijn-notitie.
    if (ob.mentor_user_id) {
      createNotification({
        toUserId:   ob.mentor_user_id,
        type:       'onboarding.admin_note',
        title:      'Notitie van management' + (ob.customer_name ? (' · ' + ob.customer_name) : ''),
        body:       note,
        linkUrl:    '/modules/mentor-onboarding.html',
        entityType: 'onboarding',
        entityId:   onboardingId,
        createdBy:  doorUserId,
      }).catch(() => {});
    }

    return uit(200, {
      ok:              true,
      update:          upd,
      mentor_notified: !!ob.mentor_user_id,
    });
}

/** De statussen die een mens als startstatus zet (zelfde lijst als de mentor). */
export const STARTSTATUS_HANDMATIG = new Set(['nog_te_benaderen', 'geen_gehoor', 'wil_later', 'wil_niet']);

/**
 * DE STARTSTATUS (onboardings.mentor_intake_status), gezet door het management
 * — tot nu toe kon alleen de toegewezen mentor dat. `null` wist hem: dan valt
 * de afleiding terug op de sessies in het LMS. Een regel op de tijdlijn, en de
 * spiegel daarna. Geen melding aan het management: dat is wie het doet.
 */
export async function zetStartstatus({ onboardingId, status, note = null, doorUserId = null }) {
  if (status !== null && !STARTSTATUS_HANDMATIG.has(status)) {
    return uit(400, { error: 'Ongeldige startstatus. Toegestaan: ' + [...STARTSTATUS_HANDMATIG].join(', ') + ', null' });
  }
  const { data: ob, error: obErr } = await supabaseAdmin
    .from('onboardings')
    .select('id, status')
    .eq('id', onboardingId)
    .maybeSingle();
  if (obErr) throw new Error('onboarding lookup: ' + obErr.message);
  if (!ob) return uit(404, { error: 'Onboarding niet gevonden' });
  if (ob.status === 'gearchiveerd' || ob.status === 'geannuleerd') {
    return uit(409, { error: 'Onboarding is gearchiveerd of geannuleerd' });
  }
  const { error: updErr } = await supabaseAdmin
    .from('onboardings')
    .update({ mentor_intake_status: status })
    .eq('id', onboardingId);
  if (updErr) throw new Error('intake-status update: ' + updErr.message);
  const { error: logErr } = await supabaseAdmin
    .from('onboarding_mentor_updates')
    .insert({
      onboarding_id: onboardingId,
      kind:          'status',
      status:        status,
      note:          note || (status ? null : 'Handmatige status gewist'),
      created_by:    doorUserId,
    });
  if (logErr) throw new Error('mentor_update log insert: ' + logErr.message);
  await spiegelNaActie(onboardingId, 'onboarding-startstatus');
  return uit(200, { ok: true, mentor_intake_status: status });
}
