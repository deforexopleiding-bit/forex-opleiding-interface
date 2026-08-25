// api/_lib/conv-less-resume.js
//
// Hervat-pad voor CONV-LOZE pauzes: dunning-runs die gepauzeerd staan zonder
// conversation_id (reply_*-reden OF helemaal geen reden = wees). De reminder-cron
// (filter paused_by_conversation_id IS NOT NULL) ziet ze nooit → ze blijven
// permanent in de dode hoek. Deze sweep geeft ze een uitweg en trekt de
// bestaande berg gestaffeld leeg.
//
// SCOPE (conv-loos, geen actieve reden):
//   status='paused'
//   AND paused_by_conversation_id IS NULL
//   AND paused_by_arrangement_id  IS NULL
//   AND paused_by_manual_user_id  IS NULL
//   AND ( paused_manual_reason IS NULL              -- pure wees (bv. Ikcompany)
//         OR paused_manual_reason begint met 'reply_' )  -- reply_email/whatsapp/both/unknown/backfilled
//   AND needs_attention is niet true                -- bewust mens-geparkeerd → uitgesloten
//   AND klant is GEEN testklant (is_test-vlag OF naam/e-mail bevat 'test')
// (De reden-match doen we in JS met /^reply_/ i.p.v. SQL LIKE, zodat de '_' geen
//  wildcard is en de NULL-wees vanzelf meekomt — geen escape-gedoe.)
//
// GEDRAG per run (VERSE betaal-check op moment van hervatten):
//   * BETAALD (0 open facturen) → completeRunsForCustomer(cid,'paid'). Geen bericht.
//     (sluit meteen alle niet-terminale runs van de klant — dubbele lopen mee.)
//   * NOG SCHULD + recent klantcontact (< silence_days) → NIET hervatten; mens-taak.
//   * NOG SCHULD + stil >= silence_days:
//       - mode='auto_first' → HERVATTEN: run → 'active', next_action_at gestaffeld,
//         en current_step_id teruggezet naar een ZACHTE, KANAAL-PASSENDE ladder-
//         ingang (zie punt 4), zodat de eerste engine-touch mild is. De losende
//         dubbele sibling(s) worden actief afgesloten ('superseded_duplicate').
//       - mode='human_only' (default) → NIET autonoom hervatten; mens-taak borgen.
//         (Wil je dat human_only óók auto-hervat en op dry_run leunt voor send-
//         onderdrukking? Eén regel — zeg het maar.)
//
// VEILIG DEFAULT via joost_config.finance.autonomy_config.conv_less_resume:
//   enabled=false, mode='human_only', silence_days=14, max_actions_per_run=5.
//   De ECHTE customer-send loopt via de engine-stap en respecteert dunning_dry_run.
//   Idempotent + capped (grootste bedragen eerst) + fail-soft per run.

import { supabaseAdmin } from '../supabase.js';
import { completeRunsForCustomer } from './promise-maturity.js';
import {
  loadConversationReminderConfig,
  loadRenderContext,
} from '../cron-dunning-conversation-reminders.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

export const CONV_LESS_RESUME_DEFAULTS = Object.freeze({
  enabled:             false,          // master-switch — default UIT (sweep no-op)
  mode:                'human_only',   // 'human_only' | 'auto_first'
  silence_days:        14,             // recent contact < N dagen → niet hervatten (mens)
  max_actions_per_run: 5,              // spreidings-cap → berg loopt gestaffeld leeg
  stagger_minutes:     15,             // next_action_at-spreiding tussen hervatte runs
});

export async function getConvLessResumeConfig() {
  const cfgRes = await loadConversationReminderConfig();
  const ac = (cfgRes?.ok ? cfgRes.autonomyCfg : {}) || {};
  const cl = (ac.conv_less_resume && typeof ac.conv_less_resume === 'object') ? ac.conv_less_resume : {};
  return { ...CONV_LESS_RESUME_DEFAULTS, ...cl };
}

function openAmount(inv) {
  return Math.max(0, (Number(inv?.amount_total) || 0) - (Number(inv?.amount_paid) || 0) - (Number(inv?.credited_amount) || 0));
}
// Conv-loze reden: reply_*-prefix OF helemaal geen reden (wees).
function inConvLessScope(reason) {
  return reason == null || /^reply_/.test(String(reason));
}
// Testklant: expliciete vlag OF naam/e-mail bevat 'test'.
function isTestLike(c) {
  if (!c) return false;
  if (c.is_test) return true;
  const hay = `${c.company_name || ''} ${c.first_name || ''} ${c.last_name || ''} ${c.email || ''}`.toLowerCase();
  return hay.includes('test');
}
// Kanaalkeuze voor de zachte ladder-ingang, afgeleid van de pauze-reden.
function preferChannelFor(reason) {
  const r = String(reason || '');
  if (r.startsWith('reply_whatsapp') || r.startsWith('reply_both')) return 'whatsapp';
  if (r.startsWith('reply_email')) return 'email';
  return 'email'; // reply_unknown / reply_backfilled / NULL-wees → e-mail (universeel bezorgbaar)
}

