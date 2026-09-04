// api/public-afspraak-annuleren.js
//
// Publiek (server-to-server via x-internal-token): annuleer een afspraak.
// GHL first (appointmentStatus=cancelled), dan DB status='cancelled'. Een al
// verdwenen GHL-afspraak (404/410) telt als geannuleerd — we spiegelen dan
// alsnog de DB.
//
// POST { token:<uuid> }
// 200 { ok }   409 als niet meer scheduled   502 GHL-fout

import { supabaseAdmin } from './supabase.js';
import { checkSelfserviceSecret, haalAfspraakViaToken } from './_lib/afspraak-selfservice.js';
import { updateGhlAppointmentStatus } from './_lib/ghl-appointment.js';
import { stuurAnnuleringBericht } from './_lib/afspraak-status-notify.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = checkSelfserviceSecret(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const token = ((req.body || {}).token || '').toString();
  const r = await haalAfspraakViaToken(token);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const appt = r.appt;

  if (appt.status !== 'scheduled') {
    return res.status(409).json({ error: 'niet-meer-annuleerbaar', status: appt.status });
  }

  // 1) GHL cancel (validate-first). 404/410 = al weg → toch DB spiegelen.
  if (appt.ghl_appointment_id) {
    try {
      await updateGhlAppointmentStatus(appt.ghl_appointment_id, 'cancelled');
    } catch (e) {
      const gs = e?.ghlStatus ?? null;
      if (gs !== 404 && gs !== 410) {
        return res.status(502).json({ error: 'GHL-annulering mislukt', ghl_status: gs });
      }
    }
  }

  // 2) DB status flippen (atomair: alleen vanuit scheduled).
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .update({ status: 'cancelled' })
    .eq('id', appt.id)
    .eq('status', 'scheduled')
    .select('id')
    .maybeSingle();
  if (updErr) return res.status(500).json({ error: 'db-update: ' + updErr.message });
  if (!updated) return res.status(409).json({ error: 'niet-meer-annuleerbaar' });

  // 3) Audit (fail-soft).
  try {
    await supabaseAdmin.from('follow_up_events_log').insert({
      source: 'self-service',
      event_type: 'appointment_selfservice_annuleer',
      payload: { appointment_id: appt.id, scheduled_at: appt.scheduled_at },
      processed: true,
    });
  } catch (_) { /* niet blokkerend */ }

  // 4) Bevestiging (annulering) — fail-soft, achter AFSPRAAK_REMINDERS_LIVE.
  //    reden wordt in Fase 3 door de self-service-pagina meegestuurd.
  try {
    const reden = typeof (req.body || {}).reden === 'string' ? req.body.reden : undefined;
    await stuurAnnuleringBericht(appt.id, { reden });
  } catch (_) { /* nooit blokkerend */ }

  return res.status(200).json({ ok: true });
}
