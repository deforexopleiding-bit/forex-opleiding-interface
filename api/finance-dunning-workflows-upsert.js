// api/finance-dunning-workflows-upsert.js
// POST   -> create een dunning_workflow incl. steps.
// PATCH  -> update een dunning_workflow (vereist ?id=<uuid> of body.id). Steps
//          worden diff-based ge-upsert (zie hieronder) i.p.v. DELETE+INSERT
//          zodat step-id's behouden blijven bij tekst-wijzigingen en
//          dunning_log/dunning_workflow_runs referenties geldig blijven.
// Permission: finance.dunning.config.
//
// DIFF-BASED UPSERT (sinds fix/workflow-upsert-fk):
//   De DELETE+INSERT-strategie faalde op FK-RESTRICT zodra de workflow had
//   gedraaid (dunning_log.step_id / dunning_workflow_runs.current_step_id).
//   Migratie 2026-07-15-workflow-steps-fk-set-null.sql zet die FK's naar
//   SET NULL zodat DELETE altijd lukt. Maar SET-NULL-alle-log-referenties
//   bij elke save zou de audit-trail elke keer resetten -> daarom is de
//   upsert ook diff-based:
//     - Steps met een `id` in de payload -> UPDATE die specifieke rij
//       (step_type, config, step_order) -> id blijft; logs die naar deze
//       id verwijzen blijven geldig.
//     - Steps zonder `id` -> INSERT nieuwe rij met verse UUID.
//     - Bestaande DB-steps waarvan de id NIET meer in de payload voorkomt
//       -> DELETE (FK SET NULL vangt de log-referenties op).
//   Voor UNIQUE(workflow_id, step_order) botsingen bij hernummering:
//   eerst +100000-shift op alle bestaande, dan definitieve step_order.
//
// Body shape:
//   {
//     workflow: { name, description?, is_active?, priority?, trigger_conditions? },
//     steps: [
//       { id?, step_order, step_type: 'email'|'whatsapp'|'wait'|'task'|'stop', config: {...} }
//     ]
//   }
//   NB: `id` is optioneel per step. Bestaande UI-flow (POST zonder id, PATCH
//       met alleen step_order) blijft werken -- zonder id fallt de upsert
//       terug op DELETE+INSERT-shape, wat sinds de FK SET NULL migratie
//       veilig is.
//
// Step-config validatie per type:
//   email/whatsapp: config.template_id (uuid) required; moet bestaan in
//                   dunning_templates en kind moet matchen met step_type.
//   wait:           config.days (integer >= 0) required.
//   task:           config.title (text, max 200) required;
//                   config.description (text) optional;
//                   config.assigned_user_id (uuid) optional.
//   stop:           config is {} (geen velden vereist).
//
// Response: 201 (create) of 200 (update): { workflow: row, steps: [...] }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

const VALID_STEP_TYPES = ['email', 'whatsapp', 'wait', 'task', 'stop'];
const MAX_NAME = 200;
const MAX_DESCRIPTION = 2000;
const MAX_TASK_TITLE = 200;
const MAX_TASK_DESCRIPTION = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateWorkflow(body, isUpdate) {
  const errors = [];
  const out = {};

  if (!isUpdate || body.name !== undefined) {
    const v = String(body.name || '').trim();
    if (!v) errors.push('workflow.name vereist');
    else if (v.length > MAX_NAME) errors.push(`workflow.name max ${MAX_NAME} chars`);
    else out.name = v;
  }

  if (body.description !== undefined) {
    const v = String(body.description || '').trim() || null;
    if (v && v.length > MAX_DESCRIPTION) errors.push(`workflow.description max ${MAX_DESCRIPTION} chars`);
    out.description = v;
  }

  if (body.is_active !== undefined) {
    out.is_active = body.is_active === true || body.is_active === 'true';
  }

  if (body.priority !== undefined) {
    const n = Number(body.priority);
    if (!Number.isInteger(n)) errors.push('workflow.priority moet integer zijn');
    else out.priority = n;
  }

  if (body.trigger_conditions !== undefined) {
    if (!isPlainObject(body.trigger_conditions)) {
      errors.push('workflow.trigger_conditions moet object zijn');
    } else {
      out.trigger_conditions = body.trigger_conditions;
    }
  }

  return { errors, out };
}

