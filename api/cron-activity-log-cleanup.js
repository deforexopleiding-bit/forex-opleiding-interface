// api/cron-activity-log-cleanup.js
//
// Dagelijkse cron — verwijdert activity_log-rijen ouder dan 90 dagen.
// Doel: log-tabel klein houden (retentie-window Jeffrey: 90d).
//
// Auth: checkCronAuth (Authorization: Bearer $CRON_SECRET).
// Methodes: GET (Vercel cron) + POST (debug).
// Schedule: dagelijks 04:00 UTC (zie vercel.json).
//
// Idempotent: elke run pakt alleen rijen ouder dan cutoff. Als er niets
// te verwijderen is, doet 'ie niks.
//
// Response: { ok, cutoff, deleted, error? }.

import { checkCronAuth, supabaseAdmin } from './supabase.js';

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  try {
    const cutoffIso = new Date(Date.now() - NINETY_DAYS_MS).toISOString();

    // Delete met .select('id') om het aantal verwijderde rijen te tellen.
    const { data, error } = await supabaseAdmin
      .from('activity_log')
      .delete()
      .lt('created_at', cutoffIso)
      .select('id');
    if (error) {
      console.error('[cron-activity-log-cleanup]', error.message);
      return res.status(500).json({ ok: false, cutoff: cutoffIso, error: error.message });
    }

    const deleted = (data || []).length;
    console.log('[cron-activity-log-cleanup] deleted', deleted, 'rows older than', cutoffIso);
    return res.status(200).json({ ok: true, cutoff: cutoffIso, deleted });
  } catch (e) {
    console.error('[cron-activity-log-cleanup] exception', e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || 'Interne fout' });
  }
}
