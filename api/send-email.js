import nodemailer from 'nodemailer';
import { supabase } from './supabase.js';

// Mailbox → wachtwoord env-var (zelfde als IMAP)
const SMTP_ACCOUNTS = {
  'leads@deforexopleiding.nl':         'IMAP_PASS',
  'info@deforexopleiding.nl':          'IMAP_PASS_INFO',
  'partners@deforexopleiding.nl':      'IMAP_PASS_PARTNERS',
  'administratie@deforexopleiding.nl': 'IMAP_PASS_ADMINISTRATIE',
};

const SMTP_HOST = 'smtp.strato.com';
const SMTP_PORT = 465;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { from_mailbox, to, subject, text, cc, bcc, email_id, category } = req.body || {};

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
    if (cc)  mailOpts.cc  = cc;
    if (bcc) mailOpts.bcc = bcc;

    const info = await transporter.sendMail(mailOpts);

    console.log(`[send-email] Verstuurd — messageId: ${info.messageId} | geaccepteerd: ${info.accepted?.join(', ')}`);

    // Sla op in Supabase (backup pad naast de frontend saveEmailAction call)
    const sentAt = new Date().toISOString();
    supabase.from('email_actions').insert({
      email_id: email_id || 'manual',
      action:   'reply_sent',
      value:    JSON.stringify({ to, from: from_mailbox, subject, body: text, cc: cc || null, bcc: bcc || null, category: category || null }),
      set_by:   'smtp',
      set_at:   sentAt
    }).then(({ error }) => {
      if (error) console.warn('[send-email] email_actions opslaan mislukt:', error.message);
    });

    supabase.from('email_replies').insert({
      email_subject: subject,
      final_reply:   text,
      from_address:  from_mailbox,
      to_address:    to,
      sent_at:       sentAt
    }).then(({ error }) => {
      if (error) console.warn('[send-email] email_replies opslaan mislukt:', error.message);
    });

    return res.status(200).json({
      ok: true,
      messageId: info.messageId,
      accepted:  info.accepted || [],
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