function validateSteps(steps) {
  const errors = [];
  if (!Array.isArray(steps)) {
    return { errors: ['steps moet een array zijn'], normalized: [] };
  }

  const seenOrders = new Set();
  const normalized = [];

  steps.forEach((raw, idx) => {
    const label = `step ${idx}`;
    if (!isPlainObject(raw)) { errors.push(`${label}: moet object zijn`); return; }

    const order = Number(raw.step_order);
    if (!Number.isInteger(order) || order < 0) {
      errors.push(`${label}: step_order moet integer >= 0 zijn`);
    } else if (seenOrders.has(order)) {
      errors.push(`${label}: step_order ${order} dubbel in array`);
    } else {
      seenOrders.add(order);
    }

    const type = String(raw.step_type || '').toLowerCase();
    if (!VALID_STEP_TYPES.includes(type)) {
      errors.push(`${label}: step_type moet ${VALID_STEP_TYPES.join('/')} zijn`);
      return;
    }

    const cfg = isPlainObject(raw.config) ? raw.config : {};
    const cleanCfg = {};

    if (type === 'email' || type === 'whatsapp') {
      const tplId = cfg.template_id;
      if (!isUuid(tplId)) {
        errors.push(`${label}: config.template_id (uuid) vereist voor ${type}`);
      } else {
        cleanCfg.template_id = tplId;
      }
    } else if (type === 'wait') {
      const days = Number(cfg.days);
      if (!Number.isInteger(days) || days < 0) {
        errors.push(`${label}: config.days moet integer >= 0 zijn voor wait`);
      } else {
        cleanCfg.days = days;
      }
    } else if (type === 'task') {
      const title = String(cfg.title || '').trim();
      if (!title) errors.push(`${label}: config.title vereist voor task`);
      else if (title.length > MAX_TASK_TITLE) errors.push(`${label}: config.title max ${MAX_TASK_TITLE} chars`);
      else cleanCfg.title = title;

      if (cfg.description !== undefined) {
        const desc = String(cfg.description || '').trim() || null;
        if (desc && desc.length > MAX_TASK_DESCRIPTION) {
          errors.push(`${label}: config.description max ${MAX_TASK_DESCRIPTION} chars`);
        } else if (desc) {
          cleanCfg.description = desc;
        }
      }
      if (cfg.assigned_user_id !== undefined && cfg.assigned_user_id !== null && cfg.assigned_user_id !== '') {
        if (!isUuid(cfg.assigned_user_id)) {
          errors.push(`${label}: config.assigned_user_id moet uuid zijn`);
        } else {
          cleanCfg.assigned_user_id = cfg.assigned_user_id;
        }
      }
    }
    // stop: config blijft {}

    // Optioneel id per step (voor diff-based upsert). Als ontbrekend →
    // step is nieuw en wordt geïnsert; als aanwezig → moet uuid zijn en
    // wordt geüpdatet (mits die id bij deze workflow hoort — cross-check
    // in de handler).
    const stepId = raw.id != null && raw.id !== '' ? raw.id : null;
    if (stepId != null && !isUuid(stepId)) {
      errors.push(`${label}: id moet uuid zijn (of leeg voor nieuwe step)`);
    }

    normalized.push({ id: stepId, step_order: order, step_type: type, config: cleanCfg });
  });

  return { errors, normalized };
}

