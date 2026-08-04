// api/leads-trajecten.js
// GET → distinct traject-waarden uit public.leads_overzicht, voor de dynamische
// traject-filter in de leads-module. Permission: leads.view.
//
// Sinds Feature 2 staat het traject-type (7-daagse / event / Membership / ...) in
// leads.traject; leads.soort = herkomst. Deze lijst voedt de Traject-dropdown en
// laat de dashboard-deeplink (?traject=) natuurlijk landen.
//
// Response: { trajecten: ['7-daagse', 'event', ...] }  (gesorteerd, zonder null)

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
    // Eén kolom, alleen actieve leads; distinct in JS (leads is een klein
    // funnel/event-bestand). Cap als veiligheid tegen pathologische groei.
    const { data, error } = await supabaseAdmin
      .from('leads_overzicht')
      .select('traject')
      .is('verwijderd_op', null)
      .not('traject', 'is', null)
      .limit(20000);
    if (error) throw new Error('leads_overzicht: ' + error.message);
    const trajecten = [...new Set((data || []).map(r => r.traject).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'nl'));
    return res.status(200).json({ trajecten });
  } catch (e) {
    console.error('[leads-trajecten]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
