// api/leads-soorten.js
// GET → distinct soort-waarden uit public.leads_overzicht, voor de dynamische
// soort-filter in de leads-module. Permission: leads.view.
//
// Response: { soorten: ['7-daagse', 'event', ...] }  (gesorteerd, zonder null)

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
    // Eén kolom, alle rijen; distinct in JS (leads is een klein funnel/event-
    // bestand). Cap als veiligheid tegen pathologische groei.
    const { data, error } = await supabaseAdmin
      .from('leads_overzicht')
      .select('soort')
      .not('soort', 'is', null)
      .limit(20000);
    if (error) throw new Error('leads_overzicht: ' + error.message);
    const soorten = [...new Set((data || []).map(r => r.soort).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'nl'));
    return res.status(200).json({ soorten });
  } catch (e) {
    console.error('[leads-soorten]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
