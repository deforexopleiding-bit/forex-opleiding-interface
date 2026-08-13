// api/kennisbank-artikelen.js
//
// Multi-method CRUD op public.kennisbank_artikelen (Fase 3 AI Agents).
//
//   GET                      → list (query: q, categorie, agent, limit)
//   POST                     → create { onderwerp, categorie?, content?, agents?[] }
//   PATCH   ?id=<uuid>       → update { onderwerp?, categorie?, content?, agents?[] }
//   DELETE  ?id=<uuid>       → delete
//
// Permission: admin.joost_config (mirror van rest van agent-hub).
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
    error: 'kennisbank_artikelen-tabel bestaat nog niet. Draai migratie 2026-08-13-kennisbank-artikelen.sql.',
    code: 'MIGRATION_MISSING',
  });
}

function sanitizeInput(body) {
  const out = {};
  if (typeof body.onderwerp === 'string') out.onderwerp = body.onderwerp.trim().slice(0, 200);
  if (body.categorie != null) {
    const c = String(body.categorie).trim().slice(0, 40);
    out.categorie = c || null;
  }
  if (body.content != null) out.content = String(body.content).slice(0, 10000);
  if (Array.isArray(body.agents)) {
    out.agents = body.agents
      .map((a) => String(a || '').toLowerCase().trim())
      .filter((a) => AGENT_KEYS.has(a));
  }
  return out;
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

  const method = req.method;

  // ───────── GET list ─────────
  if (method === 'GET') {
    const q         = (req.query?.q || '').toString().trim();
    const categorie = (req.query?.categorie || '').toString().trim();
    const agent     = (req.query?.agent || '').toString().trim().toLowerCase();
    const limit     = Math.min(500, Math.max(1, Number(req.query?.limit || 200)));

    try {
      let query = supabaseAdmin.from('kennisbank_artikelen')
        .select('id, onderwerp, categorie, content, agents, usage_count, created_at, updated_at, created_by')
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (categorie) query = query.eq('categorie', categorie);
      if (agent && AGENT_KEYS.has(agent)) query = query.contains('agents', [agent]);
      if (q) query = query.or(`onderwerp.ilike.%${q.replace(/%/g,'')}%,content.ilike.%${q.replace(/%/g,'')}%`);
      const { data, error } = await query;
      if (error) {
        if (isMissingTable(error)) return migrationMissing(res);
        throw error;
      }
      return res.status(200).json({ ok: true, items: data || [], count: (data || []).length });
    } catch (e) {
      console.error('[kennisbank-artikelen] GET:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  // ───────── POST create ─────────
  if (method === 'POST') {
    const body = req.body || {};
    const input = sanitizeInput(body);
    if (!input.onderwerp) return res.status(400).json({ error: 'onderwerp vereist' });
    try {
      const { data, error } = await supabaseAdmin.from('kennisbank_artikelen')
        .insert({ ...input, created_by: user.id })
        .select('id, onderwerp, categorie, content, agents, usage_count, created_at, updated_at, created_by')
        .single();
      if (error) {
        if (isMissingTable(error)) return migrationMissing(res);
        throw error;
      }
      return res.status(200).json({ ok: true, item: data });
    } catch (e) {
      console.error('[kennisbank-artikelen] POST:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  // ───────── PATCH update ─────────
  if (method === 'PATCH') {
    const id = (req.query?.id || '').toString();
    if (!UUID_RX.test(id)) return res.status(400).json({ error: 'id ongeldig' });
    const body = req.body || {};
    const input = sanitizeInput(body);
    if (!Object.keys(input).length) return res.status(400).json({ error: 'niets om te wijzigen' });
    try {
      const { data, error } = await supabaseAdmin.from('kennisbank_artikelen')
        .update(input)
        .eq('id', id)
        .select('id, onderwerp, categorie, content, agents, usage_count, created_at, updated_at, created_by')
        .single();
      if (error) {
        if (isMissingTable(error)) return migrationMissing(res);
        throw error;
      }
      return res.status(200).json({ ok: true, item: data });
    } catch (e) {
      console.error('[kennisbank-artikelen] PATCH:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  // ───────── DELETE ─────────
  if (method === 'DELETE') {
    const id = (req.query?.id || '').toString();
    if (!UUID_RX.test(id)) return res.status(400).json({ error: 'id ongeldig' });
    try {
      const { error } = await supabaseAdmin.from('kennisbank_artikelen').delete().eq('id', id);
      if (error) {
        if (isMissingTable(error)) return migrationMissing(res);
        throw error;
      }
      return res.status(200).json({ ok: true, deleted: id });
    } catch (e) {
      console.error('[kennisbank-artikelen] DELETE:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}
