// api/cron-activity-log-cleanup.js
//
// Dagelijkse cron — verwijdert activity_log-rijen ouder dan 90 dagen
// EN rate_limit_hits-rijen ouder dan 1 dag (H3 security).
//
// Auth: checkCronAuth (Authorization: Bearer $CRON_SECRET).
// Methodes: GET (Vercel cron) + POST (debug).
// Schedule: dagelijks 04:00 UTC (zie vercel.json).
//
// Idempotent: elke run pakt alleen rijen ouder dan cutoff. Als er niets
// te verwijderen is, doet 'ie niks.
//
// Response: { ok, activity_log:{cutoff,deleted}, rate_limit_hits:{cutoff,deleted}, error? }.

import { checkCronAuth, supabaseAdmin } from './supabase.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS     = 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const result = { ok: true };

  // ── 1) activity_log — 90 dagen retentie ────────────────────────────────
  try {
    const cutoffIso = new Date(Date.now() - NINETY_DAYS_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from('activity_log')
      .delete()
      .lt('created_at', cutoffIso)
      .select('id');
    if (error) {
      console.error('[cron-activity-log-cleanup] activity_log', error.message);
      result.ok = false;
      result.activity_log = { cutoff: cutoffIso, deleted: 0, error: error.message };
    } else {
      const deleted = (data || []).length;
      console.log('[cron-activity-log-cleanup] activity_log deleted', deleted, 'rows older than', cutoffIso);
      result.activity_log = { cutoff: cutoffIso, deleted };
    }
  } catch (e) {
    console.error('[cron-activity-log-cleanup] activity_log exception', e?.message || e);
    result.ok = false;
    result.activity_log = { error: e?.message || 'exception' };
  }

  // ── 2) rate_limit_hits — 1 dag retentie ────────────────────────────────
  //     Vensters in de rate-limiter zijn <= 60s; alles > 1 dag is pure ballast.
  try {
    const cutoffIso = new Date(Date.now() - ONE_DAY_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from('rate_limit_hits')
      .delete()
      .lt('created_at', cutoffIso)
      .select('id');
    if (error) {
      console.error('[cron-activity-log-cleanup] rate_limit_hits', error.message);
      result.ok = false;
      result.rate_limit_hits = { cutoff: cutoffIso, deleted: 0, error: error.message };
    } else {
      const deleted = (data || []).length;
      console.log('[cron-activity-log-cleanup] rate_limit_hits deleted', deleted, 'rows older than', cutoffIso);
      result.rate_limit_hits = { cutoff: cutoffIso, deleted };
    }
  } catch (e) {
    console.error('[cron-activity-log-cleanup] rate_limit_hits exception', e?.message || e);
    result.ok = false;
    result.rate_limit_hits = { error: e?.message || 'exception' };
  }

  return res.status(result.ok ? 200 : 500).json(result);
}
