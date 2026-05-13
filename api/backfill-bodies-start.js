import { supabase } from './supabase.js';

const MAILBOXES = ['leads', 'info', 'partners', 'administratie'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'POST of GET vereist' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader  = req.headers.authorization || '';
    const querySecret = req.query?.secret         || '';
    if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
      return res.status(401).json({ error: 'Unauthorized — CRON_SECRET vereist' });
    }
  }

  const results = [];

  for (const mailbox of MAILBOXES) {
    // Tel hoeveel mails body-fetch nog missen voor deze mailbox
    const { count, error: cntErr } = await supabase
      .from('email_messages')
      .select('id', { count: 'exact', head: true })
      .eq('mailbox', mailbox)
      .is('body_fetched_at', null)
      .is('body_fetch_error', null);

    if (cntErr) {
      console.error(`[backfill-bodies-start] count fout voor ${mailbox}:`, cntErr.message);
      results.push({ mailbox, error: cntErr.message });
      continue;
    }

    const pending_count = count ?? 0;

    // Upsert progress-rij (idempotent — reset naar pending bij herstart)
    const { error: upsertErr } = await supabase
      .from('backfill_body_progress')
      .upsert({
        mailbox,
        status:        'pending',
        bodies_fetched: 0,
        bodies_failed:  0,
        last_batch_at:  null,
        completed_at:   null,
        error_count:    0,
        last_error:     null,
        last_error_at:  null,
      }, { onConflict: 'mailbox' });

    if (upsertErr) {
      console.error(`[backfill-bodies-start] upsert fout voor ${mailbox}:`, upsertErr.message);
      results.push({ mailbox, error: upsertErr.message });
      continue;
    }

    console.log(`[backfill-bodies-start] ${mailbox}: ${pending_count} bodies te ophalen`);
    results.push({ mailbox, pending_count });
  }

  const total = results.reduce((s, r) => s + (r.pending_count || 0), 0);
  console.log(`[backfill-bodies-start] Init klaar: ${total} bodies totaal te ophalen`);

  return res.status(200).json({
    ok:     true,
    total_pending: total,
    mailboxes: results,
  });
}
