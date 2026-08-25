// api/_lib/promise-maturity.js
//
// Promise-maturity-handler: laat open MANUAL_CONFIRM_PROMISE-taken "rijpen"
// zodat een verlopen betaaltoezegging de dunning-run niet meer eeuwig blokkeert.
//
// PROBLEEM (bevestigd): een MANUAL_CONFIRM_PROMISE-taak (aangemaakt door
// joost-suggest-core.js bij intent=payment_promise) blokkeert via de
// open-action-guard (pending-actions-guard.js) zowel de engine-advance als de
// reminder-cron. Er bestond GEEN afhandeling die de taak sluit + de run hervat
// wanneer de beloofde datum verstrijkt. Deze module vult dat gat.
//
// GEDRAG (per open promise-taak):
//   * gerijpt = MET datum en promised_date_hint < (vandaag − grace_days), OF
//               ZONDER datum en de taak is ouder dan no_date_grace_days.
//     (datum in de toekomst / binnen coulance / te recent zonder datum → niet aanraken.)
//   * NAGEKOMEN (0 open facturen) → taak sluiten ('fulfilled'), en de run(s)
//     DIRECT op 'completed' zetten (NIET hervatten). Een schuldenvrije klant mag
//     onder geen beding aangemaand worden — we laten de engine-ordening buiten
//     beschouwing en ronden zelf af. Geen bericht.
//   * GEBROKEN (nog open facturen) → taak sluiten ('broken' / 'broken_no_date'),
//     run hervatten, dán:
//       - MET datum, 1e gebroken belofte, mode=auto_first + template → één
//         belofte-specifiek template-bericht; ladder loopt daarna door.
//       - 2e+ gebroken / human_only / geen template / send-fail / ZONDER datum →
//         mens-worklist-taak (MANUAL_FOLLOWUP); run blijft geparkeerd tot een mens
//         beslist. (Zonder datum kan er niet zinvol een "u beloofde rond [datum]"-
//         bericht, dus die gaan ALTIJD via de mens.)
//
// VEILIG DEFAULT: alles achter joost_config.finance.autonomy_config.promise_maturity.
//   enabled=false (sweep no-op) + mode='human_only' (nooit auto-sturen) +
//   broken_template_name=null. Dry-run (dunning_dry_run) onderdrukt de echte send.
//
// Idempotent: elke taak wordt met een atomic conditional-close geclaimd
// (status pending/approved → REJECTED); een tweede gelijktijdige run verliest de
// claim en slaat over. Gespreid via max_actions_per_run. Fail-soft per taak.

import { supabaseAdmin } from '../supabase.js';
import { unpauseRunsForConversation } from './dunning-arrangement-hooks.js';
import { buildReminderTemplatePayload } from './conv-reminder-template.js';
import { renderTemplatePreview } from './render-template-preview.js';
// Hergebruik de exact-gelijke config/deps/render-helpers van de reminder-cron,
// zodat template-mapping, sandbox-guard en dry-run 1-op-1 hetzelfde werken.
import {
  loadConversationReminderConfig,
  loadConversationReminderDeps,
  loadRenderContext,
} from '../cron-dunning-conversation-reminders.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

// ── Config ─────────────────────────────────────────────────────────────────
export const PROMISE_MATURITY_DEFAULTS = Object.freeze({
  enabled:             false,          // master-switch — default UIT (sweep no-op)
  mode:                'human_only',   // 'human_only' | 'auto_first'
  grace_days:          1,              // coulance (mét datum): acteren pas als hint < vandaag − N
  no_date_grace_days:  7,              // beloftes ZONDER datum: mens-taak na N dagen open
  broken_template_name: null,          // Meta-template voor de belofte-boodschap (Jeffrey levert)
  max_actions_per_run: 25,             // spreiding / veiligheids-cap per run
});

export async function getPromiseMaturityConfig() {
  const cfgRes = await loadConversationReminderConfig();
  const ac = (cfgRes?.ok ? cfgRes.autonomyCfg : {}) || {};
  const pm = (ac.promise_maturity && typeof ac.promise_maturity === 'object') ? ac.promise_maturity : {};
  return { ...PROMISE_MATURITY_DEFAULTS, ...pm };
}

