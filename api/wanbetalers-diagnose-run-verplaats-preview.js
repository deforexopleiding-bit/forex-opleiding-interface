// api/wanbetalers-diagnose-run-verplaats-preview.js
//
// POST { run_id, target_step_id, trigger_now?, cancel_current_pending_actions? }
// → Read-only preview van wat er zou gebeuren als je de run verplaatst.
// Doet NIETS aan de state. Super_admin only.
//
// Geeft de UI genoeg om:
//   1) klantnaam + bedrag + is_test-badge te tonen
//   2) huidige stap + doel-stap side-by-side met safety-label
//   3) lijst van open pending_actions van de HUIDIGE stap (voor cancel-cascade preview)
//   4) template-preview (subject + body) als trigger_now + send-step
//   5) confirmation-tekst die de user moet typen (bij trigger_now + send-step)
//
// Response-shape:
// {
//   ok: true,
//   customer: { id, name, email, phone, is_test, is_anonymized, is_archived,
//               total_open_eur, open_invoice_count },
//   run: { id, workflow_id, workflow_name, status, current_step_id },
//   current_step: { id, step_order, step_type, config_title } | null,
//   target_step:  { id, step_order, step_type, config_title, risk: 'safe'|'risky' },
//   open_pending_actions_current_step: [ { id, action_type, title, kind, created_at, status } ],
//   template_preview: { subject, body, to } | null,   // alleen bij trigger_now+send-step
//   requires_live_send_confirmation: bool,
//   expected_confirmation_text: string | null,        // 'IK BEVESTIG SEND NAAR <naam>' als vereist
//   warnings: [ string ]                              // bv. 'echte klant', 'geanonimiseerd', 'workflow-mismatch'
// }

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open','partially_paid','overdue'];
const SEND_STEPS = new Set(['email','whatsapp']);

