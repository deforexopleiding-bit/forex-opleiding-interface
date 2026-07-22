// api/_lib/dunning-engine.js
//
// Dunning workflow engine. Twee fases per run:
//
//   1) detectAndStartRuns — scant actieve dunning_workflows, matched klanten met
//      openstaande facturen op trigger_conditions, en start een run met de
//      eerste stap als er nog geen actieve run loopt voor die klant.
//
//   2) advanceActiveRuns — picked actieve runs waarvan next_action_at <= nu,
//      controleert stop-conditie (geen open invoices meer = paid), voert de
//      huidige stap uit via step-executor, schrijft log en schuift de pointer
//      door naar de volgende stap. Wait-steps zetten next_action_at op nu+days.
//
// Idempotent en time-budget-aware: stopt netjes als elapsed > abortMs zodat
// Vercel 60s hard timeout niet halverwege een mutatie knipt.
//
// Geen direct DB-mutatie buiten supabaseAdmin (RLS-bypass). Geen HTTP layer —
// caller (cron-endpoint) wraps deze module.

import { supabaseAdmin } from '../supabase.js';
import {
  executeEmailStep,
  executeWhatsappStep,
  executeWaitStep,
  executeTaskStep,
  executeResumeDunningStep,
} from './dunning-step-executors.js';
import { markOverdue } from './mentor-ledger-engine.js';
import { resetJoostCountersForCustomer } from './dunning-arrangement-hooks.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

// PostgREST-default max-rows is 1000. Bij grotere sets moet je via .range()
// pagineren, anders wordt de resultaatset stil afgekapt — precies wat de
// multi-factuur-doorlek veroorzaakte (klant met 4 open facturen telde er
// nog maar 1 als andere klanten samen al richting de 1000-cap namen).
const PAGE_SIZE = 1000;
const PAGE_HARD_CAP = 100 * PAGE_SIZE; // 100k rijen — vangnet tegen runaway.

/**
 * Loop chunked SELECT tot de laatste chunk kleiner is dan PAGE_SIZE (of
 * PAGE_HARD_CAP is bereikt). buildQuery is een callback die per iteratie
 * een VERSE query-builder oplevert — supabase-js query-objecten mogen niet
 * hergebruikt worden na een uitvoering.
 *
 * PURE tegenover een fake buildQuery (voor tests): geen supabase-koppeling
 * in deze helper zelf.
 *
 * Gooit alle DB-fouten door (fail-fast, consistent met callers).
 *
 * @param {() => any} buildQuery  Callback die een supabase queryBuilder
 *                                terugkeeft (zonder .range()/limit).
 * @returns {Promise<Array<object>>}  Alle rijen achter elkaar geplakt.
 */
