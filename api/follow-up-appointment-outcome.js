// api/follow-up-appointment-outcome.js
//
// POST — Uitkomst-motor voor Zoom-afspraken (follow_up_appointments).
//
// Body: {
//   appointment_id : uuid,
//   outcome        : 'gesprek_gehad' | 'sale' | 'wilt_niet_meer' | 'no_show'
//                  | 'later_opnieuw' | 'terugbel' | 'verzetten' | 'annuleren',
//   terugbel_datum?: ISO,        // vereist bij terugbel; optioneel bij later
//   lead_kind?     : 'bel'|'zoom', // bij terugbel; default 'bel'
//   snooze_months? : number,     // bij later_opnieuw; default 3
//   new_datetime?  : ISO,        // vereist bij verzetten
//   duration_minutes?: number,   // bij verzetten (default 30)
//   reden?         : string,     // bij annuleren
// }
//
// Effecten (per outcome):
//   gesprek_gehad  → appointment.status='completed' + note
//   sale           → appointment.status='completed' + note "Sale 🎉"
//   wilt_niet_meer → appointment.status='cancelled' + note (GHL/Zoom NIET
//                    annuleren — de call was al)
//   no_show        → appointment.status='no_show' + nieuwe follow_up_lead
//                    (source='manual', lead_kind='bel', lead_status=
//                    'terugbellen', terugbel_datum=now()+2u)
//   later_opnieuw  → appointment.status='completed' + nieuwe follow_up_lead
//                    met snoozed_until=now()+snooze_months (default 3)
//   terugbel       → appointment.status='completed' + nieuwe follow_up_lead
//                    met terugbel_datum (verplicht) + lead_kind
//   verzetten      → delegeer naar /api/follow-up-verplaats-call
//   annuleren      → delegeer naar /api/follow-up-annuleer
//                    (cancelt GHL + probeert Zoom te verwijderen)
//
// Fail-soft op externe sync (GHL/Zoom); status-update blijft succesvol
// zelfs als een externe call faalt, met een warning in de response.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OUTCOMES = new Set([
  'gesprek_gehad', 'sale', 'wilt_niet_meer', 'no_show',
  'later_opnieuw', 'terugbel', 'verzetten', 'annuleren',
]);

const ADMIN_ROLES = new Set(['super_admin', 'admin', 'manager']);

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function monthsFromNow(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

async function appendApptNote(appointmentId, text) {
  // Voeg regel toe aan follow_up_appointments.snelle_notitie zodat de
  // uitkomst-log zichtbaar blijft in de klassieke afspraak-detail én
  // in de nieuwe cockpit-modal.
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
    console.warn('[appt-outcome] note append:', e?.message || e);
  }
}

async function createFollowupLead({ appt, statusOverrides = {}, terugbelDatum, snoozeMonths, leadKind, noteReason }) {
  // Maakt een follow_up_leads-rij zodat de klant terugkomt in de
  // Werklijst. Idempotent: bij unique-conflict (customer_id+source)
  // gebruiken we de bestaande lead.
  const row = {
    customer_id       : null,        // appointments hebben geen directe customer_id — leeg is toegestaan
    source            : 'manual',
    lead_name         : appt.lead_name || '(zonder naam)',
    lead_email        : appt.lead_email || null,
    lead_phone        : appt.lead_phone || null,
    lead_status       : statusOverrides.lead_status || 'terugbellen',
    terugbel_datum    : terugbelDatum || null,
    lead_kind         : leadKind || 'bel',
    snoozed_until     : snoozeMonths ? monthsFromNow(snoozeMonths) : null,
    source_ref        : {
      from_appointment: appt.id,
      ghl_contact_id  : appt.lead_ghl_contact_id || null,
      reason          : noteReason || null,
    },
    created_by_user_id: null,
  };
  const RICH_KEYS = ['lead_kind', 'snoozed_until'];
  let attempt = { ...row };
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabaseAdmin
      .from('follow_up_leads')
      .insert(attempt)
      .select('id')
      .maybeSingle();
    if (!error) return { lead_id: data?.id, already: false };
    if (error.code === '42P01') { const e = new Error('follow_up_leads ontbreekt'); e.code = 'MIGRATION_REQUIRED'; throw e; }
    if (error.code === '23505') {
      // Al bestaande lead met matching customer_id+source — hergebruik.
      return { lead_id: null, already: true };
    }
    if (error.code === '42703') {
      // Rijke kolommen niet in schema; strippen en retry.
      const msg = String(error.message || '').toLowerCase();
      let stripped = false;
      for (const k of RICH_KEYS) {
        if (msg.includes(k) && k in attempt) { delete attempt[k]; stripped = true; }
      }
      if (!stripped) throw new Error('lead insert: ' + error.message);
      continue;
    }
    throw new Error('lead insert: ' + error.message);
  }
  return { lead_id: null, already: false };
}

