// api/assessment-register.js
// PUBLIEKE POST-endpoint: koppelt een (al ingediende) assessment aan een
// gekozen open event. 1:N model - 1 assessment kan meerdere event-
// inschrijvingen dragen, max 1 per event (UNIQUE-guard in DB).
//
// Geen auth (deelnemer is niet ingelogd).
//
// Body (JSON):
//   {
//     assessment_response_id: uuid,
//     event_id              : uuid
//   }
//
// Flow:
//   1. Validate IDs (uuid-format).
//   2. Fetch assessment_response (status, routing_result, voornaam, achternaam, email).
//   3. Fetch event (status, signups_closed, niveau, capacity, webflow_item_id).
//   4. Gates:
//      - event status = 'published' anders 409 EVENT_NOT_OPEN.
//      - event signups_closed = false anders 409 EVENT_CLOSED.
//      - routing_result valid + niveau match anders 409 NIVEAU_MISMATCH.
//      - assessment.routing_result == 'incomplete' -> 409 ASSESSMENT_INCOMPLETE.
//   5. Insert event_attendees met:
//      - event_id, assessment_response_id
//      - first_name/last_name/email uit assessment_response
//      - status='aangemeld' (F1-enum; spec sprak van 'confirmed' - mapping
//        gedocumenteerd in mini-migratie)
//      - created_via='assessment'
//      Dubbel via partial UNIQUE (event_id, assessment_response_id) -> 409.
//   6. Side-effects (best-effort, fail = log + continue):
//      - getConfirmedCount(event_id)
//      - syncGastenlijstWebflow(event, count) - PATCH /live met "X / Y" of "X"
//      - autoCloseIfFull(event, count) - DB-flip + closeSignupsOutbound
//
// Response 200: { ok, attendee_id, confirmed_count, capacity,
//                 gastenlijst_label, auto_closed }
// Response 400: validation errors
// Response 405: POST only
// Response 409: gates falen (EVENT_NOT_OPEN | EVENT_CLOSED | NIVEAU_MISMATCH
//               | ASSESSMENT_INCOMPLETE | DUPLICATE)
// Response 500: database-fout

