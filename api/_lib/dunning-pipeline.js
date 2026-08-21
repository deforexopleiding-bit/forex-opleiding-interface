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
// Grace-periode: als alle facturen betaald zijn sluiten we een klant NIET meteen
// af, maar plannen we de resolve op now()+deze minuten. Zo rukken we iemand met
// wie je in gesprek bent niet bruusk uit het overzicht. De engine-cron voert de
// resolve uit zodra now() >= resolve_scheduled_at én nog steeds alles betaald is
// (anders: annuleren).
export const PAID_GRACE_MINUTES = 60;
// Enige bron-van-waarheid voor "een factuur telt als openstaand" (spiegelt de
// count-check bij betalen). Gedeeld met dunning-engine.js (daar geïmporteerd
// als OPEN_STATUSES) zodat de "alles betaald"-definitie nooit tussen de twee
// modules uit elkaar kan lopen.
export const OPEN_INVOICE_STATUSES = ['open', 'partially_paid', 'overdue'];
// TERMINAL = "definitief afgerond" (opgelost/afschrijven). Blijft bestaan
// voor de setStage() auto-lock (auto-callers mogen een terminal-klant NIET
// per ongeluk uit terminal weghalen) en voor semantische UI-labels.
const TERMINAL_STAGES = new Set(['opgelost', 'afschrijven']);
// SKIP = bredere set die de dunning-engine-detectie moet OVERSLAAN:
// terminal + 'dispuut' (klant betwist factuur, geparkeerd) + 'bewind'
// (schuldbewind/curator loopt). Alle 4 zijn stages waar de engine geen
// nieuwe run mag starten TENZIJ er een verse factuur bij komt met een
// issue_date ná stage_changed_at (zie shouldSkipDueToPipelineStage — die
// dekt de "nieuwe deal na afsluiting"-edge zodat mensen niet permanent
// worden uitgesloten). dispuut/bewind zijn dus GEKOPPELD aan de engine-
// skip zonder is_terminal=true te hoeven zijn — verschil met TERMINAL:
// dispuut/bewind kunnen door de gebruiker weer teruggezet worden naar
// 'nieuw' zonder terminal-lock.
const SKIP_STAGES = new Set(['opgelost', 'afschrijven', 'dispuut', 'bewind']);

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
        stage_slug          : toSlug,
        stage_changed_at    : nowIso,
        stage_changed_by    : byUser || 'auto',
        last_activity_at    : nowIso,
        updated_at          : nowIso,
        // Elke stage-wijziging annuleert een eventueel geplande grace-resolve
        // (handmatige move, engine-resolve, of terugzetten naar een open fase).
        resolve_scheduled_at: null,
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

/**
 * countOpenInvoices(customerId) — aantal facturen met status open/partially_paid/
 * overdue. 0 = geen enkele openstaande factuur meer (spiegelt de check bij betalen).
 * Fail-soft → null bij fout (caller behandelt null conservatief = "niet zeker leeg").
 */
export async function countOpenInvoices(customerId) {
  if (!customerId) return null;
  try {
    const { count, error } = await supabaseAdmin
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .in('status', OPEN_INVOICE_STATUSES);
    if (error) throw new Error(error.message);
    return count || 0;
  } catch (e) {
    console.warn('[dunning-pipeline] countOpenInvoices fail-soft', customerId, e?.message || e);
    return null;
  }
}

/**
 * schedulePaidResolve(customerId, byUser) — plan de automatische afsluiting op
 * now()+PAID_GRACE_MINUTES i.p.v. meteen naar 'opgelost'. Aangeroepen op de
 * "volledig betaald"-transitie. Doet NIETS aan de stage (klant blijft zichtbaar
 * in zijn huidige fase). Idempotent: al gepland → geen nieuwe planning/log.
 *
 * Skip als: geen pipeline-record (klant zat niet in dunning) of terminale fase
 * (al opgelost/afschrijven). FAIL-SOFT — mag de betaal-registratie nooit breken.
 */