async function delegateVerplaatsen(req, body) {
  // Vercel serverless functions moeten via HTTP intern gecalld worden
  // (of we importeren de handler direct). We proxy'en naar het
  // bestaande endpoint met dezelfde Bearer-header zodat auth/rol-gate
  // hergebruikt wordt.
  const url = new URL(req.url, `https://${req.headers.host}`);
  const target = `${url.protocol}//${url.host}/api/follow-up-verplaats-call`;
  const resp = await fetch(target, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': req.headers.authorization || '',
      'Cookie'       : req.headers.cookie || '',
    },
    body: JSON.stringify({
      appointment_id  : body.appointment_id,
      new_datetime    : body.new_datetime,
      duration_minutes: body.duration_minutes || 30,
    }),
  });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { ok: resp.ok, status: resp.status, body: json || text };
}

async function delegateAnnuleren(req, body) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const target = `${url.protocol}//${url.host}/api/follow-up-annuleer`;
  const resp = await fetch(target, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': req.headers.authorization || '',
      'Cookie'       : req.headers.cookie || '',
    },
    body: JSON.stringify({
      appointment_id: body.appointment_id,
      reden         : body.reden || null,
    }),
  });
  const text = await resp.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { ok: resp.ok, status: resp.status, body: json || text };
}

