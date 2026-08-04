// api/backfill-email-attachments.js
//
// POST — backfill email_messages.attachments voor rijen die momenteel NULL
// zijn (dus: nooit geprocest door sync-emails.js Pass 2 attachment-flow).
// Refetcht per rij de raw IMAP-source via ImapFlow, parseert met mailparser,
// en upload de bijlagen via de shared helper.
//
// Body:
//   {
//     dry_run:     boolean (default true) — false schrijft daadwerkelijk
//     mailbox:     'administratie'|'onboarding'|'events'|'leads'|'info'|'partners'
//                  (verplicht — 1 mailbox per invocation ivm IMAP-sessie)
//     days_back:   int (default 30, max 180)
//     limit:       int (default 30, max 100) — aantal rijen dit run
//     min_uid:     int (optional cursor voor resume; default 0)
//   }
//
// Response 200:
//   {
//     ok, dry_run, mailbox, scanned, updated_count, would_update_count,
//     attachments_uploaded, still_null_count, next_min_uid,
//     samples: [ { imap_uid, from_address, attachments_count, warnings } ],
//     warnings: [ ... ] // globale (bv. bucket-permissie)
//   }
//
// AUTH: super_admin only. Bewust GEEN cron — Jeffrey triggert.
//
// TIME-BUDGET: Vercel 60s. Elk mail = 1 IMAP fetchOne + N uploads. Bij 30
// mails met gemiddeld 1 bijlage: ~30s. `limit`-cap houdt run onder de grens.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { uploadEmailAttachments } from './_lib/email-attachment-upload.js';

const KNOWN_MAILBOXES = new Set(['administratie', 'onboarding', 'events', 'leads', 'info', 'partners']);
const MAX_LIMIT       = 100;
const MAX_DAYS_BACK   = 180;
const HARD_DEADLINE_MS = 52_000; // laat 8s marge onder de 60s

