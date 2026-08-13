// api/agent-feedback-create.js
//
// POST → schrijf een duim-op/duim-neer feedback-event naar
// agent_suggestion_feedback (Fase 2 AI Agents-consolidatie).
//
// Body:
//   { agent_key: 'joost'|'simone'|'mila'|'lisa',
//     rating:    'up'|'down',
//     module?:   'finance'|'events'|'onboarding' | null (lisa),
//     suggestion_id?: text | null,
//     note?:     text | null }
//
// Auth: authenticated + requirePermission('admin.joost_config').
// RLS op de tabel filtert nogmaals (admin/super_admin/manager).
//
// Additief; raakt geen bestaande tabel. Foutgevoelig fail-soft:
// als de tabel nog niet bestaat (migratie niet gedraaid) → 503 met
// duidelijke melding zodat UI weet "migratie ontbreekt".

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const AGENT_KEYS = new Set(['joost', 'simone', 'mila', 'lisa']);
const RATINGS    = new Set(['up', 'down']);
const MODULES    = new Set(['finance', 'events', 'onboarding']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const body = req.body || {};
  const agent_key = String(body.agent_key || '').toLowerCase().trim();
  const rating    = String(body.rating || '').toLowerCase().trim();
  const moduleRaw = body.module != null ? String(body.module).toLowerCase().trim() : null;
  const suggestion_id = body.suggestion_id != null ? String(body.suggestion_id).slice(0, 200) : null;
  const note = body.note != null ? String(body.note).slice(0, 2000) : null;

  if (!AGENT_KEYS.has(agent_key)) return res.status(400).json({ error: 'agent_key ongeldig' });
  if (!RATINGS.has(rating))       return res.status(400).json({ error: "rating moet 'up' of 'down' zijn" });
  if (moduleRaw && !MODULES.has(moduleRaw) && agent_key !== 'lisa') {
    return res.status(400).json({ error: 'module ongeldig' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('agent_suggestion_feedback')
      .insert({
        agent_key,
        rating,
        module: moduleRaw,
        suggestion_id,
        note,
        user_id: user.id,
      })
      .select('id, created_at')
      .single();
    if (error) {
      // Migratie waarschijnlijk niet gedraaid.
      if (/relation .* does not exist/i.test(error.message || '') || error.code === '42P01') {
        return res.status(503).json({
          error: 'Feedback-tabel bestaat nog niet. Draai migratie 2026-08-13-agent-suggestion-feedback.sql.',
          code: 'MIGRATION_MISSING',
        });
      }
      console.error('[agent-feedback-create] insert:', error.message);
      return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ ok: true, id: data.id, created_at: data.created_at });
  } catch (e) {
    console.error('[agent-feedback-create] exception:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
