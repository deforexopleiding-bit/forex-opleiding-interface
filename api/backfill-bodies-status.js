import { supabaseAdmin as supabase, verifyAdmin } from './supabase.js';

const MAILBOXES = ['leads', 'info', 'partners', 'administratie'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  // ── Haal progress-rijen op ────────────────────────────────────────────────
  const { data: progressRows, error: progErr } = await supabase
    .from('backfill_body_progress')
    .select('*')
    .order('mailbox');

  if (progErr) {
    console.error('[backfill-bodies-status] progress query fout:', progErr.message);
    return res.status(500).json({ error: progErr.message });
  }

  // ── Tel live: hoeveel mails hebben nog geen body? ─────────────────────────
  const liveCounts = {};
  for (const mailbox of MAILBOXES) {
    const { count } = await supabase
      .from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('mailbox', mailbox)
      .is('body_fetched_at', null)
      .is('body_fetch_error', null);
    liveCounts[mailbox] = count ?? 0;
  }

  // ── Totalen ───────────────────────────────────────────────────────────────
  const progress = progressRows || [];
  const totalFetched = progress.reduce((s, r) => s + (r.bodies_fetched || 0), 0);
  const totalFailed  = progress.reduce((s, r) => s + (r.bodies_failed  || 0), 0);
  const totalPending = Object.values(liveCounts).reduce((s, c) => s + c, 0);

  return res.status(200).json({
    ok:            true,
    total_fetched: totalFetched,
    total_failed:  totalFailed,
    total_pending: totalPending,
    progress: progress.map(r => ({
      mailbox:           r.mailbox,
      status:            r.status,
      bodies_fetched:    r.bodies_fetched,
      bodies_failed:     r.bodies_failed,
      pending_live:      liveCounts[r.mailbox] ?? 0,
      last_batch_at:     r.last_batch_at,
      completed_at:      r.completed_at,
      last_error:        r.last_error || null,
    })),
    live_pending_per_mailbox: liveCounts,
  });
}