// Spiegelt ACCOUNTS in sync-emails.js. Bij uitbreiding: BEIDE bijhouden.
const ACCOUNTS_BY_MAILBOX = {
  leads:         { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  info:          { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  partners:      { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  administratie: { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
  onboarding:    { user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING' },
  events:        { user: 'events@deforexopleiding.nl',        passEnv: 'IMAP_PASS_EVENTS' },
};

async function isSuperAdmin(req) {
  try {
    const supabase = createUserClient(req);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return false;
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', user.id)
      .maybeSingle();
    return !!(profile && profile.is_active && profile.role === 'super_admin');
  } catch (_) {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  if (!(await isSuperAdmin(req))) {
    return res.status(403).json({ error: 'super_admin vereist' });
  }

  const startedAt = Date.now();
  const body      = (req.body && typeof req.body === 'object') ? req.body : {};
  const dryRun    = body.dry_run !== false;
  const mailboxRaw = typeof body.mailbox === 'string' ? body.mailbox.trim().toLowerCase() : null;
  if (!mailboxRaw || !KNOWN_MAILBOXES.has(mailboxRaw)) {
    return res.status(400).json({ error: `mailbox moet ${[...KNOWN_MAILBOXES].join('|')} zijn` });
  }
  const daysBack = Math.min(MAX_DAYS_BACK, Math.max(1, parseInt(body.days_back || 30, 10) || 30));
  const limit    = Math.min(MAX_LIMIT, Math.max(1, parseInt(body.limit || 30, 10) || 30));
  const minUid   = Math.max(0, parseInt(body.min_uid || 0, 10) || 0);

  const account = ACCOUNTS_BY_MAILBOX[mailboxRaw];
  const globalWarnings = [];

  // 1) Fetch kandidaten uit DB: attachments IS NULL, binnen days_back, imap_uid > minUid.
  const cutoffIso = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();
  let candidates = [];
  let totalNullInWindow = 0;
  try {
    const { data, error, count } = await supabaseAdmin
      .from('email_messages')
      .select('id, imap_uid, from_address, subject, date_received', { count: 'exact' })
      .eq('mailbox', mailboxRaw)
      .is('attachments', null)
      .gte('date_received', cutoffIso)
      .gt('imap_uid', minUid)
      .order('imap_uid', { ascending: true })
      .limit(limit);
    if (error) throw new Error('candidates fetch: ' + error.message);
    candidates = data || [];
    totalNullInWindow = count || 0;
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'DB fout' });
  }

  if (candidates.length === 0) {
    return res.status(200).json({
      ok: true, dry_run: dryRun, mailbox: mailboxRaw,
      scanned: 0, updated_count: 0, would_update_count: 0, attachments_uploaded: 0,
      still_null_count: 0, next_min_uid: null,
      samples: [],
      warnings: ['geen kandidaten gevonden (window leeg)'],
    });
  }

  // 2) IMAP-config check.
  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) {
    return res.status(500).json({ error: 'IMAP_HOST env-var ontbreekt' });
  }
  const pass = process.env[account.passEnv];
  if (!pass) {
    return res.status(500).json({ error: `${account.passEnv} env-var ontbreekt` });
  }
  const port = parseInt(IMAP_PORT || '993', 10);

  // 3) IMAP-verbinding + per-mail proces.
  const client = new ImapFlow({
    host: IMAP_HOST, port, secure: true,
    auth: { user: account.user, pass },
    logger: false, socketTimeout: 20000,
  });

  const samples = [];
  let scanned = 0;
  let updatedCount = 0;
  let wouldUpdateCount = 0;
  let attachmentsUploaded = 0;
  let lastProcessedUid = minUid;

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      for (const row of candidates) {
        // Deadline-guard: laat 5s marge voor cleanup + response.
        if ((Date.now() - startedAt) > (HARD_DEADLINE_MS - 5000)) {
          globalWarnings.push(`deadline reached after ${scanned} rows`);
          break;
        }
        scanned++;
        lastProcessedUid = row.imap_uid;
        try {
          const bodyMsg = await client.fetchOne(row.imap_uid, { source: true }, { uid: true });
          if (!bodyMsg?.source) {
            samples.push({ imap_uid: row.imap_uid, from_address: row.from_address, attachments_count: 0, warnings: ['IMAP fetch: geen source (mail bestaat niet meer?)'] });
            // Markeer als [] in dry-run niet, in live-run WEL: zodat we deze
            // rij niet blijven proberen. Discussie: bij live-run zetten we
            // attachments=[] als de mail niet meer bestaat — dat lijkt
            // consistent met "verwerkt, 0 bijlagen".
            if (!dryRun) {
              await supabaseAdmin.from('email_messages').update({ attachments: [] }).eq('id', row.id);
            }
            continue;
          }
          const parsed = await simpleParser(bodyMsg.source, { skipImageLinks: true });
          const attRaw = Array.isArray(parsed.attachments) ? parsed.attachments : [];
          if (attRaw.length === 0) {
            samples.push({ imap_uid: row.imap_uid, from_address: row.from_address, attachments_count: 0, warnings: [] });
            if (!dryRun) {
              await supabaseAdmin.from('email_messages').update({ attachments: [] }).eq('id', row.id);
              updatedCount++;
            } else {
              wouldUpdateCount++;
            }
            continue;
          }

          if (dryRun) {
            // Dry-run: tel bijlagen zonder uploaden. Toon per attachment de
            // filename+grootte in samples zodat Jeffrey kan inspecteren.
            const dryList = attRaw.slice(0, 20).map((a, i) => ({
              filename: a?.filename || `#${i}`,
              size: a?.size || (a?.content?.length || 0),
              mime: a?.contentType || 'unknown',
            }));
            samples.push({
              imap_uid: row.imap_uid,
              from_address: row.from_address,
              subject: row.subject,
              attachments_count: attRaw.length,
              dry_run_preview: dryList,
              warnings: [],
            });
            wouldUpdateCount++;
            attachmentsUploaded += attRaw.length;
            continue;
          }

          // Live: upload + persist.
          const { rows: attRows, warnings } = await uploadEmailAttachments(attRaw, {
            mailbox: mailboxRaw,
            imapUid: row.imap_uid,
            deadlineMs: startedAt + HARD_DEADLINE_MS - 3000,
          });
          const { error: updErr } = await supabaseAdmin
            .from('email_messages')
            .update({ attachments: attRows })
            .eq('id', row.id);
          if (updErr) {
            samples.push({ imap_uid: row.imap_uid, from_address: row.from_address, attachments_count: attRows.length, warnings: ['DB update fail: ' + updErr.message] });
            continue;
          }
          updatedCount++;
          attachmentsUploaded += attRows.length;
          samples.push({
            imap_uid: row.imap_uid,
            from_address: row.from_address,
            subject: row.subject,
            attachments_count: attRows.length,
            warnings: warnings || [],
          });
        } catch (rowErr) {
          samples.push({
            imap_uid: row.imap_uid,
            from_address: row.from_address,
            attachments_count: 0,
            warnings: ['exception: ' + (rowErr?.message || String(rowErr))],
          });
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    globalWarnings.push('IMAP session error: ' + (e?.message || String(e)));
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }

  // Cap samples-response op eerste 20 zodat response niet ontploft.
  const samplesTop = samples.slice(0, 20);

  // Bereken still_null: totalNullInWindow was pre-run count; als live-run
  // updates deed, is de nieuwe count = totalNullInWindow - updatedCount.
  const stillNull = Math.max(0, totalNullInWindow - (dryRun ? 0 : updatedCount));

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    mailbox: mailboxRaw,
    days_back: daysBack,
    scanned,
    updated_count: updatedCount,
    would_update_count: wouldUpdateCount,
    attachments_uploaded: attachmentsUploaded,
    still_null_count: stillNull,
    next_min_uid: scanned > 0 ? lastProcessedUid : null,
    samples: samplesTop,
    warnings: globalWarnings,
    duration_ms: Date.now() - startedAt,
  });
}