// ── Hoofd-sweep ──────────────────────────────────────────────────────────────
export async function runConvLessResume({ scope = 'production' } = {}) {
  const summary = {
    enabled: false, dry_run_note: 'engine-stap respecteert dunning_dry_run', config_mode: null,
    scanned: 0, paid_completed: 0, recent_contact_human: 0, resumed: 0, stale_human: 0,
    superseded: 0, duplicate_skipped: 0, needs_attention_skipped: 0, test_skipped: 0,
    skipped: [], errors: [],
  };

  const config = await getConvLessResumeConfig();
  summary.config_mode = config.mode;
  // scope='test' bypasst de enabled-flag zodat cockpit-triggers werken
  // terwijl productie op enabled=false blijft. is_test-filter (pre-fetch
  // r113-114 + fatale tripwire hieronder) is autoritatief.
  if (!config.enabled && scope !== 'test') { summary.skipped.push({ reason: 'FEATURE_DISABLED' }); return summary; }
  summary.enabled = true;

  const nowMs      = Date.now();
  const silenceMs  = (Number(config.silence_days) || 14) * 86400000;
  const staggerMs  = (Number(config.stagger_minutes) || 15) * 60000;
  const maxActions = Number(config.max_actions_per_run) || 5;

  // ── Scope-fetch (conv-loze trio + reply_/NULL + geen manual-user) ──
  let q = supabaseAdmin
    .from('dunning_workflow_runs')
    .select('id, customer_id, workflow_id, current_step_id, paused_manual_reason, paused_at, updated_at, needs_attention, ' +
            'customers!inner(id, is_test, email, phone, first_name, last_name, company_name)')
    .eq('status', 'paused')
    .is('paused_by_conversation_id', null)
    .is('paused_by_arrangement_id', null)
    .is('paused_by_manual_user_id', null);
  if (scope === 'production') q = q.eq('customers.is_test', false);
  else if (scope === 'test')  q = q.eq('customers.is_test', true);
  const { data: rawRuns, error } = await q;
  if (error) { summary.errors.push({ stage: 'fetch', error: error.message }); return summary; }

  // JS-filters: reden-scope (reply_/NULL), needs_attention, test-naam-heuristiek.
  const runs = (rawRuns || []).filter((r) => {
    if (!inConvLessScope(r.paused_manual_reason)) return false;
    if (r.needs_attention) { summary.needs_attention_skipped++; return false; }
    if (scope === 'production' && isTestLike(r.customers)) { summary.test_skipped++; return false; }
    return true;
  });
  summary.scanned = runs.length;
  if (!runs.length) return summary;

  // ── Fatale tripwire (derde laag) ───────────────────────────────────────
  // Bij scope='test' MAG geen enkele niet-is_test rij in de te-verwerken
  // set zitten. Als het TOCH gebeurt (bv. door een toekomstige filter-
  // regressie in de pre-fetch of de isTestLike-heuristiek) → throw fataal
  // vóór enige write. Stille skip zou een test-run productie-data laten
  // aanraken; fataal throwen maakt de regressie meteen zichtbaar.
  if (scope === 'test') {
    const leak = runs.find((r) => r?.customers?.is_test !== true);
    if (leak) {
      throw new Error(
        `[conv-less-resume] SCOPE=TEST TRIPWIRE — run ${leak.id} referenceert non-test customer ${leak.customer_id} (customers.is_test=${JSON.stringify(leak?.customers?.is_test)}). Run afgebroken vóór enige write.`,
      );
    }
  }

  // ── Sorteer op openstaand bedrag (grootste eerst) via één batched fetch ──
  const custIds = [...new Set(runs.map((r) => r.customer_id).filter(Boolean))];
  const openByCustomer = new Map();
  try {
    const { data: invs } = await supabaseAdmin
      .from('invoices')
      .select('customer_id, amount_total, amount_paid, credited_amount, status')
      .in('customer_id', custIds)
      .in('status', OPEN_STATUSES);
    for (const iv of invs || []) {
      const v = openAmount(iv);
      if (v > 0) openByCustomer.set(iv.customer_id, (openByCustomer.get(iv.customer_id) || 0) + v);
    }
  } catch (e) { console.warn('[conv-less-resume] batch open-amount fail-soft:', e?.message || e); }

  const sorted = runs.slice().sort((a, b) => {
    const da = openByCustomer.get(a.customer_id) || 0;
    const db = openByCustomer.get(b.customer_id) || 0;
    if (db !== da) return db - da;                                              // grootste schuld eerst
    return String(b.updated_at || '').localeCompare(String(a.updated_at || '')); // recentste run = winnaar
  });

  const processed = new Set();
  let acted = 0, resumeIndex = 0;

  for (const run of sorted) {
    if (acted >= maxActions) { summary.skipped.push({ reason: 'MAX_ACTIONS_REACHED' }); break; }
    try {
      const cid = run.customer_id;
      if (processed.has(cid)) { summary.duplicate_skipped++; continue; } // één winnaar per klant

      // ── VERSE betaal-check (geen oude snapshot) ──
      const { customer, openInvoices } = await loadRenderContext(cid);
      if (!customer) { summary.skipped.push({ run_id: run.id, reason: 'CUSTOMER_NOT_FOUND' }); continue; }
      processed.add(cid);

      // BETAALD → run(s) direct afronden (dubbele lopen mee via completeRunsForCustomer).
      if ((openInvoices?.length || 0) === 0) {
        await completeRunsForCustomer(cid, 'paid');
        summary.paid_completed++; acted++; continue;
      }

      // NOG SCHULD → recent contact?
      const lastContactMs = await _lastCustomerContactMs(cid, customer.email);
      const recent = lastContactMs > 0 && (nowMs - lastContactMs) < silenceMs;
      if (recent) {
        const created = await _ensureHumanTask({ cid, run, kind: 'review_conversation', lastContactMs });
        if (created) { summary.recent_contact_human++; acted++; }
        else summary.skipped.push({ run_id: run.id, reason: 'RECENT_CONTACT_ALREADY_FLAGGED' });
        continue;
      }

      // STIL >= silence_days:
      if (config.mode !== 'auto_first') {
        // human_only → NIET autonoom hervatten; mens-taak borgen.
        const created = await _ensureHumanTask({ cid, run, kind: 'resume_manually', lastContactMs });
        if (created) { summary.stale_human++; acted++; }
        else summary.skipped.push({ run_id: run.id, reason: 'STALE_ALREADY_FLAGGED' });
        continue;
      }

      // auto_first → HERVATTEN met zachte, kanaal-passende ladder-ingang.
      const softStepId = await _softEntryStepId(run.workflow_id, preferChannelFor(run.paused_manual_reason));
      const nextAt = new Date(nowMs + resumeIndex * staggerMs).toISOString();
      resumeIndex++;
      try {
        const iso = new Date().toISOString();
        const upd = { status: 'active', paused_manual_reason: null, paused_at: null, next_action_at: nextAt, updated_at: iso };
        if (softStepId) upd.current_step_id = softStepId; // zachte eerste engine-touch (beide kanalen)
        await supabaseAdmin.from('dunning_workflow_runs').update(upd).eq('id', run.id).eq('status', 'paused'); // klem
        await supabaseAdmin.from('dunning_log').insert({
          run_id: run.id, step_id: softStepId || null, event_type: 'conv_less_resumed',
          payload: { reason: run.paused_manual_reason || 'wees', next_action_at: nextAt, soft_entry_step_id: softStepId || null, channel: preferChannelFor(run.paused_manual_reason) },
        });
        summary.resumed++;
        // Losende dubbele sibling(s) van DEZELFDE klant actief afsluiten.
        const sup = await _supersedeSiblingRuns(cid, run.id);
        summary.superseded += sup;
      } catch (e) { console.warn('[conv-less-resume] resume update fail-soft:', run.id, e?.message || e); }
      acted++;
    } catch (e) {
      summary.errors.push({ run_id: run.id, error: e?.message || String(e) });
    }
  }

  return summary;
}

