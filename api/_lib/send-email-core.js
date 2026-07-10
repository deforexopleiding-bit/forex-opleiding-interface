// api/_lib/send-email-core.js
//
// Gedeelde SMTP-send-kern (nodemailer + Strato). Extractie uit
// api/send-email.js zodat cron-jobs zoals cron-dunning-bulk-send direct
// een e-mail kunnen versturen zonder self-fetch. send-email.js zelf blijft
// de RBAC + attachments + DB-log doen; deze helper is pure send.
//
// Ondersteunt de vaste mailbox-set (SMTP_ACCOUNTS): elke mailbox heeft
// z'n eigen wachtwoord-env-var (IMAP_PASS_* — zelfde pattern als IMAP).
// From-header = `"De Forex Opleiding" <mailbox>`, reply-to = mailbox.

import nodemailer from 'nodemailer';

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

/**
 * @param {object} opts
 * @param {string} opts.fromMailbox   Een van SMTP_ACCOUNTS keys.
 * @param {string|string[]} opts.to
 * @param {string} opts.subject
 * @param {string} opts.text          Verplicht (plain-text fallback).
 * @param {string} [opts.html]
 * @param {string|string[]} [opts.cc]
 * @param {string|string[]} [opts.bcc]
 * @returns {Promise<{ ok:true, messageId:string, accepted:string[] } |
 *                    { ok:false, reason:string, code?:string }>}
 */
export async function sendEmailViaSmtp({
  fromMailbox,
  to,
  subject,
  text,
  html   = null,
  cc     = null,
  bcc    = null,
} = {}) {
  const mailbox = String(fromMailbox || '').toLowerCase();
  if (!mailbox || !SMTP_ACCOUNTS[mailbox]) {
    return { ok: false, reason: `Onbekende mailbox: ${fromMailbox}`, code: 'UNKNOWN_MAILBOX' };
  }
  if (!to || (Array.isArray(to) && to.length === 0)) return { ok: false, reason: 'to ontbreekt', code: 'NO_TO' };
  if (!subject) return { ok: false, reason: 'subject ontbreekt', code: 'NO_SUBJECT' };
  if (!text)    return { ok: false, reason: 'text ontbreekt',    code: 'NO_TEXT' };

  const passEnv = SMTP_ACCOUNTS[mailbox];
  const password = process.env[passEnv];
  if (!password) {
    return { ok: false, reason: `SMTP-wachtwoord voor ${mailbox} niet geconfigureerd (${passEnv})`, code: 'SMTP_NOT_CONFIGURED' };
  }

  let transporter;
  try {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: true,
      auth: { user: mailbox, pass: password },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    });
  } catch (e) {
    return { ok: false, reason: 'transport-init: ' + (e?.message || e), code: 'TRANSPORT_INIT' };
  }

  try {
    const mailOpts = {
      from   : `"De Forex Opleiding" <${mailbox}>`,
      to,
      subject,
      text,
      replyTo: mailbox,
    };
    if (html) mailOpts.html = html;
    if (cc)   mailOpts.cc   = cc;
    if (bcc)  mailOpts.bcc  = bcc;
    const info = await transporter.sendMail(mailOpts);
    return { ok: true, messageId: info?.messageId || null, accepted: info?.accepted || [] };
  } catch (e) {
    return { ok: false, reason: e?.message || String(e), code: 'SMTP_SEND_FAIL' };
  }
}

export const SMTP_MAILBOXES = Object.keys(SMTP_ACCOUNTS);
