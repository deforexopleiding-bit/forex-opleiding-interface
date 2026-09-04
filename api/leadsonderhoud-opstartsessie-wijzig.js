// api/leadsonderhoud-opstartsessie-wijzig.js
//
// POST { appointment_id: uuid, new_start_at: ISO-string }
//
// BP3 v19 (2026-09-03) — wijzig (reschedule) van een opstartsessie-boeking
// vanuit de Leadsonderhoud/Opstartsessies-tab detail-modal. Nieuwe start-
// tijd; eindtijd = nieuwe start + bestaande duration_minutes.
//
// Flow (GHL-first, zelfde patroon als annuleer):
//   1) Fetch appointment (incl. duration_minutes) + scope-check.
//   2) PUT GHL: updateGhlAppointmentTime(ghl_id, startIso, endIso). Bij
//      GHL-fout géén DB-mutatie; 502 met ghl_error.
//   3) DB update: follow_up_appointments.scheduled_at = new_start_at.
//      (duration_minutes blijft; end_at wordt niet gepersisteerd in de
//      tabel — we berekenen 'em on-the-fly voor GHL.)
//
// Gate: leads.update (Romy heeft die uit BP1) OF sales/manager/admin/
// super_admin. Scope: appointmentsetter mag alleen eigen boekingen
// (setter_user_id === user.id); management ongefilterd.
//
// INCASSO-VEILIG: raakt uitsluitend follow_up_appointments (via GHL + DB).
// Geen finance/dunning/arrangement/pending-action/mentor.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { updateGhlAppointmentTime } from './_lib/ghl-appointment.js';
import { stuurVerzetBericht } from './_lib/afspraak-status-notify.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MGMT_ROLES = new Set(['super_admin', 'admin', 'manager', 'sales']);
const DEFAULT_DURATION_MIN = 30;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = req.body || {};
  const appointmentId = String(body.appointment_id || '').trim();
  const newStartRaw   = String(body.new_start_at || '').trim();
  if (!UUID_RE.test(appointmentId)) return res.status(400).json({ error: 'appointment_id (uuid) vereist' });
  if (!newStartRaw) return res.status(400).json({ error: 'new_start_at (ISO) vereist' });

  const newStartDate = new Date(newStartRaw);
  if (Number.isNaN(newStartDate.getTime())) {
    return res.status(400).json({ error: 'new_start_at is geen geldige datum-tijd' });
  }
  // Sanity: reschedule mag niet in het verleden liggen (accepteer 5 min
  // buffer voor client-clock skew).
  if (newStartDate.getTime() < Date.now() - 5 * 60 * 1000) {
    return res.status(400).json({ error: 'Nieuwe starttijd ligt in het verleden' });
  }

  try {
    const { data: appt, error: fErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, status, ghl_appointment_id, setter_user_id, owner_id, lead_name, scheduled_at, duration_minutes')
      .eq('id', appointmentId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!appt) return res.status(404).json({ error: 'Appointment niet gevonden' });

    // Al geannuleerd? Reschedule alleen op open/actieve boekingen.
    const currentStatus = String(appt.status || '').toLowerCase();
    if (currentStatus === 'cancelled') {
      return res.status(409).json({ error: 'Kan geannuleerde boeking niet wijzigen. Boek een nieuwe.' });
    }

    // Scope-check: als user géén management-rol heeft, moet setter_user_id kloppen.
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    const isMgmt = !!(profile && MGMT_ROLES.has(String(profile.role || '').toLowerCase()));
    if (!isMgmt) {
      if (!appt.setter_user_id || appt.setter_user_id !== user.id) {
        return res.status(403).json({ error: 'Alleen eigen boekingen kunnen worden gewijzigd' });
      }
    }

    const durationMin = Number(appt.duration_minutes) > 0
      ? Number(appt.duration_minutes)
      : DEFAULT_DURATION_MIN;
    const newStartIso = newStartDate.toISOString();
    const newEndIso   = new Date(newStartDate.getTime() + durationMin * 60 * 1000).toISOString();

    // 1) GHL update (validate-first — als GHL faalt, gaat DB-mutatie NIET door).
    if (!appt.ghl_appointment_id) {
      // Geen GHL-koppeling → alleen DB-update kan; geen sync te doen.
      const { error: updErr } = await supabaseAdmin
        .from('follow_up_appointments')
        .update({ scheduled_at: newStartIso })
        .eq('id', appointmentId);
      if (updErr) return res.status(500).json({ error: updErr.message, code: updErr.code });
      return res.status(200).json({
        ok: true, appointment_id: appointmentId,
        new_start_at: newStartIso, new_end_at: newEndIso,
        ghl_updated: false, ghl_skipped: 'geen ghl_appointment_id',
      });
    }

    try {
      await updateGhlAppointmentTime(appt.ghl_appointment_id, newStartIso, newEndIso);
    } catch (e) {
      const ghlStatus = e?.ghlStatus || null;
      const ghlError  = e?.message || String(e);
      console.error('[opstartsessie-wijzig] GHL fail:', ghlStatus, ghlError);
      return res.status(502).json({ error: 'GHL update faalde', ghl_error: ghlError, ghl_status: ghlStatus });
    }

    // 2) DB update: alleen scheduled_at (duration blijft).
    const { error: updErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .update({ scheduled_at: newStartIso })
      .eq('id', appointmentId);
    if (updErr) {
      // GHL is al bijgewerkt — log discrepancy en meld 500.
      console.error('[opstartsessie-wijzig] DB update faalde na GHL-succes:', updErr.code, updErr.message);
      return res.status(500).json({
        error: 'DB-update faalde na GHL-succes (out-of-sync — controleer handmatig)',
        code: updErr.code, ghl_updated: true,
      });
    }

    // verzet_sent_at resetten (fail-soft; kolom uit Fase 1) + bevestiging sturen.
    try { await supabaseAdmin.from('follow_up_appointments').update({ verzet_sent_at: null }).eq('id', appointmentId); } catch (_) { /* soft */ }
    try { await stuurVerzetBericht(appointmentId); } catch (_) { /* nooit blokkerend */ }

    return res.status(200).json({
      ok: true, appointment_id: appointmentId,
      new_start_at: newStartIso, new_end_at: newEndIso,
      duration_minutes: durationMin, ghl_updated: true,
    });
  } catch (e) {
    console.error('[opstartsessie-wijzig] exception:', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
