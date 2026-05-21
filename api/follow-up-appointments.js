// api/follow-up-appointments.js
//
// Data endpoint voor de Follow-up Module frontend.
//
// GET  /api/follow-up-appointments?period=today|week|custom&status=scheduled,no_show
//   → Retourneert appointments via RLS-aware query (Dave ziet eigen,
//     ADMIN_ROLES ziet alles)
//
// PATCH /api/follow-up-appointments
//   Body: { id: uuid, voicememo_status: 'pending'|'sent'|'skipped'|'no_whatsapp' }
//   → Update voicememo afvinken na verzending door Dave
//
// Auth: Authorization Bearer <supabase-jwt> via createUserClient

import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);

  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  if (req.method === 'GET') {
    return handleGet(req, res, supabase);
  }

  if (req.method === 'PATCH') {
    return handlePatch(req, res, supabase, user);
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}

async function handleGet(req, res, supabase) {
  const period = req.query.period || 'today';
  const statusFilter = req.query.status ? String(req.query.status).split(',') : null;

  const now = new Date();
  let startDate, endDate;

  if (period === 'today') {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
  } else if (period === 'morgen') {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    startDate.setDate(startDate.getDate() + 1);
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 1);
  } else if (period === 'week') {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);
  } else if (period === 'past_week') {
    endDate = new Date(now);
    startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 7);
  } else if (period === 'opvolging_overdue') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    return await fetchOpvolgingRange(supabase, null, today, period, res);

  } else if (period === 'opvolging_today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const { data: outcomes, error: outErr } = await supabase
      .from('follow_up_outcomes')
      .select('appointment_id, outcome, terugkom_datum, opvolging_status')
      .gte('terugkom_datum', today.toISOString().slice(0, 10))
      .lt('terugkom_datum', tomorrow.toISOString().slice(0, 10))
      .in('opvolging_status', ['gepland', 'verzet']);

    if (outErr) {
      return res.status(500).json({ error: outErr.message });
    }

    const ids = (outcomes || []).map(o => o.appointment_id);
    if (ids.length === 0) {
      return res.status(200).json({ period, count: 0, appointments: [] });
    }

    const { data, error } = await supabase
      .from('follow_up_appointments')
      .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, voicememo_status, zoom_meeting_id, zoom_join_url, owner_id')
      .in('id', ids)
      .in('status', ['scheduled', 'in_progress', 'completed', 'no_show']);

    // Merge terugkom_datum + opvolging_status uit outcomes
    const outcomeMap = new Map((outcomes || []).map(o => [o.appointment_id, o]));

    // Verrijk met has_outcome
    const todayOutcomeIds = (data || []).map(a => a.id);
    let todayOutcomeSet = new Set();
    if (todayOutcomeIds.length > 0) {
      const { data: todayOutcomes } = await supabase
        .from('follow_up_outcomes')
        .select('appointment_id')
        .in('appointment_id', todayOutcomeIds);
      todayOutcomeSet = new Set((todayOutcomes || []).map(o => o.appointment_id));
    }

    const enriched = (data || []).map(a => ({
      ...a,
      terugkom_datum: outcomeMap.get(a.id)?.terugkom_datum,
      opvolging_status: outcomeMap.get(a.id)?.opvolging_status,
      has_outcome: todayOutcomeSet.has(a.id),
      outcome: outcomeMap.get(a.id)?.outcome || null,
    }));

    return res.status(200).json({
      period,
      count: enriched.length,
      appointments: enriched,
    });

  } else if (period === 'opvolging_week') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const weekEnd = new Date(today);
    weekEnd.setDate(weekEnd.getDate() + 7);

    return await fetchOpvolgingRange(supabase, tomorrow, weekEnd, period, res);

  } else if (period === 'opvolging_30d') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() + 8);
    const end = new Date();
    end.setDate(end.getDate() + 30);

    return await fetchOpvolgingRange(supabase, start, end, period, res);

  } else if (period === 'opvolging_verder') {
    const start = new Date();
    start.setDate(start.getDate() + 31);

    return await fetchOpvolgingRange(supabase, start, null, period, res);

  } else if (period === 'recent_completed') {
    // Optie C: vandaag + gisteren (00:00 gisteren t/m einde vandaag)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const { data, error } = await supabase
      .from('follow_up_appointments')
      .select('id, lead_name, lead_email, scheduled_at, status, voicememo_status, zoom_meeting_id, zoom_join_url, owner_id, parent_appointment_id')
      .in('status', ['completed', 'no_show', 'cancelled', 'verplaatst'])
      .gte('scheduled_at', yesterday.toISOString())
      .lt('scheduled_at', tomorrow.toISOString())
      .order('scheduled_at', { ascending: false })
      .limit(50);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Verrijk met has_outcome (bug-fix: was ontbrekend, veroorzaakte verkeerde "Outcome" label na opslaan)
    const rcIds = (data || []).map(a => a.id);
    let rcEnriched = data || [];
    if (rcIds.length > 0) {
      const { data: rcOutcomes } = await supabase
        .from('follow_up_outcomes')
        .select('appointment_id, outcome')
        .in('appointment_id', rcIds);
      const rcOutcomeMap = new Map((rcOutcomes || []).map(o => [o.appointment_id, o]));
      rcEnriched = data.map(a => ({
        ...a,
        has_outcome: rcOutcomeMap.has(a.id),
        outcome: rcOutcomeMap.get(a.id)?.outcome || null,
      }));
    }

    return res.status(200).json({ period, count: rcEnriched.length, appointments: rcEnriched });

  } else if (period === 'open_acties') {
    const cutoff = new Date(Date.now() - 30 * 60 * 1000);

    const { data: appts, error: apptErr } = await supabase
      .from('follow_up_appointments')
      .select('id, lead_name, lead_email, scheduled_at, status, voicememo_status, zoom_meeting_id, zoom_join_url, owner_id, parent_appointment_id')
      .lt('scheduled_at', cutoff.toISOString())
      .in('status', ['scheduled', 'in_progress', 'completed', 'no_show'])
      .order('scheduled_at', { ascending: false })
      // Limit ruimer dan strikt nodig: outcome-filter gebeurt in JS na fetch,
      // dus we willen voldoende ruimte om legacy items zonder outcome te vinden
      // ook al zijn ze ouder dan de meest recente 50.
      .limit(500);

    if (apptErr) {
      return res.status(500).json({ error: apptErr.message });
    }

    const apptIds = (appts || []).map(a => a.id);
    if (apptIds.length === 0) {
      return res.status(200).json({ period, count: 0, appointments: [] });
    }

    const { data: existingOutcomes } = await supabase
      .from('follow_up_outcomes')
      .select('appointment_id, niet_meer_opvolgen')
      .in('appointment_id', apptIds);

    const withOutcome = new Set((existingOutcomes || []).map(o => o.appointment_id));
    const nietMeerOpvolgen = new Set(
      (existingOutcomes || [])
        .filter(o => o.niet_meer_opvolgen === true)
        .map(o => o.appointment_id)
    );
    const openActies = (appts || []).filter(a => {
      const memoPending = a.voicememo_status === 'pending';
      const noOutcome = !withOutcome.has(a.id);
      const nietMeer = nietMeerOpvolgen.has(a.id);

      // Memo pending is altijd actie nodig (voicememo verplicht per business rule)
      if (memoPending) return true;

      // Anders: outcome ontbreekt EN niet als 'klaar' gemarkeerd
      return noOutcome && !nietMeer;
    });

    return res.status(200).json({
      period,
      count: openActies.length,
      appointments: openActies,
    });

  } else {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 30);
  }

  let query = supabase
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, duration_minutes, status, voicememo_status, voicememo_sent_at, requires_screenshot, screenshot_url, snelle_notitie, zoom_meeting_id, zoom_join_url, owner_id, created_at, parent_appointment_id')
    .gte('scheduled_at', startDate.toISOString())
    .lt('scheduled_at', endDate.toISOString())
    .order('scheduled_at', { ascending: true });

  if (statusFilter && statusFilter.length > 0) {
    query = query.in('status', statusFilter);
  } else if (period !== 'today') {
    // Default voor toekomst-periodes (week, morgen, custom):
    // alleen actieve afspraken — cancelled/verplaatst niet tonen in komende-overzichten.
    query = query.in('status', ['scheduled', 'in_progress']);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[appointments-get] db error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  // Verrijk met has_outcome voor visuele outcome-indicator op cards
  const apptIds = (data || []).map(a => a.id);
  let enrichedAppts = data || [];
  if (apptIds.length > 0) {
    const { data: outcomes } = await supabase
      .from('follow_up_outcomes')
      .select('appointment_id, outcome')
      .in('appointment_id', apptIds);
    const outcomeEnrichMap = new Map((outcomes || []).map(o => [o.appointment_id, o]));
    enrichedAppts = data.map(a => ({
      ...a,
      has_outcome: outcomeEnrichMap.has(a.id),
      outcome: outcomeEnrichMap.get(a.id)?.outcome || null,
    }));
  }

  // Verrijk met parent_outcome voor card-context label (child-appointments)
  enrichedAppts = await enrichWithParentOutcome(supabase, enrichedAppts);

  // Optie-C filter: today-tab toont alleen calls binnen 30-min grace-window
  // (toekomst + net begonnen); cancelled/verplaatst/verwijderd worden altijd uitgefilterd.
  // Calls van >30min geleden zonder outcome: verschijnen in Open acties.
  if (period === 'today') {
    const cutoff30 = new Date(Date.now() - 30 * 60 * 1000);
    enrichedAppts = enrichedAppts.filter(a =>
      new Date(a.scheduled_at) >= cutoff30
      && !['cancelled', 'verplaatst', 'verwijderd'].includes(a.status)
    );
  }

  return res.status(200).json({
    period,
    range: { start: startDate.toISOString(), end: endDate.toISOString() },
    count: enrichedAppts.length,
    appointments: enrichedAppts,
  });
}

