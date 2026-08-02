// api/wanbetalers-diagnose-run-verplaats.js
//
// POST { run_id, target_step_id, trigger_now?, cancel_current_pending_actions?,
//        live_send_confirmation?, reason? }
// → Verplaats één dunning-run naar een specifieke stap in DEZELFDE workflow.
// Puur DB-mutatie op run + optioneel cancel van open pending_actions van
// huidige stap + audit-spoor. GEEN send-code in dit endpoint — bij
// trigger_now=true zet 't next_action_at op nu en laat de bestaande
// cron-executor het werk doen (met alle bestaande guards, is_test-scope,
// recipient-guard voor sandbox, etc).
//
// Super_admin only. Werkt op zowel echte klanten als de sandbox-test-klant
// (is_test=true). Voor test-klanten blijft de recipient-guard in de executor
// actief — sends komen altijd bij het sandbox-contact terecht.
//
// Waarborgen (spiegelt docs/wanbetalers-verplaats-tool-ontwerp.md 10-punts tabel):
//   1  Super_admin only              — verifyAdmin + profile.role check
//   2  Klantnaam/bedrag preview      — via preview-endpoint (client-side flow)
//   3  Trigger default UIT           — next_action_at=NULL tenzij triggerNow=true
//   4  2-staps typ-bevestiging       — client-side + server-side check hieronder
//   5  Server-side confirm-check     — live_send_confirmation moet klantnaam bevatten
//   6  Same-workflow-guard           — target_step.workflow_id === run.workflow_id
//   7  Race-guard op run.status      — UPDATE met .in('status', ['active','paused'])
//   8  Volledig audit-spoor          — dunning_log + audit_log
//   9  1 endpoint = 1 run            — signature accepteert single run_id
//   10 Extra waarschuwing echte klant — preview-endpoint returnt warnings[]

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_STEPS = new Set(['email','whatsapp']);
const MAX_REASON = 500;

