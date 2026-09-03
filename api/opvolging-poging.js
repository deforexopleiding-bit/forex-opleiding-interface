// api/opvolging-poging.js
//
// POST → één poging vastleggen bij een taak. Nooit overschrijven: elke
// gebeurtenis is een eigen rij, ook als de taak later gearchiveerd wordt.
//
// Body: { taak_id, soort, resultaat?, automatisch?, call_log_id?, duur_sec? }
//   soort ∈ call | whatsapp | spraakbericht | agenda_doorgestuurd | ingepland
//
// Nieuw endpoint. Schrijft uitsluitend in opvolging_pogingen (+ last-touch op
// opvolging_taken.updated_at).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const SOORTEN = ['call', 'whatsapp', 'spraakbericht', 'agenda_doorgestuurd', 'ingepland'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const allowed = await requirePermission(req, 'opvolging.module.access');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (opvolging.module.access)' });

  const b = req.body || {};
  if (!b.taak_id) return res.status(400).json({ error: 'taak_id ontbreekt' });
  if (!SOORTEN.includes(b.soort)) return res.status(400).json({ error: 'onbekende soort' });

  try {
    const { data, error } = await supabaseAdmin.from('opvolging_pogingen').insert({
      taak_id: b.taak_id,
      soort: b.soort,
      resultaat: b.resultaat || null,
      automatisch: b.automatisch === true,
      call_log_id: b.call_log_id || null,
      duur_sec: Number.isFinite(b.duur_sec) ? b.duur_sec : null,
    }).select().single();
    if (error) throw error;

    await supabaseAdmin.from('opvolging_taken')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', b.taak_id);

    return res.status(200).json({ success: true, poging: data });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Onbekende fout' });
  }
}
