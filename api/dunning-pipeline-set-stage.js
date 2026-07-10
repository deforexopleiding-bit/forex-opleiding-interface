// api/dunning-pipeline-set-stage.js
// POST { customer_id, stage_slug, reason? } → handmatige fase-wijziging.
// byUser = user.id → mag ook terminale fases in/uit (setStage terminal-
// guard geldt alleen voor auto-callers).
// Permission: finance.dunning.execute. Audit-log.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getClientIp } from './_lib/audit-customer.js';
import { ensurePipelineCustomer, setStage } from './_lib/dunning-pipeline.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  const cid = body?.customer_id ? String(body.customer_id).trim() : null;
  const to  = body?.stage_slug  ? String(body.stage_slug).trim().toLowerCase() : null;
  const reason = body?.reason ? String(body.reason).trim() : null;
  if (!cid || !UUID_RE.test(cid)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  if (!to) return res.status(400).json({ error: 'stage_slug vereist' });

  try {
    // Zorg dat er een pipeline-record bestaat (handmatige move kan een
    // klant introduceren die de auto-triggers gemist hebben).
    await ensurePipelineCustomer(cid);
    const result = await setStage(cid, to, reason || 'manual', user.id);
    if (!result.ok) return res.status(400).json({ error: result.reason || 'setStage_fail' });

    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id    : user.id,
        action     : 'dunning_pipeline.set_stage',
        entity_type: 'customer',
        entity_id  : cid,
        after_json : { from: result.from || null, to, reason: reason || null },
        reason_text: `Fase gezet op '${to}' (${result.from ? 'was ' + result.from : 'nieuw record'})${reason ? ' — ' + reason : ''}`,
        ip_address : getClientIp(req),
      });
    } catch (e) { console.warn('[dunning-pipeline-set-stage] audit soft-fail', e?.message || e); }

    return res.status(200).json({ ok: true, from: result.from || null, to, skipped: result.skipped || null, unchanged: result.unchanged || false });
  } catch (e) {
    console.error('[dunning-pipeline-set-stage]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
