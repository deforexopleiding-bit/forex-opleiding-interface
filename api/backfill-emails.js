import { ImapFlow } from 'imapflow';
import { supabaseAdmin as supabase, checkCronAuth } from './supabase.js';
import { categorize } from './email-agent.js';

const ACCOUNTS = [
  { mailbox: 'leads',         user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { mailbox: 'info',          user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { mailbox: 'partners',      user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { mailbox: 'administratie', user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
];

const BATCH_SIZE = 50;      // Mails per run — conservatief voor categorize() latency
const MAX_RUN_MS = 50_000;  // Abort vóór Vercel's 60s hard timeout

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── Authenticatie: CRON_SECRET verplicht ─────────────────────────────────
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST niet geconfigureerd' });

  const port     = parseInt(IMAP_PORT || '993', 10);
  const runStart = Date.now();

  // ── Kies de volgende mailbox (minst-recent-bewerkt, nulls first) ──────────
  const { data: progressRows, error: selErr } = await supabase
    .from('backfill_progress')
    .select('*')
    .in('status', ['pending', 'in_progress', 'failed'])
    .order('last_batch_at', { ascending: true, nullsFirst: true })
    .order('mails_processed', { ascending: true })
    .limit(1);

  if (selErr) {
    console.error('[backfill-emails] backfill_progress query fout:', selErr.message);
    return res.status(500).json({ error: selErr.message });
  }

  if (!progressRows?.length) {
    console.log('[backfill-emails] Geen mailboxen meer te verwerken — backfill volledig klaar');
    return res.status(200).json({ ok: true, all_done: true });
  }

  const progress = progressRows[0];
  const account  = ACCOUNTS.find(a => a.mailbox === progress.mailbox);

  if (!account || !process.env[account.passEnv]) {
    console.error(`[backfill-emails] Account niet geconfigureerd: ${progress.mailbox}`);
    return res.status(500).json({ error: `Account ${progress.mailbox} niet geconfigureerd` });
  }

  // ── Markeer als 'in_progress' ─────────────────────────────────────────────
  const { error: claimErr } = await supabase
    .from('backfill_progress')
    .update({ status: 'in_progress', last_batch_at: new Date().toISOString() })
    .eq('id', progress.id);

  if (claimErr) {
    console.error(`[backfill-emails] claim update fout ${progress.mailbox}:`, claimErr.message);
    return res.status(500).json({ error: claimErr.message });
  }

  // ── Bepaal UID-range voor deze batch ──────────────────────────────────────
  const newestUid       = parseInt(progress.newest_uid);
  const oldestUid       = parseInt(progress.oldest_uid);
  const lastProcessedUid = progress.last_processed_uid != null
    ? parseInt(progress.last_processed_uid)
    : null;

  const startUid = lastProcessedUid != null ? lastProcessedUid + 1 : oldestUid;

  console.log(`[backfill-emails] Start batch ${progress.mailbox}: uid=${startUid}→${newestUid}, processed=${progress.mails_processed}/${progress.mails_total_estimated}`);

  // Al klaar voor deze mailbox?
  if (startUid > newestUid) {
    try {
      const { error: doneErr } = await supabase
        .from('backfill_progress')
        .update({ status: 'completed', completed_at: new Date().toISOString() })
        .eq('id', progress.id);
      if (doneErr) console.error(`[backfill-emails] completed update fout:`, doneErr.message);
    } catch (e) {
      console.error(`[backfill-emails] completed update threw:`, e.message);
    }
    console.log(`[backfill-emails] ${progress.mailbox}: volledig verwerkt`);
    return res.status(200).json({ ok: true, mailbox: progress.mailbox, status: 'completed', batch_done: 0 });
  }

  // ── IMAP verbinding ───────────────────────────────────────────────────────
  const client = new ImapFlow({
    host:          IMAP_HOST,
    port,
    secure:        true,
    auth:          { user: account.user, pass: process.env[account.passEnv] },
    logger:        false,
    socketTimeout: 20_000,
  });

  let batchProcessed  = 0;
  let batchSkipped    = 0;
  let batchFailed     = 0;
  let maxProcessedUid = lastProcessedUid ?? (oldestUid - 1);
  let timerAborted    = false;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // ── Fetch BATCH_SIZE mails vanaf startUid ───────────────────────────
      // Breek na BATCH_SIZE — ImapFlow handelt generator cleanup af
      const rawMsgs = [];
      for await (const msg of client.fetch(
        `${startUid}:${newestUid}`,
        { envelope: true, flags: true, uid: true },
        { uid: true },
      )) {
        rawMsgs.push(msg);
        if (rawMsgs.length >= BATCH_SIZE) break;
      }

      console.log(`[backfill-emails] ${progress.mailbox}: ${rawMsgs.length} mails in batch`);

      // ── Verwerk mails ─────────────────────────────────────────────────
      const rows = [];
      for (const msg of rawMsgs) {
        // Timer abort: commit wat we hebben en hervatten volgende run
        if (Date.now() - runStart > MAX_RUN_MS) {
          timerAborted = true;
          console.log(`[backfill-emails] Timer abort ${progress.mailbox} bij UID ${msg.uid} na ${Math.round((Date.now() - runStart) / 1000)}s — hervat bij volgende run`);
          break;
        }

        const uid = msg.uid;
        if (!uid) { batchSkipped++; continue; }

        const env         = msg.envelope || {};
        const fromEntry   = env.from?.[0] || {};
        const fromAddress = fromEntry.address || '';
        const fromName    = fromEntry.name    || '';
        const subject     = env.subject       || '(geen onderwerp)';
        const receivedAt  = env.date ? new Date(env.date).toISOString() : new Date().toISOString();
        const isRead      = msg.flags?.has('\\Seen') ?? false;

        // AI-categorisatie (envelope-only; snippet Fase 3)
        let category       = 'Onbekend';
        let requiresAction = false;
        let confidence     = 0;
        let aiSource       = 'none';
        let catReason      = '';
        try {
          const cat  = await categorize({ from: fromAddress, subject, bodySnippet: '', date: receivedAt });
          category       = cat.category        || 'Onbekend';
          requiresAction = cat.requires_action  ?? false;
          confidence     = cat.confidence       ?? 0;
          aiSource       = cat.source           || 'ai';
          catReason      = cat.reason           || '';
          console.log(`[backfill-emails] ${progress.mailbox} UID ${uid}: ${category} (${aiSource})`);
        } catch (catErr) {
          console.warn(`[backfill-emails] categorize fout UID ${uid}:`, catErr.message);
          batchFailed++;
        }

        if (uid > maxProcessedUid) maxProcessedUid = uid;

        rows.push({
          mailbox:             progress.mailbox,
          imap_uid:            uid,
          message_id:          env.messageId || null,
          from_address:        fromAddress,
          from_name:           fromName,
          subject,
          date_received:       receivedAt,
          snippet:             null,       // Fase 3: partial IMAP fetch
          category,
          requires_action:     requiresAction,
          category_confidence: confidence,
          category_reason:     `[bron: ${aiSource}] ${catReason}`.trim(),
          is_read:             isRead,
        });

        batchProcessed++;
      }

      // ── Batch-insert — idempotent via ON CONFLICT DO NOTHING ───────────
      if (rows.length > 0) {
        const { error: insertErr } = await supabase
          .from('email_messages')
          .upsert(rows, { onConflict: 'mailbox,imap_uid', ignoreDuplicates: true });

        if (insertErr) {
          console.error(`[backfill-emails] email_messages insert fout ${progress.mailbox}:`, insertErr.message);
          // Niet fataal — progress wordt bijgehouden op UID-basis
        }
      }

    } finally {
      lock.release();
    }
  } catch (err) {
    // ── IMAP fout — log en plan retry voor volgende cron-run ─────────────
    console.error(`[backfill-emails] IMAP fout ${progress.mailbox}:`, err.message);

    try {
      const { error: failErr } = await supabase
        .from('backfill_progress')
        .update({
          status:        'failed',
          last_error:    err.message.slice(0, 500),
          last_error_at: new Date().toISOString(),
          error_count:   (parseInt(progress.error_count) || 0) + 1,
          last_batch_at: new Date().toISOString(),
        })
        .eq('id', progress.id);
      if (failErr) console.error('[backfill-emails] fail-update fout:', failErr.message);
    } catch (updateThrow) {
      console.error('[backfill-emails] fail-update threw:', updateThrow.message);
    }

    return res.status(200).json({
      ok:         false,
      mailbox:    progress.mailbox,
      error:      err.message,
      will_retry: true,
    });
  } finally {
    try { await client.logout(); } catch {}
  }

  // ── Voortgang bijwerken ───────────────────────────────────────────────────
  const newProcessed = (parseInt(progress.mails_processed) || 0) + batchProcessed;
  const newSkipped   = (parseInt(progress.mails_skipped)   || 0) + batchSkipped;
  const newFailed    = (parseInt(progress.mails_failed)    || 0) + batchFailed;
  const isComplete   = maxProcessedUid >= newestUid;

  const progressUpdate = {
    last_processed_uid: maxProcessedUid,
    mails_processed:    newProcessed,
    mails_skipped:      newSkipped,
    mails_failed:       newFailed,
    last_batch_at:      new Date().toISOString(),
    status:             isComplete ? 'completed' : 'in_progress',
    ...(isComplete ? { completed_at: new Date().toISOString() } : {}),
  };

  try {
    const { error: progressErr } = await supabase
      .from('backfill_progress')
      .update(progressUpdate)
      .eq('id', progress.id);
    if (progressErr) {
      console.error(`[backfill-emails] progress update fout ${progress.mailbox}:`, progressErr.message);
    }
  } catch (updateThrow) {
    console.error(`[backfill-emails] progress update threw ${progress.mailbox}:`, updateThrow.message);
  }

  const pct = Math.round((newProcessed / (parseInt(progress.mails_total_estimated) || 1)) * 100);
  console.log(`[backfill-emails] ${progress.mailbox} batch klaar: ${batchProcessed} processed, ${batchSkipped} skipped, ${batchFailed} failed, maxUid=${maxProcessedUid}, ${pct}%, complete=${isComplete}${timerAborted ? ' (timer abort)' : ''}`);

  return res.status(200).json({
    ok:              true,
    mailbox:         progress.mailbox,
    batch_processed: batchProcessed,
    batch_skipped:   batchSkipped,
    batch_failed:    batchFailed,
    last_uid:        maxProcessedUid,
    total_processed: newProcessed,
    total_estimated: parseInt(progress.mails_total_estimated),
    percentage:      pct,
    status:          isComplete ? 'completed' : (timerAborted ? 'timer_aborted_will_resume' : 'in_progress'),
  });
}
