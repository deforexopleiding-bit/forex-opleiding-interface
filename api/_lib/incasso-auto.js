// api/_lib/incasso-auto.js
//
// Auto-incasso configuratie + evaluatie (read-only).
//
// - getIncassoAutoSettings() / setIncassoAutoSettings(patch) — app_settings
//   key 'incasso_auto' (jsonb). Zelfde patroon als dunning-dry-run.js.
// - evaluateIncassoCandidates() — geeft de klanten terug die zouden worden
//   aangedragen door de (nog te bouwen) cron. READ-ONLY: maakt/verplaatst
//   niets.

import { supabaseAdmin } from '../supabase.js';
import { customerDisplayName } from './customer-name.js';
import { createDossierCore } from './incasso-dossier.js';

const SETTINGS_KEY = 'incasso_auto';
const OPEN_INV_STATUSES = ['open', 'partially_paid', 'overdue'];
const TERMINAL_DOSSIER_STATUSES = ['betaald', 'afgeschreven', 'oninbaar', 'geretourneerd'];

export const DEFAULT_SETTINGS = {
  enabled                              : false,
  min_days_overdue                     : null, // integer of null (uit)
  min_amount_open_eur                  : null, // number of null (uit)
  require_broken_arrangement           : false,
  require_no_response_after_aanmaning  : false,
  require_refusal_signal               : false,
};

function _sanitize(patch) {
  const out = { ...DEFAULT_SETTINGS };
  if (patch && typeof patch === 'object') {
    if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
    if (patch.min_days_overdue == null || patch.min_days_overdue === '') {
      out.min_days_overdue = null;
    } else {
      const n = Number(patch.min_days_overdue);
      if (Number.isFinite(n) && n >= 0 && n <= 3650) out.min_days_overdue = Math.trunc(n);
    }
    if (patch.min_amount_open_eur == null || patch.min_amount_open_eur === '') {
      out.min_amount_open_eur = null;
    } else {
      const n = Number(patch.min_amount_open_eur);
      if (Number.isFinite(n) && n >= 0) out.min_amount_open_eur = Math.round(n * 100) / 100;
    }
    if (typeof patch.require_broken_arrangement          === 'boolean') out.require_broken_arrangement          = patch.require_broken_arrangement;
    if (typeof patch.require_no_response_after_aanmaning === 'boolean') out.require_no_response_after_aanmaning = patch.require_no_response_after_aanmaning;
    if (typeof patch.require_refusal_signal              === 'boolean') out.require_refusal_signal              = patch.require_refusal_signal;
  }
  return out;
}

export async function getIncassoAutoSettings() {
  try {
    const { data } = await supabaseAdmin
      .from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle();
    return _sanitize(data?.value);
  } catch (e) {
    console.warn('[incasso-auto] settings lookup fail-soft:', e?.message || e);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function setIncassoAutoSettings(patch) {
  const value = _sanitize(patch);
  const { error } = await supabaseAdmin
    .from('app_settings').upsert({ key: SETTINGS_KEY, value }, { onConflict: 'key' });
  if (error) throw new Error('incasso_auto save: ' + error.message);
  return value;
}

function openAmountEur(inv) {
  const t = Number(inv?.amount_total)    || 0;
  const p = Number(inv?.amount_paid)     || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}
function daysOverdue(iso, nowMs) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t >= nowMs) return 0;
  return Math.floor((nowMs - t) / (24 * 3600 * 1000));
}

