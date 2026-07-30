// api/leadsonderhoud-wachtrij.js
// GET -> wat de motor bij de volgende ronde zou versturen, over alle trajecten
// heen. Bron: view onderhoud_wachtrij. De view zit alle voorwaarden al in
// (toestemming, welk bericht, of het al gestuurd is), dus dit endpoint leest
// alleen en sorteert; het beslist niets.
//
// Alleen lezen. Gate: leads.view (zie leadsonderhoud-overzicht.js voor de reden).
//
// Response: { items: [ ...onderhoud_wachtrij-rij ], totaal }

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
    // Zelfde volgorde als de motor aanhoudt: eerst op urgentie, dan op de dag in
    // de proefperiode. Zo zie je in het overzicht wat als eerste zou gaan.
    const { data, error } = await supabaseAdmin
      .from('onderhoud_wachtrij')
      .select('*')
      .order('urgentie', { ascending: true })
      .order('dag', { ascending: true });
    if (error) throw error;

    return res.status(200).json({ items: data, totaal: data.length });
  } catch (e) {
    console.error('leadsonderhoud-wachtrij mislukt:', e.message);
    return res.status(500).json({ error: 'Wachtrij laden mislukt' });
  }
}
