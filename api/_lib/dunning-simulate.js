// api/_lib/dunning-simulate.js
//
// DRY-RUN SIMULATIE van de aanmaan-motor. Pure functie: geen DB, geen HTTP,
// geen writes, geen sends. Krijgt een SNAPSHOT van de live dataset en rekent
// uit wat `dunning-engine.js` zou doen op dag 1 na deploy en de dagen daarna.
//
// Waarom een aparte core i.p.v. de engine met een dry-run-vlag: de engine
// muteert onderweg (runs, dunning_log, pipeline-stages, Joost-tellers,
// mentor-ledger). Een vlag door al die paden weven is precies het soort
// wijziging dat je op een live CRM niet wilt. Deze core leest alleen en
// spiegelt de beslisregels; de guard-functies zelf worden GEDEELD met de
// motor (dunning-overdue-guard.js), zodat de ladder- en vervaldatum-logica
// per definitie identiek is.
//
// Wat WEL gespiegeld wordt (in dezelfde volgorde als de motor):
//   detect : cooldown → harde vervaldatum-poort → startdrempel (ladder) →
//            klanttype → min. openstaand → terminale pipeline-fase →
//            bestaande run → run_once → arrangement_breached
//   advance: openstaand>0 → blokkerende actie → kantooruren (send-stappen) →
//            vervaldatum-poort → ladder-sport → stap uitvoeren →
//            pointer door (wait mikt op de ladder-dag van de volgende send)
//
// AANNAMES (bewust, staan ook in de rapport-header van het script):
//   * niemand betaalt tijdens het simulatievenster
//   * niemand antwoordt (reply-stop pauzeert dus geen enkele run)
//   * er komen geen nieuwe facturen bij
//   * elke send slaagt (geen Meta-fouten, geen retry-pad)
//   * niemand grijpt handmatig in
// Dat maakt de uitkomst een BOVENGRENS: in werkelijkheid vertrekken er
// minder berichten, nooit meer.

import {
  todayIsoInTz,
  daysOverdueSigned,
  isOverdue,
  resolveStepTierDays,
  resolveWorkflowStartDays,
  DEFAULT_LADDER,
  DEFAULT_GRACE_DAYS,
} from './dunning-overdue-guard.js';

import {
  isSendStep,
  isWithinOfficeHours,
  DEFAULT_OFFICE_HOURS,
} from './dunning-office-hours.js';

const DAY_MS = 86400000;

/** 'YYYY-MM-DD' → epoch-ms op UTC-middernacht. */
function ymdMs(iso) {
  const ms = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}
/** epoch-ms → 'YYYY-MM-DD' (UTC). */
function msYmd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function addDays(iso, n) {
  return msYmd(ymdMs(iso) + n * DAY_MS);
}

/** Oudste vervaldatum over de openstaande facturen van een klant. */
export function oldestDueIso(invoices) {
  let out = null;
  for (const inv of invoices || []) {
    if (!inv?.due_date) continue;
    const iso = String(inv.due_date).slice(0, 10);
    if (!out || iso < out) out = iso;
  }
  return out;
}

/** Totaal openstaand (euro) over de facturen van een klant. */
export function totalOpenEur(invoices) {
  let sum = 0;
  for (const inv of invoices || []) sum += Number(inv?.open_amount) || 0;
  return sum;
}

function isCompany(c) {
  if (c?.is_company === true) return true;
  return !!(c?.company_name && String(c.company_name).trim());
}
function matchesCustomerType(customer, wanted) {
  if (!wanted || wanted === 'any') return true;
  if (wanted === 'b2b') return isCompany(customer);
  if (wanted === 'b2c') return !isCompany(customer);
  return true;
}

const TERMINAL_STAGES = new Set(['opgelost', 'afschrijven']);

/**
 * Simuleer de motor over `horizonDays` dagen vanaf `snapshot.today`.
 *
 * @param {object} snapshot   zie scripts/dunning-dry-run-simulatie.js voor de opbouw
 * @param {object} [opts]
 *   - horizonDays              (default 8)
 *   - maxSendsPerCustomerPerDay  SIMULATIE-KNOP voor het voorstel "max één
 *     ladder-sport per klant per dag". null = spiegel de huidige branch.
 *     Zit BEWUST alleen hier en niet in de motor: dit is een what-if, geen
 *     gedragswijziging.
 *   - backfillPointer          SIMULATIE-KNOP voor het voorstel "eenmalige
 *     backfill": zet bij aanvang de pointer van elke bestaande run op de
 *     hoogste ladder-sport die de klant al voorbij is, zonder te verzenden.
 * @returns {object} rapport-object (puur data; het script maakt er tekst van)
 */
