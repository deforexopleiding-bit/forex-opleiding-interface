// api/follow-up-outcomes.js
//
// GET  ?appointment_id=<uuid> → bestaande outcome of null (200)
// POST body: { appointment_id, outcome, bezwaren: string[], warmte_score: 1-10,
//              terugkom_datum: 'YYYY-MM-DD', terugkom_datetime: ISO8601,
//              volgende_actie: string, notitie: string,
//              follow_up_type: 'geen'|'intern'|'agenda',
//              follow_up_datetime: 'YYYY-MM-DDTHH:MM:SS' (Amsterdam local, geen Z),
//              follow_up_duration_minutes: integer (default 30) }
//      → UPSERT (onConflict: appointment_id); side-effect: update appointment status.
//        Als follow_up_type='agenda'/'intern': maak child appointment row aan.
//        type='agenda': update ook GHL + Zoom naar nieuwe tijd (validate-first).

import { createUserClient } from './supabase.js';
import { addGhlTags, tagsFromOutcome } from './ghl-tag-helper.js';
import { updateZoomMeetingTime } from './_lib/zoom-meeting.js';
import { updateGhlAppointmentTime } from './_lib/ghl-appointment.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);

const OUTCOME_TO_STATUS = {
  klant_geworden:    'completed',
  geen_klant:        'completed',
  no_show:           'no_show',
  niet_bereikt:      'no_show',
  interesse_uitstel: 'completed',
  interesse_overleg: 'completed',
  geen_interesse:    'completed',
  niet_geschikt:     'completed',
  wil_niet_meer:     'cancelled',
};

