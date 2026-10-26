// api/trial-belpoging.js
//
// POST /api/trial-belpoging { email, lead_id?, aanmelding_id?, resultaat, notitie? }
// Eén belpoging uit de bellijst van Leadsonderhoud › The Lab noteren (logboek,
// tabel trial_belpogingen — migratie 2026-10-26-trial-belpogingen.sql).
// RBAC: leads.view. Antwoord: 200 { ok, poging } · 400 · 503 MIGRATIE_NODIG.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { isOntbrekendeTabel } from './funnel-stats.js';

export const RESULTATEN = Object.freeze(['geen_antwoord', 'voicemail', 'gesproken', 'sessie_geboekt', 'terugbellen', 'geen_interesse', 'verkeerd_nummer']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure validatie → { ok, rij } of { ok:false, fout }. */
export function valideerBelpoging(b) {
  const x = b && typeof b === 'object' ? b : {};
  const email = String(x.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, fout: 'Geldig e-mailadres vereist' };
  if (!RESULTATEN.includes(x.resultaat)) return { ok: false, fout: 'Onbekend resultaat' };
  return { ok: true, rij: {
    email, resultaat: x.resultaat,
    lead_id: UUID_RE.test(String(x.lead_id || '')) ? String(x.lead_id) : null,
    aanmelding_id: UUID_RE.test(String(x.aanmelding_id || '')) ? String(x.aanmelding_id) : null,
    notitie: String(x.notitie || '').trim().slice(0, 1000) || null,
  } };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) return res.status(403).json({ error: 'Geen rechten (leads.view)' });

  const v = valideerBelpoging(req.body);
  if (!v.ok) return res.status(400).json({ error: v.fout });

  const { data: prof } = await supabaseAdmin.from('profiles').select('full_name, email').eq('id', user.id).maybeSingle();
  const { data, error } = await supabaseAdmin.from('trial_belpogingen').insert({
    ...v.rij, door_user_id: user.id, door_naam: prof?.full_name || prof?.email || user.email || null,
  }).select('id, aangemaakt, email, resultaat, notitie, door_naam').single();
  if (error) {
    if (isOntbrekendeTabel(error)) return res.status(503).json({ error: 'De tabel trial_belpogingen bestaat nog niet (migratie 2026-10-26-trial-belpogingen.sql).', code: 'MIGRATIE_NODIG' });
    console.error('[trial-belpoging] insert:', error.message);
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }
  return res.status(200).json({ ok: true, poging: data });
}
