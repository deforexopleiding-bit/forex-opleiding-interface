// api/_lib/webflow-publish.js
// Auto-publish hook voor Webflow-site (Blok 2 PR 4).
//
// Verantwoordelijkheden:
//   1. Toggle-state lezen (webflow_auto_publish_enabled in app_settings).
//      AAN -> publishen volgens lock/debounce-regels.
//      UIT -> publish skippen + pending=true zetten zodat de catch-up bij
//             toggle-flip of "Publish nu"-knop alsnog publisht.
//   2. Lock + trailing-debounce zodat een burst van outbound mutaties
//      coalesceert tot ~1 site-publish (Vercel is stateless, dus we
//      gebruiken DB-state met read-then-write CAS-pattern).
//   3. Tijdens een lopende publish komen er typisch nog 1-N andere
//      mutaties binnen. Die zien in_progress=true -> pending=true. Nadat
//      de actieve publish klaar is, signaleert pending=true dat de
//      volgende mutatie (of de cron / admin-knop) een trailing publish
//      moet doen om de tussentijdse wijzigingen mee te nemen.
//
// State-shape in app_settings (key = webflow_publish_state):
//   {
//     pending                : bool,
//     last_publish_at        : iso|null,
//     in_progress            : bool,
//     in_progress_started_at : iso|null
//   }
//
// Geen formele atomic CAS via PostgreSQL functions - we doen read-then-
// write met een korte stale-lock window (LOCK_STALE_MS). In de praktijk
// is de race-window klein en publisht Webflow desnoods dubbel; de site
// is idempotent t.o.v. publish-API.

import { supabaseAdmin } from '../supabase.js';

// ── Constants ───────────────────────────────────────────────────────────────
export const SETTING_ENABLED_KEY = 'webflow_auto_publish_enabled';
export const SETTING_STATE_KEY   = 'webflow_publish_state';

// Trailing-debounce: een burst van mutaties binnen DEBOUNCE_MS na de laatste
// succesvolle publish coalesceert tot pending=true. Kort genoeg dat er na de
// burst snel een verse publish komt; lang genoeg dat 5-10 mutaties in een
// admin-flow tot 1 publish samenvallen.
export const DEBOUNCE_MS    = 5_000;

// Stale-lock: als in_progress=true al > LOCK_STALE_MS staat, beschouwen we
// 'm als crashed/lost en mogen we 'm overrulen. Webflow publish duurt
// typisch 5-15s; we kiezen 60s ruim daarboven.
export const LOCK_STALE_MS  = 60_000;

const DEFAULT_ENABLED_STATE = { enabled: true };
const DEFAULT_PUBLISH_STATE = {
  pending: false,
  last_publish_at: null,
  in_progress: false,
  in_progress_started_at: null,
};

// ── State I/O ────────────────────────────────────────────────────────────────

export async function getAutoPublishEnabled() {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', SETTING_ENABLED_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const v = data?.value;
    if (v && typeof v === 'object' && typeof v.enabled === 'boolean') {
      return v.enabled;
    }
    // Niet geconfigureerd? Default AAN (spec: nieuwe omgevingen publishen
    // automatisch; admin kan altijd uitzetten).
    return DEFAULT_ENABLED_STATE.enabled;
  } catch (e) {
    console.error('[webflow-publish] getAutoPublishEnabled error:', e.message);
    // Soft-fail naar AAN: bij DB-glitch liever publishen dan eindeloos pending.
    return true;
  }
}

export async function getPublishState() {
  try {
    const { data, error } = await supabaseAdmin
      .from('app_settings')
      .select('value, updated_at')
      .eq('key', SETTING_STATE_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data?.value || typeof data.value !== 'object') {
      return { ...DEFAULT_PUBLISH_STATE, _fresh: true };
    }
    return { ...DEFAULT_PUBLISH_STATE, ...data.value };
  } catch (e) {
    console.error('[webflow-publish] getPublishState error:', e.message);
    return { ...DEFAULT_PUBLISH_STATE, _error: e.message };
  }
}

/**
 * Persist een PATCH (subset) op de publish_state. Doet read-then-write om
 * niet onbedoeld andere velden te overschrijven (race-window is acceptabel
 * voor onze use-case - geen kritisch ACID-pad).
 */
