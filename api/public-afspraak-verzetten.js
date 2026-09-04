// api/public-afspraak-verzetten.js
//
// Publiek (server-to-server via x-internal-token): verzet een afspraak naar een
// nieuw tijdstip. GHL blijft de agenda/Zoom-motor — we updaten daar de tijd en
// spiegelen scheduled_at. De reminder-guards worden gereset zodat de flow voor
// het nieuwe tijdstip opnieuw loopt, en het token wordt geroteerd (oude link
// vervalt).
//
// POST { token:<uuid>, new_start_at:<ISO> }
// 200 { ok, new_token, scheduled_at }   409 als niet meer scheduled   502 GHL-fout

import crypto from 'crypto';
import { supabaseAdmin } from './supabase.js';
import { checkSelfserviceSecret, haalAfspraakViaToken } from './_lib/afspraak-selfservice.js';
import { updateGhlAppointmentTime } from './_lib/ghl-appointment.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = checkSelfserviceSecret(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const body = req.body || {};
  const token = (body.token || '').toString();
  const newStartRaw = (body.new_start_at || '').toString();

  const r = await haalAfspraakViaToken(token);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const appt = r.appt;

  if (appt.status !== 'scheduled') {
    return res.status(409).json({ error: 'niet-meer-wijzigbaar', status: appt.status });
  }

  const startMs = Date.parse(newStartRaw);
  if (!Number.isFinite(startMs)) return res.status(400).json({ error: 'new_start_at ongeldig (ISO vereist)' });
  if (startMs < Date.now() + 15 * 60 * 1000) return res.status(400).json({ error: 'nieuw tijdstip moet in de toekomst liggen' });

  const dur = Number(appt.duration_minutes) > 0 ? Number(appt.duration_minutes) : 20;
  const startIso = new Date(startMs).toISOString();
  const endIso   = new Date(startMs + dur * 60 * 1000).toISOString();

  // 1) GHL first (validate-first): faalt dit, dan geen DB-mutatie.
  if (!appt.ghl_appointment_id) return res.status(409).json({ error: 'geen-ghl-koppeling' });
  try {
    await updateGhlAppointmentTime(appt.ghl_appointment_id, startIso, endIso);
  } catch (e) {
    return res.status(502).json({ error: 'GHL-verzet mislukt', ghl_status: e?.ghlStatus ?? null });
  }

  // 2) DB spiegelen: nieuwe tijd, guards resetten, token roteren.
  const newToken = crypto.randomUUID();
  const { error: updErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .update({
      scheduled_at: startIso,
      afspraak_token: newToken,
      bevestiging_sent_at: null,
      reminder_24u_at: null,
      reminder_2u_at: null,
      reminder_30m_at: null,
      zoom_5min_at: null,
      bevestigd_at: null,
    })
    .eq('id', appt.id);
  if (updErr) return res.status(500).json({ error: 'db-update: ' + updErr.message });

  // 3) Audit (fail-soft).
  try {
    await supabaseAdmin.from('follow_up_events_log').insert({
      source: 'self-service',
      event_type: 'appointment_selfservice_verzet',
      payload: { appointment_id: appt.id, van: appt.scheduled_at, naar: startIso },
      processed: true,
    });
  } catch (_) { /* niet blokkerend */ }

  return res.status(200).json({ ok: true, new_token: newToken, scheduled_at: startIso });
}
