// api/email-send-v2.js
//
// v2 E-mail module — verzenden met VERZEND-GUARD.
//
// Server-side preview-detect via process.env.VERCEL_ENV. Op 'preview' of
// 'development' wordt het to-adres ALTIJD overschreven naar Jeffrey's
// mail (biemoldjeffrey@gmail.com) en het onderwerp prefixed met
// "[PREVIEW → was <origineel>]" zodat er nooit een echte klant gemaild
// wordt vanaf een preview-omgeving.
//
// Op 'production' gaat de mail naar de opgegeven ontvanger.
//
// Delegatie: kopie van de send-logic uit api/send-email.js. Bewust GEEN
// import cross-api om Vercel-bundeling-risico's te vermijden.
//
// Body (POST):
//   { from_mailbox, to, subject, text, html?, cc?, bcc?, email_id?,
//     attachments? [{ filename, contentType, content(base64), size }],
//     handtekening? }
//
// Response:
//   { ok:true, messageId, accepted, dbSaved, guarded, guard_target?,
//     original_to?, env }
//   guarded=true als preview-override actief was.
//
// Permission: email.reply.send (bij email_id) of email.forward.send.

import nodemailer from 'nodemailer';
import { createUserClient } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';
import { metHandtekening, metHandtekeningAsync } from './_lib/email-handtekening.js';
import { supabaseAdmin } from './supabase.js';

const SMTP_ACCOUNTS = {
  'leads@deforexopleiding.nl':         'IMAP_PASS',
  'info@deforexopleiding.nl':          'IMAP_PASS_INFO',
  'partners@deforexopleiding.nl':      'IMAP_PASS_PARTNERS',
  'administratie@deforexopleiding.nl': 'IMAP_PASS_ADMINISTRATIE',
  'onboarding@deforexopleiding.nl':    'IMAP_PASS_ONBOARDING',
  'events@deforexopleiding.nl':        'IMAP_PASS_EVENTS',
  'welkom@deforexopleiding.nl':        'IMAP_PASS_WELKOM',
};

const SMTP_HOST = 'smtp.strato.com';
const SMTP_PORT = 465;

// Preview-doel — server-side hardcoded, niet client-instelbaar.
const PREVIEW_TO_OVERRIDE = 'biemoldjeffrey@gmail.com';

