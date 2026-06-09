// api/joost-config-upsert.js
// POST -> upsert joost_config rij voor een module.
//   Bestaande rij voor module → UPDATE (merge: alleen meegestuurde velden).
//   Geen rij → INSERT (alle defaults uit de migratie gelden bij ontbrekende keys).
//
// Permission: admin.joost_config (strict — geen fallback).
//
// Body:
//   {
//     module:                 string (required, lowercase a-z 0-9 _ -, 1-50 chars),
//     persona_name:           string (optional, max 100 chars),
//     persona_tone:           string (optional, max 500 chars),
//     system_prompt_template: string (optional, max 10000 chars),
//     knowledge_base:         object (optional — plain object, geen array/null/scalar),
//     model:                  string (optional, must be in MODELS_ALLOWED),
//     temperature:            number (optional, 0.00 - 1.00),
//     context_message_count:  integer (optional, 5 - 50),
//     is_enabled:             boolean (optional)
//   }
//
// Bij UPDATE: zet updated_by_user_id = user.id, updated_at = now-ISO
//   (de trigger doet updated_at ook, maar we sturen het mee voor expliciete
//   duidelijkheid — consistent met admin-whatsapp-module-upsert).
//
// Audit (audit_log, fail-soft):
//   action      = 'joost.config_updated'
//   entity_type = 'joost_config'
//   entity_id   = row.module (geen uuid, module is PK)
//   after_json  = { module, persona_name, model, temperature, is_enabled }
//
// Response 200: { config: row }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const MODULE_RX = /^[a-z0-9_-]{1,50}$/;

