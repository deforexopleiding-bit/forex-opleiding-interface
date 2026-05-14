import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabaseAdmin as supabase, checkCronAuth } from './supabase.js';

const ACCOUNTS = [
  { mailbox: 'leads',         user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { mailbox: 'info',          user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { mailbox: 'partners',      user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { mailbox: 'administratie', user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
];

const BATCH_SIZE = 20;    // Mails per run — simpleParser is CPU-intensief
const MAX_RUN_MS = 50_000; // Abort vóór Vercel's 60s hard timeout
const BODY_LIMIT  = 100_000; // 100KB per body-veld

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── Authenticatie: CRON_SECRET verplicht ─────────────────────────────────
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST niet geconfigureerd' });

  const port     = parseInt(IMAP_PORT || '993', 10);
  const runStart = Date.now();

  // ── Kies de mailbox met oudste last_batch_at (nulls first) ────────────────
  const { data: progressRows, error: selErr } = await supabase
    .from('backfill_body_progress')
    .select('*')
    .in('status', ['pending', 'in_progress', 'failed'])
    .order('last_batch_at', { ascending: true, nullsFirst: true })
    .limit(1);

  if (selErr) {
    console.error('[backfill-bodies] progress query fout:', selErr.message);
    return res.status(500).json({ error: selErr.message });
  }

  if (!progressRows?.length) {
    console.log('[backfill-bodies] Geen mailboxen meer te verwerken — backfill volledig klaar');
    return res.status(200).json({ ok: true, all_done: true });
  }

  const progress = progressRows[0];
  const account  = ACCOUNTS.find(a => a.mailbox === progress.mailbox);

  if (!account || !process.env[account.passEnv]) {
    console.error(`[backfill-bodies] Account niet geconfigureerd: ${progress.mailbox}`);
    return res.status(500).json({ error: `Account ${progress.mailbox} niet geconfigureerd` });
  }

  // ── Markeer als in_progress ───────────────────────────────────────────────
  const { error: claimErr } = await supabase
    .from('backfill_body_progress')
    .update({ status: 'in_progress', last_batch_at: new Date().toISOString() })
    .eq('id', progress.id);

  if (claimErr) {
    console.error(`[backfill-bodies] claim update fout:`, claimErr.message);
    return res.status(500).json({ error: claimErr.message });
  }

  // ── Haal volgende batch op ────────────────────────────────────────────────
  // Geen cursor nodig: de NULL-status op body_fetched_at/body_fetch_error IS
  // de voortgang. Elke run pakt automatisch de volgende niet-verwerkte mails.
  const { data: batch, error: batchErr } = await supabase
    .from('email_messages')
    .select('id, imap_uid')
    .eq('mailbox', progress.mailbox)
    .is('body_fetched_at', null)
    .is('body_fetch_error', null)
    .order('imap_uid', { ascending: true })
    .limit(BATCH_SIZE);

  if (batchErr) {
    console.error(`[backfill-bodies] batch query fout:`, batchErr.message);
    return res.status(500).json({ error: batchErr.message });
  }

  // Geen mails meer voor deze mailbox → markeer als completed
  if (!batch?.length) {
    try {
      await supabase
        .from('backfill_body_progress')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', progress.id);
    } catch (e) {
      console.error('[backfill-bodies] completed update threw:', e.message);
    }
    console.log(`[backfill-bodies] ${progress.mailbox}: volledig verwerkt`);
    return res.status(200).json({ ok: true, mailbox: progress.mailbox, status: 'completed', batch_done: 0 });
  }

  console.log(`[backfill-bodies] Start batch ${progress.mailbox}: ${batch.length} mails zonder body`);

  // ── IMAP verbinding ───────────────────────────────────────────────────────
  const client = new ImapFlow({
    host:          IMAP_HOST,
    port,
    secure:        true,
    auth:          { user: account.user, pass: process.env[account.passEnv] },
    logger:        false,
    socketTimeout: 20_000,
  });

  let batchFetched = 0;
  let batchFailed  = 0;
  let timerAborted = false;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const row of batch) {
        // Timer abort
        if (Date.now() - runStart > MAX_RUN_MS) {
          timerAborted = true;
          console.log(`[backfill-bodies] Timer abort ${progress.mailbox} bij id=${row.id} na ${Math.round((Date.now() - runStart) / 1000)}s`);
          break;
        }

        try {
          const bodyMsg = await client.fetchOne(row.imap_uid, { source: true }, { uid: true });
          if (!bodyMsg?.source) {
            // Geen source — sla body_fetch_error op
            await supabase.from('email_messages').update({
              body_fetch_error: 'Geen source teruggegeven door IMAP',
            }).eq('id', row.id);
            batchFailed++;
          } else {
            const parsed  = await simpleParser(bodyMsg.source, { skipImageLinks: true });
            const rawText = parsed.text || '';
            const rawHtml = parsed.html || '';

            const { error: updateErr } = await supabase
              .from('email_messages')
              .update({
                body_text:       rawText.slice(0, BODY_LIMIT) || null,
                body_html:       rawHtml.slice(0, BODY_LIMIT) || null,
                body_fetched_at: new Date().toISOString(),
                body_truncated:  rawText.length > BODY_LIMIT || rawHtml.length > BODY_LIMIT,
                snippet:         rawText.slice(0, 300).trim() || null,
              })
              .eq('id', row.id);

            if (updateErr) {
              console.error(`[backfill-bodies] update fout id=${row.id}:`, updateErr.message);
              batchFailed++;
            } else {
              batchFetched++;
            }
          }
        } catch (rowErr) {
          console.warn(`[backfill-bodies] fout bij uid=${row.imap_uid}:`, rowErr.message);
          try {
            await supabase.from('email_messages').update({
              body_fetch_error: rowErr.message.slice(0, 200),
            }).eq('id', row.id);
          } catch {}
          batchFailed++;
        }

      }
    } finally {
      lock.release();
    }
  } catch (err) {
    // IMAP-verbindingsfout — plan retry
    console.error(`[backfill-bodies] IMAP fout ${progress.mailbox}:`, err.message);
    try {
      await supabase.from('backfill_body_progress').update({
        status:        'failed',
        last_error:    err.message.slice(0, 500),
        last_error_at: new Date().toISOString(),
        error_count:   (parseInt(progress.error_count) || 0) + 1,
        last_batch_at: new Date().toISOString(),
      }).eq('id', progress.id);
    } catch {}
    return res.status(200).json({ ok: false, mailbox: progress.mailbox, error: err.message, will_retry: true });
  } finally {
    try { await client.logout(); } catch {}
  }

  // ── Voortgang bijwerken ───────────────────────────────────────────────────
  const newFetched = (parseInt(progress.bodies_fetched) || 0) + batchFetched;
  const newFailed  = (parseInt(progress.bodies_failed)  || 0) + batchFailed;

  // Check of er nog mails over zijn
  const { count: remaining } = await supabase
    .from('email_messages')
    .select('id', { count: 'exact', head: true })
    .eq('mailbox', progress.mailbox)
    .is('body_fetched_at', null)
    .is('body_fetch_error', null);

  const isComplete = (remaining ?? 0) === 0 && !timerAborted;

  try {
    await supabase.from('backfill_body_progress').update({
      bodies_fetched: newFetched,
      bodies_failed:  newFailed,
      last_batch_at:  new Date().toISOString(),
      status:         isComplete ? 'completed' : 'in_progress',
      ...(isComplete ? { completed_at: new Date().toISOString() } : {}),
    }).eq('id', progress.id);
  } catch (updateErr) {
    console.error(`[backfill-bodies] progress update threw:`, updateErr.message);
  }

  console.log(`[backfill-bodies] ${progress.mailbox} batch klaar: ${batchFetched} fetched, ${batchFailed} failed, remaining=${remaining}${timerAborted ? ' (timer abort)' : ''}`);

  return res.status(200).json({
    ok:              true,
    mailbox:         progress.mailbox,
    batch_fetched:   batchFetched,
    batch_failed:    batchFailed,
    total_fetched:   newFetched,
    remaining:       remaining ?? 'onbekend',
    status:          isComplete ? 'completed' : (timerAborted ? 'timer_aborted_will_resume' : 'in_progress'),
  });
}
