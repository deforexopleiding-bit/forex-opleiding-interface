// api/finance-dunning-templates-delete.js
// DELETE ?id=<uuid> → verwijder een dunning_template.
// Permission: finance.dunning.config.
//
// Pre-check: scan dunning_workflow_steps voor referenties via
// config->>'template_id'. Bij gebruik: 409 Conflict + lijst betrokken steps.
// Anders: DELETE. Geen cascade — workflows blijven intact, alleen template-row
// gaat weg.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'DELETE only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.config'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.config)' });
  }

  const id = req.query?.id || null;
  if (!id) return res.status(400).json({ error: 'id query-param vereist' });

  try {
    // 1. Bestaat de template?
    const { data: tpl } = await supabaseAdmin
      .from('dunning_templates').select('id, name, kind').eq('id', id).maybeSingle();
    if (!tpl) return res.status(404).json({ error: 'Template niet gevonden' });

    // 2. In-use-check tegen workflow_steps. config is jsonb → vergelijk op
    //    config->>'template_id' (text-cast). Bij grote workflow-sets: indexen
    //    op (workflow_id, step_order) zijn er; jsonb-text-vergelijking is een
    //    seq-scan maar workflow_steps zal klein zijn (≤ honderden rows totaal).
    const { data: uses, error: useErr } = await supabaseAdmin
      .from('dunning_workflow_steps')
      .select('id, workflow_id, step_order, step_type, config')
      .or(`config->>template_id.eq.${id}`);
    if (useErr) {
      // Defensief: bij select-fout liever 500 dan onbedoeld DELETEn.
      console.error('[dunning-template-delete] in-use check fout:', useErr.message);
      return res.status(500).json({ error: 'in-use check fout: ' + useErr.message });
    }
    if (uses && uses.length) {
      const refs = uses.map(s => ({
        step_id:     s.id,
        workflow_id: s.workflow_id,
        step_order:  s.step_order,
        step_type:   s.step_type,
      }));
      return res.status(409).json({
        error: `Template wordt gebruikt door ${uses.length} workflow-stap(pen)`,
        used_by: refs,
      });
    }

    // 3. DELETE.
    const { error: delErr } = await supabaseAdmin
      .from('dunning_templates').delete().eq('id', id);
    if (delErr) throw new Error('delete: ' + delErr.message);

    // 4. Audit-log (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'finance_dunning_template.delete',
        entity_type: 'dunning_template',
        entity_id:   id,
        after_json:  { name: tpl.name, kind: tpl.kind },
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[dunning-template audit]', e.message); }

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('[finance-dunning-templates-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