const VALID_OUTCOMES = [
  'klant_geworden', 'geen_klant', 'no_show',
  'niet_bereikt', 'interesse_uitstel', 'interesse_overleg',
  'geen_interesse', 'niet_geschikt', 'wil_niet_meer',
];
const VALID_VOLGENDE_ACTIES = ['bellen', 'email', 'event', 'sluiten', 'niet_meer_opvolgen'];
const VALID_FOLLOW_UP_TYPES = ['geen', 'intern', 'agenda'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  // ── GET: haal bestaande outcome op voor pre-fill modal ───────────────────
  if (req.method === 'GET') {
    const { appointment_id } = req.query;
    if (!appointment_id) {
      return res.status(400).json({ error: 'appointment_id vereist' });
    }
    const { data, error } = await supabase
      .from('follow_up_outcomes')
      .select('*')
      .eq('appointment_id', appointment_id)
      .maybeSingle();
    if (error) {
      console.error('[outcomes-get] error:', error.message);
      return res.status(500).json({ error: error.message });
    }
    // 200 + null bij geen rij — voorkomt console-noise op "new outcome" flows
    return res.status(200).json(data || null);
  }

  const body = req.body || {};
  const { appointment_id, outcome } = body;

  if (!appointment_id || typeof appointment_id !== 'string') {
    return res.status(400).json({ error: 'appointment_id ontbreekt of ongeldig.' });
  }
  if (!VALID_OUTCOMES.includes(outcome)) {
    return res.status(400).json({ error: `outcome moet één van: ${VALID_OUTCOMES.join(', ')}` });
  }

  // ── Valideer follow_up velden ─────────────────────────────────────────────
  const followUpType = body.follow_up_type || null;
  const followUpDurationMin = Number.isInteger(body.follow_up_duration_minutes) && body.follow_up_duration_minutes > 0
    ? body.follow_up_duration_minutes
    : 30;

  if (followUpType && !VALID_FOLLOW_UP_TYPES.includes(followUpType)) {
    return res.status(400).json({ error: 'follow_up_type moet geen, intern of agenda zijn.' });
  }
  if (followUpType && followUpType !== 'geen' && !body.follow_up_datetime) {
    return res.status(400).json({ error: 'follow_up_datetime vereist bij follow_up_type intern of agenda.' });
  }

  // Parse follow_up_datetime: Amsterdam-local → UTC (zelfde patroon als verplaats-call)
  let followUpStartISO = null;
  let followUpEndISO = null;
  if (followUpType && followUpType !== 'geen' && body.follow_up_datetime) {
    const followUpDt = dayjs.tz(body.follow_up_datetime, 'Europe/Amsterdam').utc();
    followUpStartISO = followUpDt.toISOString();
    followUpEndISO = followUpDt.add(followUpDurationMin, 'minute').toISOString();
  }

  // terugkom_datetime: frontend stuurt al UTC ISO (browser doet locale→UTC);
  // dayjs voor consistente validatie ipv Date.parse
  const terugkomDt = body.terugkom_datetime && dayjs(body.terugkom_datetime).isValid()
    ? dayjs(body.terugkom_datetime).toISOString()
    : null;
  const terugkomDatum = body.terugkom_datum && /^\d{4}-\d{2}-\d{2}$/.test(body.terugkom_datum)
    ? body.terugkom_datum
    : (terugkomDt ? terugkomDt.slice(0, 10) : null);

  // ── Fetch parent appointment (vroeg — voor validate-first + child-insert + tags) ──
  const { data: parentAppt, error: apptErr } = await supabase
    .from('follow_up_appointments')
    .select('id, ghl_appointment_id, zoom_meeting_id, zoom_join_url, lead_name, lead_email, lead_phone, lead_ghl_contact_id, owner_id, duration_minutes')
    .eq('id', appointment_id)
    .maybeSingle();

  if (apptErr || !parentAppt) {
    return res.status(404).json({ error: 'Appointment niet gevonden.' });
  }

  // ── Guard: sla follow-up aanmaken over als al een scheduled child bestaat (A1 edit-gedrag) ──
  let skipFollowUp = false;
  if (followUpType && followUpType !== 'geen') {
    const { data: existingChild } = await supabase
      .from('follow_up_appointments')
      .select('id')
      .eq('parent_appointment_id', appointment_id)
      .eq('status', 'scheduled')
      .maybeSingle();

    if (existingChild) {
      console.log('[outcomes-post] child-row bestaat al, follow-up stap overgeslagen:', existingChild.id);
      skipFollowUp = true;
    }
  }

  // ── Validate-first: GHL update — blocking (faal → 422, geen DB-mutaties) ──
  let ghlResult = null;
  if (!skipFollowUp && followUpType === 'agenda' && parentAppt.ghl_appointment_id) {
    try {
      ghlResult = await updateGhlAppointmentTime(
        parentAppt.ghl_appointment_id,
        followUpStartISO,
        followUpEndISO
      );
    } catch (ghlErr) {
      console.error('[outcomes-post] GHL update failed:', ghlErr?.message, ghlErr);
      const ghlStatus = ghlErr?.ghlStatus || 500;
      const ghlBody = ghlErr?.ghlBody || '';
      return res.status(422).json({
        error: mapGhlError(ghlStatus, ghlBody),
        ghl_status: ghlStatus,
      });
    }
  }

  // ── Zoom update — best-effort (faal blokkeert niet) ──────────────────────
  let zoomResult = null;
  if (!skipFollowUp && followUpType === 'agenda' && parentAppt.zoom_meeting_id) {
    try {
      zoomResult = await updateZoomMeetingTime(
        parentAppt.zoom_meeting_id,
        followUpStartISO,
        followUpDurationMin
      );
    } catch (zoomErr) {
      console.error('[outcomes-post] Zoom update failed (best-effort):', zoomErr?.message, zoomErr);
      // Niet blokkerend
    }
  }

  // ── Outcome upsert ────────────────────────────────────────────────────────
  const outcomeRow = {
    appointment_id,
    outcome,
    bezwaren: Array.isArray(body.bezwaren) ? body.bezwaren : null,
    volgende_actie: VALID_VOLGENDE_ACTIES.includes(body.volgende_actie) ? body.volgende_actie : null,
    terugkom_datum: terugkomDatum,
    terugkom_datetime: terugkomDt,
    warmte_score: Number.isInteger(body.warmte_score) && body.warmte_score >= 1 && body.warmte_score <= 10 ? body.warmte_score : null,
    notitie: typeof body.notitie === 'string' && body.notitie.length > 0 ? body.notitie : null,
    opvolging_status: terugkomDatum ? 'gepland' : null,
    niet_meer_opvolgen: body.volgende_actie === 'niet_meer_opvolgen',
    ingevuld_door: user.id,
    ingevuld_at: new Date().toISOString(),
  };

  const { data: outcomeData, error: outcomeErr } = await supabase
    .from('follow_up_outcomes')
    .upsert(outcomeRow, { onConflict: 'appointment_id', ignoreDuplicates: false })
    .select('id')
    .single();

  if (outcomeErr) {
    console.error('[outcomes-upsert] error:', outcomeErr.message);
    return res.status(500).json({ error: outcomeErr.message });
  }

  // ── Parent appointment status update ─────────────────────────────────────
  const newStatus = OUTCOME_TO_STATUS[outcome];
  const { error: updateErr } = await supabase
    .from('follow_up_appointments')
    .update({ status: newStatus })
    .eq('id', appointment_id);

  if (updateErr) {
    console.error('[outcomes-post] status update error:', updateErr.message);
    return res.status(500).json({ error: 'Outcome saved but status update failed: ' + updateErr.message });
  }

  // ── Child appointment INSERT (follow-up row) ──────────────────────────────
  let newAppt = null;
  if (!skipFollowUp && followUpType && followUpType !== 'geen') {
    const childRow = {
      parent_appointment_id: appointment_id,
      lead_name:            parentAppt.lead_name,
      lead_email:           parentAppt.lead_email,
      lead_phone:           parentAppt.lead_phone,
      lead_ghl_contact_id:  parentAppt.lead_ghl_contact_id,
      scheduled_at:         followUpStartISO,
      duration_minutes:     followUpDurationMin,
      status:               'scheduled',
      voicememo_status:     'pending',
      owner_id:             parentAppt.owner_id,
      // Agenda: hergebruik GHL + Zoom van parent; intern: null
      ghl_appointment_id: followUpType === 'agenda' ? parentAppt.ghl_appointment_id : null,
      zoom_meeting_id:    followUpType === 'agenda' ? parentAppt.zoom_meeting_id : null,
      zoom_join_url:      followUpType === 'agenda' ? parentAppt.zoom_join_url : null,
    };

    const { data: insertedAppt, error: insertErr } = await supabase
      .from('follow_up_appointments')
      .insert(childRow)
      .select('id, scheduled_at, status')
      .single();

    if (insertErr) {
      console.error('[outcomes-post] child insert error:', insertErr.message, 'appointment:', appointment_id);
      // Outcome is al opgeslagen — niet aborteren voor child-insert failure
    } else {
      newAppt = insertedAppt;
    }
  }

  // ── GHL tags (best-effort) ────────────────────────────────────────────────
  let tagResult = null;
  if (parentAppt.lead_ghl_contact_id) {
    const tagsToAdd = tagsFromOutcome({
      outcome,
      bezwaren: outcomeRow.bezwaren,
    });

    if (tagsToAdd.length > 0) {
      try {
        tagResult = await addGhlTags(parentAppt.lead_ghl_contact_id, tagsToAdd, {
          source: 'outcome-save',
          appointment_id,
          outcome,
          owner_id: parentAppt.owner_id,
        });
      } catch (err) {
        console.error('[outcomes-post] tag-call exception:', err.message);
        // Niet blokkerend
      }
    }
  }

  return res.status(200).json({
    outcome_id: outcomeData.id,
    appointment_id,
    new_status: newStatus,
    follow_up_appointment: newAppt ? { id: newAppt.id, scheduled_at: newAppt.scheduled_at } : null,
    zoom_updated: !!zoomResult,
    ghl_updated: !!ghlResult,
    tags: tagResult ? { added: tagResult.tagsAdded, errors: tagResult.errors } : null,
  });
}

function mapGhlError(status, body) {
  if (status === 400) {
    if (body.includes('slot') || body.includes('available')) {
      return 'Slot niet beschikbaar in Dave\'s GHL-kalender (mogelijk weekend, buiten werktijd, of conflict)';
    }
    return `Ongeldige aanvraag bij GHL: ${body.slice(0, 120)}`;
  }
  if (status === 401) return 'Geen GHL-toegang (token-issue) — neem contact op met beheerder';
  if (status === 404) return 'Afspraak bestaat niet meer in GHL';
  if (status >= 500) return 'GHL is tijdelijk niet beschikbaar — probeer het over enkele minuten opnieuw';
  return `GHL-fout ${status}: ${body.slice(0, 120)}`;
}