export function simulateEngine(snapshot, opts = {}) {
  const horizonDays = Number.isFinite(Number(opts.horizonDays)) ? Number(opts.horizonDays) : 8;
  const maxPerDay   = Number.isFinite(Number(opts.maxSendsPerCustomerPerDay))
    ? Number(opts.maxSendsPerCustomerPerDay) : null;
  const backfillPointer = opts.backfillPointer === true;
  const startIso    = snapshot?.today || todayIsoInTz();

  const settings    = snapshot?.settings || {};
  const graceDays   = Number.isFinite(Number(settings.graceDays)) ? Number(settings.graceDays) : DEFAULT_GRACE_DAYS;
  const cooldownDays = Number.isFinite(Number(settings.cooldownDays)) ? Number(settings.cooldownDays) : 7;
  const ladder      = settings.ladder || DEFAULT_LADDER;
  const officeHours = settings.officeHours || DEFAULT_OFFICE_HOURS;

  const templates   = new Map(Object.entries(snapshot?.templates || {}));
  const workflows   = (snapshot?.workflows || [])
    .slice()
    .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));

  // ── Werkkopie van de runs (in-memory; de echte tabel wordt nooit geraakt) ──
  const runs = (snapshot?.runs || []).map((r) => ({ ...r }));
  const runsByCustomer = new Map();
  for (const r of runs) {
    if (['active', 'paused'].includes(r.status)) runsByCustomer.set(r.customer_id, r);
  }

  // Ooit-gedraaid per (workflow, customer) — voor run_once_per_customer.
  const everRan = new Set((snapshot?.everRan || []).map((e) => `${e.workflow_id}|${e.customer_id}`));
  // Laatste engine-send per klant (uit dunning_log) — voor de cooldown.
  const lastSendByCustomer = new Map(Object.entries(snapshot?.lastSendByCustomer || {}));
  const blocked = new Set(snapshot?.blockedCustomers || []);
  const breached = new Map(Object.entries(snapshot?.breachedByCustomer || {}));

  const customers = (snapshot?.customers || []).map((c) => ({ ...c }));
  const custById  = new Map(customers.map((c) => [c.id, c]));

  // Per workflow: stappen, ladder-sporten en de startdrempel — één keer.
  const wfMeta = new Map();
  for (const wf of workflows) {
    const steps = (wf.steps || []).slice().sort((a, b) => Number(a.step_order) - Number(b.step_order));
    const tierDays = steps
      .filter((st) => isSendStep(st.step_type))
      .map((st) => resolveStepTierDays(st, templates.get(st?.config?.template_id) || null, ladder))
      .filter((n) => Number.isFinite(n));
    wfMeta.set(wf.id, {
      steps,
      stepById: new Map(steps.map((s) => [s.id, s])),
      tierDays,
      startDays: resolveWorkflowStartDays({
        triggerConditions: wf.trigger_conditions || {},
        stepTierDays: tierDays,
        fallbackDays: (wf.trigger_conditions || {}).arrangement_breached === true ? 1 : 14,
      }),
    });
  }

  // ── SIMULATIE-KNOP: eenmalige pointer-backfill ─────────────────────────
  // Zet elke bestaande run op de LAATSTE send-stap waarvan de ladder-sport de
  // klant al voorbij is; die stap wordt dan als eerste verstuurd en de rest
  // van de ladder volgt op zijn eigen dagen. Zo krijgt een klant die al lang
  // te laat is meteen het passende bericht in plaats van de hele reeks.
  if (backfillPointer) {
    for (const run of runs) {
      if (run.status !== 'active') continue;
      const meta = wfMeta.get(run.workflow_id);
      const cust = customers.find((c) => c.id === run.customer_id);
      if (!meta || !cust) continue;
      const signed = daysOverdueSigned(oldestDueIso(cust.invoices), startIso);
      if (signed == null) continue;
      let target = null;
      for (const st of meta.steps) {
        if (!isSendStep(st.step_type)) continue;
        const tier = resolveStepTierDays(st, templates.get(st?.config?.template_id) || null, ladder);
        if (tier != null && signed >= tier) target = st;
      }
      if (target) run.current_step_id = target.id;
    }
  }

  const sentPerCustomerPerDay = new Map();  // `${cid}|${dayIso}` → aantal
  const messages = [];      // { date, hour, customer_id, customer_name, workflow_id, workflow_name, step_order, step_type, template, days_overdue }
  const startedRuns = [];   // { date, customer_id, workflow_id, days_overdue }
  const skipLog = { not_overdue: 0, below_start: 0, cooldown: 0, existing_run: 0, blocked: 0, terminal_stage: 0, type_or_amount: 0, run_once: 0, no_breach: 0 };

  const nextSendTierAfter = (wfId, stepOrder) => {
    const meta = wfMeta.get(wfId);
    if (!meta) return null;
    const nxt = meta.steps.find((st) => Number(st.step_order) > Number(stepOrder) && isSendStep(st.step_type));
    if (!nxt) return null;
    return resolveStepTierDays(nxt, templates.get(nxt?.config?.template_id) || null, ladder);
  };

  for (let d = 0; d < horizonDays; d++) {
    const dayIso = addDays(startIso, d);

    for (let hour = 0; hour < 24; hour++) {
      // Kloktijd van deze tick (Europe/Amsterdam wordt door de office-hours-
      // helper zelf omgerekend; we voeren een echte Date in).
      const tickAt = new Date(ymdMs(dayIso) + hour * 3600000);
      const tickMs = tickAt.getTime();

      // ── DETECT ──────────────────────────────────────────────────────────
      for (const wf of workflows) {
        const meta = wfMeta.get(wf.id);
        if (!meta || !meta.steps.length) continue;
        const tc = wf.trigger_conditions || {};
        const wantBreach = tc.arrangement_breached === true;
        const minTotal = Number.isFinite(Number(tc.min_total_amount)) ? Number(tc.min_total_amount) : 0;

        for (const cust of customers) {
          if (runsByCustomer.has(cust.id)) { skipLog.existing_run++; continue; }
          if (wantBreach && !breached.has(cust.id)) { skipLog.no_breach++; continue; }

          const due = oldestDueIso(cust.invoices);
          if (!isOverdue(due, dayIso, graceDays)) { skipLog.not_overdue++; continue; }

          const signed = daysOverdueSigned(due, dayIso);
          if ((signed ?? 0) < meta.startDays) { skipLog.below_start++; continue; }

          if (!matchesCustomerType(cust, tc.customer_type || 'any')) { skipLog.type_or_amount++; continue; }
          if (totalOpenEur(cust.invoices) < minTotal) { skipLog.type_or_amount++; continue; }
          if (TERMINAL_STAGES.has(cust.stage_slug || '')) { skipLog.terminal_stage++; continue; }
          if (tc.run_once_per_customer_per_workflow === true && everRan.has(`${wf.id}|${cust.id}`)) {
            skipLog.run_once++; continue;
          }

          // Cooldown: een engine-send binnen `cooldownDays` blokkeert een
          // NIEUWE run. (Let op: dit geldt alleen bij het starten, niet
          // tussen de stappen van een lopende run — zie rapport.)
          const last = lastSendByCustomer.get(cust.id);
          if (last && (tickMs - Date.parse(last)) < cooldownDays * DAY_MS) { skipLog.cooldown++; continue; }

          const run = {
            id: `sim:${wf.id}:${cust.id}`,
            workflow_id: wf.id,
            customer_id: cust.id,
            status: 'active',
            current_step_id: meta.steps[0].id,
            next_action_at: tickAt.toISOString(),
            needs_attention: false,
            _simulated: true,
          };
          runs.push(run);
          runsByCustomer.set(cust.id, run);
          everRan.add(`${wf.id}|${cust.id}`);
          startedRuns.push({ date: dayIso, hour, customer_id: cust.id, customer_name: cust.name, workflow_id: wf.id, workflow_name: wf.name, days_overdue: signed });
        }
      }

      // ── ADVANCE ─────────────────────────────────────────────────────────
      for (const run of runs) {
        if (run.status !== 'active') continue;
        if (run.needs_attention) continue;
        if (run.paused_by_conversation_id || run.paused_by_arrangement_id) continue;
        if (run.next_action_at && Date.parse(run.next_action_at) > tickMs) continue;

        const cust = custById.get(run.customer_id);
        const meta = wfMeta.get(run.workflow_id);
        if (!cust || !meta) continue;

        // Geen openstaande facturen → run zou afgerond worden (paid).
        if (!cust.invoices || cust.invoices.length === 0) { run.status = 'completed'; continue; }
        // Blokkerende handmatige actie → stap overslaan deze tick.
        if (blocked.has(cust.id)) { skipLog.blocked++; continue; }

        const due = oldestDueIso(cust.invoices);
        const signed = daysOverdueSigned(due, dayIso);

        // Binnenlus: opeenvolgende niet-wait stappen in één tick, precies
        // zoals de motor (wait/stop breken de lus).
        let guard = 0;
        while (guard++ < 50) {
          const step = meta.stepById.get(run.current_step_id);
          if (!step) { run.status = 'completed'; break; }

          if (isSendStep(step.step_type)) {
            if (!isWithinOfficeHours(tickAt, officeHours)) break;          // wacht op volgende tick
            if (maxPerDay != null) {                                        // what-if-throttle
              const key = `${cust.id}|${dayIso}`;
              if ((sentPerCustomerPerDay.get(key) || 0) >= maxPerDay) {
                run.next_action_at = new Date(ymdMs(dayIso) + DAY_MS).toISOString();
                break;
              }
            }
            if (!isOverdue(due, dayIso, graceDays)) {                       // harde poort
              run.next_action_at = new Date(ymdMs(due) + (graceDays + 1) * DAY_MS).toISOString();
              break;
            }
            const tier = resolveStepTierDays(step, templates.get(step?.config?.template_id) || null, ladder);
            if (tier != null && signed != null && signed < tier) {          // ladder-sport
              run.next_action_at = new Date(ymdMs(due) + tier * DAY_MS).toISOString();
              break;
            }
            const tpl = templates.get(step?.config?.template_id) || null;
            messages.push({
              date: dayIso,
              hour,
              customer_id: cust.id,
              customer_name: cust.name,
              workflow_id: run.workflow_id,
              workflow_name: (workflows.find((w) => w.id === run.workflow_id) || {}).name || run.workflow_id,
              step_order: step.step_order,
              step_type: step.step_type,
              template: tpl?.meta_template_name || tpl?.name || '(geen template)',
              days_overdue: signed,
              run_id: run.id,
              run_was_existing: !run._simulated,
            });
            lastSendByCustomer.set(cust.id, tickAt.toISOString());
            const key = `${cust.id}|${dayIso}`;
            sentPerCustomerPerDay.set(key, (sentPerCustomerPerDay.get(key) || 0) + 1);
          }

          const nextStep = meta.steps.find((st) => Number(st.step_order) > Number(step.step_order)) || null;

          if (step.step_type === 'wait') {
            const waitDays = Number(step?.config?.days) || 0;
            const tier = nextSendTierAfter(run.workflow_id, step.step_order);
            const ladderMs = (tier != null && due) ? (ymdMs(due) + tier * DAY_MS) : null;
            const nextMs = ladderMs != null ? Math.max(tickMs, ladderMs) : (tickMs + waitDays * DAY_MS);
            run.next_action_at = new Date(nextMs).toISOString();
            run.current_step_id = nextStep ? nextStep.id : null;
            if (!nextStep) run.status = 'completed';
            break;
          }
          if (step.step_type === 'stop') { run.status = 'completed'; break; }

          run.next_action_at = tickAt.toISOString();
          run.current_step_id = nextStep ? nextStep.id : null;
          if (!nextStep) { run.status = 'completed'; break; }
        }
      }
    }
  }

  return buildReport({
    startIso, horizonDays, messages, startedRuns, skipLog, snapshot,
    cooldownDays, graceDays, ladder,
    options: { maxSendsPerCustomerPerDay: maxPerDay, backfillPointer },
  });
}

