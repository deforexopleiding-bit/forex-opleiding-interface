// api/leadsonderhoud-droogloop-log.js
// GET -> wat de motor de afgelopen dagen in droogloop zou hebben verstuurd.
// Bron: berichten_log met status 'droog'. Zo zie je op het wachtrijscherm of de
// juiste mensen het juiste bericht zouden krijgen — het hele doel van de stand.
//
// Gate: leads.view. Response: { items: [...], totaal }

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
    const zevenDagen = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabaseAdmin
      .from('berichten_log')
      .select('gebruiker_id, lead_id, traject, soort, kanaal, naar, agent, verstuurd_op')
      .eq('status', 'droog')
      .gte('verstuurd_op', zevenDagen)
      .order('verstuurd_op', { ascending: false })
      .limit(300);
    if (error) throw error;
    return res.status(200).json({ items: data, totaal: data.length });
  } catch (e) {
    console.error('droogloop-log mislukt:', e.message);
    return res.status(500).json({ error: 'Droogloop-log laden mislukt' });
  }
}
