// api/_lib/email.js
//
// Dunne fail-soft transactionele mailer. Sinds deze versie via Strato SMTP
// (nodemailer) i.p.v. Resend — Strato is de mailbox van DFO en heeft een
// vertrouwde domeinreputatie. Signatuur ongewijzigd: callers (bv.
// mentor-payout-approve.js) hoeven niets aan te passen.
//
// Auth: SMTP_USER + SMTP_PASS (Strato mailbox-credentials).
// Host: SMTP_HOST default 'smtp.strato.de'.
// Port: SMTP_PORT default 465 (TLS on connect via `secure:true`).
// From: SMTP_FROM default `De Forex Opleiding <${SMTP_USER}>`.
//
// Gebruik:
//   const result = await sendMail({ to, subject, html });
//   if (!result.sent) console.warn('mail miste:', result.reason);
//
// Belangrijk:
//   - Ontbreekt SMTP_USER of SMTP_PASS → { sent:false, reason:'smtp_not_configured' }.
//   - Gooit NOOIT — alle fouten worden teruggemeld via { sent:false, reason }.
//   - Geen transporter.verify() — dat zou een extra roundtrip per send doen.

import nodemailer from 'nodemailer';

export async function sendMail({ to, subject, html }) {
  const SMTP_HOST = process.env.SMTP_HOST || 'smtp.strato.de';
  const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
  const SMTP_USER = process.env.SMTP_USER || null;
  const SMTP_PASS = process.env.SMTP_PASS || null;
  const SMTP_FROM = process.env.SMTP_FROM || (SMTP_USER ? `De Forex Opleiding <${SMTP_USER}>` : null);

  if (!SMTP_USER || !SMTP_PASS) {
    return { sent: false, reason: 'smtp_not_configured' };
  }
  if (!to || (Array.isArray(to) && to.length === 0)) {
    return { sent: false, reason: 'to ontbreekt' };
  }
  if (!subject) return { sent: false, reason: 'subject ontbreekt' };
  if (!html)    return { sent: false, reason: 'html ontbreekt' };

  let transporter;
  try {
    transporter = nodemailer.createTransport({
      host             : SMTP_HOST,
      port             : SMTP_PORT,
      secure           : SMTP_PORT === 465,
      auth             : { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout  : 10000,
      socketTimeout    : 15000,
    });
  } catch (e) {
    return { sent: false, reason: 'transport: ' + (e?.message || e) };
  }

  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      html,
    });
    return { sent: true, id: info?.messageId || null };
  } catch (e) {
    return { sent: false, reason: e?.message || String(e) };
  }
}