function safeFilename(name) {
  return String(name || 'bijlage').replace(/[/\\]/g, '_').replace(/\.\./g, '_').slice(0, 255);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const {
    from_mailbox, to, subject, text, html, cc, bcc, email_id,
    attachments, handtekening,
  } = req.body || {};

  const featureKey = email_id ? 'email.reply.send' : 'email.forward.send';
  if (!(await requirePermissionFailOpen(req, featureKey))) {
    return res.status(403).json({ error: 'Insufficient permissions', feature: featureKey });
  }
  if (!from_mailbox || !to || !subject || !text) {
    return res.status(400).json({ error: 'from_mailbox, to, subject en text zijn vereist' });
  }

  // ── VERZEND-GUARD ────────────────────────────────────────────────────────
  // Server-side detect via VERCEL_ENV. Alleen 'production' mag naar echte
  // ontvanger; alles anders (preview, development, ontbrekend) redirect
  // naar Jeffrey's mail. Onderwerp krijgt prefix zodat het duidelijk is
  // dat het een preview-send was.
  const vercelEnv = String(process.env.VERCEL_ENV || 'development').toLowerCase();
  const isProd    = vercelEnv === 'production';
  let effectiveTo      = to;
  let effectiveSubject = subject;
  let guarded          = false;
  let originalTo       = null;
  if (!isProd) {
    guarded          = true;
    originalTo       = to;
    effectiveTo      = PREVIEW_TO_OVERRIDE;
    effectiveSubject = `[PREVIEW → was: ${to}] ${subject}`;
    // CC/BCC ook wegdrukken om ongewilde mail te vermijden.
    // (variabelen worden hieronder niet doorgegeven bij guarded=true).
  }

  // v2 email-round DEEL 3: haal per-mailbox handtekening uit DB
  // (fallback op hardcoded als DB-lookup faalt of tabel ontbreekt).
  const mailboxSlug = String(from_mailbox || '').toLowerCase().split('@')[0];
  const sig = handtekening
    ? await metHandtekeningAsync(text, html, { mailbox: mailboxSlug, supabaseAdmin })
    : { text, html: html || null };

  const passEnv = SMTP_ACCOUNTS[String(from_mailbox).toLowerCase()];
  if (!passEnv) return res.status(400).json({ error: `Onbekende mailbox: ${from_mailbox}` });
  const password = process.env[passEnv];
  if (!password) {
    return res.status(500).json({ error: `SMTP wachtwoord voor ${from_mailbox} niet geconfigureerd (env var: ${passEnv})` });
  }

  console.log(`[email-send-v2] env=${vercelEnv} guarded=${guarded} van:${from_mailbox} naar:${effectiveTo}${originalTo ? ` (origineel:${originalTo})` : ''} onderwerp:${effectiveSubject}`);

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: from_mailbox, pass: password },
  });

  // ── Threading-headers voor reply-groepering (Gmail/Outlook) ─────────────
  let inReplyToMid = null;
  if (email_id && typeof email_id === 'string' && email_id.includes(':')) {
    try {
      const lastColon    = email_id.lastIndexOf(':');
      const srcMailbox   = email_id.slice(0, lastColon);
      const srcImapUid   = email_id.slice(lastColon + 1);
      const { data: srcRow } = await supabase
        .from('email_messages')
        .select('message_id')
        .eq('mailbox', srcMailbox)
        .eq('imap_uid', srcImapUid)
        .maybeSingle();
      if (srcRow?.message_id) inReplyToMid = String(srcRow.message_id);
    } catch (_) { /* fail-soft */ }
  }

  try {
    const mailOpts = {
      from:    `"De Forex Opleiding" <${from_mailbox}>`,
      to:      effectiveTo,
      subject: effectiveSubject,
      text:    sig.text,
      replyTo: from_mailbox,
    };
    if (sig.html) mailOpts.html = sig.html;
    // Bij guarded verwerpen we cc/bcc; op productie laten we ze door.
    if (!guarded && cc)  mailOpts.cc  = cc;
    if (!guarded && bcc) mailOpts.bcc = bcc;
    if (inReplyToMid) { mailOpts.inReplyTo = inReplyToMid; mailOpts.references = inReplyToMid; }

    if (Array.isArray(attachments) && attachments.length > 0) {
      mailOpts.attachments = attachments.map((a) => ({
        filename:    safeFilename(a.filename),
        contentType: a.contentType || 'application/octet-stream',
        content:     Buffer.from(a.content || '', 'base64'),
        encoding:    'base64',
      }));
    }

    const info = await transporter.sendMail(mailOpts);
    console.log(`[email-send-v2] verstuurd — messageId:${info.messageId} accepted:${(info.accepted || []).join(', ')}`);

    const attachMeta = Array.isArray(attachments) && attachments.length > 0
      ? attachments.map((a) => ({ filename: safeFilename(a.filename), contentType: a.contentType || 'application/octet-stream', size: a.size || 0 }))
      : null;

    const sentAt = new Date().toISOString();
    const insertPayload = {
      email_id:      email_id || null,
      email_subject: effectiveSubject,
      final_reply:   sig.text,
      from_address:  from_mailbox,
      to_address:    effectiveTo,
      cc_address:    (!guarded && cc)  ? cc  : null,
      bcc_address:   (!guarded && bcc) ? bcc : null,
      sent_at:       sentAt,
      sent_by_id:    user.id,
    };
    if (attachMeta !== null) insertPayload.attachments = attachMeta;
    const { error: dbErr } = await supabase.from('email_replies').insert(insertPayload);
    if (dbErr) console.warn('[email-send-v2] email_replies insert fail-soft:', dbErr.message);

    if (email_id) {
      try {
        const lastColon   = String(email_id).lastIndexOf(':');
        const origMailbox = lastColon >= 0 ? email_id.slice(0, lastColon) : null;
        const origUid     = lastColon >= 0 ? email_id.slice(lastColon + 1) : null;
        if (origMailbox && origUid) {
          await supabase
            .from('email_messages')
            .update({ requires_action: false })
            .eq('mailbox', origMailbox)
            .eq('imap_uid', origUid);
        }
      } catch (_) { /* fail-soft */ }
    }

    return res.status(200).json({
      ok:            true,
      messageId:     info.messageId,
      accepted:      info.accepted || [],
      dbSaved:       !dbErr,
      guarded,
      guard_target:  guarded ? PREVIEW_TO_OVERRIDE : null,
      original_to:   originalTo,
      env:           vercelEnv,
    });
  } catch (err) {
    console.error(`[email-send-v2] SMTP fout ${from_mailbox}→${effectiveTo}:`, err.message, 'code:', err.code, 'resp:', err.response);
    return res.status(500).json({
      error:        err.message || 'Onbekende SMTP fout',
      code:         err.code || null,
      responseCode: err.responseCode || null,
      response:     err.response || null,
      guarded,
      env:          vercelEnv,
    });
  }
}
