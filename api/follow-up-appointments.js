// api/follow-up-appointments.js
//
// Data endpoint voor de Follow-up Module frontend.
//
// GET  /api/follow-up-appointments?period=today|week|custom&status=scheduled,no_show
//   → Retourneert appointments via RLS-aware query (Dave ziet eigen,
//     ADMIN_ROLES ziet alles)
//
// PATCH /api/follow-up-appointments
//   Body: { id: uuid, voicememo_status: 'sent'|'skipped' }
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
  } else if (period === 'week') {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 7);
  } else if (period === 'past_week') {
    endDate = new Date(now);
    startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 7);
  } else {
    startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 30);
  }

  let query = supabase
    .from('follow_up_appointments')
    .select('id, lead_name, lead_email, lead_phone, scheduled_at, duration_minutes, status, voicememo_status, voicememo_sent_at, requires_screenshot, screenshot_url, snelle_notitie, owner_id, created_at')
    .gte('scheduled_at', startDate.toISOString())
    .lt('scheduled_at', endDate.toISOString())
    .order('scheduled_at', { ascending: true });

  if (statusFilter && statusFilter.length > 0) {
    query = query.in('status', statusFilter);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[appointments-get] db error:', error.message);
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({
    period,
    range: { start: startDate.toISOString(), end: endDate.toISOString() },
    count: data?.length || 0,
    appointments: data || [],
  });
}

async function handlePatch(req, res, supabase, user) {
  const { id, voicememo_status } = req.body || {};

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Veld id ontbreekt of ongeldig.' });
  }

  if (!['sent', 'skipped'].includes(voicememo_status)) {
    return res.status(400).json({ error: 'voicememo_status moet sent of skipped zijn.' });
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
    .select('id, voicememo_status, voicememo_sent_at, voicememo_sent_by')
    .single();

  if (error) {
    console.error('[appointments-patch] db error:', error.message);
    return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
  }

  return res.status(200).json({ updated: data });
}
