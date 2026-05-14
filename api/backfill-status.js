import { supabaseAdmin as supabase, verifyAdmin } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Cache-Control', 'no-store');

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });

  try {
    // ── Backfill voortgang per mailbox ────────────────────────────────────
    const { data: progressRows, error: progressErr } = await supabase
      .from('backfill_progress')
      .select('*')
      .order('mailbox');

    if (progressErr) throw new Error('backfill_progress ophalen mislukt: ' + progressErr.message);

    // ── Totaal in email_messages (live sync + backfill samen) ─────────────
    const { count: totalMessages, error: countErr } = await supabase
      .from('email_messages')
      .select('*', { count: 'exact', head: true });

    if (countErr) console.warn('[backfill-status] email_messages count fout:', countErr.message);

    // ── Per-mailbox statistieken ──────────────────────────────────────────
    const mailboxStats = (progressRows || []).map(p => {
      const processed  = parseInt(p.mails_processed)        || 0;
      const total      = parseInt(p.mails_total_estimated)   || 0;
      const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

      // Snelheidsschatting op basis van verstreken tijd
      let estimatedRemainingMinutes = null;
      if (p.started_at && p.last_batch_at && total > 0 && processed > 0) {
        const remaining  = total - processed;
        const startMs    = new Date(p.started_at).getTime();
        const lastMs     = new Date(p.last_batch_at).getTime();
        const elapsedMin = (lastMs - startMs) / (1000 * 60);
        const speed      = elapsedMin > 0 ? processed / elapsedMin : null; // mails/min
        estimatedRemainingMinutes = speed ? Math.round(remaining / speed) : null;
      }

      return {
        mailbox:                     p.mailbox,
        status:                      p.status,
        progress: {
          processed,
          total,
          percentage,
        },
        last_processed_uid:          p.last_processed_uid,
        oldest_uid:                  p.oldest_uid,
        newest_uid:                  p.newest_uid,
        started_at:                  p.started_at,
        last_batch_at:               p.last_batch_at,
        completed_at:                p.completed_at,
        estimated_remaining_minutes: estimatedRemainingMinutes,
        errors: {
          count:         parseInt(p.error_count)  || 0,
          last_error:    p.last_error              || null,
          last_error_at: p.last_error_at           || null,
        },
      };
    });

    // ── Aggregaten ────────────────────────────────────────────────────────
    const totalProcessed = mailboxStats.reduce((s, m) => s + m.progress.processed, 0);
    const totalEstimated = mailboxStats.reduce((s, m) => s + m.progress.total, 0);
    const overallPct     = totalEstimated > 0 ? Math.round((totalProcessed / totalEstimated) * 100) : 0;
    const completedCount = mailboxStats.filter(m => m.status === 'completed').length;
    const allDone        = mailboxStats.length > 0 && completedCount === mailboxStats.length;

    // Schatting "wanneer klaar" op basis van de traagste mailbox
    const maxRemainingMin = mailboxStats.reduce((max, m) => Math.max(max, m.estimated_remaining_minutes || 0), 0);
    const estimatedDoneAt = maxRemainingMin > 0
      ? new Date(Date.now() + maxRemainingMin * 60 * 1000).toISOString()
      : null;

    return res.status(200).json({
      ok:       true,
      all_done: allDone,
      overall: {
        processed:           totalProcessed,
        estimated:           totalEstimated,
        percentage:          overallPct,
        completed_mailboxes: completedCount,
        total_mailboxes:     mailboxStats.length,
      },
      total_in_email_messages: totalMessages || 0,
      estimated_done_at:       estimatedDoneAt,
      mailboxes:               mailboxStats,
    });

  } catch (err) {
    console.error('[backfill-status]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
