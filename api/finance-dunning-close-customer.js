// api/finance-dunning-close-customer.js
// FIX 4 — Markeer een wanbetaler als "afgehandeld/betaald" en haal 'm netjes
// uit de dunning-flow. Dual-close:
//   1) alle active|paused dunning_workflow_runs -> completed
//      (analoog completeRunsFromArrangement in dunning-arrangement-hooks.js).
//   2) pipeline_customers.stage_slug -> 'opgelost' via setStage() met de reden.
//   3) alle PENDING/APPROVED pending_actions voor deze klant -> 'REJECTED'
//      (voorkomt spook-taken en de #888 guard-blokkade op een eventuele
//      latere run als de klant terugkomt met een nieuwe factuur).
//
// De engine-detectie skipt daarna klanten met terminal stage (opgelost/
// afschrijven) tenzij er een factuur bij komt met issue_date NA
// stage_changed_at — dan komt de klant automatisch weer in de flow zonder
// dat iemand handmatig hoeft in te grijpen. Zie shouldSkipDueToTerminalStage
// in api/_lib/dunning-pipeline.js + tests/dunning-terminal-stage-skip.test.js.
//
// Body:
//   {
//     customer_id: uuid (required),
//     reason:      string (min 5, max 500, required),
//     force?:      bool   (default false — pas op true bij openstaand bedrag)
//   }
//
// Gedrag bij openstaand bedrag:
//   - force omitted / false + open_invoices bevat >0 → 409 met
//     { code: 'HAS_OPEN_INVOICES', open_amount_eur, open_count, warning }.
//     Client toont confirm-modal en herstuurt met force=true.
//   - force=true → afsluiten gebeurt ook al staat er nog een bedrag open.
//     Response bevat open_amount_at_close in de audit-payload zodat achteraf
//     terug te vinden is wat er open stond op moment van sluiten.
//
// Fail-soft per stap: elke sub-actie (run-close, pipeline-stage, pending-
// actions, audit-log) heeft eigen try/catch. Errors verzamelen in warnings[]
// en gaan mee in de 200-response zodat een halve-faal ZICHTBAAR is voor de
// operator (geen stille truncatie zoals we in de dag7-drift zagen).
//
// Permission: finance.dunning.execute (server-side hard gate).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { setStage } from './_lib/dunning-pipeline.js';
import { customerDisplayName } from './_lib/customer-name.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const TARGET_STAGE = 'opgelost';
const COMPLETION_REASON = 'manual_close_admin';