// evaluateIncassoCandidates() — draait tegen huidige settings + DB, returnt
// de kandidatenlijst. Geen side effects.
export async function evaluateIncassoCandidates(opts = {}) {
  const settings = opts.settings || await getIncassoAutoSettings();
  const nowMs = Date.now();

  // 1) Open facturen aggregeren per klant.
  const { data: invRows, error: iErr } = await supabaseAdmin
    .from('invoices')
    .select('id, customer_id, amount_total, amount_paid, credited_amount, due_date, status, is_test')
    .in('status', OPEN_INV_STATUSES).eq('is_test', false);
  if (iErr) throw new Error('invoices: ' + iErr.message);

  const perCustomer = new Map();
  for (const inv of invRows || []) {
    if (!inv.customer_id) continue;
    const openEur = openAmountEur(inv);
    if (openEur <= 0) continue;
    const dOverdue = daysOverdue(inv.due_date, nowMs);
    const agg = perCustomer.get(inv.customer_id) || {
      customer_id: inv.customer_id, open_invoice_count: 0, total_open_eur: 0, max_days_overdue: 0,
    };
    agg.open_invoice_count += 1;
    agg.total_open_eur     += openEur;
    if (dOverdue != null && dOverdue > agg.max_days_overdue) agg.max_days_overdue = dOverdue;
    perCustomer.set(inv.customer_id, agg);
  }

  if (perCustomer.size === 0) return { settings, candidates: [] };

  const custIds = Array.from(perCustomer.keys());

  // 2) Bestaande open incasso-dossiers uitsluiten.
  const { data: openDos } = await supabaseAdmin
    .from('dunning_incasso_dossiers').select('customer_id, status')
    .in('customer_id', custIds)
    .not('status', 'in', `(${TERMINAL_DOSSIER_STATUSES.map((s) => `"${s}"`).join(',')})`);
  const inDossier = new Set((openDos || []).map((r) => r.customer_id));

  // 3) Customer meta (naam / is_company).
  const { data: custs } = await supabaseAdmin
    .from('customers').select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test')
    .in('id', custIds);
  const custById = new Map((custs || []).map((c) => [c.id, c]));

  // 4) Verbroken arrangements per klant.
  const { data: brokenArrs } = await supabaseAdmin
    .from('payment_arrangements').select('customer_id, status')
    .in('customer_id', custIds).eq('status', 'VERBROKEN');
  const brokenSet = new Set((brokenArrs || []).map((a) => a.customer_id));

  // 5) Aanmaan-log + conversaties (last_inbound_at) per klant.
  //    Laatste 'bulk_reminder_sent'-event per klant → vergelijk met
  //    whatsapp_conversations.last_inbound_at (na dat event = wél reactie).
  const { data: logRows } = await supabaseAdmin
    .from('dunning_log').select('event_type, payload, created_at')
    .in('event_type', ['bulk_reminder_sent', 'payment_refusal_flagged', 'payment_refusal_cleared', 'incasso_pre_brief_sent'])
    .order('created_at', { ascending: false }).limit(5000);
  const lastRemBy    = new Map(); // customer_id → iso
  const briefSentBy  = new Set(); // klant heeft pre-brief-marker
  const refusalStateBy = new Map(); // customer_id → latest 'flagged'|'cleared'
  for (const l of logRows || []) {
    const cid = l.payload?.customer_id;
    if (!cid) continue;
    const t = l.event_type;
    if (t === 'bulk_reminder_sent' && !lastRemBy.has(cid)) lastRemBy.set(cid, l.created_at);
    else if (t === 'incasso_pre_brief_sent') briefSentBy.add(cid);
    else if ((t === 'payment_refusal_flagged' || t === 'payment_refusal_cleared') && !refusalStateBy.has(cid)) {
      refusalStateBy.set(cid, t === 'payment_refusal_flagged' ? 'flagged' : 'cleared');
    }
  }

  const { data: convs } = await supabaseAdmin
    .from('whatsapp_conversations').select('customer_id, last_inbound_at')
    .in('customer_id', custIds);
  const lastInboundBy = new Map();
  for (const c of convs || []) {
    if (!c.customer_id || !c.last_inbound_at) continue;
    const cur = lastInboundBy.get(c.customer_id);
    if (!cur || new Date(c.last_inbound_at).getTime() > new Date(cur).getTime()) {
      lastInboundBy.set(c.customer_id, c.last_inbound_at);
    }
  }

  const S = settings;
  const anyTriggerEnabled = !!(S.require_broken_arrangement || S.require_no_response_after_aanmaning || S.require_refusal_signal);

  const candidates = [];
  for (const [cid, agg] of perCustomer) {
    if (inDossier.has(cid)) continue;
    const cust = custById.get(cid);
    if (!cust) continue;
    if (cust.is_test || cust.archived_at || cust.anonymized_at) continue;

    // Drempels (AND, alleen indien ingesteld).
    if (S.min_amount_open_eur != null && agg.total_open_eur < S.min_amount_open_eur) continue;
    if (S.min_days_overdue    != null && agg.max_days_overdue < S.min_days_overdue) continue;

    const matched = [];

    if (S.require_broken_arrangement && brokenSet.has(cid)) matched.push('verbroken_arrangement');
    if (S.require_no_response_after_aanmaning) {
      const lastRem = lastRemBy.get(cid);
      if (lastRem) {
        const lastInb = lastInboundBy.get(cid);
        const noReactieErna = !lastInb || (new Date(lastInb).getTime() <= new Date(lastRem).getTime());
        if (noReactieErna) matched.push('geen_reactie_na_aanmaning');
      }
    }
    if (S.require_refusal_signal && refusalStateBy.get(cid) === 'flagged') matched.push('betalingsonwil_gemarkeerd');

    // Triggers (OR): minstens één gematcht als er triggers aan staan.
    if (anyTriggerEnabled && matched.length === 0) continue;

    const name = customerDisplayName(cust, '(zonder naam)');
    const wik_needed = (cust.is_company !== true) && !briefSentBy.has(cid);

    candidates.push({
      customer_id       : cid,
      customer_name     : name,
      is_company        : !!cust.is_company,
      open_invoice_count: agg.open_invoice_count,
      total_open_eur    : Math.round(agg.total_open_eur * 100) / 100,
      total_open_cents  : Math.round(agg.total_open_eur * 100),
      days_overdue      : agg.max_days_overdue,
      matched_conditions: matched, // leeg als er geen triggers aan staan (dan tellen alleen drempels)
      wik_needed,
    });
  }

  candidates.sort((a, b) => b.total_open_eur - a.total_open_eur);
  return { settings, candidates };
}

