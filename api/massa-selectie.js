// api/massa-selectie.js
//
// Massa-e-mail fase 2a — de selectie: alle leads die aan de (combineerbare)
// filters voldoen, met wat de lijst nodig heeft (categorie, laatst
// massabericht, afgemeld). Alleen lezen.
//
// POST { filter } → { items:[…], totaal, opties:{bron,soort,traject},
//                     campagnes:[{id,naam,aangemaakt_op}], tabel_ontbreekt }
// RBAC: leads.update (massaverzending is een stap zwaarder dan 1-op-1).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { zoekSegment, tabelOntbreekt, MIGRATIE } from './_lib/massa-mail.js';

export function compact(l) {
  return {
    id: l.id,
    naam: [l.voornaam, l.achternaam].filter(Boolean).join(' ') || l.email || 'Onbekend',
    email: l.email || null,
    telefoon: l.telefoon_e164 || null,
    bron: l.bron || null,
    soort: l.soort || null,
    traject: l.traject || null,
    status: l.status || 'nieuw',
    aangemaakt: l.aangemaakt || null,
    kennismaking: l.kennismaking,
    categorie: l.categorie,
    tags: l.tags || [],
    is_klant: !!l.is_klant,
    toestemming: l.toestemming === true,
    laatst_massa_op: l.laatst_massa_op,
    afgemeld: !!l.afgemeld,
    geldig_email: !!l.geldig_email,
    geldig_nummer: !!l.geldig_nummer,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.update'))) return res.status(403).json({ error: 'Geen rechten (leads.update)' });

  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const seg = await zoekSegment(supabaseAdmin, b.filter || {});
    let campagnes = [];
    const { data: cs, error: cErr } = await supabaseAdmin.from('massa_campagnes')
      .select('id, naam, aangemaakt_op').order('aangemaakt_op', { ascending: false }).limit(50);
    if (cErr && !tabelOntbreekt(cErr)) console.error('[massa-selectie] campagnes lezen mislukt:', cErr.message);
    else campagnes = cs || [];
    return res.status(200).json({
      items: seg.items.map(compact),
      totaal: seg.totaal,
      opties: seg.opties,
      campagnes,
      tabel_ontbreekt: seg.tabel_ontbreekt,
      migratie: seg.tabel_ontbreekt ? MIGRATIE : null,
    });
  } catch (e) {
    console.error('[massa-selectie] fout:', e?.message || e);
    return res.status(500).json({ error: 'Selectie laden mislukt' });
  }
}
