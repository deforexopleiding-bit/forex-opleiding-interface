// api/follow-up-opvolglijst-afschrijven.js
//
// POST — Schrijf een opvolglijst-item af met verplichte reden. Het item
// verdwijnt uit de Opvolglijst en verschijnt (waar zinvol) in de
// Afgeboekt-tab.
//
// Body:
//   { type: 'attendee'|'appointment',
//     ref_id: uuid,
//     reason: string (min 3 chars, max 2000) }
//
// Effect per type:
//   type='attendee':
//     - event_attendees.no_show_followup_status = 'afgeschreven' + _at
//     - Als de attendee een matching follow_up_lead heeft (via
//       source_ref.attendee_id): zet lead_status='verloren' + notitie
//       met de reden.
//     - Attendee verdwijnt uit Opvolglijst; lead (indien aanwezig)
//       verschijnt in Afgeboekt (reden='verloren').
//
//   type='appointment':
//     - follow_up_appointments.follow_up_afgeschreven_at = now()
//     - follow_up_afgeschreven_reason = reason
//     - follow_up_afgeschreven_by = user.id
//     - Als status='wacht_op_reschedule' → status='cancelled' zodat de
//       afspraak in Afgeboekt (reden='cancelled') opduikt.
//     - snelle_notitie krijgt een audit-regel met de reden.
//
// Fail-soft 42703/PGRST204 op de nieuwe kolommen → 501 MIGRATION_REQUIRED.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissingColumnError(err) {
  if (!err) return false;
  if (err.code === '42703' || err.code === 'PGRST204') return true;
  const msg = String(err.message || '').toLowerCase();
  return /could not find the/i.test(msg) || /schema cache/i.test(msg);
}

async function appendApptNote(appointmentId, text) {
  try {
    const { data: current } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('snelle_notitie')
      .eq('id', appointmentId)
      .maybeSingle();
    const prev = String(current?.snelle_notitie || '');
    const stamp = new Date().toLocaleString('nl-NL', {
      day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit',
    });
    const line = `[${stamp}] ${text}`;
    const combined = prev ? (prev + '\n' + line) : line;
    await supabaseAdmin
      .from('follow_up_appointments')
      .update({ snelle_notitie: combined.slice(0, 2000) })
      .eq('id', appointmentId);
  } catch (e) {
    console.warn('[opvolglijst-afschrijven appt-note]', e?.message || e);
  }
}

