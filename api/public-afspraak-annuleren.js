// api/public-afspraak-annuleren.js
//
// Publiek (server-to-server via x-internal-token): annuleer een afspraak.
// GHL first (appointmentStatus=cancelled), dan DB status='cancelled'. Een al
// verdwenen GHL-afspraak (404/410) telt als geannuleerd — we spiegelen dan
// alsnog de DB.
//
// Regels (server-gevalideerd, niet te omzeilen via de UI):
//   • Annuleren mag alleen als het NU > 2 uur vóór scheduled_at is. Binnen 2 uur
//     → 403 te-laat-annuleren (verzetten kan dan nog wel).
//   • Er moet ALTIJD een serieuze reden mee (zelfde accountability als verzetten).
//
// POST { token:<uuid>, reden:<string ≥15 tekens>, reden_code?:<string> }
// 200 { ok }   400 reden-verplicht   403 te-laat-annuleren   409 niet meer scheduled   502 GHL-fout

import { supabaseAdmin } from './supabase.js';
import { checkSelfserviceSecret, haalAfspraakViaToken, redenGeldig, schoonReden, binnen2Uur } from './_lib/afspraak-selfservice.js';
import { updateGhlAppointmentStatus } from './_lib/ghl-appointment.js';
import { stuurAnnuleringBericht } from './_lib/afspraak-status-notify.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const auth = checkSelfserviceSecret(req);
  if (!auth.ok) return res.status(auth.status).json(auth.body);

  const body = req.body || {};
  const token = (body.token || '').toString();
  const reden     = schoonReden(body.reden);
  const redenCode = typeof body.reden_code === 'string' ? body.reden_code.slice(0, 40).trim() || null : null;

  // Verplichte, serieuze reden — vóór alle GHL/DB-mutaties.
  if (!redenGeldig(reden)) {
    return res.status(400).json({ error: 'reden-verplicht' });
  }

  const r = await haalAfspraakViaToken(token);
  if (r.error) return res.status(r.status).json({ error: r.error });
  const appt = r.appt;

  if (appt.status !== 'scheduled') {
    return res.status(409).json({ error: 'niet-meer-annuleerbaar', status: appt.status });
  }

  // 2-uur-grens: binnen 2 uur vóór de afspraak kan zelf annuleren niet meer.
  if (binnen2Uur(appt.scheduled_at)) {
    return res.status(403).json({ error: 'te-laat-annuleren', scheduled_at: appt.scheduled_at });
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

  // 2b) Reden opslaan (fail-soft; kolommen uit Fase 1).
  if (reden || redenCode) {
    try {
      await supabaseAdmin.from('follow_up_appointments')
        .update({ annulering_reden: reden, annulering_reden_code: redenCode })
        .eq('id', appt.id);
    } catch (_) { /* soft */ }
  }

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
  try { await stuurAnnuleringBericht(appt.id, { reden: reden || undefined }); } catch (_) { /* nooit blokkerend */ }

  return res.status(200).json({ ok: true });
}
