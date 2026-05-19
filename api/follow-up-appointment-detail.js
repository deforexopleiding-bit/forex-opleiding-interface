// api/follow-up-appointment-detail.js
//
// GET  ?id=<appointment_id> — appointment + outcome + lead history
// PATCH ?id=<appointment_id> body: { snelle_notitie } — update patchable fields

import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET') {
    return await handleGet(req, res);
  }
  if (req.method === 'PATCH') {
    return await handlePatch(req, res);
  }
  return res.status(405).json({ error: 'Method not allowed.' });
}

async function handleGet(req, res) {
  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  const id = req.query.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Query parameter id ontbreekt.' });
  }

  const { data: appt, error: apptErr } = await supabase
    .from('follow_up_appointments')
    .select('*')
    .eq('id', id)
    .single();

  if (apptErr || !appt) {
    return res.status(404).json({ error: 'Appointment niet gevonden of geen toegang.' });
  }

  const { data: outcome } = await supabase
    .from('follow_up_outcomes')
    .select('*')
    .eq('appointment_id', id)
    .order('ingevuld_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: history } = await supabase
    .from('follow_up_appointments')
    .select('id, lead_name, scheduled_at, status, voicememo_status, duration_minutes')
    .eq('lead_ghl_contact_id', appt.lead_ghl_contact_id)
    .neq('id', id)
    .order('scheduled_at', { ascending: false })
    .limit(20);

  // Screenshot audit status ophalen (tabel bestaat als screenshot-audit feature actief is)
  // Geen .catch() chaining — supabase v2 geeft errors altijd via result.error, niet via rejection
  let screenshotAudit = null;
  try {
    const { data: auditData } = await supabase
      .from('follow_up_screenshot_audit')
      .select('admin_reviewed, ai_review_result, review_notes')
      .eq('appointment_id', id)
      .maybeSingle();
    screenshotAudit = auditData || null;
  } catch {
    // Tabel bestaat mogelijk nog niet — niet blokkerend
  }

  return res.status(200).json({
    appointment: appt,
    outcome: outcome || null,
    lead_history: history || [],
    screenshot_audit: screenshotAudit || null,
  });
}

async function handlePatch(req, res) {
  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return res.status(401).json({ error: 'Niet geauthenticeerd.' });
  }

  const id = req.query.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Query parameter id ontbreekt.' });
  }

  const body = req.body || {};
  const updates = {};

  if (typeof body.snelle_notitie === 'string') {
    updates.snelle_notitie = body.snelle_notitie.slice(0, 2000) || null;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Geen veld om te updaten.' });
  }

  const { data, error } = await supabase
    .from('follow_up_appointments')
    .update(updates)
    .eq('id', id)
    .select('id, snelle_notitie')
    .single();

  if (error) {
    console.error('[appointment-detail-patch] error:', error.message);
    return res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message });
  }

  return res.status(200).json({ updated: data });
}
