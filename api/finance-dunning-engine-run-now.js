// api/finance-dunning-engine-run-now.js
// Handmatige trigger voor de dunning-engine vanuit de UI (Wanbetalers-tab,
// knop "Nu uitvoeren"). Zelfde engine als de cron, maar geauthenticeerd via
// Bearer JWT + RBAC permission-check i.p.v. CRON_SECRET.
//
// Permission: finance.dunning.execute (manager/admin/super_admin).
// Methode: POST only.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { runEngine } from './_lib/dunning-engine.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1) Auth: geldige Bearer-JWT vereist.
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // 2) RBAC: finance.dunning.execute.
  const allowed = await requirePermission(req, 'finance.dunning.execute');
  if (!allowed) {
    return res.status(403).json({
      error: 'Insufficient permissions',
      feature: 'finance.dunning.execute',
    });
  }

  // 3) Run engine.
  try {
    const result = await runEngine({ mode: 'manual' });
    console.log('[finance-dunning-engine-run-now]', user.id, JSON.stringify(result));
    return res.status(200).json(result);
  } catch (e) {
    console.error('[finance-dunning-engine-run-now] fatal', e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
