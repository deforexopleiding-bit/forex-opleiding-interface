// api/_lib/dunning-pipeline.js
//
// Alle pipeline-triggers lopen via één plek. ALLE functies zijn
// FAIL-SOFT: een fout in pipeline-schrijven mag NOOIT de onderliggende
// actie (bulk-send / inbound-webhook / betaal-registratie / engine-cron)
// laten falen. Return-shape geeft { ok, ... } terug; caller kan negeren.
//
// Auto-toggles: één app_settings-rij 'dunning_pipeline_auto' (jsonb),
// per-trigger boolean. isAutoEnabled(key) → default TRUE bij missing.

import { supabaseAdmin } from '../supabase.js';

const AUTO_SETTINGS_KEY = 'dunning_pipeline_auto';
const TERMINAL_STAGES = new Set(['opgelost', 'afschrijven']);

let _autoCache = { at: 0, value: null };
const AUTO_CACHE_TTL_MS = 30_000; // 30s — een kort tijdvenster verlaagt query-druk zonder settings-UI vertraging

/**
 * isAutoEnabled(togglName) — leest app_settings 'dunning_pipeline_auto'.
 * Ontbreekt de rij of de key → return TRUE (default AAN). Ontbreken is
 * geen fout; de migratie seed'd 'em maar we bouwen ook toekomst-vast.
 *
 * FAIL-SOFT: DB-fout → return TRUE (default AAN).
 *
 * @param {string} key  bv. 'on_bulk_sent_to_aangemaand'
 * @returns {Promise<boolean>}
 */
export async function isAutoEnabled(key) {
  const now = Date.now();
  if (_autoCache.value && (now - _autoCache.at) < AUTO_CACHE_TTL_MS) {
    const v = _autoCache.value[key];
    return v === false ? false : true;
  }
  try {
    const { data } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', AUTO_SETTINGS_KEY)
      .maybeSingle();
    const value = (data?.value && typeof data.value === 'object') ? data.value : {};
    _autoCache = { at: now, value };
    const v = value[key];
    return v === false ? false : true;
  } catch (e) {
    console.warn('[dunning-pipeline] isAutoEnabled fail-soft', key, e?.message || e);
    return true;
  }
}

/**
 * addLogEntry(customerId, entryType, body, meta, byUser) — schrijft een
 * dunning_pipeline_log-rij. Idempotentie is aan caller; deze helper
 * doet altijd INSERT.
 *
 * FAIL-SOFT: DB-fout → warning + return { ok:false }.
 */
export async function addLogEntry(customerId, entryType, body, meta, byUser) {
  if (!customerId) return { ok: false, reason: 'no_customer_id' };
  try {
    const { error } = await supabaseAdmin
      .from('dunning_pipeline_log')
      .insert({
        customer_id: customerId,
        entry_type : entryType,
        body       : body || null,
        meta       : meta || null,
        created_by : byUser || null,
      });
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e) {
    console.warn('[dunning-pipeline] addLogEntry fail-soft', customerId, entryType, e?.message || e);
    return { ok: false, reason: e?.message || 'insert_fail' };
  }
}

/**
 * ensurePipelineCustomer(customerId) — idempotent: maakt een
 * dunning_pipeline_customers-rij als 'ie nog niet bestaat, met stage
 * 'nieuw' + een log-entry "Toegevoegd aan pipeline".
 *
 * Return { ok, created } zodat caller weet of dit een NIEUW record was
 * (voor stats / initiële log).
 *
 * FAIL-SOFT.
 */
export async function ensurePipelineCustomer(customerId) {
  if (!customerId) return { ok: false, created: false };
  try {
    const { data: existing } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('id')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (existing) return { ok: true, created: false };

    const { error: iErr } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .insert({ customer_id: customerId, stage_slug: 'nieuw', stage_changed_by: 'auto:overdue' });
    if (iErr) {
      // Race: unique-violation → iemand anders was ons voor. Prima.
      if (String(iErr.code || '') !== '23505') throw new Error(iErr.message);
      return { ok: true, created: false };
    }

    await addLogEntry(customerId, 'auto_event', 'Toegevoegd aan pipeline', { from: null, to: 'nieuw' }, 'auto');
    return { ok: true, created: true };
  } catch (e) {
    console.warn('[dunning-pipeline] ensurePipelineCustomer fail-soft', customerId, e?.message || e);
    return { ok: false, created: false };
  }
}

/**
 * setStage(customerId, toSlug, reason, byUser, opts?) — wijzigt fase
 * ALLEEN als 'ie echt verandert. Schrijft een log-entry 'stage_change'.
 * Update stage_changed_at/by + last_activity_at.
 *
 * TERMINAL-GUARD: als de klant al in 'opgelost' of 'afschrijven' zit,
 * NIET automatisch wijzigen (byUser='auto' → skip). Handmatige
 * wijziging (byUser≠'auto') mag terminale fases wél verlaten.
 *
 * VOLGORDE-GUARD (optioneel): opts.onlyIfFrom = string of Set;
 * doe de wijziging alleen als de huidige fase in die set zit. Caller
 * gebruikt dit voor "aangemaand alleen vanuit nieuw" etc.
 *
 * FAIL-SOFT.
 */
export async function setStage(customerId, toSlug, reason, byUser, opts) {
  if (!customerId || !toSlug) return { ok: false, reason: 'invalid_args' };
  try {
    const { data: row } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('id, stage_slug')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!row) return { ok: false, reason: 'no_pipeline_record' };

    const from = row.stage_slug || 'nieuw';
    if (from === toSlug) return { ok: true, unchanged: true };

    // TERMINAL-guard voor auto-callers.
    const isAuto = String(byUser || '').startsWith('auto');
    if (isAuto && TERMINAL_STAGES.has(from)) {
      return { ok: true, skipped: 'terminal_locked' };
    }

    // VOLGORDE-guard.
    if (opts?.onlyIfFrom) {
      const allowed = (opts.onlyIfFrom instanceof Set) ? opts.onlyIfFrom : new Set([opts.onlyIfFrom]);
      if (!allowed.has(from)) return { ok: true, skipped: 'wrong_stage', from };
    }

    const nowIso = new Date().toISOString();
    const { error: uErr } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .update({
        stage_slug       : toSlug,
        stage_changed_at : nowIso,
        stage_changed_by : byUser || 'auto',
        last_activity_at : nowIso,
        updated_at       : nowIso,
      })
      .eq('id', row.id);
    if (uErr) throw new Error(uErr.message);

    await addLogEntry(
      customerId,
      'stage_change',
      reason || `${from} → ${toSlug}`,
      { from_stage: from, to_stage: toSlug, reason: reason || null },
      byUser || 'auto',
    );
    return { ok: true, from, to: toSlug };
  } catch (e) {
    console.warn('[dunning-pipeline] setStage fail-soft', customerId, toSlug, e?.message || e);
    return { ok: false, reason: e?.message || 'update_fail' };
  }
}

export const PIPELINE_TERMINAL_STAGES = TERMINAL_STAGES;