/** Groepeert de ruwe simulatie-uitkomst tot het rapport. */
function buildReport({ startIso, horizonDays, messages, startedRuns, skipLog, snapshot, cooldownDays, graceDays, ladder, options }) {
  const days = [];
  for (let d = 0; d < horizonDays; d++) {
    const dayIso = addDays(startIso, d);
    const msgs = messages.filter((m) => m.date === dayIso);
    const byTemplate = {};
    const byWorkflow = {};
    for (const m of msgs) {
      byTemplate[m.template] = (byTemplate[m.template] || 0) + 1;
      byWorkflow[m.workflow_name] = (byWorkflow[m.workflow_name] || 0) + 1;
    }
    days.push({
      date: dayIso,
      day_index: d + 1,
      total: msgs.length,
      unique_customers: new Set(msgs.map((m) => m.customer_id)).size,
      by_template: byTemplate,
      by_workflow: byWorkflow,
      runs_started: startedRuns.filter((r) => r.date === dayIso).length,
    });
  }

  // ── Klanten met meerdere berichten + de kortste tussenpoos ──────────────
  const perCustomer = new Map();
  for (const m of messages) {
    if (!perCustomer.has(m.customer_id)) perCustomer.set(m.customer_id, []);
    perCustomer.get(m.customer_id).push(m);
  }
  const multiMessage = [];
  for (const [cid, list] of perCustomer) {
    if (list.length < 2) continue;
    list.sort((a, b) => (a.date + String(a.hour).padStart(2, '0')).localeCompare(b.date + String(b.hour).padStart(2, '0')));
    const gaps = [];
    for (let i = 1; i < list.length; i++) {
      const prev = ymdMs(list[i - 1].date) + list[i - 1].hour * 3600000;
      const cur  = ymdMs(list[i].date) + list[i].hour * 3600000;
      gaps.push(Math.round((cur - prev) / 3600000)); // uren
    }
    const minGapHours = Math.min(...gaps);
    multiMessage.push({
      customer_id: cid,
      customer_name: list[0].customer_name,
      count: list.length,
      messages: list.map((m) => ({ date: m.date, hour: m.hour, template: m.template, days_overdue: m.days_overdue })),
      min_gap_hours: minGapHours,
      // De cooldown gaat ALLEEN over het starten van een nieuwe run. Zit de
      // reeks binnen één run, dan heeft de cooldown er geen invloed op.
      within_single_run: new Set(list.map((m) => m.run_id)).size === 1,
      cooldown_would_cover: minGapHours >= cooldownDays * 24,
    });
  }
  multiMessage.sort((a, b) => (a.min_gap_hours - b.min_gap_hours) || (b.count - a.count));

  // ── Inhaalgolf: >1 bericht op dezelfde dag ──────────────────────────────
  const burstSameDay = [];
  for (const [cid, list] of perCustomer) {
    const byDay = {};
    for (const m of list) (byDay[m.date] ||= []).push(m);
    for (const [date, ms] of Object.entries(byDay)) {
      if (ms.length > 1) {
        burstSameDay.push({
          customer_id: cid,
          customer_name: ms[0].customer_name,
          date,
          count: ms.length,
          templates: ms.map((m) => m.template),
          hours: ms.map((m) => m.hour),
          days_overdue: ms[0].days_overdue,
        });
      }
    }
  }
  burstSameDay.sort((a, b) => b.count - a.count);

  // ── Nog-niet-vervallen klanten: wanneer komen ze binnen? ────────────────
  const notYetDue = [];
  for (const c of snapshot?.customers || []) {
    const due = oldestDueIso(c.invoices);
    if (!due) continue;
    if (isOverdue(due, startIso, graceDays)) continue;
    // Eerste dag waarop de poort opengaat = due + grace + 1.
    const opensOn = msYmd(ymdMs(due) + (graceDays + 1) * DAY_MS);
    const started = startedRuns.find((r) => r.customer_id === c.id);
    const firstMsg = (perCustomer.get(c.id) || [])[0] || null;
    notYetDue.push({
      customer_id: c.id,
      customer_name: c.name,
      oldest_due_date: due,
      days_until_due: Math.round((ymdMs(due) - ymdMs(startIso)) / DAY_MS),
      gate_opens_on: opensOn,
      enters_engine_on: started ? started.date : null,
      first_message_on: firstMsg ? firstMsg.date : null,
      first_message_template: firstMsg ? firstMsg.template : null,
    });
  }
  notYetDue.sort((a, b) => a.oldest_due_date.localeCompare(b.oldest_due_date));

  return {
    meta: {
      start_date: startIso,
      horizon_days: horizonDays,
      grace_days: graceDays,
      cooldown_days: cooldownDays,
      ladder,
      customers_in_snapshot: (snapshot?.customers || []).length,
      existing_runs_in_snapshot: (snapshot?.runs || []).length,
      options: options || {},
    },
    days,
    totals: {
      messages: messages.length,
      unique_customers: perCustomer.size,
      runs_started: startedRuns.length,
      by_template: messages.reduce((acc, m) => { acc[m.template] = (acc[m.template] || 0) + 1; return acc; }, {}),
      by_workflow: messages.reduce((acc, m) => { acc[m.workflow_name] = (acc[m.workflow_name] || 0) + 1; return acc; }, {}),
    },
    multi_message_customers: multiMessage,
    same_day_bursts: burstSameDay,
    not_yet_due: notYetDue,
    started_runs: startedRuns,
    messages,
    skip_reasons: skipLog,
  };
}
