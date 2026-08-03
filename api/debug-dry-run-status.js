// api/debug-dry-run-status.js
//
// READ-ONLY DIAGNOSTIC. Roept de dry-run-guard live aan in de exacte
// productie-context en toont wat 'ie ziet:
//   1) DRY_RUN_KEY-constante uit dunning-dry-run.js (bewijst welke key gelezen wordt)
//   2) Ruwe app_settings-rij voor die key (via de MODULE'S EIGEN supabaseAdmin)
//   3) Type-inspectie van value + value.enabled
//   4) invalidateDryRunCache() → verse fetch
//   5) isDryRunEnabled() live-uitkomst
//   6) Env-fingerprint (SUPABASE_URL host + kolom-schema + git commit)
//
// GEEN sends, GEEN writes, GEEN cache-mutatie buiten dry-run's eigen cache-clear.
// Super_admin only. Bouwt aan het einde één samenvattend antwoord dat
// definitief oplost of code en werkelijkheid matchen.
//
// GET /api/debug-dry-run-status
// Response 200:
//   {
//     drY_run_key_constant,        <- de literal string uit de code
//     raw_app_settings_row,         <- key/value/updated_at/updated_by_user_id
//     value_type,                   <- typeof value (object/string/…)
//     enabled_raw,                  <- value?.enabled letterlijk
//     enabled_type,                 <- typeof enabled
//     enabled_strict_eq_false,      <- (enabled === false) — exact wat de code checkt
//     computed_dry,                 <- resultaat van isDryRunEnabled() ná cache-clear
//     count_rows_with_this_key,     <- SELECT COUNT(*) — bewijst uniek
//     env_fingerprint: { supabase_url_host, has_service_role_key, node_env, vercel_env, git_sha },
//     verdict:                      <- klare tekst: 'DRY_RUN_AAN' | 'DRY_RUN_UIT_LIVE_STUURT' |
//                                      'CODE_VS_DATA_TEGENSPRAAK'
//   }

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { isDryRunEnabled, invalidateDryRunCache } from './_lib/dunning-dry-run.js';

const DRY_RUN_KEY_LITERAL = 'dunning_dry_run';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (admin.profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin.' });
  }

  const out = {
    drY_run_key_constant: DRY_RUN_KEY_LITERAL,
    raw_app_settings_row: null,
    value_type: null,
    enabled_raw: null,
    enabled_type: null,
    enabled_strict_eq_false: null,
    computed_dry: null,
    count_rows_with_this_key: null,
    env_fingerprint: {
      // Alleen HOST + laatste 4 chars van path zodat je project-ref kunt
      // herkennen zonder credentials te lekken. Anon/service-role keys
      // worden NOOIT teruggestuurd.
      supabase_url_host: null,
      supabase_project_ref: null,
      has_service_role_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      has_anon_key:         !!process.env.SUPABASE_ANON_KEY,
      node_env:             process.env.NODE_ENV || null,
      vercel_env:           process.env.VERCEL_ENV || null,
      git_sha:              (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
      git_branch:           process.env.VERCEL_GIT_COMMIT_REF || null,
    },
    verdict: null,
    warnings: [],
  };

  // ── Env-fingerprint: hostname + project-ref van SUPABASE_URL ─────────
  try {
    const rawUrl = process.env.SUPABASE_URL || '';
    if (rawUrl) {
      const u = new URL(rawUrl);
      out.env_fingerprint.supabase_url_host = u.hostname;
      // Supabase URLs zijn https://<projectref>.supabase.co — projectref
      // is unieke ID voor de DB. Verschil tussen preview/productie is
      // ZICHTBAAR als deze verschilt tussen wat jij lokaal ziet en wat
      // Vercel returnt.
      const m = u.hostname.match(/^([a-z0-9-]+)\.supabase\./i);
      if (m) out.env_fingerprint.supabase_project_ref = m[1];
    }
  } catch (e) {
    out.warnings.push('SUPABASE_URL parse fail: ' + e.message);
  }

  // ── 1) COUNT: bewijst dat er precies 1 rij is met deze key ──────────
  try {
    const { count, error } = await supabaseAdmin
      .from('app_settings')
      .select('key', { count: 'exact', head: true })
      .eq('key', DRY_RUN_KEY_LITERAL);
    if (error) out.warnings.push('count query error: ' + error.message);
    else out.count_rows_with_this_key = count;
  } catch (e) {
    out.warnings.push('count query exception: ' + e.message);
  }

  // ── 2) Ruwe rij ophalen — via de EIGEN supabaseAdmin van deze module ─
  //     (identieke client als dunning-dry-run.js gebruikt via de shared
  //      supabase.js import). Bewijst dat we in DEZELFDE database praten.
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('key, value, updated_at, updated_by_user_id')
      .eq('key', DRY_RUN_KEY_LITERAL)
      .maybeSingle();
    if (error) {
      out.warnings.push('raw row query error: ' + error.message);
    } else if (data) {
      out.raw_app_settings_row = data;
      out.value_type = typeof data.value;
      // ── 3) enabled-veld precies zoals de code 'em leest ──
      const enabled = data?.value?.enabled;
      out.enabled_raw = enabled;
      out.enabled_type = typeof enabled;
      // ── DIT is de EXACTE check in dunning-dry-run.js:42 ──
      out.enabled_strict_eq_false = (enabled === false);
    } else {
      out.warnings.push('geen rij voor key=' + DRY_RUN_KEY_LITERAL);
    }
  } catch (e) {
    out.warnings.push('raw row query exception: ' + e.message);
  }

  // ── 4) Cache invalideren + isDryRunEnabled() live aanroepen ─────────
  try {
    invalidateDryRunCache();
    out.computed_dry = await isDryRunEnabled();
  } catch (e) {
    out.warnings.push('isDryRunEnabled exception: ' + e.message);
    out.computed_dry = null;
  }

  // ── Verdict: interpretatie van bovenstaande ──────────────────────────
  // - computed_dry=true  → guard staat AAN → step-executor zou NIET moeten sturen
  // - computed_dry=false → guard staat UIT → step-executor stuurt ECHT
  // - enabled=true + computed_dry=false → onmogelijk in de code → schema-drift
  // - enabled=false + computed_dry=false → normaal (dry-run uit)
  // - enabled=true + computed_dry=true → normaal (dry-run aan)
  if (out.computed_dry === true) {
    if (out.raw_app_settings_row?.value?.enabled === true) {
      out.verdict = 'DRY_RUN_AAN (consistent — geen live sends verwacht)';
    } else if (out.raw_app_settings_row?.value?.enabled === false) {
      out.verdict = 'ANOMALIE: setting=false maar computed_dry=true (fail-safe pad?)';
    } else {
      out.verdict = 'DRY_RUN_AAN via fail-safe (enabled niet strict-boolean-false)';
    }
  } else if (out.computed_dry === false) {
    if (out.raw_app_settings_row?.value?.enabled === false) {
      out.verdict = 'DRY_RUN_UIT_LIVE_STUURT (consistent — sends gaan echt)';
    } else {
      // ← DIT is de scenario waar de user in zou zitten als de tegenspraak echt is
      out.verdict = 'CODE_VS_DATA_TEGENSPRAAK: raw_row zegt enabled=' + JSON.stringify(out.enabled_raw)
        + ' maar isDryRunEnabled returnde FALSE. Schema-drift of runtime-issue.';
    }
  } else {
    out.verdict = 'ONBEPAALD (isDryRunEnabled gaf null/exception)';
  }

  return res.status(200).json(out);
}
