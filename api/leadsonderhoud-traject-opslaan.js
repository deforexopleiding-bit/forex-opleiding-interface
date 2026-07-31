// api/leadsonderhoud-traject-opslaan.js
// POST -> maakt een traject aan (geen id) of werkt het bij (met id).
// Bron: onderhoud_trajecten. Alleen de toegestane velden worden overgenomen;
// onbekende velden in de body worden genegeerd (whitelist-patroon).
//
// Gate: leads.view (zoals de rest van de module — bewuste keuze voor nu).
//
// Body: { id?, slug, naam, omschrijving?, agent?, agenda_link?, archief_na?, volgorde?, actief? }
// Response: { traject }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  const b = req.body || {};
  const naam = (b.naam || '').trim();
  const slug = (b.slug || '').trim();
  if (!naam) return res.status(400).json({ error: 'Naam is verplicht' });
  if (!slug) return res.status(400).json({ error: 'Slug is verplicht' });

  // Alleen deze velden mogen gezet worden.
  const velden = {
    slug,
    naam,
    omschrijving: b.omschrijving != null ? String(b.omschrijving) : null,
    agent: b.agent != null ? String(b.agent) : null,
    agenda_link: b.agenda_link != null ? String(b.agenda_link) : null,
    archief_na: Number.isFinite(Number(b.archief_na)) ? Number(b.archief_na) : 30,
    volgorde: Number.isFinite(Number(b.volgorde)) ? Number(b.volgorde) : 1,
    actief: b.actief !== false,
  };

  try {
    let rij;
    if (b.id) {
      const { data, error } = await supabaseAdmin
        .from('onderhoud_trajecten').update(velden).eq('id', b.id).select().single();
      if (error) throw error;
      rij = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from('onderhoud_trajecten').insert(velden).select().single();
      if (error) throw error;
      rij = data;
    }
    return res.status(200).json({ traject: rij });
  } catch (e) {
    console.error('traject-opslaan mislukt:', e.message);
    // 23505 = unieke slug bestaat al
    if (e.code === '23505') return res.status(409).json({ error: 'Er bestaat al een traject met deze slug' });
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
}