// Toegestane Anthropic-models (uit recon: per-use-case keuze; Joost-default sonnet,
// opus voor zware reasoning, haiku voor snelle classificatie). Korte vorm zonder
// date-suffix conform CLAUDE.md Stack-sectie en agent-chat.js patroon.
const MODELS_ALLOWED = ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ---- Auth ----
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // ---- Permission (strict) ----
  const hasAdmin = await requirePermission(req, 'admin.joost_config');
  if (!hasAdmin) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  // ---- Body parsen ----
  const body = req.body || {};

  // module: required
  const moduleRaw = typeof body.module === 'string' ? body.module.trim() : '';
  if (!moduleRaw) return res.status(400).json({ error: 'module: string vereist' });
  if (!MODULE_RX.test(moduleRaw)) {
    return res.status(400).json({ error: 'module: alleen lowercase a-z, 0-9, _ en - (max 50 chars)' });
  }
  const moduleKey = moduleRaw;

  // Optionele velden: alleen meenemen als ze in body zijn meegestuurd, zodat
  // UPDATE-pad een partial merge doet en INSERT-pad de DB-defaults gebruikt voor
  // wat niet expliciet is gezet.
  const updates = {};

  if (body.persona_name !== undefined) {
    if (typeof body.persona_name !== 'string') {
      return res.status(400).json({ error: 'persona_name: string vereist' });
    }
    const s = body.persona_name.trim();
    if (!s) return res.status(400).json({ error: 'persona_name: leeg niet toegestaan' });
    if (s.length > 100) return res.status(400).json({ error: 'persona_name: max 100 chars' });
    updates.persona_name = s;
  }

  if (body.persona_tone !== undefined) {
    if (typeof body.persona_tone !== 'string') {
      return res.status(400).json({ error: 'persona_tone: string vereist' });
    }
    const s = body.persona_tone.trim();
    if (!s) return res.status(400).json({ error: 'persona_tone: leeg niet toegestaan' });
    if (s.length > 500) return res.status(400).json({ error: 'persona_tone: max 500 chars' });
    updates.persona_tone = s;
  }

  if (body.system_prompt_template !== undefined) {
    if (typeof body.system_prompt_template !== 'string') {
      return res.status(400).json({ error: 'system_prompt_template: string vereist' });
    }
    // Lege string mag — kolom is NOT NULL DEFAULT '' in de migratie.
    if (body.system_prompt_template.length > 10000) {
      return res.status(400).json({ error: 'system_prompt_template: max 10000 chars' });
    }
    updates.system_prompt_template = body.system_prompt_template;
  }

  if (body.knowledge_base !== undefined) {
    if (!isPlainObject(body.knowledge_base)) {
      return res.status(400).json({ error: 'knowledge_base: plain object vereist (geen array/null/scalar)' });
    }
    updates.knowledge_base = body.knowledge_base;
  }

  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || !MODELS_ALLOWED.includes(body.model)) {
      return res.status(400).json({
        error: `model: moet één van [${MODELS_ALLOWED.join(', ')}] zijn`,
      });
    }
    updates.model = body.model;
  }

  if (body.temperature !== undefined) {
    const n = Number(body.temperature);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return res.status(400).json({ error: 'temperature: nummer tussen 0.0 en 1.0 vereist' });
    }
    // DB-kolom is numeric(3,2) → 2 decimalen.
    updates.temperature = Math.round(n * 100) / 100;
  }

  if (body.context_message_count !== undefined) {
    const n = Number(body.context_message_count);
    if (!Number.isInteger(n) || n < 5 || n > 50) {
      return res.status(400).json({ error: 'context_message_count: integer tussen 5 en 50 vereist' });
    }
    updates.context_message_count = n;
  }

  if (body.is_enabled !== undefined) {
    if (typeof body.is_enabled !== 'boolean') {
      return res.status(400).json({ error: 'is_enabled: boolean vereist' });
    }
    updates.is_enabled = body.is_enabled;
  }

  // ---- Existing rij ophalen (voor before_json audit + UPDATE no-op check) ----
  try {
    const { data: existing, error: getErr } = await supabaseAdmin
      .from('joost_config')
      .select(`
        module, persona_name, persona_tone, system_prompt_template,
        knowledge_base, model, temperature, context_message_count,
        is_enabled, updated_by_user_id, updated_at
      `)
      .eq('module', moduleKey)
      .maybeSingle();
    if (getErr) {
      console.error('[joost-config-upsert] select error:', getErr.message);
      return res.status(500).json({ error: getErr.message });
    }

    // UPDATE-pad zonder mutations is zinloos (INSERT-pad mag wel zonder
    // updates, dan landen DB-defaults).
    if (existing && Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Geen velden om te updaten' });
    }

    // Echte atomic UPSERT: INSERT ... ON CONFLICT (module) DO UPDATE via
    // PostgREST. Bij geen-rij landen DB-defaults voor velden die niet in
    // updates zitten (kolom-defaults uit migratie). Bij wel-rij worden
    // alleen de meegestuurde keys overschreven (PostgREST upsert ignoreert
    // undefined keys niet — daarom bouwen we de payload expliciet).
    const upsertRow = {
      module: moduleKey,
      ...updates,
      updated_by_user_id: user.id,
      updated_at: new Date().toISOString(),
    };

    const { data: row, error: upsertErr } = await supabaseAdmin
      .from('joost_config')
      .upsert(upsertRow, { onConflict: 'module' })
      .select(`
        module, persona_name, persona_tone, system_prompt_template,
        knowledge_base, model, temperature, context_message_count,
        is_enabled, updated_by_user_id, updated_at
      `)
      .single();
    if (upsertErr) {
      console.error('[joost-config-upsert] upsert error:', upsertErr.message);
      return res.status(500).json({ error: upsertErr.message });
    }

    // ---- Audit-log (fail-soft) ----
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'joost.config_updated',
        entity_type: 'joost_config',
        entity_id:   null, // module is PK (text, geen uuid); entity_id is uuid-kolom
        before_json: existing || null,
        after_json:  {
          module:        row.module,
          persona_name:  row.persona_name,
          model:         row.model,
          temperature:   row.temperature,
          is_enabled:    row.is_enabled,
        },
        reason_text: `module=${row.module}`,
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      console.error('[joost-config-upsert audit]', e.message);
    }

    return res.status(200).json({ config: row });
  } catch (e) {
    console.error('[joost-config-upsert] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
