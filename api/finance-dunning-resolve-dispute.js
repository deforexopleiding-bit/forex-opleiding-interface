// api/finance-dunning-resolve-dispute.js
// Acties-tab v1 — Los een dispuut op. Twee routes:
//   A) resolution='resume'  → klant had ongelijk / geschil van tafel →
//      stage terug naar 'nieuw'. Engine pakt de klant op als er nog open
//      facturen zijn (shouldSkipDueToPipelineStage laat 'nieuw' door). De
//      bestaande active/paused runs blijven staan en tikken meteen door
//      zodra hun next_action_at bereikt is.
//   B) resolution='close'   → klant had gelijk / factuur gecrediteerd →
//      delegate naar finance-dunning-close-customer (dual-close: runs →
//      completed + stage → opgelost + pending_actions → REJECTED). Deze
//      endpoint doet dat door dat endpoint niet aan te roepen, maar door
//      dezelfde bouwstenen te gebruiken (setStage 'opgelost' + audit).
//      Voor consistentie met FIX 4 kan de UI beter direct
//      finance-dunning-close-customer aanroepen; deze branch is voor
//      wanneer de UI vanuit de dispuut-context wil sluiten zonder de
//      close-dossier modal opnieuw te openen.
//
// Body:
//   {
//     customer_id: uuid (required),
//     resolution:  'resume' | 'close' (required),
//     reason:      string (min 5, max 500, required),
//   }
//
// Permission: finance.dunning.execute.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { setStage } from './_lib/dunning-pipeline.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { getClientIp } from './_lib/audit-customer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESUME = 'resume';
const CLOSE  = 'close';

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
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!customerId) return res.status(400).json({ error: 'customer_id (uuid) verplicht' });
  if (resolution !== RESUME && resolution !== CLOSE) {
    return res.status(400).json({ error: "resolution moet 'resume' of 'close' zijn" });
  }
  if (reason.length < 5) return res.status(400).json({ error: 'reason (min 5 chars) verplicht' });
  if (reason.length > 500) return res.status(400).json({ error: 'reason max 500 chars' });

  const nowIso = new Date().toISOString();
  const userId = user?.id || null;

  try {
    const { data: cust, error: custErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company')
      .eq('id', customerId)
      .maybeSingle();
    if (custErr) throw new Error('customer lookup: ' + custErr.message);
    if (!cust)   return res.status(404).json({ error: 'Klant niet gevonden' });

    // Verifieer huidige stage — voorkomt per ongeluk resolve-dispute op
    // een klant die niet in dispuut staat.
    const { data: pc } = await supabaseAdmin
      .from('dunning_pipeline_customers')
      .select('stage_slug')
      .eq('customer_id', customerId)
      .maybeSingle();
    if (!pc || pc.stage_slug !== 'dispuut') {
      return res.status(409).json({
        error: 'Klant staat niet in dispuut (huidige stage: ' + (pc?.stage_slug || 'onbekend') + ')',
      });
    }

    const warnings = [];
    const targetStage = (resolution === RESUME) ? 'nieuw' : 'opgelost';

    // Stage-transitie: setStage() (fail-soft; log via addLogEntry inside).
    let markedStage = false;
    try {
      const r = await setStage(customerId, targetStage, 'Dispuut opgelost: ' + reason, userId ? String(userId) : 'system');
      markedStage = !!(r && r.ok !== false);
      if (!markedStage) warnings.push('Stage-transitie naar ' + targetStage + ' faalde: ' + (r?.reason || 'onbekend'));
    } catch (e) {
      warnings.push('setStage-fout: ' + e.message);
      console.error('[resolve-dispute] setStage:', e.message);
    }

    // Bij 'close': óók de runs sluiten (analoog close-customer's stap 1) —
    // anders blijven ze active maar met stage=opgelost, engine skipt via
    // guard maar de UI blijft de run tonen als "actief". Consistenter is
    // ze op 'completed' te zetten.
    let closedRuns = 0;
    if (resolution === CLOSE) {
      try {
        const { data: runs, error: runErr } = await supabaseAdmin
          .from('dunning_workflow_runs')
          .update({
            status:            'completed',
            completed_at:      nowIso,
            completion_reason: 'dispute_resolved_closed',
            updated_at:        nowIso,
          })
          .eq('customer_id', customerId)
          .in('status', ['active', 'paused'])
          .select('id');
        if (runErr) throw new Error(runErr.message);
        closedRuns = Array.isArray(runs) ? runs.length : 0;
      } catch (e) {
        warnings.push('run-close faalde: ' + e.message);
        console.error('[resolve-dispute] run close:', e.message);
      }
    }

    // Audit
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     userId,
        action:      'finance_dunning.dispute_resolved',
        entity_type: 'customer',
        entity_id:   customerId,
        after_json: {
          customer_id:      customerId,
          customer_display: customerDisplayName(cust, '(zonder naam)'),
          resolution,
          target_stage:     targetStage,
          reason,
          marked_stage:     markedStage,
          closed_runs:      closedRuns,
          warnings,
          resolved_at:      nowIso,
        },
        ip_address:  getClientIp(req),
      });
    } catch (e) {
      warnings.push('audit_log-insert faalde: ' + e.message);
      console.warn('[resolve-dispute] audit:', e.message);
    }

    return res.status(200).json({
      ok: true,
      customer_id:   customerId,
      resolution,
      target_stage:  targetStage,
      marked_stage:  markedStage,
      closed_runs:   closedRuns,
      warnings,
    });
  } catch (e) {
    console.error('[finance-dunning-resolve-dispute]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
