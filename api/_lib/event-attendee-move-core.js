// api/_lib/event-attendee-move-core.js
//
// DE VERPLAATSING ZELF, LOS VAN HET ENDPOINT.
//
// ── WAAROM DIT BESTAAT ───────────────────────────────────────────────────
// Een deelnemer naar een ander event verplaatsen is meer dan één update. Het
// is een nieuwe rij op het doel-event, een capaciteitscheck, een
// e-mailduplicaatcheck, tags overnemen, de bronrij op
// 'switched_to_other_event' zetten, twee audit-regels, en de cascade die een
// vol event weer opent. Elk van die stappen heeft een reden en een valkuil, en
// die staan hieronder bij de stap zelf.
//
// Sinds de aanmeldkaart in Opvolging ook kan verplaatsen zijn er TWEE ingangen:
// de eventmodule (api/events-attendee-move.js, permission
// events.attendee.create) en de opvolgmodule
// (api/opvolging-aanmelding-actie.js, actie 'verplaats_naar_event', permission
// opvolging.taak.afronden). Twee permissies, één handeling — en die handeling
// mag maar op één plek staan. Een tweede kopie zou binnen een maand een
// capaciteitscheck missen of de audit-regel anders schrijven, en dan verschilt
// het resultaat per knop.
//
// ── HET ANTWOORD IS DATA, GEEN HTTP ──────────────────────────────────────
// Deze functie kent geen `res`. Ze geeft `{ ok, status, body }` terug en de
// aanroeper bepaalt wat daarmee gebeurt. Zo blijft events-attendee-move.js
// naar buiten toe byte-voor-byte hetzelfde, en kan de opvolgmodule dezelfde
// 409 letterlijk doorgeven aan Dave ('Doel-event is vol …') zonder er een
// eigen formulering naast te zetten.
//
// Alleen echte storingen gooien; die vangt de aanroeper als 500.

import { supabaseAdmin } from '../supabase.js';
import { sendEventAttendeeInvite } from './events-invite.js';
import { getConfirmedCount } from './event-registration.js';
import { onConfirmedAttendeeMutation } from './event-attendee-mutations.js';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Een uitkomst die de aanroeper 1-op-1 als HTTP-antwoord kan gebruiken. */
const mislukt = (status, body) => ({ ok: false, status, body });

/**
 * Verplaatst een deelnemer naar een ander event.
 *
 * @param {object} p
 * @param {string} p.attendeeId      bron-deelnemer (uuid)
 * @param {string} p.targetEventId   doel-event (uuid)
 * @param {boolean} [p.sendInvite]   keuze-link sturen op de nieuwe rij
 * @param {?string} [p.userId]       wie de actie doet; gaat de audit-log in
 * @returns {Promise<{ok:boolean,status:number,body:object}>}
 *   ok:true  → status 201, body { source_attendee_id, target_event_id,
 *              new_attendee, tags_copied, invite }
 *   ok:false → status 400/404/409, body { code?, error }
 * @throws bij een echte databankstoring — de aanroeper maakt daar een 500 van.
 */