async function patchPublishState(patch) {
  const current = await getPublishState();
  const merged = { ...DEFAULT_PUBLISH_STATE, ...current, ...patch };
  // Geen audit-velden (intern systeem-state, niet user-action).
  // upsert via 2-staps SELECT/INSERT-or-UPDATE consistent met app-settings.js.
  const { data: existing } = await supabaseAdmin
    .from('app_settings')
    .select('key')
    .eq('key', SETTING_STATE_KEY)
    .maybeSingle();
  if (existing) {
    const { error } = await supabaseAdmin
      .from('app_settings')
      .update({ value: merged, updated_at: new Date().toISOString() })
      .eq('key', SETTING_STATE_KEY);
    if (error) throw new Error('publish_state update: ' + error.message);
  } else {
    const { error } = await supabaseAdmin
      .from('app_settings')
      .insert({ key: SETTING_STATE_KEY, value: merged });
    if (error) throw new Error('publish_state insert: ' + error.message);
  }
  return merged;
}

export async function markPending(reason = null) {
  return patchPublishState({ pending: true });
}

export async function clearPending() {
  return patchPublishState({ pending: false });
}

// ── Lock + debounce decision ────────────────────────────────────────────────
//
// Geeft terug:
//   { proceed: true,  state }  - publish mag door
//   { proceed: false, reason, state } - skip met reason ('disabled'|'debounced'|'in_progress')
//                                       caller heeft pending=true al gezet.
export async function decidePublish({ context = '', force = false } = {}) {
  if (!force) {
    const enabled = await getAutoPublishEnabled();
    if (!enabled) {
      const state = await markPending();
      return { proceed: false, reason: 'disabled', state, context };
    }
  }

  const state = await getPublishState();
  const now = Date.now();

  // In-progress check (met stale-lock recovery).
  if (state.in_progress === true) {
    const startedMs = state.in_progress_started_at
      ? new Date(state.in_progress_started_at).getTime()
      : 0;
    const age = startedMs ? (now - startedMs) : Infinity;
    if (age < LOCK_STALE_MS) {
      const merged = await markPending();
      return { proceed: false, reason: 'in_progress', state: merged, context };
    }
    // Stale: ga door alsof in_progress=false (we overrulen 'm hieronder).
    console.warn(`[webflow-publish] stale lock detected (age ${age}ms) - overruling`);
  }

  // Debounce: alleen relevant als geen force-call (admin-knop = altijd door).
  if (!force) {
    const lastMs = state.last_publish_at
      ? new Date(state.last_publish_at).getTime()
      : 0;
    if (lastMs && (now - lastMs) < DEBOUNCE_MS) {
      const merged = await markPending();
      return { proceed: false, reason: 'debounced', state: merged, context };
    }
  }

  // Acquire-lock (in_progress=true).
  const acquired = await patchPublishState({
    in_progress           : true,
    in_progress_started_at: new Date(now).toISOString(),
  });
  return { proceed: true, state: acquired, context };
}

// Release-lock + record success/failure.
export async function recordPublishResult({ ok, errorMessage = null }) {
  const now = new Date().toISOString();
  if (ok) {
    return patchPublishState({
      in_progress           : false,
      in_progress_started_at: null,
      last_publish_at       : now,
      pending               : false,
    });
  }
  // Bij fail: lock releasen + pending blijven (zodat volgende mutatie het probeert).
  return patchPublishState({
    in_progress           : false,
    in_progress_started_at: null,
    pending               : true,
  });
}

// ── Orchestratie: maybePublishSite + forcePublishSite ──────────────────────
//
// maybePublishSite is de standaard hook na elke outbound mutatie (F2
// create/update, Blok 1 close/reopen/hard-delete, PR3 register/auto-vol).
// forcePublishSite is alleen voor admin "Publish nu" + toggle-flip catch-up.
//
// Dynamic import van webflow-client.publishSite om de circulaire dependency
// te breken (webflow-client gebruikt maybePublishSite uit dit lib via
// dezelfde dynamic-import pattern in publishSiteIfEnabled wrapper).

async function callPublishSite(context) {
  const { publishSite } = await import('./webflow-client.js');
  return publishSite({ context });
}