// ── Zachte, kanaal-passende ladder-ingang (Option B) ────────────────────────
// Eerste send-stap van het gevraagde kanaal (bv. de vriendelijke dag-7-stap);
// fallback op de eerste send-stap ongeacht kanaal. Null → current_step_id
// ongewijzigd laten (de run hervat dan op z'n huidige stap).
async function _softEntryStepId(workflowId, preferChannel) {
  if (!workflowId) return null;
  try {
    const { data: steps } = await supabaseAdmin.from('dunning_workflow_steps')
      .select('id, step_type, step_order').eq('workflow_id', workflowId).order('step_order', { ascending: true });
    const sends = (steps || []).filter((s) => s.step_type === 'email' || s.step_type === 'whatsapp');
    if (!sends.length) return null;
    const preferred = sends.find((s) => s.step_type === preferChannel);
    return (preferred || sends[0]).id;
  } catch (_) { return null; }
}

// ── Losende dubbele runs van dezelfde klant afsluiten (superseded_duplicate) ─
async function _supersedeSiblingRuns(cid, winnerRunId) {
  let n = 0;
  try {
    const { data: sibs } = await supabaseAdmin.from('dunning_workflow_runs')
      .select('id').eq('customer_id', cid).neq('id', winnerRunId).in('status', ['active', 'paused']);
    for (const s of sibs || []) {
      try {
        const iso = new Date().toISOString();
        await supabaseAdmin.from('dunning_workflow_runs')
          .update({ status: 'cancelled', completion_reason: 'superseded_duplicate', completed_at: iso, updated_at: iso })
          .eq('id', s.id).in('status', ['active', 'paused']); // klem
        await supabaseAdmin.from('dunning_log').insert({
          run_id: s.id, step_id: null, event_type: 'cancelled', payload: { reason: 'superseded_duplicate', winner_run_id: winnerRunId },
        });
        n++;
      } catch (e) { console.warn('[conv-less-resume] supersede sibling fail-soft:', s.id, e?.message || e); }
    }
  } catch (e) { console.warn('[conv-less-resume] sibling lookup fail-soft:', cid, e?.message || e); }
  return n;
}

