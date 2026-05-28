// api/follow-up-outcomes.js
//
// GET  ?appointment_id=<uuid> → bestaande outcome of null (200)
// POST body: { appointment_id, outcome, bezwaren: string[], warmte_score: 1-10,
//              terugkom_datum: 'YYYY-MM-DD', terugkom_datetime: ISO8601,
//              volgende_actie: string, notitie: string,
//              follow_up_type: 'geen'|'intern'|'agenda'|'open',
//              follow_up_datetime: 'YYYY-MM-DDTHH:MM:SS' (Amsterdam local, geen Z),
//              follow_up_duration_minutes: integer (default 30) }
//      → UPSERT (onConflict: appointment_id); side-effect: update appointment status.
//        Als follow_up_type='agenda'/'intern': maak child appointment row aan.
//        Als follow_up_type='open': sla alleen terugkom_datum op outcome-rij
//        (opvolging_status='gepland'); geen child appointment of GHL-create.
//        type='agenda': maak NIEUWE GHL appointment voor de vervolg-call
//        (validate-first, blocking). Parent's GHL appointment blijft intact.
//        Zoom-velden komen uit GHL response (defensief); null → poll-cron vult later.
//        type='agenda' zonder lead_ghl_contact_id: fallback naar intern-gedrag.

import { createUserClient } from './supabase.js';
import { addGhlTags, tagsFromOutcome } from './ghl-tag-helper.js';
import { createGhlAppointment } from './_lib/ghl-appointment.js';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
dayjs.extend(utc);
dayjs.extend(timezone);

const OUTCOME_TO_STATUS = {
  klant_geworden:    'completed',
  no_show:           'no_show',
  niet_bereikt:      'no_show',
  interesse_uitstel: 'completed',
  interesse_overleg: 'completed',
  geen_interesse:    'completed',
  niet_geschikt:     'completed',
  wil_niet_meer:     'cancelled',
};

