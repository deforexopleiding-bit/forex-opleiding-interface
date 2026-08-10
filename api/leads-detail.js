// api/leads-detail.js
// GET ?id=X → 1 lead volledig: view-velden (uit leads_overzicht) + extra
// vastleg-velden (antwoorden/afwijzer/notitie/eigenaar_id) uit leads-tabel,
// plus eigenaar-naam uit profiles.
// Permission: leads.view.
//
// Response:
//   { lead: {...view-velden}, antwoorden, afwijzer, notitie,
//     eigenaar: {id, naam, email} | null,
//     messages: [], consent: null                              // placeholders voor toekomst
//   }

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

  const id = req.query?.id ? String(req.query.id).trim() : null;
  if (!id) return res.status(400).json({ error: 'id vereist' });

  try {
    const [viewRes, rawRes] = await Promise.all([
      supabaseAdmin.from('leads_overzicht')
        .select('id, naam, email, telefoon, soort, bron, traject, kwalificatie, score, drempel, status, aangemaakt, tag')
        .eq('id', id).maybeSingle(),
      supabaseAdmin.from('leads')
        .select('id, antwoorden, afwijzer, notitie, eigenaar_id')
        .eq('id', id).maybeSingle(),
    ]);
    if (viewRes.error) throw new Error('leads_overzicht: ' + viewRes.error.message);
    if (rawRes.error)  throw new Error('leads: ' + rawRes.error.message);
    const lead = viewRes.data;
    const raw  = rawRes.data;
    if (!lead || !raw) return res.status(404).json({ error: 'Lead niet gevonden' });

    let eigenaar = null;
    if (raw.eigenaar_id) {
      const { data: prof } = await supabaseAdmin.from('profiles')
        .select('id, full_name, email').eq('id', raw.eigenaar_id).maybeSingle();
      if (prof) {
        eigenaar = { id: prof.id, naam: prof.full_name || prof.email || 'onbekend', email: prof.email || null };
      }
    }

    return res.status(200).json({
      lead,
      antwoorden: Array.isArray(raw.antwoorden) ? raw.antwoorden : [],
      afwijzer:   raw.afwijzer === true,
      notitie:    raw.notitie || null,
      eigenaar,
      // Placeholders voor toekomstige uitbreiding — detail-UI toont een lege
      // tijdlijn-sectie die zich hierop kan aanpassen zodra data live komt.
      messages:   [],
      consent:    null,
    });
  } catch (e) {
    console.error('[leads-detail]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