// ── Laatste klantcontact (max van WA-inbound + e-mail-inbound) ──────────────
async function _lastCustomerContactMs(cid, email) {
  let waMs = 0, mailMs = 0;
  try {
    const { data } = await supabaseAdmin.from('whatsapp_conversations')
      .select('last_inbound_at').eq('customer_id', cid)
      .not('last_inbound_at', 'is', null)
      .order('last_inbound_at', { ascending: false }).limit(1).maybeSingle();
    if (data?.last_inbound_at) waMs = Date.parse(data.last_inbound_at) || 0;
  } catch (_) { /* fail-soft */ }
  if (email) {
    try {
      const { data } = await supabaseAdmin.from('email_messages')
        .select('date_received').ilike('from_address', email)
        .order('date_received', { ascending: false }).limit(1).maybeSingle();
      if (data?.date_received) mailMs = Date.parse(data.date_received) || 0;
    } catch (_) { /* fail-soft */ }
  }
  return Math.max(waMs, mailMs);
}

// ── Mens-worklist-taak (idempotent per klant; blokkeert bewust) ─────────────
async function _ensureHumanTask({ cid, run, kind, lastContactMs }) {
  try {
    const { data: existing } = await supabaseAdmin.from('pending_actions').select('id')
      .eq('customer_id', cid).eq('action_type', 'MANUAL_FOLLOWUP')
      .in('status', ['PENDING', 'APPROVED'])
      .filter('payload->>source', 'eq', 'conv_less_resume').limit(1);
    if (existing?.length) return false;
  } catch (e) { console.warn('[conv-less-resume] human-task idem-check fail-soft:', e?.message || e); }

  const contactIso = lastContactMs ? new Date(lastContactMs).toISOString().slice(0, 10) : 'onbekend';
  const isReview = kind === 'review_conversation';
  const payload = {
    title: isReview ? 'Mogelijk lopend gesprek — controleer aanmaning' : 'Conv-loze pauze — hervat handmatig',
    description: isReview
      ? `Klant reageerde recent (laatste contact ${contactIso}) en de aanmaan-flow staat gepauzeerd zonder gekoppeld gesprek. Beoordeel of het gesprek nog loopt; hervat of sluit handmatig.`
      : `Aanmaan-flow staat al lang gepauzeerd zonder gekoppeld gesprek en de factuur is nog open. Beoordeel en hervat/sluit handmatig (of zet mode='auto_first' voor automatisch hervatten).`,
    kind,
    source: 'conv_less_resume',      // NIET 'dunning_workflow' → blokkeert bewust (mens beslist)
    workflow_run_id: run.id,
    paused_manual_reason: run.paused_manual_reason || null,
    last_contact_date: contactIso,
    rationale: 'Aangemaakt door conv-less-resume-sweep.',
  };
  try {
    await supabaseAdmin.from('pending_actions').insert({
      customer_id: cid, arrangement_id: null, invoice_id: null,
      action_type: 'MANUAL_FOLLOWUP', status: 'PENDING', proposed_by_user_id: null, payload,
    });
    return true;
  } catch (e) { console.warn('[conv-less-resume] human-task insert fail:', e?.message); return false; }
}
