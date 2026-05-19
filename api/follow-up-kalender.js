import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const ALLOWED_ROLES = ['sales', 'manager', 'admin', 'super_admin'];

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Ongeldige token' });

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('id, role')
    .eq('id', user.id)
    .maybeSingle();

  if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
    return res.status(403).json({ error: 'Onvoldoende rechten' });
  }

  const { start, end, owner } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start en end vereist' });
  }

  let query = supabaseAdmin
    .from('follow_up_appointments')
    .select('id, lead_name, scheduled_at, status, duration_minutes, owner_id')
    .gte('scheduled_at', start)
    .lte('scheduled_at', end)
    .order('scheduled_at');

  // Sales: alleen eigen appointments
  if (profile.role === 'sales') {
    query = query.eq('owner_id', user.id);
  } else if (owner) {
    // Manager+: optionele filter per medewerker
    query = query.eq('owner_id', owner);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ appointments: data || [] });
}
