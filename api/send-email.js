import nodemailer from 'nodemailer';
import { createUserClient } from './supabase.js';
import { requirePermissionFailOpen } from './_lib/requirePermission.js';

// Mailbox → wachtwoord env-var (zelfde als IMAP)
const SMTP_ACCOUNTS = {
  'leads@deforexopleiding.nl':         'IMAP_PASS',
  'info@deforexopleiding.nl':          'IMAP_PASS_INFO',
  'partners@deforexopleiding.nl':      'IMAP_PASS_PARTNERS',
  'administratie@deforexopleiding.nl': 'IMAP_PASS_ADMINISTRATIE',
  'onboarding@deforexopleiding.nl':    'IMAP_PASS_ONBOARDING',
  'events@deforexopleiding.nl':        'IMAP_PASS_EVENTS',
};

const SMTP_HOST = 'smtp.strato.com';
const SMTP_PORT = 465;

// Sanitiseer bestandsnaam: geen path-traversal-tekens
function safeFilename(name) {
  return String(name || 'bijlage').replace(/[/\\]/g, '_').replace(/\.\./g, '_').slice(0, 255);
}

export default async function handler(req, res) {
  const supabase = createUserClient(req);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from_mailbox, to, subject, text, html, cc, bcc, email_id, category, attachments } = req.body || {};

  // RBAC (fail-open): reply heeft email_id, doorsturen niet → andere permission.
  const featureKey = email_id ? 'email.reply.send' : 'email.forward.send';
  if (!(await requirePermissionFailOpen(req, featureKey))) {
    return res.status(403).json({ error: 'Insufficient permissions', feature: featureKey });
  }

  if (!from_mailbox || !to || !subject || !text) {
    return res.status(400).json({ error: 'from_mailbox, to, subject en text zijn vereist' });
  }

  const passEnv = SMTP_ACCOUNTS[from_mailbox.toLowerCase()];
  if (!passEnv) {
    return res.status(400).json({ error: `Onbekende mailbox: ${from_mailbox}` });
  }

  const password = process.env[passEnv];
  if (!password) {
    return res.status(500).json({
      error: `SMTP wachtwoord voor ${from_mailbox} niet geconfigureerd (env var: ${passEnv})`
    });
  }

  console.log(`[send-email] Van: ${from_mailbox} → Naar: ${to} | Onderwerp: ${subject} | SMTP: ${SMTP_HOST}:${SMTP_PORT}`);

  const transporter = nodemailer.createTransport({
    host:   SMTP_HOST,
    port:   SMTP_PORT,
    secure: true,
    auth: {
      user: from_mailbox,
      pass: password,
    },
  });

  try {
    const mailOpts = {
      from:    `"De Forex Opleiding" <${from_mailbox}>`,
      to,
      subject,
      text,
      replyTo: from_mailbox,
    };
    if (html) mailOpts.html = html;
    if (cc)   mailOpts.cc   = cc;
    if (bcc)  mailOpts.bcc  = bcc;

    // Bijlagen meesturen als MIME-attachments
    if (Array.isArray(attachments) && attachments.length > 0) {
      mailOpts.attachments = attachments.map((a) => ({
        filename:    safeFilename(a.filename),
        contentType: a.contentType || 'application/octet-stream',
        content:     Buffer.from(a.content || '', 'base64'),
        encoding:    'base64',
      }));
    }

    const info = await transporter.sendMail(mailOpts);
    console.log(`[send-email] Verstuurd — messageId: ${info.messageId} | geaccepteerd: ${info.accepted?.join(', ')}`);

    // Attachment metadata voor opslag (filenames + sizes, geen content)
    const attachMeta = Array.isArray(attachments) && attachments.length > 0
      ? attachments.map((a) => ({ filename: safeFilename(a.filename), contentType: a.contentType || 'application/octet-stream', size: a.size || 0 }))
      : null;

    const sentAt = new Date().toISOString();
    const { data: { user: authUser } } = await supabase.auth.getUser();
    const userId = authUser?.id || null;

    // Sla op via supabase-js client (betrouwbaarder dan directe REST fetch)
    // Omit attachments field when null — PostgREST rejects unknown columns if the
    // attachments JSONB column hasn't been added to the live table yet via db-migrate.
    const insertPayload = {
      email_id:      email_id || null,
      email_subject: subject,
      final_reply:   text,
      from_address:  from_mailbox,
      to_address:    to,
      cc_address:    cc  || null,
      bcc_address:   bcc || null,
      sent_at:       sentAt,
      sent_by_id:    userId,
    };
    if (attachMeta !== null) insertPayload.attachments = attachMeta;
    const { error: dbErr } = await supabase.from('email_replies').insert(insertPayload);
    if (dbErr) {
      console.warn('[send-email] email_replies insert mislukt:', dbErr.message);
    } else {
      console.log('[send-email] email_replies opgeslagen');
    }

    // ── Thread-detectie: de beantwoorde mail hoeft niet meer in 'Te beantwoorden' ──
    // email_id is de composite uid '<mailbox>:<imap_uid>' (zie api/emails.js).
    if (email_id) {
      try {
        const lastColon   = String(email_id).lastIndexOf(':');
        const origMailbox = lastColon >= 0 ? email_id.slice(0, lastColon) : null;
        const origUid     = lastColon >= 0 ? email_id.slice(lastColon + 1) : null;
        if (origMailbox && origUid) {
          const { error: markErr } = await supabase
            .from('email_messages')
            .update({ requires_action: false })
            .eq('mailbox', origMailbox)
            .eq('imap_uid', origUid);
          if (markErr) console.warn('[send-email] requires_action mark mislukt:', markErr.message);
          else console.log('[send-email] requires_action=false gezet op beantwoorde mail', email_id);
        }
      } catch (markEx) {
        console.warn('[send-email] thread-mark fout:', markEx.message);
      }
    }

    return res.status(200).json({
      ok:        true,
      messageId: info.messageId,
      accepted:  info.accepted || [],
      dbSaved:   !dbErr,
    });
  } catch (err) {
    console.error(`[send-email] SMTP fout (${from_mailbox} → ${to}):`, err.message, 'code:', err.code || '—', 'responseCode:', err.responseCode || '—', 'response:', err.response || '—');
    return res.status(500).json({
      error:        err.message      || 'Onbekende SMTP fout',
      code:         err.code         || null,
      responseCode: err.responseCode || null,
      response:     err.response     || null,
      command:      err.command      || null,
    });
  }
}