/**
 * maybePublishSite(context, opts?)
 *   - leest toggle
 *   - acquire-lock met debounce + stale-lock check
 *   - publisht of skipt (met pending=true bij skip)
 *
 * Faal-mode bij publish-API-error: lock releasen + pending blijft op true.
 * RATE_LIMIT (429) wordt expliciet retry-baar geclassificeerd voor de caller
 * (return.retryable=true + pending=true).
 *
 * Returnt altijd een object - werpt nooit (defensive); caller logt zelf indien
 * relevant. Voorkomt dat een Webflow-glitch een DB-mutatie laat falen.
 */
export async function maybePublishSite(context = '') {
  const decision = await decidePublish({ context, force: false });
  if (!decision.proceed) {
    return {
      ok           : false,
      published    : false,
      skipped      : true,
      reason       : decision.reason,
      pending      : decision.state?.pending === true,
      context,
    };
  }

  try {
    const result = await callPublishSite(context);
    const ok = result?.ok !== false;
    await recordPublishResult({ ok, errorMessage: ok ? null : result?.error });
    return {
      ok,
      published         : ok,
      skipped           : false,
      raw               : result?.raw || null,
      error             : ok ? null : (result?.error || null),
      domainSource      : result?.domainSource || null,
      customDomainsCount: result?.customDomainsCount ?? null,
      degraded          : result?.degraded === true,
      degradedReason    : result?.degradedReason || null,
      context,
    };
  } catch (e) {
    const code = e?.code || null;
    const retryable = code === 'RATE_LIMIT' || code === 'WEBFLOW_DOWN';
    // RATE_LIMIT na publishSite-retries is exhausted: pending blijft true
    // (gezet door recordPublishResult), volgende debounced publish probeert
    // het opnieuw. Degraded i.p.v. throw: caller (mutatie-flow) hoeft
    // niets te doen.
    const degraded = code === 'RATE_LIMIT';
    const degradedReason = degraded ? 'publish_429_retries_exhausted' : null;
    await recordPublishResult({ ok: false, errorMessage: e?.message });
    return {
      ok            : false,
      published     : false,
      skipped       : false,
      error         : e?.message || String(e),
      code,
      retryable,
      degraded,
      degradedReason,
      context,
    };
  }
}

/**
 * forcePublishSite - bypass toggle + debounce. Gebruikt door:
 *   - admin "Publish nu" knop (api/admin-webflow-publish-now.js)
 *   - admin toggle-flip naar AAN met pending=true (catch-up)
 *
 * Lock + stale-recovery blijft staan. Bij succes wordt pending=false.
 */
export async function forcePublishSite(context = 'manual') {
  const decision = await decidePublish({ context, force: true });
  if (!decision.proceed) {
    // Alleen reden voor skip onder force=true is in_progress (lock al actief).
    return {
      ok       : false,
      published: false,
      skipped  : true,
      reason   : decision.reason,
      pending  : decision.state?.pending === true,
      context,
    };
  }
  try {
    const result = await callPublishSite(context);
    const ok = result?.ok !== false;
    await recordPublishResult({ ok, errorMessage: ok ? null : result?.error });
    return {
      ok,
      published         : ok,
      skipped           : false,
      raw               : result?.raw || null,
      error             : ok ? null : (result?.error || null),
      domainSource      : result?.domainSource || null,
      customDomainsCount: result?.customDomainsCount ?? null,
      degraded          : result?.degraded === true,
      degradedReason    : result?.degradedReason || null,
      context,
    };
  } catch (e) {
    const code = e?.code || null;
    const retryable = code === 'RATE_LIMIT' || code === 'WEBFLOW_DOWN';
    // RATE_LIMIT na publishSite-retries is exhausted: pending blijft true
    // (gezet door recordPublishResult), volgende debounced publish probeert
    // het opnieuw. Degraded i.p.v. throw: caller (mutatie-flow) hoeft
    // niets te doen.
    const degraded = code === 'RATE_LIMIT';
    const degradedReason = degraded ? 'publish_429_retries_exhausted' : null;
    await recordPublishResult({ ok: false, errorMessage: e?.message });
    return {
      ok            : false,
      published     : false,
      skipped       : false,
      error         : e?.message || String(e),
      code,
      retryable,
      degraded,
      degradedReason,
      context,
    };
  }
}