export async function verplaatsDeelnemer({ attendeeId, targetEventId, sendInvite = false, userId = null }) {
  if (!attendeeId || !UUID_RE.test(String(attendeeId))) {
    return mislukt(400, { error: 'attendee_id (uuid) vereist' });
  }
  if (!targetEventId || !UUID_RE.test(String(targetEventId))) {
    return mislukt(400, { error: 'target_event_id (uuid) vereist' });
  }

  // Bron-attendee.
  const { data: source, error: srcErr } = await supabaseAdmin
    .from('event_attendees')
    .select(`
      id, event_id, first_name, last_name, email, phone, status,
      customer_id, deal_id, assessment_response_id, source, automation_enabled,
      is_test
    `)
    .eq('id', attendeeId)
    .maybeSingle();
  if (srcErr) throw new Error('source-attendee: ' + srcErr.message);
  if (!source) return mislukt(404, { error: 'Deelnemer niet gevonden' });

  if (source.event_id === targetEventId) {
    return mislukt(400, { code: 'SAME_EVENT', error: 'Bron- en doel-event zijn hetzelfde' });
  }

  // Doel-event.
  const { data: targetEvent, error: evErr } = await supabaseAdmin
    .from('events')
    .select('id, capacity, status')
    .eq('id', targetEventId)
    .maybeSingle();
  if (evErr) throw new Error('target-event: ' + evErr.message);
  if (!targetEvent) return mislukt(404, { error: 'Doel-event niet gevonden' });
  if (targetEvent.status === 'archived') {
    return mislukt(409, { code: 'EVENT_ARCHIVED', error: 'Doel-event is gearchiveerd' });
  }

  // Capacity-check op doel-event — telt alleen inschrijvingen die de
  // vragenlijst hebben ingevuld (assessment_response_id IS NOT NULL).
  // Fase 1 canonical semantiek: gebruikt de shared helper getConfirmedCount
  // zodat move/add/list/detail/auto-close allemaal dezelfde regel volgen.
  // Voorheen: inline count met ACTIVE_STATUSES (incl. 'sale') ZONDER
  // assessment-filter → 8 inschrijvingen met 6 vragenlijsten telde als 8
  // → onterecht 'vol'. Nu telt 't als 6 en zijn er nog 2 plekken.
  //
  // Aanvaard overboek-risico: als N late vragenlijsten binnenkomen ná deze
  // move, kan confirmed_count > capacity worden. Bewuste keuze — gebeurt
  // zelden en admin-actie moet niet blokkeren op toekomstige gebeurtenissen.
  const cnt = await getConfirmedCount(targetEventId);
  if (targetEvent.capacity != null && cnt >= targetEvent.capacity) {
    return mislukt(409, { code: 'SEATS_FULL', error: `Doel-event is vol (${cnt}/${targetEvent.capacity} met ingevulde vragenlijst)` });
  }

  const nowIso = new Date().toISOString();

  // INSERT nieuwe rij op doel-event.
  const insertRow = {
    event_id:                targetEventId,
    first_name:              source.first_name,
    last_name:               source.last_name,
    email:                   source.email,
    phone:                   source.phone,
    status:                  'aangemeld',
    customer_id:             source.customer_id,
    deal_id:                 source.deal_id,
    assessment_response_id:  source.assessment_response_id,
    switched_from_event_id:  source.event_id,
    switched_at:             nowIso,
    // Behoud het oorspronkelijke kanaal bij een move zodat de attendee-
    // herkomst niet verloren gaat. Fallback 'manual' want de move-actie
    // zelf gebeurt via admin-UI.
    source:                  source.source || 'manual',
    // Behoud automation-opt-in van de bron-rij. Stilte attendees blijven
    // stil; opt-in attendees krijgen op het nieuwe event hun automation-flow.
    automation_enabled:      source.automation_enabled !== false,
    // EEN PROEFRIJ BLIJFT EEN PROEFRIJ.
    //
    // Dit ontbrak, en dat werd gemeten: een verplaatste testdeelnemer kwam op
    // het doel-event terug als is_test=false — dus als ECHTE aanmelding. Hij
    // telde daarna mee in de capaciteit, in de dagbeelden, in het rapport, en
    // de automations gingen op hem af. Een test die zichzelf in productie
    // verandert is het ergste soort test.
    //
    // `=== true` en niet `!== false`: bestaat de kolom op de bronrij nog niet
    // (undefined), dan is dit een gewone aanmelding en geen proefrij.
    is_test:                 source.is_test === true,
    created_by_user_id:      userId || null,
  };

  const { data: newRow, error: insErr } = await supabaseAdmin
    .from('event_attendees')
    .insert(insertRow)
    .select(`
      id, event_id, first_name, last_name, email, phone, status,
      customer_id, deal_id, subscription_id,
      ghl_contact_id, ghl_form_submission_id, assessment_response_id,
      switched_from_event_id, switched_at,
      is_test,
      registered_at, attended_at, no_show_marked_at, sale_at,
      follow_up_flagged, follow_up_reason,
      created_at, updated_at
    `)
    .single();

  if (insErr) {
    if (insErr.code === '23505') {
      return mislukt(409, { code: 'EMAIL_EXISTS', error: 'Deze email is al aangemeld voor het doel-event' });
    }
    throw new Error('attendee-insert: ' + insErr.message);
  }

  // Tags overnemen (best-effort).
  let tagsCopied = 0;
  try {
    const { data: srcTags, error: tagFetchErr } = await supabaseAdmin
      .from('event_attendee_tags')
      .select('tag_slug, source')
      .eq('attendee_id', source.id);
    if (tagFetchErr) {
      console.error('[event-attendee-move-core tag-fetch]', tagFetchErr.message);
    } else if (srcTags && srcTags.length > 0) {
      const rowsToInsert = srcTags.map((t) => ({
        attendee_id:      newRow.id,
        tag_slug:         t.tag_slug,
        source:           t.source || 'manual',
        added_by_user_id: userId || null,
      }));
      const { error: tagInsErr } = await supabaseAdmin
        .from('event_attendee_tags')
        .insert(rowsToInsert);
      if (tagInsErr) {
        console.error('[event-attendee-move-core tag-insert]', tagInsErr.message);
      } else {
        tagsCopied = rowsToInsert.length;
      }
    }
  } catch (e) {
    console.error('[event-attendee-move-core tag-copy]', e?.message || e);
  }

  // UPDATE bron-attendee: markeer als geswitched + bestemming.
  // switched_to_event_id is nieuw sinds migratie 026 — bij 42703 (kolom
  // ontbreekt) retry zonder die kolom zodat de move-flow niet breekt
  // vóór de migratie draait.
  let updErr = null;
  {
    const richUpdate = {
      status:               'switched_to_other_event',
      switched_at:          nowIso,
      switched_to_event_id: targetEventId,
    };
    const r1 = await supabaseAdmin
      .from('event_attendees')
      .update(richUpdate)
      .eq('id', source.id);
    updErr = r1.error;
    if (updErr && (updErr.code === '42703' || updErr.code === 'PGRST204')) {
      // Kolom ontbreekt → retry zonder switched_to_event_id.
      console.warn('[events-attendee-move] switched_to_event_id kolom ontbreekt — draai migratie 026 voor volledige bestemmings-audit');
      const r2 = await supabaseAdmin
        .from('event_attendees')
        .update({
          status:      'switched_to_other_event',
          switched_at: nowIso,
        })
        .eq('id', source.id);
      updErr = r2.error;
    }
  }
  if (updErr) {
    // Niet fataal; nieuwe rij staat al. Log en ga door.
    console.error('[event-attendee-move-core source-update]', updErr.message);
  }

  // Audit-log entries (fail-soft).
  try {
    await supabaseAdmin.from('event_attendee_audit_log').insert([
      {
        attendee_id:  source.id,
        action:       'moved_out',
        before_state: { event_id: source.event_id, status: source.status },
        after_state:  {
          event_id: source.event_id,
          status:   'switched_to_other_event',
          moved_to_event_id:    targetEventId,
          moved_to_attendee_id: newRow.id,
        },
        by_user_id:   userId || null,
      },
      {
        attendee_id:  newRow.id,
        action:       'moved_in',
        before_state: null,
        after_state:  {
          event_id:               newRow.event_id,
          status:                 newRow.status,
          switched_from_event_id: source.event_id,
          moved_from_attendee_id: source.id,
          tags_copied:            tagsCopied,
        },
        by_user_id:   userId || null,
      },
    ]);
  } catch (e) {
    console.error('[event-attendee-move-core audit]', e?.message || e);
  }

  // Optionele invite-flow (niet-blokkerend).
  let invite = null;
  if (sendInvite) {
    try {
      invite = await sendEventAttendeeInvite({
        attendeeId:   newRow.id,
        sentByUserId: userId || null,
      });
    } catch (e) {
      console.error('[event-attendee-move-core invite]', e?.message || e);
      invite = { ok: false, error: e?.message || 'invite send failed' };
    }
  }

  // Shared helper: target-cascade (recount + gastenlijst + autoClose) +
  // source-cascade (recount + gastenlijst + reopen-check). Voorheen enkel
  // target-autoClose; source-auto-reopen was gemist waardoor een auto_full
  // bron-event dicht bleef ondanks vrijgekomen plek. DB-trigger flipt reeds
  // signups_closed op target bij confirmed rise.
  await onConfirmedAttendeeMutation(
    [targetEventId, source.event_id],
    { reason: 'events-attendee-move' }
  );
  return {
    ok: true, status: 201,
    body: {
      source_attendee_id: source.id,
      target_event_id:    targetEventId,
      new_attendee:       newRow,
      tags_copied:        tagsCopied,
      invite,
    },
  };
}
