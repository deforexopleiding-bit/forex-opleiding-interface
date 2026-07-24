// api/finance-dunning-run-skip-step.js
//
// POST -> zet een lopende dunning_workflow_run één stap vooruit ZONDER de
// huidige stap uit te voeren. Praktijkgeval: sales heeft de klant zelf
// gebeld, dus de geplande belopdracht hoeft niet meer.
//
// Body: { run_id: uuid }
//
// Gedrag per randgeval (bewuste keuzes — zie commit-message voor onder-
// bouwing):
//   - Run niet active         → 409 "skip kan alleen vanuit active"
//   - Geen volgende stap      → run wordt afgerond met completion_reason
//                               'skipped_last_step' (semantisch gelijk aan
//                               engine's 'no_more_steps' bij natuurlijke
//                               afronding); user's intentie "hier ben ik
//                               klaar mee" wordt gehonoreerd
//   - Wait-stap als huidige   → wachttijd vervalt (impliciet: next_action_at
//                               wordt op nu gezet). Precies wat de user wil.
//   - Race (twee tegelijk)    → conditional UPDATE op current_step_id;
//                               tweede request krijgt 0 rows en 409
//
// Permission: finance.dunning.execute (zelfde als pause/resume/cancel).
//
// Schema-verificatie (les uit customer-dossier #920/#922):
//   dunning_workflow_runs → finance-dunning-run-control.js:48
//                            (id, status, workflow_id, customer_id,
//                             current_step_id, next_action_at, started_at,
//                             completed_at, completion_reason, updated_at)
//   dunning_workflow_steps → finance-dunning-workflows-detail.js:36-40
//                            (id, step_order, step_type, config)
//   dunning_log            → run-control-canonical (run_id, step_id,
//                            event_type, payload) — insert-shape r100-110
//   audit_log              → run-control-canonical (user_id, action,
//                            entity_type, entity_id, after_json,
//                            ip_address) — insert-shape r115-122
//
// Nul verzonnen kolommen — alle 4 tabellen geverifieerd tegen bestaand
// endpoint dat ze al leest of schrijft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { findNextStep } from './_lib/dunning-skip-helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  const runId = (req.body || {}).run_id || null;
  if (!runId || !UUID_RE.test(String(runId))) {
    return res.status(400).json({ error: 'run_id (uuid) vereist' });
  }

  try {
    // 1) Fetch run — status + huidige stap.
    const { data: run, error: lookupErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id, status, workflow_id, customer_id, current_step_id, next_action_at, started_at, completed_at, completion_reason, updated_at')
      .eq('id', runId)
      .maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!run) return res.status(404).json({ error: 'Run niet gevonden' });

    if (run.status !== 'active') {
      return res.status(409).json({
        error: `skip kan alleen vanuit active (huidig: ${run.status})`,
        code:  'RUN_NOT_ACTIVE',
      });
    }
    if (!run.current_step_id) {
      // Actieve run zonder current_step_id is een engine-glitch; skip is
      // dan niet zinvol want we weten niet vanwaar te springen.
      return res.status(409).json({
        error: 'Run heeft geen huidige stap (engine-glitch); overslaan is niet mogelijk',
        code:  'NO_CURRENT_STEP',
      });
    }

    // 2) Fetch alle stappen voor deze workflow — nodig voor findNextStep +
    //    om de "overgeslagen stap"-context in de log te noteren.
    const { data: steps, error: stepsErr } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, step_order, step_type, config')
      .eq('workflow_id', run.workflow_id)
      .order('step_order', { ascending: true });
    if (stepsErr) throw new Error('steps lookup: ' + stepsErr.message);

    const { current, next } = findNextStep(steps || [], run.current_step_id);
    if (!current) {
      // current_step_id verwijst naar iets dat niet in de workflow-set zit.
      // Behandel als engine-glitch (zelfde categorie als NO_CURRENT_STEP).
      return res.status(409).json({
        error: 'Huidige stap niet gevonden in workflow (mogelijk verplaatst); overslaan niet mogelijk',
        code:  'CURRENT_STEP_MISSING',
      });
    }

    const nowIso = new Date().toISOString();

    // 3) Update. TWEE PADEN:
    //    a) next bestaat → verplaats current_step_id + next_action_at=nu
    //    b) next bestaat NIET → completeer met reason 'skipped_last_step'
    //
    //    In beide gevallen: conditionele update op current_step_id om
    //    race met een parallele skip te voorkomen. Als iemand al gesprongen
    //    is, matcht de WHERE niet meer en krijgen we 0 rijen updated → 409.
    let update;
    if (next) {
      update = {
        current_step_id: next.id,
        next_action_at:  nowIso,
        updated_at:      nowIso,
      };
    } else {
      update = {
        status:            'completed',
        completed_at:      nowIso,
        completion_reason: 'skipped_last_step',
        updated_at:        nowIso,
      };
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .update(update)
      .eq('id', runId)
      .eq('current_step_id', run.current_step_id)   // race-guard
      .eq('status', 'active')                        // extra safety: alleen bij nog-active
      .select('id, workflow_id, customer_id, status, current_step_id, next_action_at, started_at, completed_at, completion_reason, updated_at')
      .maybeSingle();
    if (updErr) throw new Error('update: ' + updErr.message);
    if (!updated) {
      // Race: iemand anders sprong eerst, of de run is tussen fetch en
      // update van status veranderd. Geef 409 zodat de UI opnieuw kan
      // ophalen i.p.v. blindelings te doen alsof 't gelukt is.
      return res.status(409).json({
        error: 'Run is tussen fetch en update door iemand anders gemuteerd — herlaad en probeer opnieuw',
        code:  'RACE_CONFLICT',
      });
    }

    // 4) dunning_log — voor tijdlijn-zichtbaarheid in klantdossier.
    //    Payload beschrijft welke stap werd overgeslagen en waar we nu staan
    //    (of null bij laatste-stap-skip). Fail-soft: log-fout blokkeert
    //    de skip niet.
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id:     runId,
        step_id:    run.current_step_id,   // de OVERGESLAGEN stap
        event_type: 'run_control_skip_step',
        payload: {
          action:  'skip_step',
          user_id: user.id,
          skipped_step: {
            id:         current.id,
            order:      current.step_order,
            type:       current.step_type,
          },
          new_step: next ? {
            id:         next.id,
            order:      next.step_order,
            type:       next.step_type,
          } : null,
          completed_by_skip: !next,
        },
      });
    } catch (e) { console.error('[skip-step log]', e.message); }

    // 5) audit_log — parallel aan finance_dunning_run.{pause,resume,cancel}.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'finance_dunning_run.skip_step',
        entity_type: 'dunning_workflow_run',
        entity_id:   runId,
        after_json:  {
          skipped_step_order: current.step_order,
          new_step_order:     next ? next.step_order : null,
          completed_by_skip:  !next,
        },
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[skip-step audit]', e.message); }

    return res.status(200).json({
      success:            true,
      run:                updated,
      skipped_step:       { order: current.step_order, type: current.step_type },
      new_step:           next ? { order: next.step_order, type: next.step_type } : null,
      completed_by_skip:  !next,
    });
  } catch (e) {
    console.error('[finance-dunning-run-skip-step]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
