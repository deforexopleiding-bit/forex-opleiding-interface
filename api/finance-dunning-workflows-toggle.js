// api/finance-dunning-workflows-toggle.js
// PATCH ?id=<uuid> body: { is_active: true|false }
// Permission: finance.dunning.config.
//
// Quick-toggle endpoint dat alleen is_active flipt zonder dat de UI de volledige
// workflow + steps moet meesturen. Updated_at wordt expliciet gezet.
//
// Response: { item: updated_row }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'PATCH only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.config'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.config)' });
  }

  const body = req.body || {};
  const id = req.query?.id || body.id || null;
  if (!id) return res.status(400).json({ error: 'id vereist (?id=<uuid> of body.id)' });

  if (body.is_active === undefined) {
    return res.status(400).json({ error: 'is_active vereist (boolean)' });
  }
  const isActive = body.is_active === true || body.is_active === 'true';

  try {
    const { data: existing, error: lookupErr } = await supabaseAdmin
      .from('dunning_workflows').select('id, name').eq('id', id).maybeSingle();
    if (lookupErr) throw new Error('lookup: ' + lookupErr.message);
    if (!existing) return res.status(404).json({ error: 'Workflow niet gevonden' });

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('dunning_workflows')
      .update({ is_active: isActive, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, name, description, is_active, priority, trigger_conditions, created_by_user_id, created_at, updated_at')
      .single();
    if (updErr) throw new Error('update: ' + updErr.message);

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id:     user.id,
        action:      'finance_dunning_workflow.toggle',
        entity_type: 'dunning_workflow',
        entity_id:   id,
        after_json:  { is_active: isActive },
        ip_address:  getClientIp(req),
      });
    } catch (e) { console.error('[dunning-workflow audit]', e.message); }

    return res.status(200).json({ item: updated });
  } catch (e) {
    console.error('[finance-dunning-workflows-toggle]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
