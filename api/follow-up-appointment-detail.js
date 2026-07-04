// api/follow-up-appointment-detail.js
//
// GET  ?id=<appointment_id> — appointment + outcome + lead history
// PATCH ?id=<appointment_id> body: { snelle_notitie } — update patchable fields

import { createUserClient, supabaseAdmin } from './supabase.js';

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

  // Klant-context: match op lower(email) of ghl_contact_id via
  // supabaseAdmin (RLS wordt hier bewust omzeild — permissie is al
  // gecheckt via de authenticated getUser + de appt-fetch). Alleen
  // SELECT. Beide velden zijn optioneel; niet gevonden → null.
  let customerContext = null;
  const email = String(appt.lead_email || '').trim().toLowerCase();
  const ghlId = String(appt.lead_ghl_contact_id || '').trim();
  if (email || ghlId) {
    try {
      const COLS = 'id, first_name, last_name, company_name, email, phone, retention_not_renewing, mentor_id, ghl_contact_id';
      let match = null;
      if (ghlId) {
        const { data } = await supabaseAdmin
          .from('customers').select(COLS)
          .eq('ghl_contact_id', ghlId).limit(1).maybeSingle();
        if (data) match = data;
      }
      if (!match && email) {
        const { data } = await supabaseAdmin
          .from('customers').select(COLS)
          .ilike('email', email).limit(1).maybeSingle();
        if (data) match = data;
      }
      if (match) {
        const parts = [match.first_name, match.last_name].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
        const displayName = parts.join(' ') || match.company_name || match.email || '(onbekend)';
        let mentorName = null;
        if (match.mentor_id) {
          const { data: mentor } = await supabaseAdmin
            .from('team_members').select('name').eq('id', match.mentor_id).maybeSingle();
          mentorName = mentor?.name || null;
        }
        customerContext = {
          id                    : match.id,
          name                  : displayName,
          company_name          : match.company_name || null,
          email                 : match.email || null,
          phone                 : match.phone || null,
          retention_not_renewing: match.retention_not_renewing === true,
          mentor_name           : mentorName,
        };
      }
    } catch (e) {
      // fail-soft: klant-context is een verrijking, niet kritiek voor
      // de appointment-detail zelf.
      console.warn('[appointment-detail] customer_context lookup:', e?.message || e);
    }
  }

  return res.status(200).json({
    appointment    : appt,
    outcome        : outcome || null,
    lead_history   : history || [],
    screenshot_audit: screenshotAudit || null,
    customer_context: customerContext,
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
