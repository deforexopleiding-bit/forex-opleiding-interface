// api/wanbetalers-bulk-jobs-list.js
// GET → recente bulk-jobs (voor Bulk-historie in de UI).
// Permission: finance.dunning.execute.
//
// Query: limit? (default 50, max 200), status? (CSV filter).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const VALID_STATUS = ['draft', 'approved', 'running', 'completed', 'cancelled'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const limit = Math.min(Math.max(Number(req.query?.limit) || 50, 1), 200);
  const statusCsv = req.query?.status ? String(req.query.status).split(',').map((s) => s.trim().toLowerCase()).filter((s) => VALID_STATUS.includes(s)) : [];

  try {
    let q = supabaseAdmin
      .from('dunning_bulk_jobs')
      .select('id, channel, template_name, status, total_recipients, sent_count, failed_count, skipped_count, created_at, approved_at, completed_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (statusCsv.length === 1) q = q.eq('status', statusCsv[0]);
    else if (statusCsv.length > 1) q = q.in('status', statusCsv);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return res.status(200).json({ items: data || [] });
  } catch (e) {
    console.error('[wanbetalers-bulk-jobs-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
