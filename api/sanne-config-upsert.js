// api/sanne-config-upsert.js
// POST -> update Sanne-config (joost_config module='email').
// Dedicated endpoint (raakt joost-config-upsert.js niet — protected zone).
//
// Body-vorm: partial update, alleen meegestuurde velden overschrijven.
// Whitelist: persona_name, persona_tone, system_prompt_template, knowledge_base,
//            model, temperature, is_enabled, feature_flags, autonomy_config.
//
// Belangrijke defensieve regel (Lesson 24): lees eerst de HUIDIGE rij, merge
// dan de partial in het volledige object en schrijf ALTIJD alle non-null cols
// terug. Voorkomt de "niet-null valkuil" waar een partial update per ongeluk
// persona_name=NULL zou zetten (CHECK-constraint schendt).
//
// Permission: admin.joost_config.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const ALLOWED = new Set([
  'persona_name','persona_tone','system_prompt_template','knowledge_base',
  'model','temperature','context_message_count','is_enabled',
  'feature_flags','autonomy_config',
]);

const NOT_NULL_TEXT = ['persona_name','persona_tone','system_prompt_template','model'];

function pickAllowed(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (ALLOWED.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  try {
    // Huidige rij ophalen — anders geen update-basis + geen not-null merge.
    const { data: existing, error: readErr } = await supabaseAdmin
      .from('joost_config').select('*').eq('module', 'email').maybeSingle();
    if (readErr) return res.status(500).json({ error: 'config-read: ' + readErr.message });
    if (!existing) return res.status(404).json({ error: 'Sanne-config ontbreekt — draai migratie 2026-08-15-sanne-fase-2-0-foundation.sql eerst' });

    const partial = pickAllowed(req.body || {});
    if (Object.keys(partial).length === 0) {
      return res.status(400).json({ error: 'geen geldige velden om te updaten (whitelist: ' + Array.from(ALLOWED).join(',') + ')' });
    }

    // Merge: neem existing, overwrite met partial. Voor jsonb-velden
    // (feature_flags/autonomy_config/knowledge_base): partial vervangt VOLLEDIG.
    // Als caller een deep-merge wil moet 'ie zelf de merged jsonb sturen (leest
    // eerst met sanne-config-get). Voorkomt onbedoelde partial-jsonb-wipes.
    const merged = { ...existing, ...partial };

    // Not-null guard: als een NOT NULL text-kolom leeg wordt, val terug op existing.
    for (const col of NOT_NULL_TEXT) {
      if (merged[col] == null || merged[col] === '') merged[col] = existing[col];
    }

    merged.updated_at = new Date().toISOString();
    merged.updated_by_user_id = user.id;

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('joost_config').update(merged).eq('module', 'email').select('*').maybeSingle();
    if (updErr) return res.status(500).json({ error: 'update: ' + updErr.message });

    return res.status(200).json({ ok: true, config: updated });
  } catch (e) {
    console.error('[sanne-config-upsert]', e?.message);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
