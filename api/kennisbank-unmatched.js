// api/kennisbank-unmatched.js
//
// GET → list open onbeantwoorde vragen uit public.kennisbank_unmatched.
// POST ?action=dismiss  { id }  → zet resolved_at (soft-close)
//
// Permission: admin.joost_config.
// Fail-soft 503 met code MIGRATION_MISSING als tabel nog niet bestaat.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_KEYS = new Set(['joost', 'simone', 'mila', 'lisa']);

function isMissingTable(err) {
  if (!err) return false;
  return err.code === '42P01' || /relation .* does not exist/i.test(err.message || '');
}
function migrationMissing(res) {
  return res.status(503).json({
    error: 'kennisbank_unmatched-tabel bestaat nog niet. Draai migratie 2026-08-13-kennisbank-artikelen.sql.',
    code: 'MIGRATION_MISSING',
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  if (req.method === 'GET') {
    const agent  = (req.query?.agent || '').toString().trim().toLowerCase();
    const limit  = Math.min(200, Math.max(1, Number(req.query?.limit || 50)));
    try {
      let q = supabaseAdmin.from('kennisbank_unmatched')
        .select('id, agent_key, question, count, first_seen, last_seen, resolved_at')
        .is('resolved_at', null)
        .order('count', { ascending: false })
        .limit(limit);
      if (agent && AGENT_KEYS.has(agent)) q = q.eq('agent_key', agent);
      const { data, error } = await q;
      if (error) {
        if (isMissingTable(error)) return migrationMissing(res);
        throw error;
      }
      return res.status(200).json({ ok: true, items: data || [], count: (data || []).length });
    } catch (e) {
      console.error('[kennisbank-unmatched] GET:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  if (req.method === 'POST') {
    const action = (req.query?.action || '').toString();
    if (action !== 'dismiss') return res.status(400).json({ error: "Alleen action=dismiss ondersteund" });
    const body = req.body || {};
    const id = (body.id || '').toString();
    if (!UUID_RX.test(id)) return res.status(400).json({ error: 'id ongeldig' });
    try {
      const { error } = await supabaseAdmin.from('kennisbank_unmatched')
        .update({ resolved_at: new Date().toISOString(), resolved_by: user.id })
        .eq('id', id);
      if (error) {
        if (isMissingTable(error)) return migrationMissing(res);
        throw error;
      }
      return res.status(200).json({ ok: true, dismissed: id });
    } catch (e) {
      console.error('[kennisbank-unmatched] POST dismiss:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