// ── NL-datum helpers (Europe/Amsterdam kalenderdag) ─────────────────────────
function nlYmd(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function ymdMinusDays(ymd, n) {
  const [y, m, dd] = ymd.split('-').map(Number);
  const a = new Date(Date.UTC(y, m - 1, dd));
  a.setUTCDate(a.getUTCDate() - (Number(n) || 0));
  return a.toISOString().slice(0, 10);
}

// ── Hoofd-sweep ──────────────────────────────────────────────────────────────
export async function runPromiseMaturity({ scope = 'production' } = {}) {
  const summary = {
    enabled: false, dry_run: false, config_mode: null,
    scanned: 0, matured: 0,
    fulfilled: 0, broken_auto_sent: 0, broken_human: 0, no_date_human: 0,
    skipped: [], errors: [],
  };

  const config = await getPromiseMaturityConfig();
  summary.config_mode = config.mode;
  // scope='test' bypasst de enabled-flag zodat cockpit-triggers werken
  // terwijl productie op enabled=false blijft. is_test-filter (pre-fetch
  // join + post-fetch check r141-142 + fatale tripwire hieronder) is
  // autoritatief; non-test kan onmogelijk verwerkt worden.
  if (!config.enabled && scope !== 'test') { summary.skipped.push({ reason: 'FEATURE_DISABLED' }); return summary; }
  summary.enabled = true;

  const deps = await loadConversationReminderDeps();
  const dryRunOn = deps.isDryRunEnabled ? await deps.isDryRunEnabled() : true; // fail-safe: dry-run AAN
  summary.dry_run = dryRunOn;

  const nowMs      = Date.now();
  const todayNl    = nlYmd(new Date(nowMs));
  const cutoff     = ymdMinusDays(todayNl, Number(config.grace_days) || 1); // hint < cutoff = gerijpt
  const noDateMs   = (Number(config.no_date_grace_days) || 7) * 86400000;
  const maxActions = Number(config.max_actions_per_run) || 25;

  // Pre-fetch is_test-filter via inner-join customers zodat de SELECT nooit
  // buiten scope reikt. Post-fetch is_test-check op r141-142 blijft staan
  // (defense-in-depth — één gemiste WHERE mag de fetch niet doen lekken).
  let taskQ = supabaseAdmin
    .from('pending_actions')
    .select('id, customer_id, status, payload, created_at, customers!inner(is_test)')
    .eq('action_type', 'MANUAL_CONFIRM_PROMISE')
    .in('status', ['PENDING', 'APPROVED'])
    .order('created_at', { ascending: true });
  if (scope === 'production') taskQ = taskQ.eq('customers.is_test', false);
  else if (scope === 'test')  taskQ = taskQ.eq('customers.is_test', true);
  const { data: tasks, error } = await taskQ;
  if (error) { summary.errors.push({ stage: 'fetch', error: error.message }); return summary; }
  summary.scanned = (tasks || []).length;

  // ── Fatale tripwire (derde laag) ───────────────────────────────────────
  // Bij scope='test' MAG geen enkele niet-is_test rij in de te-verwerken
  // set zitten. Als het TOCH gebeurt (bv. door een toekomstige filter-
  // regressie) → throw fataal vóór er ook maar één write plaatsvindt.
  // Stille skip zou een test-run productie-data laten aanraken; fataal
  // throwen maakt de regressie meteen zichtbaar in de cockpit-response.
  if (scope === 'test') {
    const leak = (tasks || []).find((t) => t?.customers?.is_test !== true);
    if (leak) {
      throw new Error(
        `[promise-maturity] SCOPE=TEST TRIPWIRE — task ${leak.id} referenceert non-test customer ${leak.customer_id} (customers.is_test=${JSON.stringify(leak?.customers?.is_test)}). Run afgebroken vóór enige write.`,
      );
    }
  }

  let acted = 0;
  for (const task of tasks || []) {
    if (acted >= maxActions) { summary.skipped.push({ reason: 'MAX_ACTIONS_REACHED' }); break; }
    try {
      const hint    = task.payload?.promised_date_hint || null;
      const hasHint = !!hint && /^\d{4}-\d{2}-\d{2}$/.test(hint);

      // ── Maturity-gate ──
      // MET datum: rijp als hint < cutoff. ZONDER datum: rijp als de taak ouder
      // is dan no_date_grace_days (dode-hoek dichten — niet stil laten hangen).
      let matured = false, dated = false;
      if (hasHint) {
        dated = true;
        matured = hint < cutoff;
        if (!matured) { summary.skipped.push({ task_id: task.id, reason: 'NOT_MATURE' }); continue; }
      } else {
        const ageMs = nowMs - Date.parse(task.created_at || 0);
        matured = Number.isFinite(ageMs) && ageMs >= noDateMs;
        if (!matured) { summary.skipped.push({ task_id: task.id, reason: 'NO_DATE_TOO_RECENT' }); continue; }
      }
      summary.matured++;

      const cid    = task.customer_id;
      const convId = task.payload?.conversation_id || null;
      const { customer, openInvoices } = await loadRenderContext(cid);
      if (!customer) { summary.skipped.push({ task_id: task.id, reason: 'CUSTOMER_NOT_FOUND' }); continue; }
      // is_test-scope (spiegel van de engine): production negeert testklanten.
      if (scope === 'production' && customer.is_test) { summary.skipped.push({ task_id: task.id, reason: 'IS_TEST_SKIPPED' }); continue; }
      if (scope === 'test' && !customer.is_test)      { summary.skipped.push({ task_id: task.id, reason: 'NON_TEST_SKIPPED' }); continue; }

      const fulfilled = (openInvoices?.length || 0) === 0;
      const outcome   = fulfilled ? 'fulfilled' : (dated ? 'broken' : 'broken_no_date');

      // ── NAGEKOMEN: belofte-taak sluiten + run(s) DIRECT afronden, NIET hervatten ──
      // Kritisch: een schuldenvrije klant mag nooit aangemaand worden. We maken
      // ons niet afhankelijk van de engine-ordening en completen de run(s) zelf.
      if (fulfilled) {
        if (!(await _closePromiseTask(task, { outcome, hint }))) { summary.skipped.push({ task_id: task.id, reason: 'CLAIM_LOST' }); continue; }
        await completeRunsForCustomer(cid, 'promise_fulfilled_paid');
        summary.fulfilled++; acted++; continue;
      }

      // GEBROKEN. Repeat-detectie (gebruikt de nog-open taak): eerdere door ons
      // gesloten broken-taken (durabele marker) + re-promises in history[].
      let isRepeat = false;
      if (dated) {
        let priorBroken = 0;
        try {
          const { count } = await supabaseAdmin
            .from('pending_actions')
            .select('id', { count: 'exact', head: true })
            .eq('customer_id', cid)
            .eq('action_type', 'MANUAL_CONFIRM_PROMISE')
            .neq('id', task.id)
            .like('payload->>maturity_outcome', 'broken%');
          priorBroken = count || 0;
        } catch (e) { console.warn('[promise-maturity] priorBroken count fail-soft:', e?.message || e); }
        const hist = Array.isArray(task.payload?.history) ? task.payload.history : [];
        isRepeat = priorBroken > 0 || hist.length > 1;
      }

      // ── GEBROKEN, AUTO (1e gedateerde belofte, auto_first + template) ──
      // Sluit de taak, stuur het bericht, en HERVAT (unpause) ALLEEN bij een
      // geslaagde send. Mislukt de send → NIET hervatten (run blijft veilig
      // gepauzeerd) + mens-taak voor zichtbaarheid.
      if (dated && config.mode === 'auto_first' && !isRepeat && config.broken_template_name) {
        if (!(await _closePromiseTask(task, { outcome, hint }))) { summary.skipped.push({ task_id: task.id, reason: 'CLAIM_LOST' }); continue; }
        const sendRes = await _sendBrokenPromiseMessage({
          deps, convId, customer, openInvoices, templateName: config.broken_template_name, dryRunOn,
        });
        if (sendRes.ok) {
          if (convId) { try { await unpauseRunsForConversation(convId); } catch (e) { console.warn('[promise-maturity] unpause fail-soft:', e?.message || e); } }
          summary.broken_auto_sent++; acted++; continue;
        }
        await _ensureHumanFollowupTask({ cid, convId, task, promisedHint: hint, dated });
        summary.skipped.push({ task_id: task.id, reason: 'SEND_FAILED:' + sendRes.reason });
        summary.broken_human++; acted++; continue;
      }

      // ── GEBROKEN, MENS (human_only / 2e+ / geen template / zonder datum) ──
      // HARDE GARANTIE tegen aanmanen: (1) maak EERST de BLOKKERENDE mens-taak,
      // (2) sluit de belofte-taak pas daarna, (3) HERVAT NOOIT. Lukt de mens-taak
      // niet, dan blijft de belofte-taak open (die blokkeert nog) → op elk moment
      // ≥1 blokkerende pending_action, en de run gaat nooit naar 'active'.
      const ensured = await _ensureHumanFollowupTask({ cid, convId, task, promisedHint: hint, dated });
      if (!ensured) { summary.skipped.push({ task_id: task.id, reason: 'HUMAN_TASK_FAILED' }); continue; }
      if (!(await _closePromiseTask(task, { outcome, hint }))) { summary.skipped.push({ task_id: task.id, reason: 'CLAIM_LOST' }); continue; }
      if (dated) summary.broken_human++; else summary.no_date_human++;
      acted++;
    } catch (e) {
      summary.errors.push({ task_id: task.id, error: e?.message || String(e) });
    }
  }

  return summary;
}

// ── Belofte-taak atomair sluiten (REJECTED) ─────────────────────────────────
// maturity_outcome + rejection_reason maken 'nagekomen' vs 'gebroken' glashelder
// (de UI toont status REJECTED als "afgewezen"; de reden corrigeert dat).
// Returnt true als DEZE call de taak sloot (claim gewonnen), anders false.
async function _closePromiseTask(task, { outcome, hint }) {
  const rejectionReason =
      outcome === 'fulfilled' ? 'belofte NAGEKOMEN — factuur betaald (auto-maturity, geen afwijzing)'
    : outcome === 'broken'    ? 'belofte VERLOPEN — datum verstreken, factuur nog open (auto-maturity)'
    :                           'belofte zonder datum — vervaltermijn verstreken (auto-maturity)';
  const closePayload = {
    ...(task.payload || {}),
    maturity_outcome: outcome,
    matured_at:       new Date().toISOString(),
    matured_hint:     hint || null,
  };
  const { data: claimed } = await supabaseAdmin
    .from('pending_actions')
    .update({ status: 'REJECTED', rejection_reason: rejectionReason, payload: closePayload, updated_at: new Date().toISOString() })
    .eq('id', task.id)
    .in('status', ['PENDING', 'APPROVED'])
    .select('id');
  return !!(claimed && claimed.length);
}

// ── Run(s) van een schuldenvrije klant direct afronden ──────────────────────
// Zet alle niet-terminale runs op 'completed' (spiegel van de engine's paid-
// completion) + wist gespreks-pauze-velden. NIET hervatten: er is geen schuld,
// dus de run hoeft de ladder niet te vervolgen.
export async function completeRunsForCustomer(cid, reason) {
  let runs = [];
  try {
    const { data } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id')
      .eq('customer_id', cid)
      .in('status', ['active', 'paused']);
    runs = data || [];
  } catch (e) { console.warn('[promise-maturity] complete-run fetch fail-soft:', e?.message || e); return; }

  for (const r of runs) {
    try {
      const iso = new Date().toISOString();
      await supabaseAdmin
        .from('dunning_workflow_runs')
        .update({
          status: 'completed', completed_at: iso, completion_reason: reason,
          paused_by_conversation_id: null,
          paused_conversation_reminder_count: 0,
          paused_conversation_last_reminder_at: null,
          updated_at: iso,
        })
        .eq('id', r.id)
        .in('status', ['active', 'paused']); // klem: raakt geen al-afgeronde run
      await supabaseAdmin.from('dunning_log').insert({
        run_id: r.id, step_id: null, event_type: 'completed', payload: { reason },
      });
    } catch (e) { console.warn('[promise-maturity] complete-run fail-soft:', r.id, e?.message || e); }
  }
}

// ── Belofte-specifiek template-bericht (WhatsApp) ───────────────────────────
// Spiegelt exact de send+persist van cron-dunning-conversation-reminders.js
// (template-payload-mapping, outbound phone_number_id, sandbox-guard, dry-run).
async function _sendBrokenPromiseMessage({ deps, convId, customer, openInvoices, templateName, dryRunOn }) {
  if (!convId) return { ok: false, reason: 'NO_CONVERSATION' };
  const { data: conv } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('id, phone_number, phone_number_id')
    .eq('id', convId).maybeSingle();
  const sendTo = conv?.phone_number || customer.phone;
  if (!sendTo) return { ok: false, reason: 'NO_PHONE' };

  if (customer.is_test && deps.assertRecipientMatchesSandbox) {
    try { await deps.assertRecipientMatchesSandbox({ isTest: true, actual: sendTo, channel: 'whatsapp' }); }
    catch (e) { return { ok: false, reason: 'SANDBOX_GUARD:' + e.message }; }
  }

  const legacyVars = deps.computeVariables ? deps.computeVariables({ customer, openInvoices }) : {};
  let tplPayload = null;
  try {
    tplPayload = await buildReminderTemplatePayload({
      templateName,
      ctx: { customer, openInvoices, invoice: openInvoices[0] || null },
      legacyVars, supabase: supabaseAdmin,
    });
  } catch (e) { return { ok: false, reason: 'TEMPLATE_BUILD_FAIL:' + e.message }; }

  if (dryRunOn) {
    console.log('[promise-maturity DRY-RUN] zou belofte-template sturen', { to: sendTo, templateName });
    return { ok: true, dry: true };
  }
  if (!deps.getConfigStatus || !deps.getConfigStatus().configured) return { ok: false, reason: 'META_NOT_CONFIGURED' };

  let outboundPnId = conv?.phone_number_id || null;
  if (!outboundPnId) {
    try {
      const { data } = await supabaseAdmin.from('whatsapp_module_config')
        .select('phone_number_id').eq('module', 'finance').eq('is_active', true).maybeSingle();
      outboundPnId = data?.phone_number_id || null;
    } catch (_) { /* fail-soft */ }
  }

  let wamid = null;
  try {
    const sendArgs = { to: sendTo, templateName, languageCode: tplPayload.templateLanguage || 'nl', phoneNumberId: outboundPnId };
    if (tplPayload.mode === 'mapping' && tplPayload.components) sendArgs.components = tplPayload.components;
    else sendArgs.variables = tplPayload.variables;
    const r = await deps.sendTemplate(sendArgs);
    wamid = r?.wamid || null;
  } catch (metaErr) {
    if (deps.MetaNotConfiguredError && metaErr instanceof deps.MetaNotConfiguredError) return { ok: false, reason: 'META_NOT_CONFIGURED_RUNTIME' };
    return { ok: false, reason: 'META_SEND_FAIL:' + (metaErr?.message || metaErr) };
  }

  // Persist in de thread zodat de klant-boodschap zichtbaar is (fail-soft).
  try {
    let previewBody = `[belofte-herinnering] ${templateName}`;
    try {
      const preview = await renderTemplatePreview({ templateName, templateVariables: tplPayload?.usedVariables || null, supabase: supabaseAdmin });
      previewBody = preview.body || previewBody;
    } catch (_) { /* legacy-label fallback */ }
    await supabaseAdmin.from('whatsapp_messages').insert({
      conversation_id: conv.id, direction: 'out', meta_wamid: wamid,
      body: previewBody.slice(0, 1000), template_name: templateName,
      template_variables: tplPayload?.usedVariables || null,
      status: 'queued', sent_at: new Date().toISOString(), sent_by_user_id: null,
    });
  } catch (e) { console.warn('[promise-maturity] whatsapp_messages insert fail:', e?.message); }

  return { ok: true };
}

// ── Mens-worklist-taak (blokkeert bewust → mens beslist) ────────────────────
// Returnt true als er ná deze call een BLOKKERENDE mens-taak bestaat (nieuw óf
// al aanwezig), false alleen als het aanmaken faalde. De caller sluit de
// belofte-taak pas als dit true is → er is altijd ≥1 blokkerende actie.
async function _ensureHumanFollowupTask({ cid, convId, task, promisedHint, dated }) {
  // Idempotent: geen tweede open promise-followup voor dezelfde klant(+gesprek).
  try {
    let q = supabaseAdmin.from('pending_actions').select('id')
      .eq('customer_id', cid).eq('action_type', 'MANUAL_FOLLOWUP')
      .in('status', ['PENDING', 'APPROVED'])
      .filter('payload->>source', 'eq', 'promise_maturity');
    if (convId) q = q.filter('payload->>conversation_id', 'eq', convId);
    const { data: existing } = await q.limit(1);
    if (existing?.length) return true; // blokkerende taak bestaat al
  } catch (e) { console.warn('[promise-maturity] human-task idem-check fail-soft:', e?.message || e); }

  const description = dated
    ? `Betaaltoezegging (rond ${promisedHint}) is verstreken zonder betaling. Beoordeel en volg persoonlijk op.`
    : `Klant deed een betaaltoezegging ZONDER concrete datum en de factuur staat nog open. Neem contact op om een datum af te spreken of te escaleren.`;
  const payload = {
    title: dated ? 'Gebroken belofte — actie nodig' : 'Belofte zonder datum — actie nodig',
    description,
    kind: 'promise_followup',
    source: 'promise_maturity',   // NIET 'dunning_workflow' → blokkeert bewust (mens beslist)
    conversation_id: convId,
    promised_date_hint: promisedHint || null,
    promised_date_raw: task.payload?.promised_date_raw || null,
    origin_promise_action_id: task.id,
    rationale: 'Aangemaakt door promise-maturity-sweep (gebroken belofte).',
  };
  try {
    await supabaseAdmin.from('pending_actions').insert({
      customer_id: cid, arrangement_id: null, invoice_id: null,
      action_type: 'MANUAL_FOLLOWUP', status: 'PENDING', proposed_by_user_id: null, payload,
    });
    return true;
  } catch (e) { console.warn('[promise-maturity] human-task insert fail:', e?.message); return false; }
}
