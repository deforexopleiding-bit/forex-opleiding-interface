// api/dunning-pipeline-add-log.js
// POST { customer_id, body } → notitie toevoegen (entry_type='note').
// Permission: finance.dunning.execute.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { ensurePipelineCustomer, addLogEntry } from './_lib/dunning-pipeline.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 4000;

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
  const text = body?.body ? String(body.body).trim().slice(0, MAX_BODY) : '';
  if (!cid || !UUID_RE.test(cid)) return res.status(400).json({ error: 'customer_id (uuid) vereist' });
  if (!text) return res.status(400).json({ error: 'body (tekst) vereist' });

  try {
    await ensurePipelineCustomer(cid);
    const r = await addLogEntry(cid, 'note', text, null, user.id);
    if (!r.ok) return res.status(500).json({ error: r.reason || 'insert_fail' });

    // Bump last_activity_at zodat de klant boven in de lijst komt.
    try {
      await supabaseAdmin
        .from('dunning_pipeline_customers')
        .update({ last_activity_at: new Date().toISOString() })
        .eq('customer_id', cid);
    } catch (_) { /* soft */ }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[dunning-pipeline-add-log]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
