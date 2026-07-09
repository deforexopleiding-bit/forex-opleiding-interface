// api/event-followup-to-lead.js
//
// POST { followup_id } → maak of vind een open lead in follow_up_leads
// met source='event' voor het bijbehorende event-followup / attendee.
// Schrijft alleen follow_up_leads; event_followups wordt alleen gelezen
// zodat Dave's bestaande event-followup-flow ongemoeid blijft.
//
// Fallback: als de caller alleen een attendee_id heeft (bv. inline event
// zonder followup-rij) mag hij die ook meesturen — we gaan dan direct
// naar de attendee.
//
// Permission: events.event.view OF sales.tab.retentie.
//
// Response 200: { ok:true, lead_id, already:false|true }
// Response 501: 42P01 (follow_up_leads ontbreekt) → MIGRATION_REQUIRED

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function displayName(att) {
  const parts = [att?.first_name, att?.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
  const joined = parts.join(' ').trim();
  return joined || att?.email || '(onbekend)';
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
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (events.event.view of sales.tab.retentie)' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const followupId = typeof body.followup_id === 'string' ? body.followup_id.trim() : '';
  const bodyAttendeeId = typeof body.attendee_id === 'string' ? body.attendee_id.trim() : '';
  if (!followupId && !bodyAttendeeId) return res.status(400).json({ error: 'followup_id of attendee_id vereist' });
  if (followupId && !UUID_RE.test(followupId))    return res.status(400).json({ error: 'followup_id ongeldig' });
  if (bodyAttendeeId && !UUID_RE.test(bodyAttendeeId)) return res.status(400).json({ error: 'attendee_id ongeldig' });

  try {
    // 1) Followup + attendee/event-context ophalen. followup_id heeft
    //    voorrang; anders vallen we terug op de losse attendee.
    let followup = null;
    let attendeeId = bodyAttendeeId || null;
    let eventId = null;
    let reason = null;
    let followDate = null;

    if (followupId) {
      const { data: fu, error: fuErr } = await supabaseAdmin
        .from('event_followups')
        .select('id, attendee_id, event_id, reason, follow_up_date')
        .eq('id', followupId)
        .maybeSingle();
      if (fuErr) throw new Error('event_followups fetch: ' + fuErr.message);
      if (!fu) return res.status(404).json({ error: 'Followup niet gevonden' });
      followup   = fu;
      attendeeId = fu.attendee_id || attendeeId;
      eventId    = fu.event_id || null;
      reason     = fu.reason || null;
      followDate = fu.follow_up_date || null;
    }
    if (!attendeeId) return res.status(400).json({ error: 'Geen attendee gekoppeld aan followup' });

    const { data: att, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, customer_id, deal_id, first_name, last_name, email, phone')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('event_attendees fetch: ' + attErr.message);
    if (!att) return res.status(404).json({ error: 'Attendee niet gevonden' });
    if (!eventId) eventId = att.event_id || null;

    // 2) INSERT poging.
    const insertRow = {
      customer_id: att.customer_id || null,
      source     : 'event',
      lead_name  : displayName(att),
      lead_email : att.email || null,
      lead_phone : att.phone || null,
      lead_status: 'nieuw',
      // Punt B: terugbel_datum = de geplande follow-up-datum uit het
      // event_followups-record. Zonder dit stond de lead altijd 'nu' in
      // de werklijst i.p.v. op de gekozen opvolgdatum.
      terugbel_datum: followDate,
      source_ref : {
        event_id   : eventId,
        attendee_id: att.id,
        // Marker voor de Follow-up cockpit: deze lead komt uit het
        // event-afrond-scherm (outcome 'opvolgen' / 'twijfelt_nog' / no_show).
        // Frontend toont een 'Follow-up event'-badge + de reason als notitie.
        is_event_followup: true,
        ...(followup ? { followup_id: followup.id } : {}),
        ...(reason   ? { reason }                   : {}),
      },
      created_by_user_id: user.id,
    };

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('follow_up_leads')
      .insert(insertRow)
      .select('id')
      .maybeSingle();

    if (!insErr && inserted?.id) {
      return res.status(200).json({ ok: true, lead_id: inserted.id, already: false });
    }

    if (insErr?.code === '42P01') {
      return res.status(501).json({ error: 'Tabel follow_up_leads ontbreekt — migratie vereist', code: 'MIGRATION_REQUIRED' });
    }

    if (insErr?.code === '23505') {
      // Unique-index: (customer_id, source) WHERE lead_status NOT IN
      // ('verlengd','verloren'). Werkt alleen als customer_id niet NULL is.
      // Bij attendee zonder klant komt 23505 dus niet — dan mag een tweede
      // insert wel doorgaan (dat is een acceptabele naam-gebaseerde lead).
      let existingQuery = supabaseAdmin
        .from('follow_up_leads')
        .select('id, lead_status')
        .eq('source', 'event')
        .not('lead_status', 'in', '(verlengd,verloren)')
        .order('created_at', { ascending: false })
        .limit(1);
      if (att.customer_id) existingQuery = existingQuery.eq('customer_id', att.customer_id);
      const { data: existing } = await existingQuery.maybeSingle();
      return res.status(200).json({
        ok: true, already: true,
        lead_id    : existing?.id || null,
        lead_status: existing?.lead_status || null,
      });
    }

    console.error('[event-followup-to-lead] insert:', insErr?.message || insErr);
    return res.status(500).json({ error: insErr?.message || 'Insert mislukt' });
  } catch (e) {
    console.error('[event-followup-to-lead]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