function openAmount(inv) {
  const t = Number(inv?.amount_total) || 0;
  const p = Number(inv?.amount_paid) || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id)
    ? body.customer_id
    : null;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const force  = body.force === true;

  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
  if (reason.length < 5) return res.status(400).json({ error: 'reason (min 5 chars) verplicht' });
  if (reason.length > 500) return res.status(400).json({ error: 'reason mag max 500 chars zijn' });

  const nowIso = new Date().toISOString();
  const userId = user?.id || null;

  try {
    // ── Lookup klant (bevestigt bestaan + geeft display-naam voor audit) ──
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, archived_at, anonymized_at')
      .eq('id', customerId)
      .maybeSingle();
    if (custErr) throw new Error('customer lookup: ' + custErr.message);
    if (!cust)   return res.status(404).json({ error: 'Klant niet gevonden' });
    if (cust.archived_at || cust.anonymized_at) {
      return res.status(409).json({ error: 'Klant is gearchiveerd of geanonimiseerd; sluit-actie niet nodig' });
    }
    const customerDisplay = customerDisplayName(cust, '(zonder naam)');

    // ── Bereken open bedrag (soepele check) ──────────────────────────────
    const { data: invRows, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, amount_total, amount_paid, credited_amount, status')
      .eq('customer_id', customerId)
      .in('status', OPEN_STATUSES);
    if (invErr) throw new Error('invoice lookup: ' + invErr.message);
    let openCents = 0;
    let openCount = 0;
    for (const inv of invRows || []) {
      const oa = openAmount(inv);
      if (oa > 0) { openCents += Math.round(oa * 100); openCount++; }
    }
    const openAmountEur = openCents / 100;

    if (openCount > 0 && !force) {
      return res.status(409).json({
        code: 'HAS_OPEN_INVOICES',
        error: 'Klant heeft nog openstaand bedrag',
        open_amount_eur: openAmountEur,
        open_count:      openCount,
        warning:         `Let op: € ${openAmountEur.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} nog open (${openCount} factuur${openCount === 1 ? '' : 'en'}). Zet force=true om alsnog af te sluiten.`,
      });
    }

    // ── Dual-close: 3 stappen, fail-soft per stap ─────────────────────────
    const warnings = [];
    let closedRuns = 0;
    let closedRunIds = [];
    let markedStage = false;
    let rejectedActions = 0;

    // Stap 1 — dunning_workflow_runs -> completed (active|paused only)
    try {
      const { data: runs, error: runErr } = await supabaseAdmin
        .from('dunning_workflow_runs')
        .update({
          status:            'completed',
          completed_at:      nowIso,
          completion_reason: COMPLETION_REASON,
          updated_at:        nowIso,
        })
        .eq('customer_id', customerId)
        .in('status', ['active', 'paused'])
        .select('id, current_step_id');
      if (runErr) throw new Error(runErr.message);
      closedRuns = Array.isArray(runs) ? runs.length : 0;
      closedRunIds = (runs || []).map((r) => r.id).filter(Boolean);
      // Log per gesloten run in dunning_log (audit-spoor per klant-timeline).
      for (const r of (runs || [])) {
        try {
          await supabaseAdmin.from('dunning_log').insert({
            run_id:     r.id,
            step_id:    r.current_step_id || null,
            event_type: 'customer_closed_manually',
            payload: {
              reason,
              closed_by_user_id: userId,
              open_amount_eur:   openAmountEur,
              open_count:        openCount,
              forced:            !!force,
            },
          });
        } catch (e) {
          console.warn('[finance-dunning-close-customer] dunning_log insert fail:', r.id, e?.message);
          warnings.push('dunning_log-insert faalde voor run ' + r.id);
        }
      }
    } catch (e) {
      console.error('[finance-dunning-close-customer] step 1 (runs->completed):', e.message);
      warnings.push('Run-close faalde: ' + e.message);
    }

    // Stap 2 — pipeline_customers.stage_slug -> 'opgelost' via setStage
    // setStage is fail-soft en zorgt zelf voor dunning_pipeline_log entry
    // (entry_type='stage_change') + last_activity_at update.
    try {
      const stageResult = await setStage(customerId, TARGET_STAGE, reason, userId ? String(userId) : 'system');
      markedStage = !!(stageResult && stageResult.ok !== false);
      if (!markedStage) {
        warnings.push('Pipeline-stage-update faalde: ' + (stageResult?.error || 'onbekend'));
      }
    } catch (e) {
      console.error('[finance-dunning-close-customer] step 2 (pipeline stage):', e.message);
      warnings.push('Pipeline-stage-update faalde: ' + e.message);
    }

    // Stap 3 — open pending_actions -> REJECTED
    // Voorkomt spook-taken (open beltaken/verify-taken voor een afgesloten
    // dossier) + de #888 guard-blokkade als de klant later terugkomt.
    try {
      // Analoog aan arrangements-cancel.js:100-116 — pending_actions
      // heeft alleen status + rejection_reason + updated_at (geen
      // rejected_at / rejected_by kolommen in het schema). User-id
      // wordt via rejection_reason meegegeven zodat het spoor bestaat.
      const { data: rej, error: rejErr } = await supabaseAdmin
        .from('pending_actions')
        .update({
          status:           'REJECTED',
          rejection_reason: 'Dossier afgesloten door user ' + (userId || 'system') + ': ' + reason,
          updated_at:       nowIso,
        })
        .eq('customer_id', customerId)
        .in('status', ['PENDING', 'APPROVED'])
        .select('id');
      if (rejErr) throw new Error(rejErr.message);
      rejectedActions = Array.isArray(rej) ? rej.length : 0;
    } catch (e) {
      console.error('[finance-dunning-close-customer] step 3 (pending_actions reject):', e.message);
      warnings.push('Pending-actions-reject faalde: ' + e.message);
    }

    // ── Audit-log (fail-soft) ─────────────────────────────────────────────
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      'finance_dunning.customer_closed_manually',
        entity_type: 'customer',
        entity_id:   customerId,
        after_json: {
          customer_id:        customerId,
          customer_display:   customerDisplay,
          reason,
          forced:             !!force,
          open_amount_eur:    openAmountEur,
          open_count:         openCount,
          closed_runs:        closedRuns,
          closed_run_ids:     closedRunIds,
          marked_stage:       markedStage,
          rejected_actions:   rejectedActions,
          warnings,
          closed_at:          nowIso,
        },
      });
    } catch (e) {
      console.warn('[finance-dunning-close-customer] audit-log insert fail-soft:', e.message);
      warnings.push('audit_log-insert faalde (niet-fataal): ' + e.message);
    }

    return res.status(200).json({
      ok: true,
      customer_id:         customerId,
      customer_display:    customerDisplay,
      closed_runs:         closedRuns,
      marked_stage:        markedStage,
      rejected_actions:    rejectedActions,
      open_amount_at_close: openAmountEur,
      forced:              !!force,
      warnings,
    });
  } catch (e) {
    console.error('[finance-dunning-close-customer]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