function stepRisk(step_type) {
  return SEND_STEPS.has(String(step_type || '').toLowerCase()) ? 'risky' : 'safe';
}
function customerDisplay(c) {
  if (!c) return '(onbekend)';
  const isC = !!c.is_company;
  const name = isC
    ? (c.company_name || '(bedrijf)')
    : ([c.first_name, c.last_name].filter(Boolean).join(' ') || '(zonder naam)');
  return name;
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
  if (!runId || !UUID_RE.test(runId))                 return res.status(400).json({ error: 'run_id (uuid) vereist' });
  if (!targetStepId || !UUID_RE.test(targetStepId))   return res.status(400).json({ error: 'target_step_id (uuid) vereist' });

  try {
    // 1) Run + klant
    const { data: run, error: rErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, customer_id, workflow_id, status, current_step_id, next_action_at, updated_at')
      .eq('id', runId)
      .maybeSingle();
    if (rErr)  return res.status(500).json({ error: 'run fetch: ' + rErr.message });
    if (!run)  return res.status(404).json({ error: 'Run niet gevonden' });

    const { data: customer } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone, is_test, anonymized_at, archived_at')
      .eq('id', run.customer_id)
      .maybeSingle();
    if (!customer) return res.status(500).json({ error: 'Klant van run niet gevonden (data-integriteit)' });

    // 2) Open bedrag + facturen
    const { data: openInvs } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, credited_amount, status, due_date, issue_date, payment_url')
      .eq('customer_id', run.customer_id)
      .in('status', OPEN_STATUSES);
    const openInvsFiltered = (openInvs || []).filter((iv) =>
      Math.max(0, (Number(iv.amount_total)||0) - (Number(iv.amount_paid)||0) - (Number(iv.credited_amount)||0)) > 0
    );
    const totalOpenEur = openInvsFiltered.reduce((s, iv) =>
      s + Math.max(0, (Number(iv.amount_total)||0) - (Number(iv.amount_paid)||0) - (Number(iv.credited_amount)||0)), 0);

    // 3) Workflow + huidige stap + doel-stap
    const { data: wf } = await supabaseAdmin.from('dunning_workflows').select('id, name').eq('id', run.workflow_id).maybeSingle();
    const { data: steps } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, workflow_id, step_type, step_order, config')
      .in('id', [run.current_step_id, targetStepId].filter(Boolean));
    const curStep = (steps || []).find((s) => s.id === run.current_step_id) || null;
    const tgtStep = (steps || []).find((s) => s.id === targetStepId) || null;
    if (!tgtStep) return res.status(404).json({ error: 'target_step_id niet gevonden' });

    // Same-workflow-guard (guard #6 uit ontwerp).
    if (tgtStep.workflow_id !== run.workflow_id) {
      return res.status(400).json({ error: `Doel-stap hoort bij een andere workflow (${tgtStep.workflow_id}) dan de run (${run.workflow_id}).` });
    }

    // 4) Open pending_actions van huidige stap (voor cancel-cascade preview).
    // Filter op zowel workflow_run_id als step_id via jsonb-lookup.
    let openPA = [];
    if (run.current_step_id) {
      const { data: pas } = await supabaseAdmin
        .from('pending_actions')
        .select('id, action_type, payload, status, created_at')
        .eq('customer_id', run.customer_id)
        .in('status', ['PENDING','APPROVED'])
        .filter('payload->>workflow_run_id', 'eq', run.id)
        .filter('payload->>step_id', 'eq', run.current_step_id);
      openPA = (pas || []).map((pa) => ({
        id:         pa.id,
        action_type: pa.action_type,
        status:     pa.status,
        title:      pa.payload?.title || null,
        kind:       pa.payload?.kind  || null,
        created_at: pa.created_at,
      }));
    }

    // 5) Template preview (alleen bij trigger_now + send-step).
    let templatePreview = null;
    const requiresLiveConfirm = triggerNow && SEND_STEPS.has(String(tgtStep.step_type || '').toLowerCase());
    if (requiresLiveConfirm) {
      const templateId = tgtStep.config?.template_id || null;
      if (templateId) {
        const { data: tpl } = await supabaseAdmin
          .from('dunning_templates')
          .select('id, kind, subject, body, meta_template_name, is_active')
          .eq('id', templateId)
          .maybeSingle();
        if (tpl) {
          try {
            const { renderTemplate } = await import('./_lib/dunning-template-render.js');
            const rendered = renderTemplate({
              body:         tpl.body,
              subject:      tpl.subject,
              customer,
              openInvoices: openInvsFiltered,
            });
            templatePreview = {
              template_id:        tpl.id,
              template_kind:      tpl.kind,
              meta_template_name: tpl.meta_template_name || null,
              is_active:          !!tpl.is_active,
              subject:            rendered?.subject || tpl.subject || null,
              body:               String(rendered?.body || tpl.body || '').slice(0, 2000),
              to:                 tpl.kind === 'email' ? (customer.email || null) : (customer.phone || null),
            };
          } catch (e) {
            templatePreview = {
              template_id:        tpl.id,
              template_kind:      tpl.kind,
              meta_template_name: tpl.meta_template_name || null,
              render_error:       String(e?.message || e),
            };
          }
        } else {
          templatePreview = { template_id: templateId, render_error: 'Template niet gevonden' };
        }
      } else {
        templatePreview = { render_error: 'Stap heeft geen template_id in config' };
      }
    }

    // 6) Waarschuwingen
    const warnings = [];
    if (!customer.is_test) warnings.push('ECHTE klant (geen test) — extra oplettendheid geboden.');
    if (customer.anonymized_at) warnings.push('Klant is geanonimiseerd — verplaatsen is meestal niet zinvol.');
    if (customer.archived_at)   warnings.push('Klant is gearchiveerd.');
    if (!['active','paused'].includes(run.status)) warnings.push(`Run heeft status '${run.status}' — verplaatsen alleen mogelijk bij active/paused.`);
    if (tgtStep.id === run.current_step_id) warnings.push('Doel-stap is dezelfde als huidige stap.');
    if (templatePreview && templatePreview.render_error) warnings.push('Template-preview faalde: ' + templatePreview.render_error);
    if (templatePreview && templatePreview.template_kind && !templatePreview.to) warnings.push('Klant heeft geen ' + (templatePreview.template_kind === 'email' ? 'e-mailadres' : 'telefoonnummer') + ' — send zou falen.');

    // 7) Confirmation-tekst
    const custName = customerDisplay(customer);
    const expectedConfirm = requiresLiveConfirm ? `IK BEVESTIG SEND NAAR ${custName}` : null;

    return res.status(200).json({
      ok: true,
      customer: {
        id:                 customer.id,
        name:               custName + (customer.is_test ? ' [TEST]' : ''),
        email:              customer.email || null,
        phone:              customer.phone || null,
        is_test:            !!customer.is_test,
        is_anonymized:      !!customer.anonymized_at,
        is_archived:        !!customer.archived_at,
        total_open_eur:     Number(totalOpenEur.toFixed(2)),
        open_invoice_count: openInvsFiltered.length,
      },
      run: {
        id:              run.id,
        workflow_id:     run.workflow_id,
        workflow_name:   wf?.name || null,
        status:          run.status,
        current_step_id: run.current_step_id,
        next_action_at:  run.next_action_at,
      },
      current_step: curStep ? {
        id:           curStep.id,
        step_order:   curStep.step_order,
        step_type:    curStep.step_type,
        config_title: curStep.config?.title || null,
      } : null,
      target_step: {
        id:           tgtStep.id,
        step_order:   tgtStep.step_order,
        step_type:    tgtStep.step_type,
        config_title: tgtStep.config?.title || null,
        risk:         stepRisk(tgtStep.step_type),
      },
      open_pending_actions_current_step: openPA,
      would_cancel_pending_actions:      cancelPa ? openPA.length : 0,
      trigger_now:                       triggerNow,
      requires_live_send_confirmation:   requiresLiveConfirm,
      expected_confirmation_text:        expectedConfirm,
      template_preview:                  templatePreview,
      warnings,
    });
  } catch (e) {
    console.error('[verplaats-preview]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
