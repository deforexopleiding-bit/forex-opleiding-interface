// api/leadsonderhoud-sjablonen.js
// GET -> alle sjablonen uit onderhoud_sjablonen (inclusief html + platte tekst),
// zodat het Berichten-scherm ze kan tonen én lokaal een voorbeeld kan renderen
// zonder te versturen.
//
// Gate: leads.view. Response: { items: [...] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('onderhoud_sjablonen')
      .select('id, traject_slug, soort, kanaal, onderwerp, html, tekst, meta_template, variabele_volgorde, score_min, score_max, actief')
      .order('traject_slug', { ascending: true })
      .order('kanaal', { ascending: true })
      .order('soort', { ascending: true });
    if (error) throw error;
    const { data: logoRow } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', 'leadsonderhoud_logo_url').maybeSingle();
    return res.status(200).json({ items: data, logo_url: (logoRow && logoRow.value) || '' });
  } catch (e) {
    console.error('sjablonen laden mislukt:', e.message);
    return res.status(500).json({ error: 'Sjablonen laden mislukt' });
  }
}
