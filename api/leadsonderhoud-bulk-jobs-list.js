// api/leadsonderhoud-bulk-jobs-list.js
// GET → laatste 50 bulk-jobs (alle statussen). Gate: leads.view.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.view'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.view)' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('leadsonderhoud_bulk_jobs')
      .select('id, channel, template_name, status, total_recipients, skipped_count, sent_count, failed_count, test_sent_at, created_at, approved_at, completed_at, cancelled_at')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) {
      if (/does not exist|relation.*bulk/i.test(error.message)) {
        return res.status(200).json({ jobs: [], schema_missing: true });
      }
      throw error;
    }
    return res.status(200).json({ jobs: data || [] });
  } catch (e) {
    console.error('[ls-bulk-jobs-list] fout:', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Jobs laden mislukt' });
  }
}