async function updateApptStatus(appointmentId, newStatus) {
  const { error } = await supabaseAdmin
    .from('follow_up_appointments')
    .update({ status: newStatus, updated_at: new Date().toISOString() })
    .eq('id', appointmentId);
  if (error) throw new Error('status update: ' + error.message);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  let allowed = await requirePermission(req, 'sales.tab.retentie');
  if (!allowed) allowed = await requirePermission(req, 'sales.customer.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const appointmentId = typeof body.appointment_id === 'string' ? body.appointment_id.trim() : '';
  if (!appointmentId || !UUID_RE.test(appointmentId)) return res.status(400).json({ error: 'appointment_id vereist' });

  const outcome = String(body.outcome || '').trim();
  if (!OUTCOMES.has(outcome)) return res.status(400).json({ error: 'outcome ongeldig' });

  // Owner-gate (zelfde patroon als de andere endpoints).
  const { data: myProfile } = await supabaseAdmin
    .from('profiles').select('role').eq('id', user.id).maybeSingle();
  const myRole  = String(myProfile?.role || '').toLowerCase();
  const isAdmin = ADMIN_ROLES.has(myRole);
  const isSales = myRole === 'sales';

  const { data: appt, error: apptErr } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, owner_id, lead_ghl_contact_id, zoom_meeting_id')
    .eq('id', appointmentId)
    .maybeSingle();
  if (apptErr) return res.status(500).json({ error: 'appt fetch: ' + apptErr.message });
  if (!appt)   return res.status(404).json({ error: 'Appointment niet gevonden' });

  if (!isAdmin) {
    if (!isSales) return res.status(403).json({ error: 'Geen rechten (rol vereist)' });
    if (appt.owner_id && appt.owner_id !== user.id) {
      return res.status(403).json({ error: 'Deze afspraak is aan een andere sales toegewezen' });
    }
  }

  try {
    // ── Delegatie-outcomes: gebruik bestaande endpoints ────────────────
    if (outcome === 'verzetten') {
      if (!body.new_datetime) return res.status(400).json({ error: 'new_datetime vereist' });
      const r = await delegateVerplaatsen(req, body);
      if (!r.ok) return res.status(r.status || 500).json({ error: r.body?.error || 'Verzetten mislukt', delegate: r.body });
      await appendApptNote(appointmentId, 'Verzet via cockpit');
      return res.status(200).json({ ok: true, delegated: 'verplaats-call', appointment_id: appointmentId, delegate: r.body });
    }
    if (outcome === 'annuleren') {
      const r = await delegateAnnuleren(req, body);
      if (!r.ok) return res.status(r.status || 500).json({ error: r.body?.error || 'Annuleren mislukt', delegate: r.body });
      await appendApptNote(appointmentId, 'Geannuleerd via cockpit' + (body.reden ? ` — ${String(body.reden).slice(0,200)}` : ''));
      return res.status(200).json({ ok: true, delegated: 'annuleer', appointment_id: appointmentId, delegate: r.body });
    }

    // ── Directe status-outcomes ────────────────────────────────────────
    let newStatus = null;
    let noteText  = '';
    let followupLead = null;    // { lead_id, already }
    let extraWarnings = [];

    if (outcome === 'gesprek_gehad') {
      newStatus = 'completed';
      noteText  = 'Gesprek gehad via Zoom';
    } else if (outcome === 'sale') {
      newStatus = 'completed';
      noteText  = 'Sale geworden via Zoom-call 🎉';
    } else if (outcome === 'wilt_niet_meer') {
      newStatus = 'cancelled';
      noteText  = 'Geen interesse — call was al gevoerd, GHL/Zoom NIET geannuleerd';
    } else if (outcome === 'no_show') {
      newStatus = 'no_show';
      noteText  = 'No-show — nabellen gepland (+2u)';
      try {
        followupLead = await createFollowupLead({
          appt,
          terugbelDatum: hoursFromNow(2),
          leadKind     : 'bel',
          noteReason   : 'no_show_followup',
        });
      } catch (e) {
        if (e.code === 'MIGRATION_REQUIRED') return res.status(501).json({ error: e.message, code: 'MIGRATION_REQUIRED' });
        extraWarnings.push('follow_up_lead-aanmaak mislukt: ' + (e.message || 'onbekend'));
      }
    } else if (outcome === 'later_opnieuw') {
      newStatus = 'completed';
      const months = Number(body.snooze_months) || 3;
      noteText = `Bedenktijd — opvolgen over ${months} maanden`;
      try {
        followupLead = await createFollowupLead({
          appt,
          statusOverrides: { lead_status: 'terugbellen' },
          snoozeMonths   : months,
          terugbelDatum  : monthsFromNow(months),
          leadKind       : 'bel',
          noteReason     : 'later_opnieuw',
        });
      } catch (e) {
        if (e.code === 'MIGRATION_REQUIRED') return res.status(501).json({ error: e.message, code: 'MIGRATION_REQUIRED' });
        extraWarnings.push('follow_up_lead-aanmaak mislukt: ' + (e.message || 'onbekend'));
      }
    } else if (outcome === 'terugbel') {
      if (!body.terugbel_datum) return res.status(400).json({ error: 'terugbel_datum vereist' });
      const dt = new Date(body.terugbel_datum);
      if (isNaN(dt.getTime())) return res.status(400).json({ error: 'terugbel_datum ongeldig' });
      const kind = ['bel', 'zoom'].includes(body.lead_kind) ? body.lead_kind : 'bel';
      newStatus = 'completed';
      noteText = `Terugbel-afspraak gepland (${kind}) op ${dt.toLocaleString('nl-NL', { dateStyle:'short', timeStyle:'short' })}`;
      try {
        followupLead = await createFollowupLead({
          appt,
          terugbelDatum: dt.toISOString(),
          leadKind     : kind,
          noteReason   : 'terugbel',
        });
      } catch (e) {
        if (e.code === 'MIGRATION_REQUIRED') return res.status(501).json({ error: e.message, code: 'MIGRATION_REQUIRED' });
        extraWarnings.push('follow_up_lead-aanmaak mislukt: ' + (e.message || 'onbekend'));
      }
    }

    if (newStatus) {
      await updateApptStatus(appointmentId, newStatus);
      await appendApptNote(appointmentId, noteText);
    }

    return res.status(200).json({
      ok            : true,
      appointment_id: appointmentId,
      new_status    : newStatus,
      followup_lead : followupLead,
      warnings      : extraWarnings.length ? extraWarnings : undefined,
    });
  } catch (e) {
    console.error('[follow-up-appointment-outcome]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