export async function schedulePaidResolve(customerId, byUser) {
  if (!customerId) return { ok: false, reason: 'no_customer_id' };
  try {
    const { data: row } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('id, stage_slug, resolve_scheduled_at')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!row) return { ok: true, skipped: 'no_pipeline_record' };
    const stage = row.stage_slug || 'nieuw';
    if (TERMINAL_STAGES.has(stage)) return { ok: true, skipped: 'terminal' };
    if (row.resolve_scheduled_at) return { ok: true, skipped: 'already_scheduled', at: row.resolve_scheduled_at };

    const nowIso = new Date().toISOString();
    const at = new Date(Date.now() + PAID_GRACE_MINUTES * 60_000).toISOString();
    const { error } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .update({ resolve_scheduled_at: at, last_activity_at: nowIso, updated_at: nowIso })
      .eq('id', row.id);
    if (error) throw new Error(error.message);

    await addLogEntry(
      customerId,
      'auto_event',
      `Alles betaald — sluit automatisch over ~${PAID_GRACE_MINUTES} min`,
      { reason: 'all_paid_grace', resolve_scheduled_at: at, from_stage: stage },
      byUser || 'auto:paid',
    );
    return { ok: true, scheduledAt: at, from: stage };
  } catch (e) {
    console.warn('[dunning-pipeline] schedulePaidResolve fail-soft', customerId, e?.message || e);
    return { ok: false, reason: e?.message || 'update_fail' };
  }
}

/**
 * cancelPaidResolve(customerId, byUser, reason) — wis een geplande grace-resolve
 * (bv. er staat weer een factuur open). Logt alleen als er echt iets gepland stond.
 * FAIL-SOFT.
 */
export async function cancelPaidResolve(customerId, byUser, reason) {
  if (!customerId) return { ok: false, reason: 'no_customer_id' };
  try {
    const { data: row } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('id, resolve_scheduled_at')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!row || !row.resolve_scheduled_at) return { ok: true, skipped: 'nothing_scheduled' };

    const nowIso = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .update({ resolve_scheduled_at: null, updated_at: nowIso })
      .eq('id', row.id);
    if (error) throw new Error(error.message);

    await addLogEntry(
      customerId,
      'auto_event',
      reason || 'Geplande afsluiting geannuleerd — weer een openstaande factuur',
      { reason: 'all_paid_grace_cancelled' },
      byUser || 'auto',
    );
    return { ok: true, cancelled: true };
  } catch (e) {
    console.warn('[dunning-pipeline] cancelPaidResolve fail-soft', customerId, e?.message || e);
    return { ok: false, reason: e?.message || 'update_fail' };
  }
}

/**
 * finalizePaidResolve(customerId, byUser) — voert de daadwerkelijke afsluiting uit:
 * stage → 'opgelost' (reason all_paid_grace; setStage wist meteen resolve_scheduled_at)
 * + sluit de open MANUAL_FOLLOWUP-taken (zoals de directe flow voorheen deed, maar
 * nu pas op het resolve-moment i.p.v. bruusk bij betalen). FAIL-SOFT.
 *
 * De caller (engine-sweep) her-checkt zelf dat er 0 open facturen zijn.
 */
export async function finalizePaidResolve(customerId, byUser) {
  if (!customerId) return { ok: false, reason: 'no_customer_id' };
  const moved = await setStage(customerId, 'opgelost', 'all_paid_grace', byUser || 'auto:paid');
  // Cascade: open MANUAL_FOLLOWUP-taken sluiten (voorkomt bellen van een betaalde klant).
  try {
    const nowIso = new Date().toISOString();
    const { data: closedRows, error: closeErr } = await supabaseAdmin
      .from('pending_actions')
      .update({ status: 'REJECTED', rejection_reason: 'auto - klant heeft volledig betaald', updated_at: nowIso })
      .eq('customer_id', customerId)
      .eq('action_type', 'MANUAL_FOLLOWUP')
      .eq('status', 'PENDING')
      .select('id');
    const closedCount = Array.isArray(closedRows) ? closedRows.length : 0;
    if (closeErr) {
      console.warn('[dunning-pipeline] finalizePaidResolve auto-close soft-fail', customerId, closeErr.message);
    } else if (closedCount > 0) {
      try {
        await supabaseAdmin.from('dunning_log').insert({
          run_id: null, step_id: null, event_type: 'pending_actions_auto_closed_paid',
          payload: {
            customer_id: customerId,
            closed_action_ids: (closedRows || []).map((r) => r.id),
            closed_count: closedCount,
            reason: 'auto - klant heeft volledig betaald',
            triggered_by: 'dunning-engine:all_paid_grace',
          },
        });
      } catch { /* fail-soft */ }
    }
  } catch (e) {
    console.warn('[dunning-pipeline] finalizePaidResolve cascade exception', customerId, e?.message || e);
  }
  return { ok: true, moved };
}