export async function fetchAllRows(buildQuery) {
  const out = [];
  for (let from = 0; from < PAGE_HARD_CAP; from += PAGE_SIZE) {
    const q = buildQuery();
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    if (rows.length) out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Entry-point. Wordt aangeroepen vanuit api/cron-dunning-engine.js
 * en (optioneel) vanuit een handmatige debug-endpoint met mode="manual".
 */
/**
 * True als deze step-exec een succesvolle aanmaning-send is (email of
 * whatsapp met status='ok'). Gebruikt door de stage-hook in
 * advanceActiveRuns om na de eerste engine-send de pipeline-stage
 * 'nieuw' → 'aangemaand' te schuiven (spiegelt bulk-send-flow).
 *
 * PURE — geen DB/HTTP, unit-testbaar.
 */
export function isAanmaningSendSuccess(stepResult) {
  if (!stepResult || typeof stepResult !== 'object') return false;
  if (stepResult.status !== 'ok') return false;
  const evt = String(stepResult.log_event || '');
  return evt === 'email_sent' || evt === 'whatsapp_sent';
}

export async function runEngine({ mode = 'cron', abortMs = 50_000, scope = 'production' } = {}) {
  const startedAt = Date.now();
  const result = {
    mode,
    scope,
    detected: 0,
    runs_advanced: 0,
    errors: [],
    duration_ms: 0,
  };

  try {
    result.detected = await detectAndStartRuns(startedAt, abortMs, result.errors, scope);
  } catch (e) {
    result.errors.push({ phase: 'detect', error: e?.message || String(e) });
    console.error('[dunning-engine] detect fatal', e);
  }

  try {
    result.runs_advanced = await advanceActiveRuns(startedAt, abortMs, result.errors, scope);
  } catch (e) {
    result.errors.push({ phase: 'advance', error: e?.message || String(e) });
    console.error('[dunning-engine] advance fatal', e);
  }

  result.duration_ms = Date.now() - startedAt;
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(startedAt) {
  return Date.now() - startedAt;
}

function nowIso() {
  return new Date().toISOString();
}

function todayMidnightMs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dueDateMs(isoDate) {
  if (!isoDate) return null;
  const ymd = String(isoDate).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

function openAmount(inv) {
  const total = Number(inv?.amount_total) || 0;
  const paid = Number(inv?.amount_paid) || 0;
  const credited = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - credited);
}

function isCompany(customer) {
  if (!customer) return false;
  if (customer.is_company === true) return true;
  if (customer.company_name && String(customer.company_name).trim()) return true;
  return false;
}

function matchesCustomerType(customer, wanted) {
  if (!wanted || wanted === 'any') return true;
  const company = isCompany(customer);
  if (wanted === 'b2b') return company;
  if (wanted === 'b2c') return !company;
  return true;
}

/**
 * Fetch open invoices, optionally scoped to one customer_id. Returns rows with
 * embedded customer record (single-query, no N+1).
 *
 * D5 auto-pause: invoices die in een ACTIEF payment_arrangement zitten worden
 * uitgesloten — de dunning-engine mag klanten niet stalken zolang er een
 * actieve betaalafspraak loopt. Bij VERBROKEN/NAGEKOMEN/GEANNULEERD valt de
 * factuur vanzelf weer in scope op de volgende cron-run.
 */
async function fetchOpenInvoices(customerId = null, opts = {}) {
  // Sandbox-scoping:
  //   scope='production' (default) → alleen is_test=false rijen (cron-modus)
  //   scope='test'                  → alleen is_test=true rijen (sandbox-run)
  //   scope=null / unset            → geen is_test-filter (back-compat)
  const scope = opts?.scope || null;
  // Gepagineerd via fetchAllRows — zonder .range() knipt PostgREST op 1000
  // rijen en misten we facturen (multi-factuur-doorlek naar enkel-factuur
  // workflow-instroom). Bij een per-customer scope is de set typisch klein
  // en doet de paginering feitelijk 1 chunk; hetzelfde codepad blijft.
  const rows = await fetchAllRows(() => {
    let q = supabaseAdmin
      .from('invoices')
      .select(
        'id, customer_id, amount_total, amount_paid, credited_amount, due_date, issue_date, status, invoice_number, is_test, customers!inner(id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at, is_test)'
      )
      .in('status', OPEN_STATUSES);
    if (customerId) q = q.eq('customer_id', customerId);
    if (scope === 'production') {
      q = q.eq('is_test', false).eq('customers.is_test', false);
    } else if (scope === 'test') {
      q = q.eq('is_test', true).eq('customers.is_test', true);
    }
    return q;
  });
  if (rows.length === 0) return rows;

  // D5 — auto-pause: bouw set van invoice_ids die in een ACTIEF arrangement
  // zitten (UPPERCASE + legacy lowercase). Filter die invoices weg.
  try {
    const activeInvoiceIds = await fetchActiveArrangementInvoiceIds(customerId);
    if (activeInvoiceIds.size === 0) return rows;
    return rows.filter((inv) => !activeInvoiceIds.has(inv.id));
  } catch (e) {
    // Fail-soft: bij DB-issue logt + valt terug op ongefilterde set (oude
    // gedrag). Beter doorgaan met onnodige reminder dan een complete cron-stop.
    console.error('[dunning-engine] arrangement-pause lookup failed, continuing without filter', e?.message);
    return rows;
  }
}

/**
 * Reply-stop helper (spoedfix): returnt true als de klant via WhatsApp
 * heeft gereageerd NA de laatste engine-send in DEZE run. Wordt in
 * advanceActiveRuns vóór iedere stap aangeroepen.
 *
 * "Gereageerd" = inbound WhatsApp-bericht op ENIGE conversatie van deze
 * klant met last_inbound_at > lastSentAt van de run. WA-only voor deze
 * spoedfix (dominant kanaal + directe customer_id-koppeling op
 * whatsapp_conversations). E-mail-reply-detectie kan later toegevoegd.
 *
 * Als de run nog geen enkele send heeft (lastSentAt == null): return
 * false (kan sowieso niet "gereageerd op wat we niet hebben verstuurd").
 *
 * Bij DB-fout gooit deze functie -- caller vangt fail-open (oud gedrag)
 * zodat een tijdelijke DB-glitch niet de hele engine stopt.
 */
async function hasReplyAfterLastSend(customerId, runId) {
  const { data: lastSendRows, error: sendErr } = await supabaseAdmin
    .from('dunning_log')
    .select('created_at')
    .eq('run_id', runId)
    .in('event_type', ['email_sent', 'whatsapp_sent'])
    .order('created_at', { ascending: false })
    .limit(1);
  if (sendErr) throw sendErr;
  const lastSentAt = lastSendRows?.[0]?.created_at || null;
  if (!lastSentAt) return false;

  const { data: convRows, error: convErr } = await supabaseAdmin
    .from('whatsapp_conversations')
    .select('last_inbound_at')
    .eq('customer_id', customerId)
    .not('last_inbound_at', 'is', null);
  if (convErr) throw convErr;
  if (!convRows || convRows.length === 0) return false;

  // Klant kan meerdere conversaties hebben (verschillende modules) — pak
  // de recentste inbound.
  let mostRecent = '';
  for (const row of convRows) {
    if (row.last_inbound_at && row.last_inbound_at > mostRecent) {
      mostRecent = row.last_inbound_at;
    }
  }
  return mostRecent && mostRecent > lastSentAt;
}

/**
 * D5 helper: verzamel invoice_ids uit alle ACTIEF payment_arrangements.
 * Optioneel gescoped per customer_id voor de advance-fase (kleinere query).
 */
async function fetchActiveArrangementInvoiceIds(customerId = null) {
  let q = supabaseAdmin
    .from('payment_arrangements')
    .select('invoice_ids, customer_id, status')
    .in('status', ['ACTIEF', 'actief']);
  if (customerId) q = q.eq('customer_id', customerId);
  const { data, error } = await q;
  if (error) throw error;
  const set = new Set();
  for (const row of data || []) {
    const ids = Array.isArray(row.invoice_ids) ? row.invoice_ids : [];
    for (const id of ids) if (id) set.add(id);
  }
  return set;
}

/**
 * Aggregate open invoices per customer_id. Returns Map keyed by customer_id
 * met { customer, openInvoices, total_open_eur, oldest_due_iso, days_overdue }.
 */
function aggregatePerCustomer(rows) {
  const todayMs = todayMidnightMs();
  const per = new Map();
  for (const inv of rows) {
    const cust = inv.customers;
    if (!cust) continue;
    if (cust.archived_at || cust.anonymized_at) continue;

    const open = openAmount(inv);
    if (open <= 0) continue;

    const agg = per.get(inv.customer_id) || {
      customer: cust,
      openInvoices: [],
      total_open_eur: 0,
      oldest_due_iso: null,
      oldest_issue_iso: null,
    };
    agg.openInvoices.push(inv);
    agg.total_open_eur += open;

    if (inv.due_date) {
      const iso = String(inv.due_date).slice(0, 10);
      if (!agg.oldest_due_iso || iso < agg.oldest_due_iso) {
        agg.oldest_due_iso = iso;
      }
    }
    // issue_date bijhouden voor de "N dagen na factuurdatum"-trigger (dag-7-duwtje).
    // Alleen relevante keuze: de OUDSTE openstaande factuur bepaalt de leeftijd —
    // matcht de bestaande overdue-logic (oudste due_date).
    if (inv.issue_date) {
      const iso = String(inv.issue_date).slice(0, 10);
      if (!agg.oldest_issue_iso || iso < agg.oldest_issue_iso) {
        agg.oldest_issue_iso = iso;
      }
    }
    per.set(inv.customer_id, agg);
  }

  for (const agg of per.values()) {
    let days = 0;
    const oldestMs = dueDateMs(agg.oldest_due_iso);
    if (oldestMs != null && todayMs > oldestMs) {
      days = Math.floor((todayMs - oldestMs) / 86400000);
    }
    agg.days_overdue = days;
    // days_since_oldest_invoice — leeftijd van de oudste openstaande factuur.
    // Wordt gebruikt door workflows met trigger_conditions.min_days_since_invoice_date
    // (bv. het vriendelijke dag-7-duwtje). Gebruikt dezelfde dueDateMs-parser
    // (ISO-datum + T00:00:00 lokale tijd) voor consistentie met days_overdue.
    let daysSinceInvoice = 0;
    const oldestIssueMs = dueDateMs(agg.oldest_issue_iso);
    if (oldestIssueMs != null && todayMs > oldestIssueMs) {
      daysSinceInvoice = Math.floor((todayMs - oldestIssueMs) / 86400000);
    }
    agg.days_since_oldest_invoice = daysSinceInvoice;
  }
  return per;
}

// ---------------------------------------------------------------------------
// Phase 1: detect + start
// ---------------------------------------------------------------------------

async function detectAndStartRuns(startedAt, abortMs, errors, scope = 'production') {
  const { data: workflows, error: wfErr } = await supabaseAdmin
    .from('dunning_workflows')
    .select('id, name, trigger_conditions, priority, is_active')
    .eq('is_active', true)
    .order('priority', { ascending: true });
  if (wfErr) throw wfErr;

  let started = 0;

  // ── Cooldown-setting één keer per engine-run laden ─────────────────────
  // app_settings key 'dunning_cooldown_days' (integer, 1-90). Ontbreekt/
  // ongeldig → default 7. Cooldown vult de bestaande "actieve run"-skip
  // AAN: klanten die recent via de bulk-flow zijn benaderd worden ook
  // overgeslagen. Maakt de engine CONSERVATIEVER, nooit agressiever.
  let cooldownDays = 7;
  try {
    const { data: cdRow } = await supabaseAdmin
      .from('app_settings')
      .select('value')
      .eq('key', 'dunning_cooldown_days')
      .maybeSingle();
    const raw = cdRow?.value?.days;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= 90) cooldownDays = Math.trunc(n);
  } catch (e) {
    console.warn('[dunning-engine] cooldown-setting fail-soft, default 7:', e?.message || e);
  }
  const cooldownCutoffIso = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000).toISOString();

  // ── Pipeline-hook: nieuwe wanbetalers → 'nieuw'-fase (batch, geen N+1) ─
  // Eén ronde per engine-run: verzamel alle unieke customer_ids met een
  // te late factuur, roep ensurePipelineCustomer per klant aan (idempotent
  // — bestaande records blijven ongewijzigd). Voordelen tov een aparte
  // cron: draait al dagelijks, heeft de overdue-lijst al in scope,
  // FAIL-SOFT dus geen risico voor de engine zelf.
  //
  // Auto-instroom-verfijning: alleen klanten met PRECIES 1 open factuur
  // stromen in. ≥2 open facturen → overgeslagen (hoort bij de massa-
  // opruiming / crediteerronde). Ook overslaan als de klant al een OPEN
  // incasso-dossier heeft (defensieve extra bovenop de idempotency van
  // ensurePipelineCustomer). is_test-scope volgt runEngine's scope-param
  // (production/test/back-compat), consistent met fetchOpenInvoices.
  try {
    const { isAutoEnabled, ensurePipelineCustomer } = await import('./dunning-pipeline.js');
    if (await isAutoEnabled('on_overdue_to_nieuw')) {
      const today = new Date().toISOString().slice(0, 10);
      // Gepagineerd via fetchAllRows — bij >1000 overdue-rijen mistten we
      // customer_ids die verderop nooit door de count-query zouden komen,
      // dus die klanten stroomden nooit in.
      const overdueRows = await fetchAllRows(() => {
        let q = supabaseAdmin
          .from('invoices')
          .select('customer_id')
          .in('status', OPEN_STATUSES)
          .lt('due_date', today);
        if      (scope === 'production') q = q.eq('is_test', false);
        else if (scope === 'test')       q = q.eq('is_test', true);
        return q;
      });
      const uniqueCustIds = Array.from(new Set(
        (overdueRows || []).map((r) => r.customer_id).filter(Boolean)
      ));

      let addedCount = 0, skippedMulti = 0, skippedIncasso = 0;

      if (uniqueCustIds.length > 0) {
        // Aantal open facturen per klant — gepagineerd via fetchAllRows.
        // Dit was DE bron van de multi-factuur-doorlek: bij >1000 open-
        // factuurrijen wereldwijd knipte PostgREST er af → klant met 4
        // open telde er nog maar 1 → verkeerde workflow-instroom.
        // Zelfde is_test-scope als de overdue-query hierboven.
        const openInvRows = await fetchAllRows(() => {
          let q = supabaseAdmin
            .from('invoices')
            .select('customer_id')
            .in('customer_id', uniqueCustIds)
            .in('status', OPEN_STATUSES);
          if      (scope === 'production') q = q.eq('is_test', false);
          else if (scope === 'test')       q = q.eq('is_test', true);
          return q;
        });
        const openCountByCust = new Map();
        for (const r of openInvRows || []) {
          if (!r?.customer_id) continue;
          openCountByCust.set(r.customer_id, (openCountByCust.get(r.customer_id) || 0) + 1);
        }

        // Klanten met een niet-terminaal incasso-dossier → skippen. Fail-
        // soft: tabel bestaat pas vanaf migratie 037; oudere DB's raken
        // dit blok nooit met een crash.
        const TERMINAL_INCASSO_STATUSES = ['betaald', 'afgeschreven', 'oninbaar', 'geretourneerd'];
        const inIncasso = new Set();
        try {
          const { data: dossiers } = await supabaseAdmin
            .from('dunning_incasso_dossiers')
            .select('customer_id, status')
            .in('customer_id', uniqueCustIds)
            .not('status', 'in', `(${TERMINAL_INCASSO_STATUSES.map((s) => `"${s}"`).join(',')})`);
          for (const d of dossiers || []) if (d?.customer_id) inIncasso.add(d.customer_id);
        } catch (e) {
          console.warn('[dunning-engine] incasso-lookup soft-fail:', e?.message || e);
        }

        for (const cid of uniqueCustIds) {
          if (elapsed(startedAt) > abortMs) break;
          const cnt = openCountByCust.get(cid) || 0;
          if (cnt === 0)      continue;                             // shouldn't happen, defensief
          if (cnt >= 2)     { skippedMulti++;   continue; }
          if (inIncasso.has(cid)) { skippedIncasso++; continue; }
          await ensurePipelineCustomer(cid);
          addedCount++;
        }
      }

      console.log(`[dunning-engine] auto-instroom: ${addedCount} toegevoegd, ${skippedMulti} overgeslagen (>1 factuur), ${skippedIncasso} overgeslagen (in incasso)`);
    }
  } catch (e) {
    console.warn('[dunning-engine] pipeline-hook overdue soft-fail:', e?.message || e);
  }

  outer: for (const workflow of workflows || []) {
    if (elapsed(startedAt) > abortMs) break;

    const tc = workflow.trigger_conditions || {};
    // Backwards-compat: als NIETS gezet is (nieuwe workflows zonder velden) →
    // fallback default 14 dagen overdue (huidige gedrag). Als er WEL een
    // min_days_since_invoice_date is gezet zonder min_days_overdue, moet de
    // overdue-check GEEN default 14 gebruiken (anders zou een dag-7 duwtje
    // pas dag-21 vuren). We zetten minDays op -1 zodat de overdue-check
    // effectief altijd slaagt (days_overdue >= 0).
    const hasOverdueTrigger      = Number.isFinite(tc.min_days_overdue);
    const hasIssueDateTrigger    = Number.isFinite(tc.min_days_since_invoice_date);
    // Fase 2b: arrangement_breached-trigger. Wanneer true → workflow vuurt
    // alleen voor klanten met een payment_arrangement in status VERBROKEN
    // dat nog niet is afgehandeld (breach_handled_at IS NULL). Combineerbaar
    // met andere condities (customer_type / min_total_amount). GEEN default:
    // workflows zonder deze key gedragen zich EXACT als vroeger.
    const arrangementBreached    = tc.arrangement_breached === true;
    // Bij een arrangement_breached-workflow is de overdue-guard niet
    // relevant — een breach kán ook op een factuur zijn die net verstreken
    // is. Zet minDays op -1 tenzij de workflow expliciet een min_days_overdue
    // heeft geconfigureerd.
    const minDays                = hasOverdueTrigger
      ? tc.min_days_overdue
      : ((hasIssueDateTrigger || arrangementBreached) ? -1 : 14);
    const minDaysSinceInvoice    = hasIssueDateTrigger ? tc.min_days_since_invoice_date : null;
    const customerType           = tc.customer_type || 'any';
    const minTotal               = Number.isFinite(tc.min_total_amount) ? tc.min_total_amount : 0;
    // Extra guard voor workflows die maar 1x per customer mogen vuren
    // (dag-7-duwtje bv.): check ANY-status runs voor deze workflow_id.
    const runOncePerCustomer     = tc.run_once_per_customer_per_workflow === true;

    // Fase 2b: als arrangement_breached-workflow → laad onafgehandelde
    // breaches ÉÉN keer per workflow (map customerId → arrangementId).
    // Dedup-guard: alleen VERBROKEN + breach_handled_at IS NULL. Nieuwe
    // TOEZEGGING die opnieuw breekt → nieuwe rij, dus opnieuw NULL, dus
    // vuurt opnieuw. Per klant per breach: 1x.
    let breachedByCustomer = null; // Map<customerId, arrangementId>
    if (arrangementBreached) {
      try {
        const { data: breaches, error: brErr } = await supabaseAdmin
          .from('payment_arrangements')
          .select('id, customer_id, updated_at')
          .eq('status', 'VERBROKEN')
          .is('breach_handled_at', null)
          .order('updated_at', { ascending: true });
        if (brErr) throw brErr;
        breachedByCustomer = new Map();
        // Bij >1 unafgehandelde breach per klant: pak de OUDSTE (eerste in
        // sort). Nieuwere breaches worden in een volgende engine-tick opgepakt
        // nadat we deze afgehandeld hebben (breach_handled_at gezet).
        for (const b of (breaches || [])) {
          if (!breachedByCustomer.has(b.customer_id)) {
            breachedByCustomer.set(b.customer_id, b.id);
          }
        }
      } catch (e) {
        errors.push({ phase: 'detect_breach_load', workflow_id: workflow.id, error: e?.message || String(e) });
        console.error('[dunning-engine] breach load failed', workflow.id, e?.message);
        continue; // sla deze workflow deze tick over
      }
    }

    let openRows;
    try {
      openRows = await fetchOpenInvoices(null, { scope });
    } catch (e) {
      errors.push({ phase: 'detect', workflow_id: workflow.id, error: e?.message || String(e) });
      console.error('[dunning-engine] fetch invoices failed', workflow.id, e?.message);
      continue;
    }

    const perCustomer = aggregatePerCustomer(openRows);

    // Load steps once per workflow.
    const { data: steps, error: stepsErr } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, workflow_id, step_order, step_type, config')
      .eq('workflow_id', workflow.id)
      .order('step_order', { ascending: true });
    if (stepsErr) {
      errors.push({ phase: 'detect', workflow_id: workflow.id, error: stepsErr.message });
      console.error('[dunning-engine] steps fetch failed', workflow.id, stepsErr.message);
      continue;
    }
    const firstStep = (steps || [])[0];
    if (!firstStep) {
      console.warn('[dunning-engine] workflow has no steps, skipping', workflow.id, workflow.name);
      continue;
    }

    for (const [customerId, agg] of perCustomer) {
      if (elapsed(startedAt) > abortMs) break outer;

      // Fase 2b: arrangement_breached-filter. Klant moet een onafgehandeld
      // VERBROKEN arrangement hebben, anders overslaan. arrangementIdForBreach
      // is de specifieke rij die we straks als 'afgehandeld' markeren.
      let arrangementIdForBreach = null;
      if (arrangementBreached) {
        arrangementIdForBreach = breachedByCustomer?.get(customerId) || null;
        if (!arrangementIdForBreach) continue;
      }

      if (agg.days_overdue < minDays) continue;
      // Issue-date-trigger: alleen relevant als workflow expliciet
      // min_days_since_invoice_date heeft (bv. het vriendelijke dag-7-duwtje
      // dat vóór de vervaldatum vuurt). NULL = geen filter.
      if (minDaysSinceInvoice != null && agg.days_since_oldest_invoice < minDaysSinceInvoice) continue;

      // F5.1 mentor-hook: zodra vaststaat dat de klant te laat is, openstaande
      // bonus-entries (pending) van die klant op 'wachten_op_betaling' zetten.
      // Non-blocking; engine is idempotent. Voor de matchesCustomerType-check
      // zodat álle te late klanten gemarkeerd worden, niet alleen die binnen
      // deze workflow vallen.
      try {
        await markOverdue({ customerId });
      } catch (e) {
        console.error('[dunning-engine] mentor-hook markOverdue:', e.message);
      }

      if (!matchesCustomerType(agg.customer, customerType)) continue;
      if (agg.total_open_eur < minTotal) continue;

      try {
        // Spoedfix her-inschrijvings-lus: blokkeer nieuwe run bij ELKE
        // niet-terminale status. Alleen 'completed' en 'cancelled' zijn
        // terminaal; 'active' + 'paused' blokkeren re-enrollment zodat
        // een gepauzeerde klant NOOIT automatisch opnieuw ingeschreven
        // wordt. Zonder deze verbreding zou een paused run direct door
        // een verse run bij stap 0 vervangen worden -> zelfde bug.
        const { data: existing, error: exErr } = await supabaseAdmin
          .from('dunning_workflow_runs')
          .select('id, status')
          .eq('customer_id', customerId)
          .in('status', ['active', 'paused'])
          .limit(1)
          .maybeSingle();
        if (exErr) throw exErr;
        if (existing) continue;

        // run_once_per_customer_per_workflow: extra guard voor workflows die
        // maximaal 1x per klant mogen vuren (dag-7-duwtje). We kijken naar
        // ANY-status runs voor deze workflow_id + customer_id. Blijft de
        // klant een openstaande factuur houden nadat de run is afgerond, dan
        // wordt er GEEN tweede duwtje gestuurd. Klant met een nieuw factuur
        // die weer 7 dagen oud wordt: valt onder dezelfde guard tenzij de
        // oude run wordt heropend of gewist.
        if (runOncePerCustomer) {
          const { data: everRan, error: erErr } = await supabaseAdmin
            .from('dunning_workflow_runs')
            .select('id')
            .eq('workflow_id', workflow.id)
            .eq('customer_id', customerId)
            .limit(1)
            .maybeSingle();
          if (erErr) throw erErr;
          if (everRan) continue;
        }

        // COOLDOWN-check (spoedfix): sla klant over als er binnen de
        // cooldown-periode al een ECHTE engine-send (email/whatsapp) voor
        // deze klant is geweest. De oude check keek naar 'bulk_reminder_sent'
        // events die de engine zelf NOOIT schrijft (alleen bulk-send +
        // sandbox schrijven dat) -- dat was dode code en verklaarde de
        // her-inschrijvings-lus (5-11 runs per klant).
        // Bewuste 2-step lookup i.p.v. join: runs-per-klant is typisch <20,
        // dus 2 kleine queries scoren beter dan een dure jsonb-scan.
        try {
          const { data: recentRuns } = await supabaseAdmin
            .from('dunning_workflow_runs')
            .select('id')
            .eq('customer_id', customerId);
          const runIds = (recentRuns || []).map((r) => r.id).filter(Boolean);
          if (runIds.length > 0) {
            const { data: recentSend } = await supabaseAdmin
              .from('dunning_log')
              .select('id')
              .in('run_id', runIds)
              .in('event_type', ['email_sent', 'whatsapp_sent'])
              .gte('created_at', cooldownCutoffIso)
              .limit(1);
            if (recentSend && recentSend.length > 0) continue;
          }
        } catch (e) {
          console.warn('[dunning-engine] cooldown-check fail-soft:', customerId, e?.message || e);
          // Fail-open: bij DB-fout NIET skippen (anders schaadt een tijdelijke
          // glitch de aanmaan-flow). Oud gedrag behouden.
        }

        const triggerCount = agg.openInvoices.length;
        const { data: inserted, error: insErr } = await supabaseAdmin
          .from('dunning_workflow_runs')
          .insert({
            workflow_id: workflow.id,
            customer_id: customerId,
            status: 'active',
            current_step_id: firstStep.id,
            next_action_at: nowIso(),
            trigger_invoice_count: triggerCount,
          })
          .select('id')
          .single();
        if (insErr) throw insErr;

        // #798 — Nieuwe run = nieuwe incident-cap-budget. Reset Joost's per-
        // conv-tellers voor deze klant zodat de 10-berichten-cap opnieuw
        // begint bij dit incident. Fail-safe: geen reset bij twijfel (zie
        // resetJoostCountersForCustomer).
        try { await resetJoostCountersForCustomer(customerId); }
        catch (e) { console.warn('[dunning-engine] joost-counter-reset fail-soft (new run):', customerId, e?.message || e); }

        const { error: logErr } = await supabaseAdmin
          .from('dunning_log')
          .insert({
            run_id: inserted.id,
            step_id: firstStep.id,
            event_type: 'started',
            payload: {
              workflow_id: workflow.id,
              workflow_name: workflow.name,
              customer_id: customerId,
              trigger_invoice_count: triggerCount,
              total_open_eur: Number(agg.total_open_eur.toFixed(2)),
              days_overdue: agg.days_overdue,
              days_since_oldest_invoice: agg.days_since_oldest_invoice,
              triggered_by_arrangement_id: arrangementIdForBreach, // null als niet-breach-trigger
            },
          });
        if (logErr) {
          console.error('[dunning-engine] log insert failed', inserted.id, logErr.message);
        }

        // Fase 2b: markeer breach als afgehandeld (dedup). Als iemand
        // dezelfde afspraak later opnieuw breekt (bv. nieuwe TOEZEGGING op
        // hetzelfde arrangement — kan niet gebeuren want ACTIEF blijft
        // ACTIEF; alleen nieuw arrangement kan opnieuw VERBROKEN worden),
        // dan is dat een NIEUWE rij met eigen breach_handled_at=NULL.
        if (arrangementIdForBreach) {
          try {
            const { error: bhErr } = await supabaseAdmin
              .from('payment_arrangements')
              .update({ breach_handled_at: nowIso() })
              .eq('id', arrangementIdForBreach)
              .is('breach_handled_at', null); // race-safe: alleen als nog NULL
            if (bhErr) throw bhErr;
          } catch (e) {
            console.warn('[dunning-engine] breach_handled_at update fail-soft:', arrangementIdForBreach, e?.message || e);
          }
        }

        started++;
      } catch (e) {
        errors.push({
          phase: 'detect_start',
          workflow_id: workflow.id,
          customer_id: customerId,
          error: e?.message || String(e),
        });
        console.error('[dunning-engine] start run failed', workflow.id, customerId, e?.message);
      }
    }
  }

  return started;
}

// ---------------------------------------------------------------------------
// Phase 2: advance active runs
// ---------------------------------------------------------------------------

async function advanceActiveRuns(startedAt, abortMs, errors, scope = 'production') {
  const now = nowIso();
  const { data: runs, error: runsErr } = await supabaseAdmin
    .from('dunning_workflow_runs')
    .select(
      'id, workflow_id, customer_id, status, current_step_id, next_action_at, started_at, trigger_invoice_count'
    )
    .eq('status', 'active')
    .or(`next_action_at.is.null,next_action_at.lte.${now}`);
  if (runsErr) throw runsErr;

  let advanced = 0;

  // Harde cap op de binnenlus (workflow zonder wait/stop zou anders oneindig
  // kunnen lopen). 50 dekt ruim ook de langste actieve workflow (10-15 stappen
  // in productie). Bij bereiken: log + errors[], next_action_at blijft op nu,
  // volgende invocatie hervat.
  const MAX_STEPS_PER_RUN = 50;

  for (const run of runs || []) {
    if (elapsed(startedAt) > abortMs) break;

    try {
      // Fetch alle steps ÉÉN keer per run (workflow-config muteert niet tijdens
      // de run). Zonder deze pre-fetch zou de binnenlus per iteratie een query
      // doen voor dezelfde workflow_id.
      const { data: steps, error: stepsErr } = await supabaseAdmin
        .from('dunning_workflow_steps')
        .select('id, workflow_id, step_order, step_type, config')
        .eq('workflow_id', run.workflow_id)
        .order('step_order', { ascending: true });
      if (stepsErr) throw stepsErr;

      // ── BINNENLUS: verwerk opeenvolgende NIET-wait stappen in één keer.
      //    Effect: email + whatsapp van dezelfde ronde gaan samen de deur uit.
      //    De wait-stap bepaalt daarna de dagen tot de volgende ronde.
      //    Stop-condities: wait / stop / paid / step_missing / no_more_steps
      //    / cap / time-budget.
      let currentStepId = run.current_step_id;
      let stepsExecuted = 0;
      let runAdvanced   = false;

      while (stepsExecuted < MAX_STEPS_PER_RUN) {
        // Time-budget-check vóór elke iteratie — laat next_action_at op de
        // laatste update staan (nu), volgende invocatie hervat vanzelf.
        if (elapsed(startedAt) > abortMs) break;

        // Betaal-hercheck vóór ELKE stap. Cruciaal voor multi-stap-rondes:
        // als de klant tussen email en whatsapp betaalt, stopt de lus hier
        // en wordt de whatsapp NIET verstuurd.
        const customerRows = await fetchOpenInvoices(run.customer_id);
        const aggMap = aggregatePerCustomer(customerRows);
        const agg = aggMap.get(run.customer_id);
        const customer = agg?.customer || await fetchCustomerOnly(run.customer_id);
        const openInvoices = agg?.openInvoices || [];

        if (openInvoices.length === 0) {
          await supabaseAdmin
            .from('dunning_workflow_runs')
            .update({
              status: 'completed',
              completed_at: nowIso(),
              completion_reason: 'paid',
              updated_at: nowIso(),
            })
            .eq('id', run.id);
          await supabaseAdmin.from('dunning_log').insert({
            run_id: run.id,
            step_id: currentStepId,
            event_type: 'completed',
            payload: { reason: 'paid' },
          });
          // #798 — Incident is voorbij; reset Joost-tellers.
          try { await resetJoostCountersForCustomer(run.customer_id); }
          catch (e) { console.warn('[dunning-engine] joost-counter-reset fail-soft (paid):', run.customer_id, e?.message || e); }
          runAdvanced = true;
          break;
        }

        // ── Reply-stop guard (spoedfix): klant heeft gereageerd NA de
        // laatste engine-send in deze run -> pauzeer, verstuur NIETS meer.
        // Fail-open bij DB-fout (oud gedrag): tijdelijke glitch mag de
        // engine niet volledig stoppen. Alleen actief als run al minstens
        // 1 send heeft; nieuw-gestarte runs (geen sends yet) skippen deze
        // check.
        try {
          const replied = await hasReplyAfterLastSend(run.customer_id, run.id);
          if (replied) {
            await supabaseAdmin
              .from('dunning_workflow_runs')
              .update({ status: 'paused', updated_at: nowIso() })
              .eq('id', run.id);
            await supabaseAdmin.from('dunning_log').insert({
              run_id: run.id,
              step_id: currentStepId,
              event_type: 'paused_customer_replied',
              payload: { reason: 'klant_reageerde' },
            });
            runAdvanced = true;
            break; // stop binnenlus; run is paused
          }
        } catch (e) {
          console.warn('[dunning-engine] reply-check fail-soft, doorgaan:', run.customer_id, e?.message || e);
        }

        const currentStep = (steps || []).find((s) => s.id === currentStepId);
        if (!currentStep) {
          await supabaseAdmin
            .from('dunning_workflow_runs')
            .update({
              status: 'completed',
              completed_at: nowIso(),
              completion_reason: 'step_missing',
              updated_at: nowIso(),
            })
            .eq('id', run.id);
          await supabaseAdmin.from('dunning_log').insert({
            run_id: run.id,
            step_id: currentStepId,
            event_type: 'completed',
            payload: { reason: 'step_missing' },
          });
          // #798 — Ook step_missing is een completion; reset Joost-tellers.
          try { await resetJoostCountersForCustomer(run.customer_id); }
          catch (e) { console.warn('[dunning-engine] joost-counter-reset fail-soft (step_missing):', run.customer_id, e?.message || e); }
          runAdvanced = true;
          break;
        }

        const nextStep = (steps || []).find((s) => s.step_order > currentStep.step_order) || null;

        // Execute step.
        const execArgs = { supabaseAdmin, run, step: currentStep, customer, openInvoices };
        let stepResult;
        switch (currentStep.step_type) {
          case 'email':
            stepResult = await executeEmailStep(execArgs);
            break;
          case 'whatsapp':
            stepResult = await executeWhatsappStep(execArgs);
            break;
          case 'wait':
            stepResult = await executeWaitStep(execArgs);
            break;
          case 'task':
            stepResult = await executeTaskStep(execArgs);
            break;
          case 'resume_dunning':
            stepResult = await executeResumeDunningStep(execArgs);
            break;
          case 'stop':
            stepResult = { status: 'ok', log_event: 'stop_step', log_payload: {} };
            break;
          default:
            stepResult = {
              status: 'failed',
              log_event: 'unknown_step_type',
              log_payload: { step_type: currentStep.step_type },
            };
        }

        // Log resultaat (1 regel per uitgevoerde stap — gedrag ongewijzigd).
        // Error/skip-status van de executor laat de run doorgaan naar de
        // volgende stap; huidig gedrag replicieren.
        await supabaseAdmin.from('dunning_log').insert({
          run_id: run.id,
          step_id: currentStep.id,
          event_type: stepResult.log_event,
          payload: stepResult.log_payload || {},
        });
        stepsExecuted++;
        runAdvanced = true;

        // Pipeline-hook: eerste succesvolle aanmaning-send (email/whatsapp)
        // schuift de stage 'nieuw' → 'aangemaand'. Zelfde trigger-key als
        // bulk-send (on_bulk_sent_to_aangemaand — één toggle, consistent
        // gedrag voor beide send-paden). onlyIfFrom:'nieuw' maakt vervolg-
        // sends binnen dezelfde run no-op én voorkomt dat 'in_gesprek'/
        // 'opgelost' teruggezet worden. Fail-soft: stage-update mag de
        // engine niet omvallen.
        if (isAanmaningSendSuccess(stepResult)) {
          try {
            const { isAutoEnabled, ensurePipelineCustomer, setStage } = await import('./dunning-pipeline.js');
            if (await isAutoEnabled('on_bulk_sent_to_aangemaand')) {
              await ensurePipelineCustomer(run.customer_id);
              await setStage(run.customer_id, 'aangemaand', 'engine_sent', 'auto:engine', { onlyIfFrom: 'nieuw' });
            }
          } catch (e) {
            console.warn('[dunning-engine] stage-hook engine_sent fail-soft:', run.customer_id, e?.message || e);
          }
        }

        // Advance pointer (semantiek ongewijzigd; nu geïntegreerd in de lus).
        const update = { updated_at: nowIso() };
        let breakLoop = false;
        if (currentStep.step_type === 'wait') {
          const days = Number(currentStep?.config?.days) || 0;
          const nextMs = Date.now() + days * 86400000;
          update.next_action_at = new Date(nextMs).toISOString();
          update.current_step_id = nextStep ? nextStep.id : null;
          if (!nextStep) {
            update.status = 'completed';
            update.completed_at = nowIso();
            update.completion_reason = 'no_more_steps';
          }
          breakLoop = true;   // WAIT stopt de binnenlus — kern van deze PR.
        } else if (currentStep.step_type === 'stop') {
          update.status = 'completed';
          update.completed_at = nowIso();
          update.completion_reason = 'stop_step';
          breakLoop = true;
        } else {
          update.next_action_at = nowIso();
          update.current_step_id = nextStep ? nextStep.id : null;
          if (!nextStep) {
            update.status = 'completed';
            update.completed_at = nowIso();
            update.completion_reason = 'no_more_steps';
            breakLoop = true;
          }
        }

        await supabaseAdmin
          .from('dunning_workflow_runs')
          .update(update)
          .eq('id', run.id);

        // #798 — Als deze step-advance de run heeft afgesloten (no_more_steps
        // of stop_step), reset Joost-tellers alsnog.
        if (update.status === 'completed') {
          try { await resetJoostCountersForCustomer(run.customer_id); }
          catch (e) { console.warn('[dunning-engine] joost-counter-reset fail-soft (' + (update.completion_reason || 'step_advance') + '):', run.customer_id, e?.message || e); }
        }

        if (breakLoop) break;

        // Volgende iteratie: schuif pointer door.
        currentStepId = nextStep ? nextStep.id : null;
        if (!currentStepId) break;
      }

      // Cap-warning: workflow zonder wait/stop zou anders oneindig lopen.
      // next_action_at staat op nu (via de laatste update), dus volgende
      // invocatie hervat de run vanzelf.
      if (stepsExecuted >= MAX_STEPS_PER_RUN) {
        console.warn('[dunning-engine] MAX_STEPS_PER_RUN cap bereikt voor run', run.id, '— volgende invocatie hervat.');
        errors.push({
          phase: 'advance',
          run_id: run.id,
          customer_id: run.customer_id,
          error: 'MAX_STEPS_PER_RUN cap (' + MAX_STEPS_PER_RUN + ') bereikt binnen 1 invocatie',
        });
      }

      if (runAdvanced) advanced++;
    } catch (e) {
      errors.push({
        phase: 'advance',
        run_id: run.id,
        customer_id: run.customer_id,
        error: e?.message || String(e),
      });
      console.error('[dunning-engine] advance failed', run.id, e?.message);
    }
  }

  return advanced;
}

async function fetchCustomerOnly(customerId) {
  const { data, error } = await supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at')
    .eq('id', customerId)
    .maybeSingle();
  if (error) {
    console.error('[dunning-engine] customer fetch failed', customerId, error.message);
    return null;
  }
  return data;
}
