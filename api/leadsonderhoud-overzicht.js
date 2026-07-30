// api/leadsonderhoud-overzicht.js
// GET -> het overzicht van alle lopende proefperiodes, over alle trajecten heen.
// Bron: view trial_warmte (score + activiteit per proefgebruiker) verrijkt met
// het echte laatste contact uit trial_laatste_contact (een bericht van hen, van
// ons, of een login — de view rekent dat uit).
//
// Alleen lezen. We gaten voorlopig op leads.view; leadsonderhoud is een
// leads-tool, dus wie de Leads-afdeling mag zien mag ook dit overzicht zien.
// Een eigen key (leadsonderhoud.view) kan dit later vervangen zonder de
// endpoints te wijzigen.
//
// Query-params (optioneel):
//   traject   filter op trajectslug (nu alleen 7-daagse gevuld, maar de view
//             groeit mee); leeg = alles
//   archief   '1' -> toon gearchiveerde leads i.p.v. de lopende
//
// Response: { items: [ ...trial_warmte-rij + laatste_contact ], totaal }

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
    // De warmte-view bevat alle lopende proefperiodes met hun score en
    // activiteit. Gesorteerd op score aflopend zodat de warmste bovenaan staan.
    const { data: warmte, error } = await supabaseAdmin
      .from('trial_warmte')
      .select('*')
      .order('score', { ascending: false });
    if (error) throw error;

    // Het echte laatste contact staat in een aparte view. In één keer ophalen
    // en per gebruiker koppelen, zodat we niet per rij een query doen.
    const ids = warmte.map((r) => r.gebruiker_id).filter(Boolean);
    const laatstePerId = {};
    if (ids.length) {
      const { data: contact } = await supabaseAdmin
        .from('trial_laatste_contact')
        .select('gebruiker_id, laatste_contact')
        .in('gebruiker_id', ids);
      for (const c of contact || []) laatstePerId[c.gebruiker_id] = c.laatste_contact;
    }

    const items = warmte.map((r) => ({
      ...r,
      laatste_contact: laatstePerId[r.gebruiker_id] || null,
    }));

    return res.status(200).json({ items, totaal: items.length });
  } catch (e) {
    console.error('leadsonderhoud-overzicht mislukt:', e.message);
    return res.status(500).json({ error: 'Overzicht laden mislukt' });
  }
}
