// api/leadsonderhoud-opstartsessie-annuleer.js
//
// POST { appointment_id: uuid, mode?: 'cancel'|'delete', reden?: text }
//
// BP3 v12 (2026-09-03) — annuleer/verwijder een opstartsessie-boeking vanuit
// de Leadsonderhoud/Opstartsessies-tab.
//
//   mode='cancel' (default): GHL PUT appointmentStatus=cancelled + zet
//                            follow_up_appointments.status='cancelled'. Rij
//                            blijft bestaan; verdwijnt default uit de lijst
//                            omdat -list-endpoint 'cancelled' filter't.
//   mode='delete':           GHL PUT appointmentStatus=cancelled + hard-DELETE
//                            de follow_up_appointments-rij. FK-cascade zet
//                            opstartsessie_submissions.appointment_id op NULL
//                            (ON DELETE SET NULL) — submission blijft dus
//                            zichtbaar zonder boeking (kan opnieuw geboekt
//                            worden). NIET een 'verwijderd'-status wegschrijven
//                            (CHECK-constraint laat dat niet toe → 23514).
//
// Gate: leads.update (Romy heeft die uit BP1) OF sales/manager/admin/super_admin
// (management-rollen). Scope: appointmentsetter mag alleen eigen appointments
// (setter_user_id === user.id); management ongefilterd.
//
// INCASSO-VEILIG: raakt uitsluitend follow_up_appointments (via GHL + DB) en
// leest submission-context voor de audit-log. Geen finance/dunning/arrangement.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { updateGhlAppointmentStatus } from './_lib/ghl-appointment.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MGMT_ROLES = new Set(['super_admin', 'admin', 'manager', 'sales']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Gate: leads.update (dekt Romy). Management-rollen hebben die impliciet.
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  const body = req.body || {};
  const appointmentId = String(body.appointment_id || '').trim();
  const mode          = String(body.mode || 'cancel').toLowerCase();
  const reden         = typeof body.reden === 'string' ? body.reden.slice(0, 300) : null;
  if (!UUID_RE.test(appointmentId)) return res.status(400).json({ error: 'appointment_id (uuid) vereist' });
  if (!['cancel', 'delete'].includes(mode)) return res.status(400).json({ error: "mode moet 'cancel' of 'delete' zijn" });

  try {
    // Fetch appointment + rol-check voor scope-guard.
    const { data: appt, error: fErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, status, ghl_appointment_id, setter_user_id, owner_id, lead_name, scheduled_at')
      .eq('id', appointmentId)
      .maybeSingle();
    if (fErr) throw fErr;
    if (!appt) return res.status(404).json({ error: 'Appointment niet gevonden' });

    // Scope-check: als user géén management-rol heeft, moet setter_user_id kloppen.
    const { data: profile } = await supabaseAdmin
      .from('profiles').select('role').eq('id', user.id).maybeSingle();
    const isMgmt = !!(profile && MGMT_ROLES.has(String(profile.role || '').toLowerCase()));
    if (!isMgmt) {
      if (!appt.setter_user_id || appt.setter_user_id !== user.id) {
        return res.status(403).json({ error: 'Alleen eigen boekingen kunnen worden geannuleerd/verwijderd' });
      }
    }

    // Al geannuleerd? Cancel is dan no-op ok; delete gaat wél door.
    if (mode === 'cancel' && String(appt.status || '').toLowerCase() === 'cancelled') {
      return res.status(200).json({ ok: true, already_cancelled: true, appointment_id: appointmentId });
    }

    // 1) GHL cancel (validate-first — als GHL faalt, gaat DB-mutatie NIET door).
    let ghlOk = false;
    let ghlError = null;
    if (appt.ghl_appointment_id) {
      try {
        await updateGhlAppointmentStatus(appt.ghl_appointment_id, 'cancelled');
        ghlOk = true;
      } catch (e) {
        ghlError = e?.message || String(e);
        // 404 / 400 uit GHL: mogelijk was 'ie al weg → toestaan door te gaan.
        const ghlStatus = e?.ghlStatus || null;
        if (ghlStatus && (ghlStatus === 404 || ghlStatus === 410)) {
          console.warn('[opstartsessie-annuleer] GHL 404/410 — accepteer als al-weg:', appt.ghl_appointment_id);
          ghlOk = true;
        } else {
          console.error('[opstartsessie-annuleer] GHL fail:', ghlStatus, ghlError);
          return res.status(502).json({ error: 'GHL cancel faalde', ghl_error: ghlError, ghl_status: ghlStatus });
        }
      }
    } // geen ghl_appointment_id → alleen DB-actie

    // 2) DB-actie op basis van mode.
    if (mode === 'delete') {
      const { error: delErr } = await supabaseAdmin
        .from('follow_up_appointments').delete().eq('id', appointmentId);
      if (delErr) {
        console.error('[opstartsessie-annuleer] delete faalde:', delErr.code, delErr.message);
        return res.status(500).json({ error: delErr.message, code: delErr.code });
      }
      return res.status(200).json({
        ok: true, mode: 'delete', appointment_id: appointmentId,
        ghl_cancelled: ghlOk, reden,
      });
    }

    // mode === 'cancel'
    const { error: updErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .update({ status: 'cancelled' })
      .eq('id', appointmentId);
    if (updErr) {
      console.error('[opstartsessie-annuleer] status update faalde:', updErr.code, updErr.message);
      return res.status(500).json({ error: updErr.message, code: updErr.code });
    }
    return res.status(200).json({
      ok: true, mode: 'cancel', appointment_id: appointmentId,
      new_status: 'cancelled', ghl_cancelled: ghlOk, reden,
    });
  } catch (e) {
    console.error('[opstartsessie-annuleer] exception:', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
