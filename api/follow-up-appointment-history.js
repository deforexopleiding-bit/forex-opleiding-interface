import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Ongeldige token' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id vereist' });

  // Fetch huidige appointment voor lead_ghl_contact_id
  const { data: current } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_ghl_contact_id, parent_appointment_id')
    .eq('id', id)
    .maybeSingle();

  if (!current) return res.status(404).json({ error: 'Niet gevonden' });

  if (!current.lead_ghl_contact_id) {
    return res.status(200).json({ history: [] });
  }

  // Alle andere appointments van dezelfde lead, gesorteerd nieuwste eerst
  const { data: history } = await supabaseAdmin
    .from('follow_up_appointments')
    .select('id, scheduled_at, status, duration_minutes')
    .eq('lead_ghl_contact_id', current.lead_ghl_contact_id)
    .neq('id', id)
    .order('scheduled_at', { ascending: false });

  return res.status(200).json({ history: history || [] });
}
