import { ImapFlow } from 'imapflow';
import { supabase } from './supabase.js';
import { categorize } from './email-agent.js';

// Spiegelt de ACCOUNTS array uit emails.js — voeg nieuwe mailboxen op één plek toe
const ACCOUNTS = [
  { mailbox: 'leads',         user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { mailbox: 'info',          user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { mailbox: 'partners',      user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { mailbox: 'administratie', user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
];

// Maximaal te verwerken mails bij eerste sync (lastUid=0) om timeout te voorkomen
const INITIAL_SYNC_LIMIT = 100;

// Abort-grens: stop met nieuwe mailboxen als we bijna door de Vercel-tijd heen zijn (60s Pro)
const ABORT_MS = 55_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // ── Authenticatie: alleen Vercel cron of handmatige trigger met CRON_SECRET ──
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = req.headers.authorization || '';
    const querySecret = req.query?.secret || '';
    if (authHeader !== `Bearer ${secret}` && querySecret !== secret) {
      return res.status(401).json({ error: 'Unauthorized — CRON_SECRET vereist' });
    }
  }

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST niet geconfigureerd' });

  const port     = parseInt(IMAP_PORT || '993', 10);
  const startedAt = Date.now();
  const results   = [];

  // ── Verwerk mailboxen sequentieel (parallel zou de 55s-grens overschrijden) ──
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
    try {
      const r = await syncMailbox({ account, host: IMAP_HOST, port });
      results.push({ mailbox: account.mailbox, status: 'ok', ...r });
    } catch (err) {
      console.error(`[sync-emails] ${account.mailbox} fout:`, err.message);
      await supabase.from('email_sync_log').insert({
        mailbox:     account.mailbox,
        new_count:   0,
        last_uid:    0,
        duration_ms: Date.now() - boxStart,
        status:      'error',
        error_msg:   err.message.slice(0, 500),
      }).catch(() => {});
      results.push({ mailbox: account.mailbox, status: 'error', error: err.message });
    }
  }

  return res.status(200).json({
    ok:          true,
    duration_ms: Date.now() - startedAt,
    results,
  });
}

// ── Sync één mailbox ────────────────────────────────────────────────────────
async function syncMailbox({ account, host, port }) {
  const boxStart = Date.now();

  // Bepaal de hoogste reeds gesynchroniseerde UID voor deze mailbox
  const { data: lastRow } = await supabase
    .from('email_messages')
    .select('imap_uid')
    .eq('mailbox', account.mailbox)
    .order('imap_uid', { ascending: false })
    .limit(1);

  const lastUid      = lastRow?.[0]?.imap_uid ?? 0;
  const isInitial    = lastUid === 0;

  // ImapFlow verbinding (hogere socketTimeout dan de live-UI: we hebben meer tijd)
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
      // ── Berichten ophalen (envelope + flags + uid) ────────────────────────
      // Eerste sync: afgelopen 7 dagen (beperkt tot INITIAL_SYNC_LIMIT recentste)
      // Incrementeel: UID-range vanaf lastUid+1
      const rawMsgs = [];

      if (isInitial) {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        for await (const msg of client.fetch({ since }, { envelope: true, flags: true, uid: true })) {
          rawMsgs.push(msg);
        }
        // Meest recente eerst; neem maximaal INITIAL_SYNC_LIMIT
        rawMsgs.sort((a, b) => (b.uid ?? 0) - (a.uid ?? 0));
        rawMsgs.splice(INITIAL_SYNC_LIMIT); // in-place truncation
      } else {
        for await (const msg of client.fetch(
          `${lastUid + 1}:*`,
          { envelope: true, flags: true, uid: true },
          { uid: true }, // derde argument: interpreteer range als UID-range
        )) {
          rawMsgs.push(msg);
        }
      }

      // ── Categoriseer en bouw insert-rows ─────────────────────────────────
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

        // AI-categorisatie (envelope-only; body_snippet toegevoegd in Fase 2)
        let category       = 'Onbekend';
        let requiresAction = false;
        let confidence     = 0;
        let aiSource       = 'none';
        try {
          const cat  = await categorize({ from: fromAddress, subject, bodySnippet: '', date: receivedAt });
          category       = cat.category        || 'Onbekend';
          requiresAction = cat.requires_action  ?? false;
          confidence     = cat.confidence       ?? 0;
          aiSource       = cat.source           || 'ai';
        } catch (catErr) {
          console.warn(`[sync-emails] categorize fout ${account.mailbox}/${uid}:`, catErr.message);
        }

        if (uid > maxUid) maxUid = uid;

        rows.push({
          mailbox:         account.mailbox,
          imap_uid:        uid,
          message_id:      env.messageId || null,
          from_address:    fromAddress,
          from_name:       fromName,
          subject,
          received_at:     receivedAt,
          body_snippet:    null, // Fase 2: partial IMAP fetch voor tekst-preview
          category,
          requires_action: requiresAction,
          confidence,
          ai_source:       aiSource,
          raw_flags:       Array.from(msg.flags || []),
          is_read:         isRead,
        });
      }

      // ── Batch-insert — idempotent via ON CONFLICT DO NOTHING ─────────────
      if (rows.length > 0) {
        const { error: insertErr } = await supabase
          .from('email_messages')
          .upsert(rows, { onConflict: 'mailbox,imap_uid', ignoreDuplicates: true });

        if (insertErr) {
          console.error(`[sync-emails] insert fout ${account.mailbox}:`, insertErr.message);
          // Niet fataal: gooi geen error, log alleen
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

  // ── Sync-log bijwerken ────────────────────────────────────────────────────
  const duration = Date.now() - boxStart;
  await supabase.from('email_sync_log').insert({
    mailbox:     account.mailbox,
    new_count:   newCount,
    last_uid:    maxUid,
    duration_ms: duration,
    status:      'ok',
  }).catch(e => console.warn('[sync-emails] log insert fout:', e.message));

  return { new_count: newCount, last_uid: maxUid, duration_ms: duration };
}