const VALID_OUTCOMES = [
  'klant_geworden', 'no_show',
  'niet_bereikt', 'interesse_uitstel', 'interesse_overleg',
  'geen_interesse', 'niet_geschikt', 'wil_niet_meer',
];
const VALID_VOLGENDE_ACTIES = ['bellen', 'email', 'event', 'sluiten', 'niet_meer_opvolgen', 'onboarding_starten', 'zoom_gesprek'];
const VALID_FOLLOW_UP_TYPES = ['geen', 'intern', 'agenda', 'open'];

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
    if (!data) return res.status(200).json(null);

    // Pre-fill helpers voor modal: bepaal afgeleid follow_up_type + datum.
    //   - klant_geworden: forceer 'geen' (modal toont geen afspraak-blok voor deze flow)
    //   - child met ghl_appointment_id NOT NULL → 'agenda', datum uit child.scheduled_at
    //   - child met ghl_appointment_id NULL    → 'intern', datum uit child.scheduled_at
    //   - geen child + terugkom_datum gevuld   → 'open',   datum uit terugkom_datetime
    //   - geen child + geen terugkom           → 'geen',   datum = null
    //
    // Client-side filter ipv .not('status','in',...): PostgREST-array-not.in is
    // brittle (zie comment in api/sales-dashboard-stats.js:139). N is klein
    // (max 1-2 children per outcome), dus fetch-en-filteren is veilig en goedkoop.
    let afgeleid_follow_up_type = 'geen';
    let afspraak_datetime       = null;

    if (data.outcome !== 'klant_geworden') {
      const { data: children, error: childErr } = await supabase
        .from('follow_up_appointments')
        .select('id, scheduled_at, status, ghl_appointment_id, created_at')
        .eq('parent_appointment_id', appointment_id)
        .order('created_at', { ascending: false });
      if (childErr) {
        console.warn('[outcomes-get] child lookup failed:', childErr.message);
      }
      const child = (children || []).find(c =>
        !['cancelled', 'verplaatst', 'verwijderd'].includes(c.status)
      );
      if (child) {
        afgeleid_follow_up_type = child.ghl_appointment_id ? 'agenda' : 'intern';
        afspraak_datetime       = child.scheduled_at;
      } else if (data.terugkom_datum) {
        afgeleid_follow_up_type = 'open';
        afspraak_datetime       = data.terugkom_datetime || null;
      }
    }

    return res.status(200).json({
      ...data,
      afgeleid_follow_up_type,
      afspraak_datetime,
    });
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
    return res.status(400).json({ error: 'follow_up_type moet geen, intern, agenda of open zijn.' });
  }
  if ((followUpType === 'intern' || followUpType === 'agenda') && !body.follow_up_datetime) {
    return res.status(400).json({ error: 'follow_up_datetime vereist bij follow_up_type intern of agenda.' });
  }
  // type='open' gebruikt terugkom_datum + terugkom_datetime (op outcome-rij);
  // valideer dat die zijn meegegeven, anders geen opvolgings-signaal in DB.
  if (followUpType === 'open' && !body.terugkom_datum && !body.terugkom_datetime) {
    return res.status(400).json({ error: 'terugkom_datum vereist bij follow_up_type open.' });
  }

  // Parse follow_up_datetime: Amsterdam-local → UTC (zelfde patroon als verplaats-call).
  // Alleen relevant voor intern/agenda — 'open' gebruikt terugkom_datum/_datetime
  // op outcome-rij en maakt geen child appointment aan.
  let followUpStartISO = null;
  let followUpEndISO = null;
  if ((followUpType === 'intern' || followUpType === 'agenda') && body.follow_up_datetime) {
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
    .select('id, status, ghl_appointment_id, zoom_meeting_id, zoom_join_url, lead_name, lead_email, lead_phone, lead_ghl_contact_id, owner_id, duration_minutes')
    .eq('id', appointment_id)
    .maybeSingle();

  if (apptErr || !parentAppt) {
    return res.status(404).json({ error: 'Appointment niet gevonden.' });
  }

  // ── Guard: sla child-insert + GHL create over als al een scheduled child
  //          bestaat (A1 edit-gedrag). Alleen relevant voor intern/agenda;
  //          'open' en 'geen' maken sowieso geen child. ──
  let skipFollowUp = false;
  if (followUpType === 'intern' || followUpType === 'agenda') {
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

  // ── Validate-first: NIEUWE GHL appointment voor vervolg-call (blocking) ───
  // Parent's GHL appointment blijft intact (Jeffrey's keuze) — lead heeft dus
  // tijdelijk 2 appointments in GHL tot Dave de oude handmatig afhandelt.
  // Bij agenda zonder lead_ghl_contact_id: fallback naar intern-gedrag
  // (geen GHL/Zoom IDs op child, gewone DB-only follow-up row).
  let ghlNew = null;
  if (!skipFollowUp && followUpType === 'agenda') {
    if (!parentAppt.lead_ghl_contact_id) {
      console.warn('[outcomes-post] agenda flow zonder lead_ghl_contact_id, fallback naar intern voor appointment:', appointment_id);
    } else {
      const calendarId = process.env.GHL_CALENDAR_ID;
      const locationId = process.env.GHL_LOCATION_ID;
      if (!calendarId || !locationId) {
        console.error('[outcomes-post] GHL env-vars ontbreken: GHL_CALENDAR_ID / GHL_LOCATION_ID');
        return res.status(500).json({ error: 'GHL configuratie ontbreekt op de server.' });
      }
      try {
        ghlNew = await createGhlAppointment({
          calendarId,
          locationId,
          contactId:      parentAppt.lead_ghl_contact_id,
          assignedUserId: process.env.GHL_DAVE_USER_ID || undefined,
          startTime:      followUpStartISO,
          endTime:        followUpEndISO,
          title:          parentAppt.lead_name,
        });
      } catch (ghlErr) {
        console.error('[outcomes-post] GHL create failed:', ghlErr?.message, ghlErr);
        const ghlStatus = ghlErr?.ghlStatus || 500;
        const ghlBody   = ghlErr?.ghlBody   || '';
        return res.status(422).json({
          error: mapGhlError(ghlStatus, ghlBody),
          ghl_status: ghlStatus,
        });
      }
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
  // Beschermde statussen: outcome is administratief, flow-status niet aanpassen.
  const PROTECTED_STATUSES = ['cancelled', 'verplaatst', 'verwijderd'];
  const newStatus = PROTECTED_STATUSES.includes(parentAppt.status)
    ? parentAppt.status
    : OUTCOME_TO_STATUS[outcome];
  const { error: updateErr } = await supabase
    .from('follow_up_appointments')
    .update({ status: newStatus })
    .eq('id', appointment_id);

  if (updateErr) {
    console.error('[outcomes-post] status update error:', updateErr.message);
    return res.status(500).json({ error: 'Outcome saved but status update failed: ' + updateErr.message });
  }

  // ── Child appointment INSERT (follow-up row) ──────────────────────────────
  // Alleen voor 'intern' / 'agenda'. Bij 'open' is de opvolging gemarkeerd
  // op outcome-rij (terugkom_datum + opvolging_status='gepland') — geen
  // appointment-row nodig. Bij 'geen' geen werk.
  let newAppt = null;
  if (!skipFollowUp && (followUpType === 'intern' || followUpType === 'agenda')) {
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
      // Agenda: gebruik IDs van de NIEUWE GHL appointment (createGhlAppointment).
      // Intern of agenda-fallback (geen contactId): null. Zoom-velden kunnen
      // ook null zijn als GHL ze niet meegaf — poll-cron vult dan later (15min).
      ghl_appointment_id: ghlNew?.id              ?? null,
      zoom_meeting_id:    ghlNew?.zoom_meeting_id ?? null,
      zoom_join_url:      ghlNew?.zoom_join_url   ?? null,
    };

    const { data: insertedAppt, error: insertErr } = await supabase
      .from('follow_up_appointments')
      .insert(childRow)
      .select('id, scheduled_at, status')
      .single();

    if (insertErr) {
      console.error('[outcomes-post] child insert error:', insertErr.message, 'appointment:', appointment_id);
      return res.status(500).json({
        error: 'Vervolg-call kon niet worden aangemaakt in database. Outcome is wel opgeslagen. Neem contact op met support.',
        child_insert_failed: true,
        outcome_saved: true,
        db_error: insertErr.message,
      });
    }
    newAppt = insertedAppt;
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
    ghl_created:        !!ghlNew,
    ghl_appointment_id: ghlNew?.id || null,
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