async function handlePatch(req, res, supabase, user) {
  const { id, voicememo_status, status: newStatus } = req.body || {};

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Veld id ontbreekt of ongeldig.' });
  }

  // ── PAD A: voicememo_status bijwerken ──────────────────────────────────────
  if (voicememo_status !== undefined) {
    if (!['pending', 'sent', 'skipped', 'no_whatsapp'].includes(voicememo_status)) {
      return res.status(400).json({ error: 'voicememo_status moet pending, sent, skipped of no_whatsapp zijn.' });
    }

    const update = {
      voicememo_status,
      voicememo_sent_at: voicememo_status === 'sent' ? new Date().toISOString() : null,
      voicememo_sent_by: voicememo_status === 'sent' ? user.id : null,
    };

    const { data, error } = await supabase
      .from('follow_up_appointments')
      .update(update)
      .eq('id', id)
      .select('id, voicememo_status, voicememo_sent_at, voicememo_sent_by, owner_id')
      .single();

    if (error) {
      console.error('[appointments-patch] db error:', error.message);
      return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
    }

    let requiresScreenshot = false;
    if (voicememo_status === 'sent') {
      // Super_admin is vertrouwd — geen screenshot steekproef
      const { data: userProfile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();

      const isSuperAdmin = userProfile?.role === 'super_admin';
      if (!isSuperAdmin && Math.random() < 0.15) {
        requiresScreenshot = true;
        await supabase
          .from('follow_up_appointments')
          .update({ requires_screenshot: true })
          .eq('id', id);
      }
    }

    return res.status(200).json({ updated: data, requires_screenshot: requiresScreenshot });
  }

  // ── PAD B: status handmatig wijzigen (admin/manager/super_admin + eigen sales) ──
  if (newStatus !== undefined) {
    const ALLOWED_STATUSES = ['scheduled', 'in_progress', 'completed', 'no_show', 'cancelled'];
    if (!ALLOWED_STATUSES.includes(newStatus)) {
      return res.status(400).json({ error: 'Ongeldige status. Toegestaan: ' + ALLOWED_STATUSES.join(', ') });
    }

    // Haal profile op voor role-check
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (!profile) {
      return res.status(403).json({ error: 'Profiel niet gevonden.' });
    }

    const STATUS_ALLOWED_ROLES = ['sales', 'manager', 'admin', 'super_admin'];
    if (!STATUS_ALLOWED_ROLES.includes(profile.role)) {
      return res.status(403).json({ error: 'Onvoldoende rechten om status te wijzigen.' });
    }

    // Haal huidige status + eigenaar op voor audit en salescheck
    const { data: currentAppt, error: fetchErr } = await supabase
      .from('follow_up_appointments')
      .select('status, owner_id')
      .eq('id', id)
      .single();

    if (fetchErr || !currentAppt) {
      return res.status(404).json({ error: 'Appointment niet gevonden of geen toegang.' });
    }

    // Sales mag uitsluitend eigen appointments wijzigen (extra check bovenop RLS)
    if (profile.role === 'sales' && currentAppt.owner_id !== user.id) {
      return res.status(403).json({ error: 'Sales mag alleen eigen appointments wijzigen.' });
    }

    if (currentAppt.status === newStatus) {
      return res.status(200).json({ success: true, message: 'Status was al ' + newStatus });
    }

    const { error: updateErr } = await supabase
      .from('follow_up_appointments')
      .update({ status: newStatus })
      .eq('id', id);

    if (updateErr) {
      console.error('[appointments-patch] status update error:', updateErr.message);
      return res.status(500).json({ error: updateErr.message });
    }

    // Audit-log
    await supabase
      .from('follow_up_events_log')
      .insert({
        source: 'manual',
        event_type: 'manual_status_change',
        payload: {
          appointment_id: id,
          from: currentAppt.status,
          to: newStatus,
          changed_by_user_id: user.id,
          changed_by_role: profile.role,
        },
        processed: true,
      });

    return res.status(200).json({ success: true, from: currentAppt.status, to: newStatus });
  }

  // Geen geldig veld meegegeven
  return res.status(400).json({ error: 'Geef voicememo_status of status mee in de body.' });
}

