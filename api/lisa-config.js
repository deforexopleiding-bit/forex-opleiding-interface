// api/lisa-config.js
// Lisa config-beheer (versioned). Multi-method:
//   GET                       → actieve config (is_active=true)
//   GET  ?action=history      → alle versies (DESC, metadata)
//   POST ?action=save_draft   → UPDATE de actieve config-rij (draft, geen nieuwe versie)
//   POST ?action=publish      → INSERT nieuwe versie (is_active=true; trigger deactiveert rest)
//   POST ?action=rollback     → INSERT kopie van oude versie als nieuwe actieve versie
//
// Auth: verifyAdmin (hard: super_admin/admin/manager + actief) + requirePermissionFailOpen
// (soft feature-gate). Schrijven via supabaseAdmin (service role) ná de checks, zodat
// ook een manager met lisa.config.edit kan bewerken (RLS op lisa_config = super_admin only).

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

// Velden die via de config-editor bewerkt worden (rest van de rij blijft een snapshot).
const EDIT_FIELDS = [
  'persona_name', 'persona_age', 'persona_background', 'persona_tone',
  'persona_writing_style', 'emoji_usage', 'dos', 'donts',
  'phase_intro', 'phase_doel', 'phase_situatie', 'phase_band', 'phase_call',
];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function activeConfig(select = '*') {
  const { data } = await supabaseAdmin
    .from('lisa_config').select(select).eq('is_active', true)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

async function nextVersion() {
  const { data } = await supabaseAdmin
    .from('lisa_config').select('version').order('version', { ascending: false }).limit(1).maybeSingle();
  return (data?.version || 0) + 1;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  const action = req.query.action || '';

  // ── GET ────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (!(await requirePermissionFailOpen(req, 'lisa.config.view'))) {
      return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.config.view' });
    }
    if (action === 'history') {
      const { data, error } = await supabaseAdmin
        .from('lisa_config')
        .select('id, version, is_active, created_at, created_by, notes, persona_name')
        .order('version', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ versions: data || [] });
    }
    const config = await activeConfig('*');
    return res.status(200).json({ config });
  }

  // ── POST ───────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};

    if (action === 'save_draft') {
      if (!(await requirePermissionFailOpen(req, 'lisa.config.edit'))) {
        return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.config.edit' });
      }
      const act = await activeConfig('id');
      if (!act) return res.status(400).json({ error: 'Geen actieve config om bij te werken.' });
      const updates = pick(body, EDIT_FIELDS);
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Geen velden om bij te werken.' });
      const { error } = await supabaseAdmin.from('lisa_config').update(updates).eq('id', act.id);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, message: 'Draft opgeslagen' });
    }

    if (action === 'publish') {
      if (!(await requirePermissionFailOpen(req, 'lisa.config.publish'))) {
        return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.config.publish' });
      }
      const act = await activeConfig('*');               // snapshot van huidige actieve config
      const next = await nextVersion();
      const base = { ...(act || {}) };
      delete base.id; delete base.created_at;
      const payload = {
        ...base,
        ...pick(body, EDIT_FIELDS),                       // + huidige editor-waarden
        version: next,
        is_active: true,                                  // trigger zet andere versies inactief
        created_by: admin.user.id,
        notes: body.notes || 'Gepubliceerd via config-editor',
      };
      const { error } = await supabaseAdmin.from('lisa_config').insert(payload);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, version: next, message: 'Versie ' + next + ' live' });
    }

    if (action === 'rollback') {
      if (!(await requirePermissionFailOpen(req, 'lisa.config.publish'))) {
        return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.config.publish' });
      }
      const srcId = body.id;
      if (!srcId) return res.status(400).json({ error: 'id van doelversie vereist.' });
      const { data: src } = await supabaseAdmin.from('lisa_config').select('*').eq('id', srcId).maybeSingle();
      if (!src) return res.status(404).json({ error: 'Versie niet gevonden.' });
      const next = await nextVersion();
      const base = { ...src };
      delete base.id; delete base.created_at;
      const payload = {
        ...base,
        version: next,
        is_active: true,
        created_by: admin.user.id,
        notes: 'Rollback naar v' + src.version,
      };
      const { error } = await supabaseAdmin.from('lisa_config').insert(payload);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, version: next, message: 'Teruggezet naar v' + src.version + ' (nu v' + next + ')' });
    }

    return res.status(400).json({ error: 'Onbekende action.' });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
