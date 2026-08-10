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
    // Ronde 5 fix: leads_overzicht-view is stuk (verwijst naar dropped
    // leads.naam-kolom). Query `leads` direct met voornaam+achternaam en
    // bouw `naam` server-side.
    const [viewRes, rawRes] = await Promise.all([
      supabaseAdmin.from('leads')
        .select('id, voornaam, achternaam, email, telefoon, soort, bron, traject, kwalificatie, score, drempel, status, aangemaakt, tag, afspraak_op, verwijderd_op')
        .eq('id', id).maybeSingle(),
      supabaseAdmin.from('leads')
        .select('id, antwoorden, afwijzer, notitie, eigenaar_id')
        .eq('id', id).maybeSingle(),
    ]);
    if (viewRes.error) throw new Error('leads: ' + viewRes.error.message);
    if (rawRes.error)  throw new Error('leads-extra: ' + rawRes.error.message);
    const leadRow = viewRes.data;
    const raw  = rawRes.data;
    if (!leadRow || !raw) return res.status(404).json({ error: 'Lead niet gevonden' });
    const lead = {
      ...leadRow,
      naam: [leadRow.voornaam, leadRow.achternaam].filter(Boolean).join(' ').trim() || leadRow.email || '—',
    };

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
