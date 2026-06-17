// api/assessment-questionnaires-activate.js
//
// FEATURE C — POST: één vragenlijst exclusief is_active=true zetten.
// Body: { id: uuid }
//
// Permission: admin.joost_config.
//
// "Exact 1 actief" wordt op DB-niveau afgedwongen via partial unique index
// (is_active) WHERE is_active=true. Om die constraint te respecteren bij de
// switch:
//
//   1. Zet ALLE andere rijen waar is_active=true op false.
//   2. Zet de target-rij op is_active=true.
//
// Supabase JS heeft geen native transactie-block, dus stap 1 + stap 2 zijn
// twee aparte queries. Tussen stap 1 en stap 2 is er een (sub-millisecond)
// venster zonder actieve vragenlijst. Acceptabel:
//   - publieke flow valt terug op alle actieve vragen + env/default drempels
//     (zie assessment-scoring.js getThresholds() fallback).
//   - admin-flow is single-actor — geen concurrente toggles verwacht.
//
// Response 200: { item: <activated row> }
// Response 400/401/403/404/405/500: zie code.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const id = typeof body.id === 'string' ? body.id : null;
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id (uuid) vereist in body.id' });
  }

  try {
    // 0) Target moet bestaan.
    const { data: target, error: getErr } = await supabaseAdmin
      .from('assessment_questionnaires')
      .select('id, is_active')
      .eq('id', id)
      .maybeSingle();
    if (getErr) throw new Error(getErr.message);
    if (!target) return res.status(404).json({ error: 'Vragenlijst niet gevonden' });

    // 1) Zet alle andere actieve rijen op false (no-op als target al actief).
    const { error: deactErr } = await supabaseAdmin
      .from('assessment_questionnaires')
      .update({ is_active: false })
      .eq('is_active', true)
      .neq('id', id);
    if (deactErr) throw new Error('deactivate-others: ' + deactErr.message);

    // 2) Target activeren.
    const { data: activated, error: actErr } = await supabaseAdmin
      .from('assessment_questionnaires')
      .update({ is_active: true })
      .eq('id', id)
      .select('id, slug, name, is_active, gevorderd_threshold, motivatie_floor, low_mid_threshold, created_at, updated_at')
      .maybeSingle();
    if (actErr) throw new Error('activate-target: ' + actErr.message);
    if (!activated) return res.status(404).json({ error: 'Vragenlijst verdween tijdens activatie' });

    return res.status(200).json({ item: activated });
  } catch (e) {
    console.error('[assessment-questionnaires-activate]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