// Verrijk appointments met parent_outcome voor child-rows (parent-child follow-up patroon).
// Batch-query: één extra round-trip voor alle unieke parent_ids in de set.
export async function enrichWithParentOutcome(supabase, appointments) {
  const parentIds = [...new Set(
    appointments.map(a => a.parent_appointment_id).filter(Boolean)
  )];
  if (parentIds.length === 0) return appointments;

  const { data: parentOutcomes } = await supabase
    .from('follow_up_outcomes')
    .select('appointment_id, outcome, ingevuld_at')
    .in('appointment_id', parentIds);

  const outcomeMap = new Map((parentOutcomes || []).map(o => [o.appointment_id, o]));

  return appointments.map(a => ({
    ...a,
    parent_outcome: a.parent_appointment_id
      ? (outcomeMap.get(a.parent_appointment_id) || null)
      : null,
  }));
}

async function fetchOpvolgingRange(supabase, startDate, endDate, period, res) {
  let query = supabase
    .from('follow_up_outcomes')
    .select('appointment_id, outcome, terugkom_datum, opvolging_status')
    .in('opvolging_status', ['gepland', 'verzet'])
    .not('terugkom_datum', 'is', null);

  if (startDate) {
    query = query.gte('terugkom_datum', startDate.toISOString().slice(0, 10));
  }
  if (endDate) {
    query = query.lt('terugkom_datum', endDate.toISOString().slice(0, 10));
  }

  const { data: outcomes, error: outErr } = await query;

  if (outErr) {
    return res.status(500).json({ error: outErr.message });
  }

  const ids = (outcomes || []).map(o => o.appointment_id);
  if (ids.length === 0) {
    return res.status(200).json({ period, count: 0, appointments: [] });
  }

  const { data, error } = await supabase
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, status, voicememo_status, zoom_meeting_id, zoom_join_url, owner_id')
    .in('id', ids)
    .in('status', ['scheduled', 'in_progress', 'completed', 'no_show']);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  // Verrijk met has_outcome zodat opvolging-cards de juiste "Outcome" / "Outcome wijzigen" knop tonen
  const apptIds = (data || []).map(a => a.id);
  let hasOutcomeSet = new Set();
  if (apptIds.length > 0) {
    const { data: existingOutcomes } = await supabase
      .from('follow_up_outcomes')
      .select('appointment_id')
      .in('appointment_id', apptIds);
    hasOutcomeSet = new Set((existingOutcomes || []).map(o => o.appointment_id));
  }

  const outcomeMap = new Map((outcomes || []).map(o => [o.appointment_id, o]));
  const enriched = (data || []).map(a => ({
    ...a,
    terugkom_datum: outcomeMap.get(a.id)?.terugkom_datum,
    opvolging_status: outcomeMap.get(a.id)?.opvolging_status,
    has_outcome: hasOutcomeSet.has(a.id),
    outcome: outcomeMap.get(a.id)?.outcome || null,
  }));

  return res.status(200).json({ period, count: enriched.length, appointments: enriched });
}
