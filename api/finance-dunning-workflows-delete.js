// api/finance-dunning-workflows-delete.js
// DELETE ?id=<uuid> -> verwijder een dunning_workflow.
// Permission: finance.dunning.config.
//
// Schema-context:
//   - dunning_workflow_steps FK -> workflows ON DELETE CASCADE (steps gaan automatisch mee).
//   - dunning_workflow_runs  FK -> workflows ON DELETE RESTRICT (moeten apart geruimd).
//
// Flow:
//   1. Tel actieve runs (status='active'). Bij > 0 -> 409 met active_run_count.
//   2. Verwijder afgeronde / geannuleerde runs zodat de RESTRICT FK niet tegenhoudt.
//   3. DELETE workflow (steps cascaden mee).
//   4. Audit log (fail-soft).

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
    // 1. Bestaat de workflow?
    const { data: wf, error: wfErr } = await supabaseAdmin
      .from('dunning_workflows').select('id, name').eq('id', id).maybeSingle();
    if (wfErr) throw new Error('lookup: ' + wfErr.message);
    if (!wf) return res.status(404).json({ error: 'Workflow niet gevonden' });

    // 2. Active-runs pre-check. Supabase-js geeft via head+count exacte tellers terug.
    const { count: activeRunCount, error: countErr } = await supabaseAdmin
      .from('dunning_workflow_runs')
      .select('id', { count: 'exact', head: true })
      .eq('workflow_id', id)
      .eq('status', 'active');
    if (countErr) {
      console.error('[finance-dunning-workflows-delete] active-run count fout:', countErr.message);
      return res.status(500).json({ error: 'active-run check fout: ' + countErr.message });
    }
    if ((activeRunCount || 0) > 0) {
      return res.status(409).json({
        error: `Workflow heeft ${activeRunCount} actieve run(s); pauzeer of voltooi deze eerst`,
        active_run_count: activeRunCount,
      });
    }

    // 3. Niet-actieve runs opruimen zodat ON DELETE RESTRICT niet trippt. Falen
    //    is hier 500; we willen geen orphaned runs achterlaten.
    const { error: runDelErr } = await supabaseAdmin
      .from('dunning_workflow_runs').delete()
      .eq('workflow_id', id)
      .in('status', ['completed', 'cancelled', 'paused']);
    if (runDelErr) {
      console.error('[finance-dunning-workflows-delete] niet-actieve runs delete fout:', runDelErr.message);
      return res.status(500).json({ error: 'opruimen oude runs: ' + runDelErr.message });
    }

    // 4. DELETE workflow (steps cascaden via FK).
    const { error: delErr } = await supabaseAdmin
      .from('dunning_workflows').delete().eq('id', id);
    if (delErr) {
      // FK violation -> 409 (er kunnen nog steeds runs zitten die we niet voorzien hadden).
      if (String(delErr.message || '').toLowerCase().includes('foreign key')) {
        return res.status(409).json({
          error: 'Workflow kan niet verwijderd worden vanwege bestaande referenties',
          db_error: delErr.message,
        });
      }
      throw new Error('delete: ' + delErr.message);
    }

    // 5. Audit-log (fail-soft).
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'finance_dunning_workflow.delete',
        entity_type: 'dunning_workflow',
        entity_id:   id,
        after_json:  { name: wf.name },
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[dunning-workflow audit]', e.message); }

    return res.status(200).json({ success: true, id });
  } catch (e) {
    console.error('[finance-dunning-workflows-delete]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
