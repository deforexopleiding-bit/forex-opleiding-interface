// api/lisa-appointment-create.js
//
// BROK 2 DEEL C (Lisa Appointmentsetter) — Zoom-afspraak inschieten
// vanuit een Lisa-conversatie. Dave's Zoom-agenda (zelfde kalender-env
// als Leadsonderhoud) → in follow_up_appointments zodat Dave 'em in de
// Afspraken-tab ziet + poll-cron 'm oppikt.
//
// Body:
//   conversation_id  uuid    required   (lisa_conversations.id)
//   scheduledAt      ISO8601 required   (start-tijd)
//   durationMinutes  int     optional   default 30, clamp 15-120
//
// Auth: verifyAdmin (hard) + requirePermissionFailOpen('lisa.config.publish').
//
// Response:
//   200 { ok, ghl_appointment_id, follow_up_appointment_id,
//         zoom_meeting_id, zoom_join_url, scheduled_at }
//   400 { error }
//   403 { error }
//   404 { error }
//   422 { code: 'NO_GHL_CONTACT' | 'GHL_CONFIG_MISSING' | 'SANDBOX', error }
//   502 { error, ghlStatus }
//
// Design-keuze: gebruik createGhlAppointment DIRECT (niet
// createAppointmentForLead) — we hebben ghl_contact_id al op de conv-rij,
// er is geen lead-record, en we willen geen ghost-lead spawnen. Wél
// insert in follow_up_appointments zodat Dave 'em in zijn Afspraken-tab
// ziet (spiegel Leadsonderhoud-gedrag).
//
// Naast de GHL-call schrijft dit endpoint ook een SYSTEM-bericht in
// lisa_messages ("Afspraak geboekt: <datum/tijd>") — behulpzaam voor de
// audit-trail in de conversatie. Fail-soft; als die insert faalt logt
// het endpoint een warning maar returnt success.

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';
import { createGhlAppointment } from './_lib/ghl-appointment.js';
import { mapGhlError } from './_lib/create-appointment-from-lead.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });
  if (!(await requirePermissionFailOpen(req, 'lisa.config.publish'))) {
    return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.config.publish' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const conversationId = String(body.conversation_id || '').trim();
  const scheduledAt    = String(body.scheduledAt || '').trim();
  const durationMinutes = Number.isFinite(Number(body.durationMinutes))
    ? Math.max(15, Math.min(120, Number(body.durationMinutes)))
    : 30;

  if (!UUID_RE.test(conversationId)) return res.status(400).json({ error: 'conversation_id ongeldig' });
  if (!scheduledAt)                   return res.status(400).json({ error: 'scheduledAt vereist' });
  const startDate = new Date(scheduledAt);
  if (isNaN(startDate.getTime()))     return res.status(400).json({ error: 'scheduledAt ongeldig (ISO8601)' });

  // Conversation ophalen — contact_name voor GHL-title, ghl_contact_id
  // voor de create-call, is_sandbox als hard guard.
  let conv;
  try {
    const { data, error } = await supabaseAdmin
      .from('lisa_conversations')
      // BP3 v4 (2026-09-01) — assigned_human meelezen voor setter-stamp (pad B).
      .select('id, contact_name, instagram_handle, ghl_contact_id, is_sandbox, phase, call_booked, assigned_human')
      .eq('id', conversationId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Conversatie niet gevonden' });
    conv = data;
  } catch (e) {
    console.error('[lisa-appt-create] conv lookup:', e?.message || e);
    return res.status(500).json({ error: 'Kon conversatie niet ophalen' });
  }

  if (conv.is_sandbox) {
    return res.status(422).json({ code: 'SANDBOX', error: 'Afspraken kunnen niet vanuit sandbox-conversaties worden ingeschoten.' });
  }
  const ghlContactId = String(conv.ghl_contact_id || '').trim();
  if (!ghlContactId) {
    return res.status(422).json({ code: 'NO_GHL_CONTACT', error: 'Deze conversatie heeft geen gekoppeld GHL-contact — Lisa kan pas boeken zodra het contact bestaat.' });
  }

  const calendarId = process.env.GHL_CALENDAR_ID;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!calendarId || !locationId) {
    return res.status(422).json({ code: 'GHL_CONFIG_MISSING', error: 'GHL-configuratie ontbreekt op de server (GHL_CALENDAR_ID / GHL_LOCATION_ID).' });
  }

  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
  const title = (conv.contact_name || conv.instagram_handle || 'Lisa — Zoom-afspraak').slice(0, 120);

  // 1) GHL-appointment aanmaken.
  let ghl;
  try {
    ghl = await createGhlAppointment({
      calendarId,
      locationId,
      contactId     : ghlContactId,
      assignedUserId: process.env.GHL_DAVE_USER_ID || undefined,
      startTime     : startDate.toISOString(),
      endTime       : endDate.toISOString(),
      title,
    });
  } catch (ghlErr) {
    const nlText = mapGhlError(ghlErr?.ghlStatus, ghlErr?.ghlBody) || 'GHL-afspraak aanmaken faalde';
    console.warn('[lisa-appt-create] GHL fout:', { status: ghlErr?.ghlStatus, body: (ghlErr?.ghlBody || '').slice(0, 200) });
    return res.status(502).json({ error: nlText, ghlStatus: ghlErr?.ghlStatus || null });
  }

  // 2) follow_up_appointments-rij (zodat Dave 'em in zijn Afspraken-tab
  //    ziet). Fail-soft: als die insert faalt heeft de klant wel al de
  //    Zoom-uitnodiging → we returnen success + warning ipv rollback.
  // BP3 v4 (2026-09-01) — pad B: setter-stamp uit assigned_human. Als de
  // conversatie is overgenomen door een human (Romy die 'ik antwoord' klikt
  // → assigned_human = haar auth-user-id), dan wordt de appointment aan haar
  // toegeschreven. Zonder takeover: NULL → boeking komt niet in setter-
  // gescopte views (correcte fail-closed, want dan is er geen setter-owner).
  const resolvedSetter = conv.assigned_human || null;

  const insertRow = {
    parent_appointment_id: null,
    lead_name           : conv.contact_name || conv.instagram_handle || null,
    lead_email          : null,
    lead_phone          : null,
    lead_ghl_contact_id : ghlContactId,
    scheduled_at        : startDate.toISOString(),
    duration_minutes    : durationMinutes,
    status              : 'scheduled',
    voicememo_status    : 'pending',
    owner_id            : null,
    ghl_appointment_id  : ghl?.id              ?? null,
    zoom_meeting_id     : ghl?.zoom_meeting_id ?? null,
    zoom_join_url       : ghl?.zoom_join_url   ?? null,
    setter_user_id      : resolvedSetter,
  };
  // BP3 v4: setter_user_id staat in de OPTIONAL_KEYS-strip zodat oudere
  // schema's zonder de kolom niet crashen (spiegelt create-appointment-from-lead).
  const OPTIONAL_KEYS = ['duration_minutes', 'voicememo_status', 'parent_appointment_id', 'setter_user_id'];
  let attempt = { ...insertRow };
  let inserted = null;
  let insertWarning = null;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabaseAdmin
      .from('follow_up_appointments')
      .insert(attempt)
      .select('id, scheduled_at, status, zoom_join_url, ghl_appointment_id')
      .maybeSingle();
    if (!error) { inserted = data; break; }
    if (error.code === '42703') {
      const msg = String(error.message || '').toLowerCase();
      let stripped = false;
      for (const k of OPTIONAL_KEYS) {
        if (msg.includes(k) && k in attempt) { delete attempt[k]; stripped = true; }
      }
      if (!stripped) { insertWarning = 'DB insert schema-mismatch: ' + error.message; break; }
      continue;
    }
    insertWarning = 'DB insert follow_up_appointments faalde: ' + error.message;
    break;
  }
  if (!inserted?.id && !insertWarning) insertWarning = 'DB insert follow_up_appointments: geen resultaat';
  if (insertWarning) console.warn('[lisa-appt-create] ' + insertWarning + ' (ghl_id=' + (ghl?.id || '?') + ')');

  // 3) Optionele call_booked-vlag op de conversation zetten (aligned
  //    met wat er semantisch gebeurt) + system-message in de thread.
  //    Beide fail-soft — als ze falen blijft de afspraak staan.
  try {
    if (!conv.call_booked) {
      await supabaseAdmin
        .from('lisa_conversations')
        .update({ call_booked: true, call_booked_at: new Date().toISOString() })
        .eq('id', conv.id);
    }
  } catch (e) {
    console.warn('[lisa-appt-create] call_booked update fail:', e?.message || e);
  }
  try {
    const when = startDate.toLocaleString('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    await supabaseAdmin.from('lisa_messages').insert({
      conversation_id: conv.id,
      direction      : 'out',
      content        : `✓ Zoom-afspraak ingeschoten voor ${when} (${durationMinutes} min).`,
      ai_generated   : false,
      human_override : true,
      is_system      : true,
    });
  } catch (e) {
    console.warn('[lisa-appt-create] system-message insert fail:', e?.message || e);
  }

  return res.status(200).json({
    ok: true,
    ghl_appointment_id:       ghl?.id || null,
    follow_up_appointment_id: inserted?.id || null,
    zoom_meeting_id:          ghl?.zoom_meeting_id || null,
    zoom_join_url:            ghl?.zoom_join_url   || null,
    scheduled_at:             inserted?.scheduled_at || startDate.toISOString(),
    warning:                  insertWarning || undefined,
  });
}
