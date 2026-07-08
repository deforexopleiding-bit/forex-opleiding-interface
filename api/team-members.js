import { supabase } from './supabase.js';
import { safeError } from './_lib/safe-error.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { data, error } = await supabase
      .from('team_members')
      .select('id, name, role, type')
      .eq('is_active', true)
      .order('name');
    if (error) throw error;
    return res.status(200).json({ members: data || [] });
  } catch (err) {
    return safeError(res, 500, err);
  }
}
