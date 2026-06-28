import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { supabaseAdmin as supabase, checkCronAuth } from './supabase.js';
import { categorize } from './email-agent.js';

// Spiegelt de ACCOUNTS array uit emails.js — voeg nieuwe mailboxen op één plek toe
const ACCOUNTS = [
  { mailbox: 'leads',         user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { mailbox: 'info',          user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { mailbox: 'partners',      user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { mailbox: 'administratie', user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
  { mailbox: 'onboarding',    user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING' },
  { mailbox: 'events',        user: 'events@deforexopleiding.nl',        passEnv: 'IMAP_PASS_EVENTS' },
];

// Maximaal te verwerken mails bij eerste sync (lastUid=0) om timeout te voorkomen
const INITIAL_SYNC_LIMIT = 100;

// Abort-grens: stop met nieuwe mailboxen als we bijna door de Vercel-tijd heen zijn (60s Pro)
const ABORT_MS = 55_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── Authenticatie: CRON_SECRET verplicht ─────────────────────────────────
  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST niet geconfigureerd' });

  const port      = parseInt(IMAP_PORT || '993', 10);
  const startedAt = Date.now();
  const results   = [];

  // ── Verwerk mailboxen sequentieel — per-mailbox isolatie: fout in één stopt de rest niet ──
  for (const account of ACCOUNTS) {
    if (Date.now() - startedAt > ABORT_MS) {
      results.push({ mailbox: account.mailbox, status: 'skipped', reason: 'timeout-guard' });
      continue;
    }

    const pass = process.env[account.passEnv];
    if (!pass) {
      results.push({ mailbox: account.mailbox, status: 'skipped', reason: 'geen wachtwoord' });
      continue;
    }

    const boxStart = Date.now();
    console.log(`[sync-emails] Starting sync for mailbox: ${account.mailbox}`);

    try {
      const r = await syncMailbox({ account, host: IMAP_HOST, port, boxStart });
      console.log(`[sync-emails] Finished mailbox ${account.mailbox}: ${r.new_count} new mails, last_uid=${r.last_uid}, ${r.duration_ms}ms`);
      results.push({ mailbox: account.mailbox, status: 'ok', ...r });

    } catch (err) {
      console.error(`[sync-emails] Mailbox ${account.mailbox} failed:`, err.message);

      // Sync-log fout-entry — standaard await patroon (geen .catch() chaining)
      try {
        const { error: logErr } = await supabase.from('email_sync_log').insert({
          mailbox:       account.mailbox,
          started_at:    new Date(boxStart).toISOString(),
          completed_at:  new Date().toISOString(),
          mails_new:     0,
          last_uid:      0,
          duration_ms:   Date.now() - boxStart,
          status:        'failed',
          error_message: err.message.slice(0, 500),
        });
        if (logErr) console.error(`[sync-emails] Sync_log insert failed for ${account.mailbox}:`, logErr.message);
      } catch (logWriteErr) {
        console.error(`[sync-emails] Sync_log insert threw for ${account.mailbox}:`, logWriteErr.message);
      }

      results.push({ mailbox: account.mailbox, status: 'failed', error: err.message });
      // Expliciet doorgaan naar volgende mailbox — geen abort
    }
  }

  return res.status(200).json({
    ok:          true,
    duration_ms: Date.now() - startedAt,
    results,
  });
}

// ── Sync één mailbox ────────────────────────────────────────────────────────
async function syncMailbox({ account, host, port, boxStart }) {
  // Bepaal de hoogste reeds gesynchroniseerde UID voor deze mailbox
  const { data: lastRow, error: uidErr } = await supabase
    .from('email_messages')
    .select('imap_uid')
    .eq('mailbox', account.mailbox)
    .order('imap_uid', { ascending: false })
    .limit(1);

  if (uidErr) console.warn(`[sync-emails] lastUid ophalen fout voor ${account.mailbox}:`, uidErr.message);

  const lastUid   = lastRow?.[0]?.imap_uid ?? 0;
  const isInitial = lastUid === 0;

  console.log(`[sync-emails] ${account.mailbox}: lastUid=${lastUid}, isInitial=${isInitial}`);

  // ImapFlow verbinding
  const client = new ImapFlow({
    host,
    port,
    secure:        true,
    auth:          { user: account.user, pass: process.env[account.passEnv] },
    logger:        false,
    socketTimeout: 20_000,
  });

  await client.connect();

  let newCount = 0;
  let maxUid   = lastUid;

  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // ── Berichten ophalen (envelope + flags + uid) ──────────────────────
      // Eerste sync: afgelopen 7 dagen, max INITIAL_SYNC_LIMIT recentste
      // Incrementeel: UID-range vanaf lastUid+1
      const rawMsgs = [];

      if (isInitial) {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        for await (const msg of client.fetch({ since }, { envelope: true, flags: true, uid: true })) {
          rawMsgs.push(msg);
        }
        // Meest recente eerst; neem maximaal INITIAL_SYNC_LIMIT
        rawMsgs.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0));
        rawMsgs.splice(INITIAL_SYNC_LIMIT);
      } else {
        for await (const msg of client.fetch(
          `${lastUid + 1}:*`,
          { envelope: true, flags: true, uid: true },
          { uid: true }, // derde argument: interpreteer range als UID-range
        )) {
          rawMsgs.push(msg);
        }
      }

      console.log(`[sync-emails] ${account.mailbox}: ${rawMsgs.length} berichten te verwerken`);

      // 3-pass aanpak (Fase email-classifier-fix commit 2):
      // 1) Bouw base-rows uit envelopes
      // 2) Fetch body's via IMAP — VÓÓR categorize zodat snippet beschikbaar is
      // 3) Categorize met bodySnippet ingevuld → body_keywords pattern werkt nu

      // ── Pass 1: base rows uit envelopes ───────────────────────────────
      const rows = [];
      for (const msg of rawMsgs) {
        const uid = msg.uid;
        if (!uid || uid <= lastUid) continue;

        const env         = msg.envelope || {};
        const fromEntry   = env.from?.[0] || {};
        const fromAddress = fromEntry.address || '';
        const fromName    = fromEntry.name    || '';
        const subject     = env.subject       || '(geen onderwerp)';
        const receivedAt  = env.date ? new Date(env.date).toISOString() : new Date().toISOString();
        const isRead      = msg.flags?.has('\\Seen') ?? false;

        if (uid > maxUid) maxUid = uid;

        rows.push({
          mailbox:             account.mailbox,
          imap_uid:            uid,
          message_id:          env.messageId || null,
          from_address:        fromAddress,
          from_name:           fromName,
          subject,
          date_received:       receivedAt,
          snippet:             null, // gevuld in Pass 2
          // categorize-velden in Pass 3:
          category:            'Onbekend',
          requires_action:     false,
          category_confidence: 0,
          category_reason:     '',
          is_read:             isRead,
        });
      }

      // ── Pass 2: Body ophalen voor nieuwe mails ────────────────────────
      // Zelfde IMAP-sessie is al open — geen extra verbinding nodig.
      // Try/catch per mail: body-fout mag metadata-sync nooit breken.
      // Body wordt nu vóór categorize gefetched zodat de classifier de
      // body_keywords kan matchen tegen email_patterns (eerder werkte dat
      // niet omdat bodySnippet='' werd doorgegeven).
      const BODY_LIMIT = 100_000;
      for (const row of rows) {
        try {
          const bodyMsg = await client.fetchOne(row.imap_uid, { source: true }, { uid: true });
          if (bodyMsg?.source) {
            const parsed  = await simpleParser(bodyMsg.source, { skipImageLinks: true });
            const rawText = parsed.text || '';
            const rawHtml = parsed.html || '';
            row.body_text       = rawText.slice(0, BODY_LIMIT) || null;
            row.body_html       = rawHtml.slice(0, BODY_LIMIT) || null;
            row.body_fetched_at = new Date().toISOString();
            row.body_truncated  = rawText.length > BODY_LIMIT || rawHtml.length > BODY_LIMIT;
            row.snippet         = rawText.slice(0, 300).trim() || null;
          }
        } catch (bodyErr) {
          console.warn(`[sync-emails] body-fetch fout ${account.mailbox}/${row.imap_uid}:`, bodyErr.message);
          row.body_fetch_error = bodyErr.message.slice(0, 200);
          // Geen body_fetched_at gezet → backfill kan later opnieuw proberen
          // row.snippet blijft null → categorize krijgt '' (fallback gedrag, geen crash)
        }
      }

      // ── Pass 3: Categorize met bodySnippet beschikbaar ────────────────
      for (const row of rows) {
        try {
          const cat = await categorize({
            from:        row.from_address,
            subject:     row.subject,
            bodySnippet: row.snippet || '',
            date:        row.date_received,
          });
          row.category            = cat.category         || 'Onbekend';
          row.requires_action     = cat.requires_action   ?? false;
          row.category_confidence = cat.confidence        ?? 0;
          const aiSource          = cat.source            || 'ai';
          row.category_reason     = `[bron: ${aiSource}] ${cat.reason || ''}`.trim();
        } catch (catErr) {
          console.warn(`[sync-emails] categorize fout ${account.mailbox}/${row.imap_uid}:`, catErr.message);
          // row.category blijft 'Onbekend' (default uit Pass 1)
        }
      }

      // ── Batch-insert — idempotent via ON CONFLICT DO NOTHING ───────────
      if (rows.length > 0) {
        const { error: insertErr } = await supabase
          .from('email_messages')
          .upsert(rows, { onConflict: 'mailbox,imap_uid', ignoreDuplicates: true });

        if (insertErr) {
          console.error(`[sync-emails] email_messages insert fout ${account.mailbox}:`, insertErr.message);
          // Niet fataal: mails zijn mogelijk gedeeltelijk geschreven
        } else {
          newCount = rows.length;
        }
      }

    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch {}
  }

  // ── Sync-log bijwerken — standaard await patroon (geen .catch() chaining) ──
  const duration = Date.now() - boxStart;
  try {
    const { error: logErr } = await supabase.from('email_sync_log').insert({
      mailbox:      account.mailbox,
      started_at:   new Date(boxStart).toISOString(),
      completed_at: new Date().toISOString(),
      mails_new:    newCount,
      last_uid:     maxUid,
      duration_ms:  duration,
      status:       'ok',
    });
    if (logErr) console.error(`[sync-emails] Sync_log insert failed for ${account.mailbox}:`, logErr.message);
  } catch (logWriteErr) {
    console.error(`[sync-emails] Sync_log insert threw for ${account.mailbox}:`, logWriteErr.message);
  }

  return { new_count: newCount, last_uid: maxUid, duration_ms: duration };
}
