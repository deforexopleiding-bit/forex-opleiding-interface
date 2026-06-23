// api/bubble-schema-probe.js
//
// SUPER_ADMIN read-only diagnostiek-endpoint. Vraagt 1 record op van
// een Bubble Data API objecttype en returnt alleen de PROPERTY-KEYS +
// hun JS-typen (geen waarden) — zodat we het schema kunnen valideren
// zonder PII te lekken.
//
// Gebruik:
//   GET /api/bubble-schema-probe?type=user
//   GET /api/bubble-schema-probe?type=one-on-one-session
//
// Het type-param is whitelisted:
//   - 'user'                → Bubble object 'user'
//   - 'one-on-one-session'  → Bubble object '1-1-session'
//
// (Mapping bevestigd via api/mentor-coaching-debug.js:174 dat
// '1-1-session' als objectnaam gebruikt voor coaching-sessies.)
//
// Response 200:
//   { type, count, field_keys: [<sorted property names>],
//     field_types: { <key>: 'string'|'number'|'boolean'|'array'|'object'|'null' } }
//
// GEEN echte waarden — alleen keys + types. Bij 0 records:
//   { type, count:0, field_keys:[] }.
//
// Errors:
//   400  type ontbreekt of niet in whitelist
//   401  geen sessie
//   403  geen super_admin
//   502  Bubble-fout (config/netwerk/HTTP) — zonder token-detail
//   500  overige fouten

import { createUserClient, supabaseAdmin } from './supabase.js';
import { bubbleList } from './_lib/bubble.js';

// Whitelist van toegestane probe-types + mapping naar de Bubble object-
// naam. Whitelist-only: onbekend type → 400, geen pass-through naar Bubble.
const TYPE_MAP = {
  'user'               : 'user',
  'one-on-one-session' : '1-1-session',
};

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  try {
    // Auth: Bearer → user → profile.role === 'super_admin'. Zelfde gate
    // als api/admin-meta-templates-list.js — strikte super_admin only.
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin' });
    }

    // Type-param uit whitelist resolven; default 'user'.
    const rawType = typeof req.query?.type === 'string' ? req.query.type.trim() : '';
    const probeKey = rawType || 'user';
    const bubbleType = TYPE_MAP[probeKey];
    if (!bubbleType) {
      return res.status(400).json({
        error: 'type moet één van: ' + Object.keys(TYPE_MAP).join(', '),
      });
    }

    let records;
    try {
      // limit=1 — we hebben maar 1 record nodig voor schema-introspectie.
      const { results } = await bubbleList(bubbleType, [], { limit: 1 });
      records = Array.isArray(results) ? results : [];
    } catch (e) {
      // Bubble-fout fail-soft mappen naar 502 zonder secrets te lekken.
      console.error('[bubble-schema-probe]', e?.code || '', e?.message || e);
      const code = e?.code || 'BUBBLE_ERROR';
      if (code === 'BUBBLE_CONFIG_MISSING') {
        return res.status(503).json({
          error : 'Bubble-koppeling niet geconfigureerd (env)',
          detail: 'BUBBLE_API_TOKEN of BUBBLE_API_ROOT ontbreekt',
        });
      }
      // Korte detail-string, geen URL/token/headers.
      const detail = String(e?.message || 'onbekende Bubble-fout').slice(0, 200);
      return res.status(502).json({
        error : 'Bubble API onbereikbaar',
        detail,
      });
    }

    if (records.length === 0) {
      return res.status(200).json({
        type        : probeKey,
        count       : 0,
        field_keys  : [],
        field_types : {},
      });
    }

    // Eerste record als probe; pak top-level property-namen + types.
    // GEEN echte waarden in de output — alleen keys + types.
    const sample = records[0] || {};
    const fieldKeys = Object.keys(sample).sort((a, b) => a.localeCompare(b));
    const fieldTypes = {};
    for (const k of fieldKeys) {
      fieldTypes[k] = typeOf(sample[k]);
    }

    return res.status(200).json({
      type        : probeKey,
      count       : records.length,
      field_keys  : fieldKeys,
      field_types : fieldTypes,
    });
  } catch (e) {
    console.error('[bubble-schema-probe] fatal:', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