// Verifieer dat alle template_id-refs bestaan in dunning_templates met de juiste kind.
async function verifyTemplateRefs(normalizedSteps) {
  const errors = [];
  const refs = normalizedSteps
    .map((s, idx) => ({ idx, type: s.step_type, tplId: s.config?.template_id }))
    .filter(r => r.type === 'email' || r.type === 'whatsapp');
  if (!refs.length) return errors;

  const ids = [...new Set(refs.map(r => r.tplId))];
  const { data, error } = await supabaseAdmin
    .from('dunning_templates')
    .select('id, kind')
    .in('id', ids);
  if (error) throw new Error('template-ref check: ' + error.message);

  const tplMap = new Map((data || []).map(t => [t.id, t.kind]));
  for (const r of refs) {
    const kind = tplMap.get(r.tplId);
    if (!kind) {
      errors.push(`step ${r.idx}: template ${r.tplId} bestaat niet`);
    } else if (kind !== r.type) {
      errors.push(`step ${r.idx}: template ${r.tplId} heeft kind=${kind}, verwacht ${r.type}`);
    }
  }
  return errors;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'POST, PATCH');
    return res.status(405).json({ error: 'POST of PATCH' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.config'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.config)' });
  }

  const body = req.body || {};
  const isUpdate = req.method === 'PATCH';
  const id = isUpdate ? (req.query?.id || body.id || null) : null;

  if (isUpdate && !id) {
    return res.status(400).json({ error: 'id vereist bij PATCH (?id=<uuid> of body.id)' });
  }

  const wfBody    = isPlainObject(body.workflow) ? body.workflow : {};
  const stepsBody = body.steps;

  const { errors: wfErrors, out: wfOut } = validateWorkflow(wfBody, isUpdate);
  const { errors: stepErrors, normalized: normalizedSteps } = validateSteps(
    Array.isArray(stepsBody) ? stepsBody : (isUpdate && stepsBody === undefined ? [] : stepsBody)
  );

  // Steps zijn verplicht bij POST. Bij PATCH zonder steps-array: workflow-only update.
  const stepsProvided = Array.isArray(stepsBody);
  const aggregateErrors = [...wfErrors];
  if (!isUpdate && !stepsProvided) {
    aggregateErrors.push('steps array vereist bij POST');
  } else if (stepsProvided) {
    aggregateErrors.push(...stepErrors);
  }

  if (aggregateErrors.length) {
    return res.status(400).json({ error: aggregateErrors.join(', '), errors: aggregateErrors });
  }

  try {
    // Cross-ref check: alle email/whatsapp steps moeten verwijzen naar bestaande templates
    // met matching kind. Pas uitvoeren als steps daadwerkelijk zijn meegegeven.
    if (stepsProvided && normalizedSteps.length) {
      const refErrors = await verifyTemplateRefs(normalizedSteps);
      if (refErrors.length) {
        return res.status(400).json({ error: refErrors.join(', '), errors: refErrors });
      }
    }

    let workflowRow;

    if (isUpdate) {
      // Bestaat workflow?
      const { data: existing, error: lookupErr } = await supabaseAdmin
        .from('dunning_workflows').select('id, name').eq('id', id).maybeSingle();
      if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
      if (!existing) return res.status(404).json({ error: 'Workflow niet gevonden' });

      const payload = { ...wfOut, updated_at: new Date().toISOString() };
      const { data: updated, error: updErr } = await supabaseAdmin
        .from('dunning_workflows').update(payload).eq('id', id)
        .select('id, name, description, is_active, priority, trigger_conditions, created_by_user_id, created_at, updated_at')
        .single();
      if (updErr) throw new Error('update workflow: ' + updErr.message);
      workflowRow = updated;

      // Diff-based steps upsert. Geen DB-transactie in supabase-js: elke stap
      // is fail-fast (bij fout: 500). De volgorde is bewust:
      //   1. Fetch bestaande steps (voor id-mapping + cross-check).
      //   2. Valideer dat elk payload-step.id ook echt bij deze workflow hoort
      //      (anders zou een client een step van een andere workflow kunnen
      //      overschrijven).
      //   3. Bepaal DELETE-set (bestaande id's niet in payload).
      //   4. Shift alle nog-te-behouden bestaande steps naar step_order + 100000
      //      om UNIQUE(workflow_id, step_order)-botsingen te vermijden tijdens
      //      hernummering.
      //   5. UPDATE per bestaand-id → definitief step_order + type + config.
      //   6. INSERT nieuwe rijen (payload-steps zonder id).
      //   7. DELETE de weggevallen steps (FK SET NULL vangt log-referenties op).
      if (stepsProvided) {
        // 1. Bestaande steps ophalen.
        const { data: existing, error: exErr } = await supabaseAdmin
          .from('dunning_workflow_steps')
          .select('id, step_order')
          .eq('workflow_id', id);
        if (exErr) throw new Error('bestaande steps ophalen: ' + exErr.message);
        const existingById = new Map((existing || []).map(s => [s.id, s]));
        const existingCount = (existing || []).length;

        // ─── DATA-LOSS GUARDS (kritisch, na typo-incident 15-jul-2026) ───
        //
        // Guard A: workflow met bestaande steps + lege payload → nooit
        // stilzwijgend alles wissen. Alleen toestaan met expliciete
        // body.confirm_delete_all=true bevestiging.
        const confirmDeleteAll = body.confirm_delete_all === true;
        if (existingCount > 0 && normalizedSteps.length === 0 && !confirmDeleteAll) {
          return res.status(400).json({
            error: `Workflow heeft ${existingCount} bestaande stappen en de payload is leeg. ` +
                   `Weigering: leegmaken vereist expliciete bevestiging (body.confirm_delete_all=true). ` +
                   `Als je de editor kapot ziet: herlaad de pagina en probeer opnieuw.`,
            code: 'REFUSE_EMPTY_PAYLOAD_ON_POPULATED_WORKFLOW',
            existing_step_count: existingCount,
          });
        }

        // Guard B: workflow met bestaande steps + payload waarin GEEN enkele
        // step een id heeft → verouderde/gecrashte client. Zonder id's zou
        // de diff-based upsert alle bestaande verwijderen en de payload als
        // "nieuwe" steps inserten -> ontkoppeling van log-history + effectief
        // dataverlies-equivalent.
        const stepsWithIdCount = normalizedSteps.filter(s => s.id).length;
        if (existingCount > 0 && normalizedSteps.length > 0 && stepsWithIdCount === 0 && !confirmDeleteAll) {
          return res.status(400).json({
            error: `Verouderde clientversie: workflow heeft ${existingCount} bestaande stappen, ` +
                   `maar de payload bevat geen enkele step-id. Ververs de pagina en probeer opnieuw.`,
            code: 'REFUSE_ID_LESS_STEPS_ON_POPULATED_WORKFLOW',
            existing_step_count: existingCount,
            payload_step_count: normalizedSteps.length,
          });
        }

        // 2. Cross-check: iedere payload-step.id moet bij deze workflow horen.
        for (const s of normalizedSteps) {
          if (s.id && !existingById.has(s.id)) {
            throw new Error(`step id=${s.id} hoort niet bij workflow ${id} (of bestaat niet)`);
          }
        }

        // 3. DELETE-set: bestaande id's die niet meer in payload zitten.
        const keptIds = new Set(normalizedSteps.filter(s => s.id).map(s => s.id));
        const deleteIds = (existing || []).map(s => s.id).filter(sid => !keptIds.has(sid));

        // 4. Shift van te-behouden bestaande steps naar step_order + 100000
        //    om conflicten met de nieuwe step_orders te vermijden. Idempotent:
        //    +100000 zit ver buiten normale range (typische workflow ~30 steps).
        if (keptIds.size > 0) {
          for (const sid of keptIds) {
            const cur = existingById.get(sid);
            const { error: shiftErr } = await supabaseAdmin
              .from('dunning_workflow_steps')
              .update({ step_order: (cur?.step_order || 0) + 100000 })
              .eq('id', sid);
            if (shiftErr) throw new Error('step-shift naar temp-order: ' + shiftErr.message);
          }
        }

        // 5. UPDATE per bestaand-id → definitieve step_order + type + config.
        for (const s of normalizedSteps) {
          if (!s.id) continue;
          const { error: updStepErr } = await supabaseAdmin
            .from('dunning_workflow_steps')
            .update({
              step_order: s.step_order,
              step_type:  s.step_type,
              config:     s.config,
            })
            .eq('id', s.id);
          if (updStepErr) throw new Error(`update step ${s.id}: ${updStepErr.message}`);
        }

        // 6. INSERT nieuwe rijen.
        const newRows = normalizedSteps
          .filter(s => !s.id)
          .map(s => ({
            workflow_id: id,
            step_order:  s.step_order,
            step_type:   s.step_type,
            config:      s.config,
          }));
        if (newRows.length > 0) {
          const { error: insErr } = await supabaseAdmin
            .from('dunning_workflow_steps').insert(newRows);
          if (insErr) throw new Error('insert nieuwe steps: ' + insErr.message);
        }

        // 7. DELETE weggevallen steps. FK SET NULL (migratie 2026-07-15-
        //    workflow-steps-fk-set-null) zorgt dat log-referenties intact
        //    blijven met step_id=NULL.
        if (deleteIds.length > 0) {
          const { error: delErr } = await supabaseAdmin
            .from('dunning_workflow_steps')
            .delete()
            .in('id', deleteIds);
          if (delErr) throw new Error('delete weggevallen steps: ' + delErr.message);
        }
      }
    } else {
      // INSERT workflow
      const insertWf = {
        name:               wfOut.name,
        description:        wfOut.description ?? null,
        is_active:          wfOut.is_active !== undefined ? wfOut.is_active : false,
        priority:           wfOut.priority   !== undefined ? wfOut.priority   : 100,
        trigger_conditions: wfOut.trigger_conditions ?? {},
        created_by_user_id: user.id,
      };
      const { data: created, error: insWfErr } = await supabaseAdmin
        .from('dunning_workflows').insert(insertWf)
        .select('id, name, description, is_active, priority, trigger_conditions, created_by_user_id, created_at, updated_at')
        .single();
      if (insWfErr) throw new Error('insert workflow: ' + insWfErr.message);
      workflowRow = created;

      if (normalizedSteps.length) {
        const insertRows = normalizedSteps.map(s => ({
          workflow_id: created.id,
          step_order:  s.step_order,
          step_type:   s.step_type,
          config:      s.config,
        }));
        const { error: insStepErr } = await supabaseAdmin
          .from('dunning_workflow_steps').insert(insertRows);
        if (insStepErr) {
          console.error('[finance-dunning-workflows-upsert] steps insert na workflow-create faalde:', insStepErr.message);
          throw new Error('insert steps: ' + insStepErr.message);
        }
      }
    }

    // Lees finale steps terug voor consistente response.
    const { data: finalSteps, error: finalErr } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, step_order, step_type, config, created_at')
      .eq('workflow_id', workflowRow.id)
      .order('step_order', { ascending: true });
    if (finalErr) throw new Error('readback steps: ' + finalErr.message);

    const action = isUpdate ? 'finance_dunning_workflow.update' : 'finance_dunning_workflow.create';
    await auditLog(user.id, action, workflowRow.id, {
      name: workflowRow.name, step_count: (finalSteps || []).length,
    }, req).catch(() => {});

    return res.status(isUpdate ? 200 : 201).json({ workflow: workflowRow, steps: finalSteps || [] });
  } catch (e) {
    console.error('[finance-dunning-workflows-upsert]', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function auditLog(userId, action, entityId, after, req) {
  try {
    await supabaseAdmin.from('audit_log').insert({
      user_id: userId, action, entity_type: 'dunning_workflow', entity_id: entityId,
      after_json: after, ip_address: getClientIp(req),
    });
  } catch (e) { console.error('[dunning-workflow audit]', e.message); }
}