import { supabaseAdmin } from './supabase.js';
import { UUID_RE } from './_lib/assessment-validation.js';
import {
  isNiveauMatch,
  getConfirmedCount,
  syncGastenlijstWebflow,
  autoCloseIfFull,
} from './_lib/event-registration.js';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt.' });

  const arId = typeof body.assessment_response_id === 'string'
    ? body.assessment_response_id.trim() : null;
  const evId = typeof body.event_id === 'string'
    ? body.event_id.trim() : null;

  if (!arId || !UUID_RE.test(arId)) {
    return res.status(400).json({ error: 'assessment_response_id (uuid) vereist.' });
  }
  if (!evId || !UUID_RE.test(evId)) {
    return res.status(400).json({ error: 'event_id (uuid) vereist.' });
  }

  // ── 1) Assessment ophalen ─────────────────────────────────────────────
  let assessment;
  try {
    const { data, error } = await supabaseAdmin
      .from('assessment_responses')
      .select('id, status, routing_result, first_name, last_name, email')
      .eq('id', arId)
      .maybeSingle();
    if (error) throw new Error('assessment fetch: ' + error.message);
    if (!data)  return res.status(404).json({ error: 'Assessment niet gevonden.', code: 'ASSESSMENT_NOT_FOUND' });
    assessment = data;
  } catch (e) {
    console.error('[assessment-register] assessment fetch', e.message);
    return res.status(500).json({ error: e.message });
  }

  if (assessment.routing_result === 'incomplete' || !assessment.routing_result) {
    return res.status(409).json({
      error: 'Assessment is niet volledig gescoord.',
      code : 'ASSESSMENT_INCOMPLETE',
    });
  }

  // ── 2) Event ophalen ──────────────────────────────────────────────────
  let event;
  try {
    const { data, error } = await supabaseAdmin
      .from('events')
      .select('id, title, status, signups_closed, niveau, capacity, webflow_item_id, starts_at')
      .eq('id', evId)
      .maybeSingle();
    if (error) throw new Error('event fetch: ' + error.message);
    if (!data)  return res.status(404).json({ error: 'Event niet gevonden.', code: 'EVENT_NOT_FOUND' });
    event = data;
  } catch (e) {
    console.error('[assessment-register] event fetch', e.message);
    return res.status(500).json({ error: e.message });
  }

  // ── 3) Gates ──────────────────────────────────────────────────────────
  if (event.status !== 'published') {
    return res.status(409).json({
      error: 'Event is niet open voor inschrijving.',
      code : 'EVENT_NOT_OPEN',
    });
  }
  if (event.signups_closed === true) {
    return res.status(409).json({
      error: 'Inschrijvingen zijn gesloten voor dit event.',
      code : 'EVENT_CLOSED',
    });
  }
  if (!isNiveauMatch(assessment.routing_result, event.niveau)) {
    return res.status(409).json({
      error: `Niveau van event komt niet overeen met jouw resultaat (${assessment.routing_result} vs ${event.niveau}).`,
      code : 'NIVEAU_MISMATCH',
    });
  }

  // ── 4) Insert event_attendees ─────────────────────────────────────────
  //
  // Fase 2c robustness: bij 23505 op (event_id, lower(email)) kan de
  // conflict-rij een signup-first attendee zijn (assessment_response_id
  // IS NULL). In dat geval doen we recovery-UPDATE i.p.v. 409 — die rij
  // krijgt nu de assessment + naam-velden uit assessment_responses, telt
  // vanaf nu mee voor capaciteit. Andere conflict-state (al gekoppeld
  // aan een andere assessment) blijft 409 DUPLICATE.
  let attendeeId;
  try {
    const { data: row, error } = await supabaseAdmin
      .from('event_attendees')
      .insert({
        event_id              : event.id,
        assessment_response_id: assessment.id,
        first_name            : assessment.first_name,
        last_name             : assessment.last_name,
        email                 : assessment.email,
        status                : 'aangemeld',
        created_via           : 'assessment',
        registered_at         : new Date().toISOString(),
      })
      .select('id')
      .maybeSingle();
    if (error) {
      // PG-23505 = unique_violation. Recovery-pad voor signup-first attendees.
      if (error.code === '23505' || /duplicate key/i.test(error.message || '')) {
        // Zoek de conflicterende rij via (event_id, lower(email)). Gevoeligheid
        // op email is via de partial UNIQUE index op lower(email); we matchen
        // hier in code dezelfde semantiek via ilike.
        let existing = null;
        try {
          if (assessment.email) {
            const { data: existingRow } = await supabaseAdmin
              .from('event_attendees')
              .select('id, assessment_response_id')
              .eq('event_id', event.id)
              .ilike('email', assessment.email)
              .maybeSingle();
            existing = existingRow;
          }
        } catch (e2) {
          console.error('[assessment-register] conflict lookup:', e2?.message || e2);
        }
        // Signup-first recovery: existing rij heeft geen assessment → UPDATE.
        if (existing && existing.assessment_response_id == null) {
          const { error: updErr } = await supabaseAdmin
            .from('event_attendees')
            .update({
              assessment_response_id: assessment.id,
              first_name            : assessment.first_name,
              last_name             : assessment.last_name,
            })
            .eq('id', existing.id);
          if (updErr) {
            console.error('[assessment-register] signup-first link update:', updErr.message);
            return res.status(500).json({ error: 'Inschrijving kon niet worden opgeslagen.' });
          }
          attendeeId = existing.id;
          // Doorvallen naar side-effects hieronder zodat de rij die nu
          // meetelt direct in de gastenlijst en eventueel auto-vol komt.
        } else {
          // Andere conflicten (al gekoppeld aan andere assessment, of
          // conflicting rij niet vindbaar): blijf 409 DUPLICATE.
          return res.status(409).json({
            error: 'Je bent al ingeschreven voor dit event.',
            code : 'DUPLICATE',
          });
        }
      } else {
        throw new Error('attendee insert: ' + error.message);
      }
    } else {
      if (!row) throw new Error('attendee insert returnde geen rij.');
      attendeeId = row.id;
    }
  } catch (e) {
    console.error('[assessment-register] insert', e.message);
    return res.status(500).json({ error: 'Inschrijving kon niet worden opgeslagen.' });
  }

  // ── 5) Side-effects (best-effort) ─────────────────────────────────────
  const confirmedCount = await getConfirmedCount(event.id);
  const gastenlijst    = await syncGastenlijstWebflow(event, confirmedCount);
  const autoClose      = await autoCloseIfFull(event, confirmedCount);

  return res.status(200).json({
    ok               : true,
    attendee_id      : attendeeId,
    event_id         : event.id,
    confirmed_count  : confirmedCount,
    capacity         : event.capacity,
    gastenlijst_label: gastenlijst.label || null,
    gastenlijst_sync : gastenlijst.ok && !gastenlijst.skipped ? 'updated' : (gastenlijst.skipped ? 'skipped' : 'failed'),
    auto_closed      : !!autoClose.auto_closed,
  });
}
