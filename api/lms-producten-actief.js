// api/lms-producten-actief.js
// GET → actieve LMS-producten (slug, naam, duur_dagen) voor het "lead toevoegen"-
// formulier, zodat je per product een grant met begin/einddatum kunt zetten.
// Permission: leads.update.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.update)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('lms_producten')
      .select('slug, naam, duur_dagen')
      .eq('actief', true)
      .order('volgorde', { ascending: true });
    if (error) throw new Error('lms_producten: ' + error.message);
    return res.status(200).json({ producten: data || [] });
  } catch (e) {
    console.error('[lms-producten-actief]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
