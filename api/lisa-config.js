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
import { validateFollowupSequence } from './_lib/lisa-followup.js';

// Velden die via de config-editor bewerkt worden (rest van de rij blijft een snapshot).
const EDIT_FIELDS = [
  'persona_name', 'persona_age', 'persona_background', 'persona_tone',
  'persona_writing_style', 'emoji_usage', 'dos', 'donts',
  'phase_intro', 'phase_doel', 'phase_situatie', 'phase_band', 'phase_call',
  // Knowledge (F4.3) — structured producten/FAQ + KB-tagfilter
  'kb_products', 'kb_faq', 'kb_pricing', 'kb_usps', 'kb_tag_filter', 'kb_use_general_kb',
  // Follow-up (F7.2) — sequence + stop-keywords
  'followup_sequence', 'stop_keywords', 'followup_ai_threshold_chars', 'followup_enabled',
];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ── Knowledge-veld validatie (alleen toegepast op aanwezige velden) ───────────
function validateProducts(products) {
  if (!Array.isArray(products)) return [];
  return products.filter((p) => p && typeof p === 'object').map((p) => ({
    naam: String(p.naam || '').trim(),
    beschrijving: String(p.beschrijving || '').trim(),
    prijs: String(p.prijs || '').trim(),
    doelgroep: String(p.doelgroep || '').trim(),
    duur: String(p.duur || '').trim(),
  }));
}

function validateFaq(faq) {
  if (!Array.isArray(faq)) return [];
  return faq.filter((q) => q && typeof q === 'object').map((q) => ({
    vraag: String(q.vraag || '').trim(),
    antwoord: String(q.antwoord || '').trim(),
    // keywords lowercase-genormaliseerd voor case-insensitive RAG-match (F4.4)
    keywords: Array.isArray(q.keywords)
      ? q.keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
      : [],
  }));
}

// Normaliseer KB-velden in-place — alleen velden die in de update zitten.
function normalizeKbFields(updates) {
  if (updates.kb_products !== undefined) updates.kb_products = validateProducts(updates.kb_products);
  if (updates.kb_faq !== undefined) updates.kb_faq = validateFaq(updates.kb_faq);
  if (updates.kb_tag_filter !== undefined) {
    updates.kb_tag_filter = Array.isArray(updates.kb_tag_filter)
      ? updates.kb_tag_filter.map((t) => String(t).trim()).filter(Boolean) : [];
  }
  if (updates.kb_use_general_kb !== undefined) updates.kb_use_general_kb = !!updates.kb_use_general_kb;
  return updates;
}

// Normaliseer follow-up-velden in-place (F7.2).
function normalizeFollowupFields(updates) {
  if (updates.followup_sequence !== undefined) {
    updates.followup_sequence = validateFollowupSequence(updates.followup_sequence).valid;
  }
  if (updates.stop_keywords !== undefined) {
    updates.stop_keywords = Array.isArray(updates.stop_keywords)
      ? updates.stop_keywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean) : [];
  }
  if (updates.followup_ai_threshold_chars !== undefined) {
    const n = parseInt(updates.followup_ai_threshold_chars, 10);
    updates.followup_ai_threshold_chars = isNaN(n) ? 200 : Math.max(0, Math.min(2000, n));
  }
  if (updates.followup_enabled !== undefined) updates.followup_enabled = !!updates.followup_enabled;
  return updates;
}

async function activeConfig(select = '*') {
  const { data } = await supabaseAdmin
    .from('lisa_config').select(select).eq('is_active', true)
    .order('version', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

// Hoogste versie (kan een draft zijn) — wat de editor bewerkt.
async function latestConfig(select = '*') {
  const { data } = await supabaseAdmin
    .from('lisa_config').select(select)
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
    // ?which=latest → de editor bewerkt de hoogste versie (draft of actief);
    //   default → de actieve (live) config (voor de Lisa-backend later).
    if ((req.query.which || 'active') === 'latest') {
      const latest = await latestConfig('*');
      const act = await activeConfig('version');
      return res.status(200).json({ config: latest, active_version: act?.version || null });
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
      const updates = normalizeFollowupFields(normalizeKbFields(pick(body, EDIT_FIELDS)));
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Geen velden om bij te werken.' });
      const latest = await latestConfig('*');
      if (latest && latest.is_active === false) {
        // Open draft bijwerken (gepubliceerde versies blijven immutable → rollback klopt).
        const { error } = await supabaseAdmin.from('lisa_config').update(updates).eq('id', latest.id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true, version: latest.version, message: 'Draft bijgewerkt (v' + latest.version + ')' });
      }
      // Laatste versie is gepubliceerd → nieuwe draft-versie (snapshot + edits, inactief).
      const base = { ...(latest || {}) };
      delete base.id; delete base.created_at;
      const next = (latest?.version || 0) + 1;
      const payload = { ...base, ...updates, version: next, is_active: false, created_by: admin.user.id, notes: 'Draft' };
      const { error } = await supabaseAdmin.from('lisa_config').insert(payload);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, version: next, message: 'Draft opgeslagen (v' + next + ')' });
    }

    if (action === 'publish') {
      if (!(await requirePermissionFailOpen(req, 'lisa.config.publish'))) {
        return res.status(403).json({ error: 'Insufficient permissions', feature: 'lisa.config.publish' });
      }
      const updates = normalizeFollowupFields(normalizeKbFields(pick(body, EDIT_FIELDS)));
      const latest = await latestConfig('*');
      if (latest && latest.is_active === false) {
        // Bestaande draft live zetten (trigger deactiveert de vorige actieve versie).
        const { error } = await supabaseAdmin.from('lisa_config')
          .update({ ...updates, is_active: true, notes: body.notes || 'Gepubliceerd via config-editor' })
          .eq('id', latest.id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true, version: latest.version, message: 'Versie ' + latest.version + ' live' });
      }
      // Geen openstaande draft → nieuwe actieve versie vanaf de actieve config + edits.
      const next = await nextVersion();
      const base = { ...(latest || {}) };
      delete base.id; delete base.created_at;
      const payload = {
        ...base,
        ...updates,
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
      const srcId = body.version_id || body.id;
      if (!srcId) return res.status(400).json({ error: 'version_id van doelversie vereist.' });
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