async function appendLeadNote(leadId, text) {
  // Best-effort: hergebruik follow_up_lead_notes-tabel als 'ie bestaat,
  // anders skippen. Vermijdt harde koppeling met een specifiek schema.
  try {
    await supabaseAdmin
      .from('follow_up_lead_notes')
      .insert({
        lead_id      : leadId,
        entry_kind   : 'outcome',
        outcome_code : 'afgeschreven',
        note         : String(text || '').slice(0, 2000),
      });
  } catch (e) {
    // Fail-soft: notities zijn secundair aan de status-write.
    console.warn('[opvolglijst-afschrijven lead-note]', e?.message || e);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'events.event.view');
  if (!allowed) allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const type   = String(body.type   || '').trim();
  const refId  = String(body.ref_id || '').trim();
  const reason = String(body.reason || '').trim();

  if (!['attendee', 'appointment'].includes(type)) {
    return res.status(400).json({ error: "type moet 'attendee' of 'appointment' zijn" });
  }
  if (!UUID_RE.test(refId)) {
    return res.status(400).json({ error: 'ref_id (uuid) vereist' });
  }
  if (reason.length < 3) {
    return res.status(400).json({ error: 'Reden vereist (min 3 tekens)' });
  }
  const reasonClipped = reason.slice(0, 2000);

  const nowIso = new Date().toISOString();

  try {
    if (type === 'attendee') {
      // 1) Attendee status naar 'afgeschreven'.
      const { data: att, error: attErr } = await supabaseAdmin
        .from('event_attendees')
        .select('id, customer_id, first_name, last_name, email, phone, event_id')
        .eq('id', refId)
        .maybeSingle();
      if (attErr) {
        if (attErr.code === '42P01') return res.status(501).json({ error: 'event_attendees ontbreekt', code: 'MIGRATION_REQUIRED' });
        throw new Error('attendee fetch: ' + attErr.message);
      }
      if (!att) return res.status(404).json({ error: 'Attendee niet gevonden' });

      const { error: upErr } = await supabaseAdmin
        .from('event_attendees')
        .update({
          no_show_followup_status: 'afgeschreven',
          no_show_followup_at    : nowIso,
        })
        .eq('id', refId);
      if (upErr) {
        if (isMissingColumnError(upErr)) {
          return res.status(501).json({ error: 'no_show_followup_status kolom ontbreekt — draai migratie 024', code: 'MIGRATION_REQUIRED' });
        }
        throw new Error('attendee update: ' + upErr.message);
      }

      // 2) Bijbehorende lead vinden (via source_ref.attendee_id) en op
      //    'verloren' zetten — dan verschijnt 'ie in Afgeboekt.
      let leadId = null;
      try {
        const { data: leads } = await supabaseAdmin
          .from('follow_up_leads')
          .select('id, lead_status, source_ref')
          .eq('source', 'event');
        const matched = (leads || []).find((l) => l?.source_ref?.attendee_id === refId);
        if (matched) leadId = matched.id;
      } catch (e) {
        console.warn('[opvolglijst-afschrijven lead-lookup]', e?.message || e);
      }
      if (leadId) {
        try {
          const { error: leadErr } = await supabaseAdmin
            .from('follow_up_leads')
            .update({ lead_status: 'verloren', updated_at: nowIso })
            .eq('id', leadId);
          if (leadErr) console.warn('[opvolglijst-afschrijven lead-update]', leadErr.message);
          else await appendLeadNote(leadId, 'Afgeschreven vanuit Opvolglijst — ' + reasonClipped);
        } catch (e) {
          console.warn('[opvolglijst-afschrijven lead-catch]', e?.message || e);
        }
      }

      return res.status(200).json({
        ok        : true,
        type,
        ref_id    : refId,
        lead_id   : leadId,
        reason    : reasonClipped,
      });
    }

    // ── type='appointment' ──────────────────────────────────────────────
    const { data: appt, error: apptErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .select('id, status, lead_name, follow_up_afgeschreven_at')
      .eq('id', refId)
      .maybeSingle();
    if (apptErr) {
      if (isMissingColumnError(apptErr)) {
        // De 'follow_up_afgeschreven_at' kolom ontbreekt — migratie 025 niet gedraaid.
        return res.status(501).json({ error: 'follow_up_afgeschreven_at kolom ontbreekt — draai migratie 025', code: 'MIGRATION_REQUIRED' });
      }
      if (apptErr.code === '42P01') return res.status(501).json({ error: 'follow_up_appointments ontbreekt', code: 'MIGRATION_REQUIRED' });
      throw new Error('appt fetch: ' + apptErr.message);
    }
    if (!appt) return res.status(404).json({ error: 'Appointment niet gevonden' });
    if (appt.follow_up_afgeschreven_at) {
      // Idempotent — geen fout gooien, gewoon melden dat 't al is gebeurd.
      return res.status(200).json({ ok: true, type, ref_id: refId, already: true });
    }

    // Als de afspraak nog wacht_op_reschedule staat: zet 'em op cancelled
    // zodat Afgeboekt-tab 'em pikt (die filter: status IN ('no_show','cancelled')).
    const updates = {
      follow_up_afgeschreven_at    : nowIso,
      follow_up_afgeschreven_reason: reasonClipped,
      follow_up_afgeschreven_by    : user.id,
      updated_at                   : nowIso,
    };
    if (appt.status === 'wacht_op_reschedule') updates.status = 'cancelled';

    const { error: upErr } = await supabaseAdmin
      .from('follow_up_appointments')
      .update(updates)
      .eq('id', refId);
    if (upErr) {
      if (isMissingColumnError(upErr)) {
        return res.status(501).json({ error: 'follow_up_afgeschreven_* kolommen ontbreken — draai migratie 025', code: 'MIGRATION_REQUIRED' });
      }
      throw new Error('appt update: ' + upErr.message);
    }

    await appendApptNote(refId, 'Afgeschreven vanuit Opvolglijst — ' + reasonClipped);

    return res.status(200).json({
      ok         : true,
      type,
      ref_id     : refId,
      reason     : reasonClipped,
      new_status : updates.status || appt.status,
    });
  } catch (e) {
    console.error('[follow-up-opvolglijst-afschrijven]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