// runIncassoAuto({ openedBy, source }) — verwerkt de kandidaten uit
// evaluateIncassoCandidates() en zet ze in dossier via createDossierCore.
// - wik_needed → OVERSLAAN + dunning_log 'incasso_auto_skipped_wik'
// - bureau bepaling: enige actieve bureau voor de country → gebruik die;
//   bij >1 of 0 → bureau_id=null (mensactie kan later koppelen).
// - createDossierCore is idempotent; created:false → stil overslaan.
export async function runIncassoAuto({ openedBy = null, source = 'auto' } = {}) {
  const { settings, candidates } = await evaluateIncassoCandidates();
  const summary = {
    total_candidates: candidates.length,
    created         : [],
    skipped_wik     : [],
    skipped_other   : [],
    errors          : [],
  };

  // Actieve bureaus vooraf ophalen — 1× query.
  let bureausByCountry = { NL: [], BE: [] };
  try {
    const { data: buRows } = await supabaseAdmin
      .from('dunning_incasso_bureaus')
      .select('id, name, country').eq('is_active', true);
    for (const b of buRows || []) {
      const key = (b.country === 'BE') ? 'BE' : 'NL';
      bureausByCountry[key].push(b);
    }
  } catch (e) {
    console.warn('[incasso-auto] bureaus lookup soft-fail:', e?.message || e);
  }

  for (const c of candidates) {
    try {
      if (c.wik_needed) {
        summary.skipped_wik.push({ customer_id: c.customer_id, customer_name: c.customer_name });
        try {
          await supabaseAdmin.from('dunning_log').insert({
            run_id     : null,
            step_id    : null,
            event_type : 'incasso_auto_skipped_wik',
            payload    : { customer_id: c.customer_id, reason: 'wik_brief_ontbreekt', source },
          });
        } catch (_) { /* fail-soft */ }
        continue;
      }
      const country = 'NL'; // default; later te overrulen o.b.v. klant-adres.
      const active  = bureausByCountry[country] || [];
      const bureauId = (active.length === 1) ? active[0].id : null;
      const result = await createDossierCore(c.customer_id, {
        country, bureauId, openedBy, source,
      });
      if (result.created) {
        summary.created.push({
          customer_id: c.customer_id,
          customer_name: c.customer_name,
          dossier_id : result.dossier.id,
          bureau_id  : bureauId,
        });
        try {
          await supabaseAdmin.from('dunning_log').insert({
            run_id     : null,
            step_id    : null,
            event_type : 'incasso_auto_created',
            payload    : {
              customer_id: c.customer_id,
              dossier_id : result.dossier.id,
              bureau_id  : bureauId,
              source     : source,
              matched_conditions: c.matched_conditions,
              total_open_eur    : c.total_open_eur,
              days_overdue      : c.days_overdue,
            },
          });
        } catch (_) { /* fail-soft */ }
      } else {
        summary.skipped_other.push({ customer_id: c.customer_id, reason: 'already_open_dossier' });
      }
    } catch (e) {
      console.error('[incasso-auto] candidate fail', c.customer_id, e?.message || e);
      summary.errors.push({ customer_id: c.customer_id, error: e?.message || String(e) });
    }
  }

  summary.settings = settings;
  return summary;
}
