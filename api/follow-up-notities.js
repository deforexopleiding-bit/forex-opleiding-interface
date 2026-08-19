// api/follow-up-notities.js
//
// GET  ?appointment_id=<id> — haal notities op voor een appointment
// POST body: { appointment_id, body } — voeg nieuwe notitie toe

import { createClient } from '@supabase/supabase-js';
import { requireCrmStaff } from './_lib/crm-roles.js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // Dit endpoint leest én schrijft CRM-data via de service-role client (RLS
  // wordt dus omzeild). Een check op "geldig JWT" alleen is niet genoeg: elk
  // auto-aangemaakt viewer/student-account heeft een geldig JWT. Daarom een
  // expliciete rolcheck — zelfde poort als public.is_crm_staff() in RLS.
  const auth = await requireCrmStaff(req);
  if (!auth) return res.status(403).json({ error: 'Toegang geweigerd. CRM-rol vereist.' });

  const { user, profile } = auth;

  if (req.method === 'GET') {
    const { appointment_id } = req.query;
    if (!appointment_id) {
      return res.status(400).json({ error: 'appointment_id vereist' });
    }

    const { data, error } = await supabaseAdmin
      .from('follow_up_notities')
      .select('*')
      .eq('appointment_id', appointment_id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ notities: data || [] });
  }

  if (req.method === 'POST') {
    const { appointment_id, body: noteBody } = req.body || {};
    if (!appointment_id || !noteBody?.trim()) {
      return res.status(400).json({ error: 'appointment_id en body vereist' });
    }

    const { data, error } = await supabaseAdmin
      .from('follow_up_notities')
      .insert({
        appointment_id,
        body: noteBody.trim(),
        created_by: user.id,
        created_by_name: profile?.full_name || user.email,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json(data);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