function customerDisplay(c) {
  if (!c) return '(onbekend)';
  const isC = !!c.is_company;
  const name = isC
    ? (c.company_name || '(bedrijf)')
    : ([c.first_name, c.last_name].filter(Boolean).join(' ') || '(zonder naam)');
  return name;
}
function normalizeConfirm(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }
  const admin = await verifyAdmin(req);
  if (!admin)                            return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (admin.profile?.role !== 'super_admin') return res.status(403).json({ error: 'Alleen super_admin.' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const runId          = typeof body.run_id === 'string' ? body.run_id.trim() : '';
  const targetStepId   = typeof body.target_step_id === 'string' ? body.target_step_id.trim() : '';
  const triggerNow     = body.trigger_now === true;
  const cancelPa       = body.cancel_current_pending_actions === true;
  const confirmText    = typeof body.live_send_confirmation === 'string' ? body.live_send_confirmation : '';
  const reason         = String(body.reason || '').trim().slice(0, MAX_REASON) || null;

  if (!runId || !UUID_RE.test(runId))               return res.status(400).json({ error: 'run_id (uuid) vereist' });
  if (!targetStepId || !UUID_RE.test(targetStepId)) return res.status(400).json({ error: 'target_step_id (uuid) vereist' });

  try {
    // ── 1) Run + klant + steps ophalen ──────────────────────────────────
    const { data: run, error: rErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, customer_id, workflow_id, status, current_step_id')
      .eq('id', runId)
      .maybeSingle();
    if (rErr) return res.status(500).json({ error: 'run fetch: ' + rErr.message });
    if (!run) return res.status(404).json({ error: 'Run niet gevonden' });
    if (!['active','paused'].includes(run.status)) {
      return res.status(409).json({ error: `Verplaatsen alleen mogelijk bij status active/paused; huidig: ${run.status}` });
    }

    const { data: customer } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, is_test, email, phone')
      .eq('id', run.customer_id)
      .maybeSingle();
    if (!customer) return res.status(500).json({ error: 'Klant van run niet gevonden' });

    const { data: steps } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, workflow_id, step_type, step_order, config')
      .in('id', [run.current_step_id, targetStepId].filter(Boolean));
    const curStep = (steps || []).find((s) => s.id === run.current_step_id) || null;
    const tgtStep = (steps || []).find((s) => s.id === targetStepId) || null;
    if (!tgtStep) return res.status(404).json({ error: 'target_step_id niet gevonden' });

    // ── 2) Same-workflow-guard (waarborg #6) ────────────────────────────
    if (tgtStep.workflow_id !== run.workflow_id) {
      return res.status(400).json({
        error: `SAME_WORKFLOW_GUARD_FAILED: doel-stap hoort bij workflow ${tgtStep.workflow_id}, run bij ${run.workflow_id}. Cross-workflow verplaatsen niet ondersteund.`,
      });
    }

    // ── 3) Confirm-check (waarborgen #4 + #5) ───────────────────────────
    const isSendStep = SEND_STEPS.has(String(tgtStep.step_type || '').toLowerCase());
    const requiresLiveConfirm = triggerNow && isSendStep;
    if (requiresLiveConfirm) {
      const custName = customerDisplay(customer);
      const expected = `IK BEVESTIG SEND NAAR ${custName}`;
      const gotNorm  = normalizeConfirm(confirmText);
      const expNorm  = normalizeConfirm(expected);
      // Vereist: string bevat letterlijk "IK BEVESTIG SEND NAAR <naam>".
      // Case-insensitive, spaties genormaliseerd; klantnaam MOET er letterlijk in staan.
      if (gotNorm !== expNorm) {
        return res.status(400).json({
          error: `LIVE_SEND_CONFIRM_FAILED: verwachtte "${expected}", ontvangen: ${confirmText ? '"' + confirmText.slice(0, 80) + '"' : '(leeg)'}`,
        });
      }
    }

    // ── 4) UPDATE run (waarborg #7: race-guard op status) ───────────────
    const nowIso = new Date().toISOString();
    const nextActionAt = triggerNow ? nowIso : null;
    const { data: updRows, error: updErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update({
        current_step_id: targetStepId,
        next_action_at:  nextActionAt,
        updated_at:      nowIso,
      })
      .eq('id', run.id)
      .in('status', ['active','paused'])
      .select('id, current_step_id, next_action_at, status');
    if (updErr) return res.status(500).json({ error: 'run update: ' + updErr.message });
    if (!updRows || updRows.length === 0) {
      return res.status(409).json({ error: 'RACE_GUARD: run-status veranderde tijdens de call (niet meer active/paused).' });
    }

    // ── 5) Cancel-cascade (optioneel — waarborg: eigen audit-entry per taak) ─
    let cancelledPa = [];
    if (cancelPa && run.current_step_id) {
      // Zoek open (PENDING/APPROVED) pending_actions gebonden aan huidige stap
      // via jsonb-filter op payload.workflow_run_id + payload.step_id.
      const { data: openPa } = await supabaseAdmin
        .from('pending_actions')
        .select('id, action_type, payload, status, created_at')
        .eq('customer_id', run.customer_id)
        .in('status', ['PENDING','APPROVED'])
        .filter('payload->>workflow_run_id', 'eq', run.id)
        .filter('payload->>step_id', 'eq', run.current_step_id);
      for (const pa of openPa || []) {
        // Update elke rij met eigen guard: matcht status + payload-koppeling.
        // Fail-loud niet nodig (voor cancel is niks-doen bij mismatch acceptabel).
        const { error: paErr } = await supabaseAdmin
          .from('pending_actions')
          .update({
            status:           'CANCELLED',
            rejection_reason: `Gecanceld door run-verplaatsing door user ${admin.user.id} (was: step_id=${run.current_step_id}, run=${run.id})` + (reason ? ' — ' + reason : ''),
            updated_at:       nowIso,
          })
          .eq('id', pa.id)
          .in('status', ['PENDING','APPROVED']);
        if (!paErr) {
          cancelledPa.push({
            id:          pa.id,
            action_type: pa.action_type,
            title:       pa.payload?.title || null,
            kind:        pa.payload?.kind  || null,
            created_at:  pa.created_at,
          });
        }
      }
    }

    // ── 6) Audit-spoor (waarborg #8): dunning_log + audit_log ───────────
    // dunning_log event: run_step_manual_move.
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id:  run.id,
        step_id: run.current_step_id || null,
        event_type: 'run_step_manual_move',
        payload: {
          from_step_id:       run.current_step_id,
          to_step_id:         targetStepId,
          from_step_type:     curStep?.step_type || null,
          to_step_type:       tgtStep.step_type || null,
          from_step_order:    curStep?.step_order ?? null,
          to_step_order:      tgtStep.step_order ?? null,
          trigger_now:        triggerNow,
          cancel_cascade:     cancelPa,
          cancelled_pa_count: cancelledPa.length,
          cancelled_pa_ids:   cancelledPa.map((p) => p.id),
          moved_by_user_id:   admin.user.id,
          moved_by_user_email: admin.user.email || null,
          reason,
          is_test_customer:   !!customer.is_test,
        },
      });
    } catch (e) {
      console.warn('[verplaats-tool] dunning_log insert soft-fail:', e?.message || e);
    }

    // audit_log entry (bestaand pattern spiegelt finance_dunning.customer_closed_manually).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     admin.user.id,
        action:      'finance_dunning.run_step_manual_move',
        entity_type: 'dunning_workflow_run',
        entity_id:   run.id,
        after_json: {
          run_id:             run.id,
          customer_id:        run.customer_id,
          customer_name:      customerDisplay(customer),
          is_test:            !!customer.is_test,
          workflow_id:        run.workflow_id,
          from_step_id:       run.current_step_id,
          to_step_id:         targetStepId,
          from_step_type:     curStep?.step_type || null,
          to_step_type:       tgtStep.step_type || null,
          trigger_now:        triggerNow,
          next_action_at:     nextActionAt,
          cancel_cascade:     cancelPa,
          cancelled_pa_count: cancelledPa.length,
          cancelled_pa_ids:   cancelledPa.map((p) => p.id),
          moved_at:           nowIso,
          reason,
        },
      });
    } catch (e) {
      console.warn('[verplaats-tool] audit_log insert soft-fail:', e?.message || e);
    }

    // ── 7) Response ─────────────────────────────────────────────────────
    return res.status(200).json({
      ok: true,
      run_id:             run.id,
      customer_id:        run.customer_id,
      customer_name:      customerDisplay(customer),
      is_test:            !!customer.is_test,
      from_step_id:       run.current_step_id,
      to_step_id:         targetStepId,
      from_step_type:     curStep?.step_type || null,
      to_step_type:       tgtStep.step_type || null,
      trigger_now:        triggerNow,
      next_action_at:     nextActionAt,
      cancelled_pending_actions_count: cancelledPa.length,
      cancelled_pending_actions:       cancelledPa,
      note: triggerNow
        ? `next_action_at=now — engine pikt bij volgende cron-tick op. Voor sandbox: draai /api/wanbetalers-sandbox-run-engine handmatig.`
        : 'next_action_at=NULL — engine pikt NIET automatisch op; zet handmatig een tick als je 't wilt laten vuren.',
    });
  } catch (e) {
    console.error('[verplaats-tool]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
