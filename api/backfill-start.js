import { ImapFlow } from 'imapflow';
import { supabase } from './supabase.js';

const ACCOUNTS = [
  { mailbox: 'leads',         user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { mailbox: 'info',          user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { mailbox: 'partners',      user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { mailbox: 'administratie', user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
];

const BACKFILL_START_DATE = new Date('2026-01-01T00:00:00.000Z');
const MAILS_PER_RUN       = 50;  // conservatieve schatting per batch
const RUNS_PER_HOUR       = 12;  // elke 5 minuten

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST niet geconfigureerd' });

  const port    = parseInt(IMAP_PORT || '993', 10);
  const results = [];
  let totalToProcess = 0;

  for (const account of ACCOUNTS) {
    console.log(`[backfill-start] Initializing mailbox: ${account.mailbox}`);

    const pass = process.env[account.passEnv];
    if (!pass) {
      results.push({ mailbox: account.mailbox, status: 'skipped', reason: 'geen wachtwoord' });
      continue;
    }

    // ── Idempotent: al geïnitialiseerd? Return bestaande state ───────────
    const { data: existing, error: checkErr } = await supabase
      .from('backfill_progress')
      .select('*')
      .eq('mailbox', account.mailbox)
      .maybeSingle();

    if (checkErr) {
      console.error(`[backfill-start] check fout voor ${account.mailbox}:`, checkErr.message);
      results.push({ mailbox: account.mailbox, error: checkErr.message });
      continue;
    }

    if (existing) {
      const remaining = Math.max(0, (existing.mails_total_estimated || 0) - (existing.mails_processed || 0));
      totalToProcess += remaining;
      results.push({
        mailbox:               account.mailbox,
        already_initialized:   true,
        status:                existing.status,
        mails_processed:       existing.mails_processed,
        mails_total_estimated: existing.mails_total_estimated,
        mails_remaining:       remaining,
      });
      console.log(`[backfill-start] ${account.mailbox}: already initialized, status=${existing.status}, remaining=${remaining}`);
      continue;
    }

    // ── IMAP: scan UIDs since 2026-01-01 ─────────────────────────────────
    const client = new ImapFlow({
      host:          IMAP_HOST,
      port,
      secure:        true,
      auth:          { user: account.user, pass },
      logger:        false,
      socketTimeout: 25_000,
    });

    try {
      await client.connect();

      let uids = [];
      const lock = await client.getMailboxLock('INBOX');
      try {
        uids = await client.search({ since: BACKFILL_START_DATE }, { uid: true });
        uids.sort((a, b) => a - b);
      } finally {
        lock.release();
      }

      console.log(`[backfill-start] ${account.mailbox}: ${uids.length} UIDs gevonden since 2026-01-01`);

      if (uids.length === 0) {
        results.push({ mailbox: account.mailbox, mails_to_process: 0, already_initialized: false });
        continue;
      }

      const oldestUid = uids[0];
      const newestUid = uids[uids.length - 1];
      const total     = uids.length;

      const { error: insertErr } = await supabase.from('backfill_progress').insert({
        mailbox:               account.mailbox,
        start_date:            BACKFILL_START_DATE.toISOString(),
        status:                'pending',
        total_uids:            total,
        oldest_uid:            oldestUid,
        newest_uid:            newestUid,
        mails_total_estimated: total,
        mails_processed:       0,
        mails_skipped:         0,
        mails_failed:          0,
        error_count:           0,
      });

      if (insertErr) {
        console.error(`[backfill-start] insert fout ${account.mailbox}:`, insertErr.message);
        results.push({ mailbox: account.mailbox, error: insertErr.message });
        continue;
      }

      totalToProcess += total;
      results.push({
        mailbox:             account.mailbox,
        already_initialized: false,
        mails_to_process:    total,
        oldest_uid:          oldestUid,
        newest_uid:          newestUid,
      });
      console.log(`[backfill-start] ${account.mailbox}: initialized — ${total} mails (UID ${oldestUid}–${newestUid})`);

    } catch (err) {
      console.error(`[backfill-start] ${account.mailbox} fout:`, err.message);
      results.push({ mailbox: account.mailbox, error: err.message });
    } finally {
      try { await client.logout(); } catch {}
    }
  }

  const estimatedRuns  = Math.ceil(totalToProcess / MAILS_PER_RUN);
  const estimatedHours = Math.round((estimatedRuns / RUNS_PER_HOUR) * 10) / 10;

  return res.status(200).json({
    ok:                       true,
    mailboxes:                results,
    total_to_process:         totalToProcess,
    estimated_runs:           estimatedRuns,
    estimated_duration_hours: estimatedHours,
  });
}
