// api/bubble-schema-probe.js
//
// SUPER_ADMIN read-only diagnostiek-endpoint. Sampelt tot ~200 records
// van een Bubble Data API objecttype, neemt de UNION van alle top-level
// property-keys, en returnt alleen keys + types + per-key aanwezigheids-
// telling. NOOIT echte waarden — zodat we het schema kunnen valideren
// zonder PII te lekken.
//
// Bubble's Data API omits properties met lege/null-waarde volledig uit
// z'n response. Een sample van 1 record mist daardoor optionele velden
// (mentor_user, traject, calls, etc) die we hier expliciet zoeken. Door
// een grotere sample te nemen en de UNION te bouwen vinden we ook de
// zeldzame velden; field_presence vertelt hoe vaak elke key in de sample
// voorkomt (zodat we core- vs zeldzame velden kunnen onderscheiden).
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
//   { type           : <probeKey>,
//     sampled        : <int — aantal records dat we daadwerkelijk zagen>,
//     field_keys     : [<sorted UNION van property-namen>],
//     field_types    : { <key>: 'string'|'number'|'boolean'|'array'|'object'|'null' },
//     field_presence : { <key>: <int — in hoeveel records de key voorkomt> } }
//
// GEEN echte waarden — alleen keys, types, en presence-counts.
// Bij 0 records: { type, sampled:0, field_keys:[], field_types:{}, field_presence:{} }.
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

// Sample-cap. bubbleList haalt in pages van 100 op tot het cap-limit;
// we kiezen 200 als balans tussen schema-coverage en round-trips
// (~2 calls naar Bubble per probe, ~1-3 sec).
const SAMPLE_LIMIT = 200;

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
      // limit=200 — paginatie ingebouwd in bubbleList. We samplen tot 200
      // records zodat we óók velden zien die in slechts een fractie van de
      // dataset voorkomen (Bubble omits empty properties helemaal uit z'n
      // Data API response — 1 record sample mist dus optionele velden).
      const { results } = await bubbleList(bubbleType, [], { limit: SAMPLE_LIMIT });
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
        type           : probeKey,
        sampled        : 0,
        field_keys     : [],
        field_types    : {},
        field_presence : {},
      });
    }

    // UNION-pass over alle records.
    //   - field_keys     : alle unieke top-level property-namen, gesorteerd.
    //   - field_types    : per key het type, afgeleid van de EERSTE record
    //                      waarin de key niet-null voorkomt. Fallback op
    //                      'null' als alleen null-waarden gevonden zijn (dan
    //                      kan de operator zien dat de key bestaat maar dat
    //                      de waarde-discovery niet lukt).
    //   - field_presence : aantal records (van de sample) waarin die key
    //                      voorkomt. Helpt zeldzame velden (bv. mentor_user,
    //                      traject, calls) onderscheiden van core-velden.
    //
    // GEEN ECHTE WAARDEN in de output — alleen keys, types, en aantallen.
    const presence  = new Map();   // key → count
    const firstType = new Map();   // key → type-string (op eerste niet-null)
    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      for (const k of Object.keys(rec)) {
        presence.set(k, (presence.get(k) || 0) + 1);
        if (!firstType.has(k)) {
          const t = typeOf(rec[k]);
          if (t !== 'null') firstType.set(k, t);
        }
      }
    }
    // Voor keys waar alleen null-waarden voorkwamen: type = 'null'.
    for (const k of presence.keys()) {
      if (!firstType.has(k)) firstType.set(k, 'null');
    }

    const fieldKeys = Array.from(presence.keys()).sort((a, b) => a.localeCompare(b));
    const fieldTypes    = {};
    const fieldPresence = {};
    for (const k of fieldKeys) {
      fieldTypes[k]    = firstType.get(k);
      fieldPresence[k] = presence.get(k) || 0;
    }

    return res.status(200).json({
      type           : probeKey,
      sampled        : records.length,
      field_keys     : fieldKeys,
      field_types    : fieldTypes,
      field_presence : fieldPresence,
    });
  } catch (e) {
    console.error('[bubble-schema-probe] fatal:', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