export const PIPELINE_TERMINAL_STAGES = TERMINAL_STAGES;
export const PIPELINE_SKIP_STAGES     = SKIP_STAGES;

/**
 * FIX 4 + acties-tab v1 — Pure guard-helper voor de engine-detectie:
 * mag een klant overgeslagen worden omdat 'ie in een "flow-parkeer"-
 * stage staat (opgelost/afschrijven = definitief afgesloten, of
 * dispuut/bewind = geparkeerd, geen aanmaanpogingen zolang de situatie
 * loopt)?
 *
 * KRITIEKE EDGE: een klant die in EEN VAN DIE 4 STAGES staat maar een
 * NIEUWE factuur krijgt (nieuwe deal, latere issue_date) MAG NIET
 * permanent uitgesloten blijven — anders sluiten we mensen levenslang
 * uit de dunning-flow. Regel:
 *   - Niet-skip stage (nieuw/aangemaand/in_gesprek/regeling/brief_verstuurd/
 *     incasso) → NIET skippen (huidige gedrag intact).
 *   - Skip-stage + alle open facturen dateren van vóór of op
 *     stage_changed_at → skippen (klant is echt geparkeerd/afgesloten).
 *   - Skip-stage + minstens 1 factuur met issue_date NA stage_changed_at
 *     → NIET skippen (nieuwe factuur = nieuwe case, engine mag weer
 *     draaien).
 *   - Skip-stage zonder stage_changed_at, of geen invoice-datums:
 *     conservatief SKIP (defense-in-depth — een handmatig gemarkeerde
 *     klant sluit zichzelf niet per ongeluk open door datum-hiaten).
 *
 * Vergelijking gebeurt op datum-string niveau (YYYY-MM-DD) zodat
 * timezone-drift niet meetelt. issue_date is de canonieke facuurdatum
 * (matches invoices-schema; niet due_date, want dat kan willekeurig
 * ver in de toekomst liggen bij TL-imports).
 *
 * NAAMKEUZE: functie heet nog `shouldSkipDueToTerminalStage` voor
 * backward-compat met bestaande call-sites (dunning-engine.js). Nieuwe
 * semantiek dekt óók dispuut/bewind — checkt tegen SKIP_STAGES i.p.v.
 * TERMINAL_STAGES. Alias `shouldSkipDueToPipelineStage` als duidelijker
 * naam voor nieuwe callers.
 *
 * Pure functie — geen DB, geen I/O. Testbaar.
 *
 * @param {object} args
 * @param {string} args.stageSlug         huidige pipeline-stage van de klant
 * @param {string|null} args.stageChangedAt   ISO timestamp of null
 * @param {Array<{issue_date?:string}>} args.openInvoices   open facturen uit agg.openInvoices
 * @returns {boolean}  true = engine moet klant overslaan
 */
export function shouldSkipDueToTerminalStage({ stageSlug, stageChangedAt, openInvoices }) {
  if (!SKIP_STAGES.has(stageSlug)) return false;
  if (!stageChangedAt) return true;                   // conservatief
  const stageChangedDate = String(stageChangedAt).slice(0, 10);
  const invs = Array.isArray(openInvoices) ? openInvoices : [];
  let newestIssueIso = null;
  for (const inv of invs) {
    const iso = inv?.issue_date ? String(inv.issue_date).slice(0, 10) : null;
    if (!iso) continue;
    if (!newestIssueIso || iso > newestIssueIso) newestIssueIso = iso;
  }
  if (!newestIssueIso) return true;                   // conservatief
  // Nieuwste factuur ná stage-parkering → klant heeft NIEUWE cases,
  // engine mag draaien. Op-of-vóór → alles is "oud", skippen.
  return newestIssueIso <= stageChangedDate;
}

// Duidelijker naam voor nieuwe callers. Zelfde functie.
export const shouldSkipDueToPipelineStage = shouldSkipDueToTerminalStage;
