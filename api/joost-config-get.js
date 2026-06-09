// api/joost-config-get.js
// GET -> haal de Joost-config voor een module op (1 rij per module).
// Permission: admin.joost_config OF finance.joost.view (fallback voor read-only
// finance-gebruikers die het Joost-paneel in de inbox mogen zien zonder de
// config te kunnen bewerken).
//
// Query-params:
//   module (text, default 'finance')  -> exact-match op joost_config.module
//
// Response 200: { config: row | null }
//   - row: volledige joost_config rij (persona_name, persona_tone,
//     system_prompt_template, knowledge_base, model, temperature,
//     context_message_count, is_enabled, updated_by_user_id, updated_at).
//   - null als nog geen rij bestaat voor de opgegeven module.
//
// Auth: Bearer-token verplicht (401 bij ontbreken / ongeldig).
// RBAC: 403 als noch admin.joost_config noch finance.joost.view granted is.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const MODULE_RX = /^[a-z0-9_-]{1,50}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // ---- Auth ----
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // ---- Permission (OR-fallback, short-circuit) ----
  // admin.joost_config geeft volledige toegang; finance.joost.view is read-only
  // gate voor inbox-gebruikers die het paneel mogen zien.
  const hasAdmin = await requirePermission(req, 'admin.joost_config');
  const hasView  = hasAdmin ? true : await requirePermission(req, 'finance.joost.view');
  if (!hasAdmin && !hasView) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config of finance.joost.view)' });
  }

  // ---- Module-param valideren ----
  const moduleRaw = (req.query?.module ?? 'finance').toString().trim();
  const moduleKey = moduleRaw || 'finance';
  if (!MODULE_RX.test(moduleKey)) {
    return res.status(400).json({ error: 'module: alleen lowercase a-z, 0-9, _ en - (max 50 chars)' });
  }

  // ---- Query ----
  try {
    const { data: row, error } = await supabaseAdmin
      .from('joost_config')
      .select(`
        module, persona_name, persona_tone, system_prompt_template,
        knowledge_base, model, temperature, context_message_count,
        is_enabled, updated_by_user_id, updated_at
      `)
      .eq('module', moduleKey)
      .maybeSingle();

    if (error) {
      console.error('[joost-config-get] select error:', error.message);
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ config: row || null });
  } catch (e) {
    console.error('[joost-config-get] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
