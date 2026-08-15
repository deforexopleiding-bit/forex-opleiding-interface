// api/sanne-stats.js
// GET ?days=7 -> tellers voor Sanne's prestaties-tab (default 7 dagen).
//
// Response:
//   {
//     window_days: 7,
//     suggestions: { by_status: {...}, by_mailbox: {...}, total: N },
//     skips: { by_reason: {...}, by_mailbox: {...}, total: N },
//     recent: [ ...laatste 20 suggestions... ]
//   }
//
// Permission: admin.joost_config (voor volledige stats) — dezelfde als config-UI.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'admin.joost_config'))) {
    return res.status(403).json({ error: 'Geen rechten (admin.joost_config)' });
  }

  const days = Math.max(1, Math.min(90, Number(req.query?.days || 7)));
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString();

  try {
    const [sugRes, skipRes, recentRes] = await Promise.all([
      supabaseAdmin.from('sanne_suggestions').select('status, mailbox').gte('created_at', cutoff),
      supabaseAdmin.from('sanne_skip_log').select('skip_reason, mailbox').gte('skipped_at', cutoff),
      supabaseAdmin.from('sanne_suggestions')
        .select('id, mailbox, detected_intent, confidence, status, created_at, outcome_at')
        .order('created_at', { ascending: false }).limit(20),
    ]);

    if (sugRes.error) throw sugRes.error;
    if (skipRes.error) throw skipRes.error;
    if (recentRes.error) throw recentRes.error;

    const suggByStatus = {}, suggByMailbox = {};
    for (const r of (sugRes.data || [])) {
      suggByStatus[r.status || 'UNKNOWN'] = (suggByStatus[r.status || 'UNKNOWN'] || 0) + 1;
      suggByMailbox[r.mailbox || '?']    = (suggByMailbox[r.mailbox || '?']    || 0) + 1;
    }
    const skipByReason = {}, skipByMailbox = {};
    for (const r of (skipRes.data || [])) {
      skipByReason[r.skip_reason || 'unknown'] = (skipByReason[r.skip_reason || 'unknown'] || 0) + 1;
      skipByMailbox[r.mailbox || '?']          = (skipByMailbox[r.mailbox || '?']          || 0) + 1;
    }

    return res.status(200).json({
      window_days: days,
      suggestions: {
        total: (sugRes.data || []).length,
        by_status: suggByStatus,
        by_mailbox: suggByMailbox,
      },
      skips: {
        total: (skipRes.data || []).length,
        by_reason: skipByReason,
        by_mailbox: skipByMailbox,
      },
      recent: recentRes.data || [],
    });
  } catch (e) {
    console.error('[sanne-stats]', e?.message);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
