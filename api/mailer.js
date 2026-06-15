// api/mailer.js
//
// Herbruikbare email-helper voor cron-flows. Geen default export →
// Vercel serveert dit niet als route.
//
// Hergebruikt Strato SMTP via nodemailer (zelfde patroon als admin-users.js).

import nodemailer from 'nodemailer';

const FROM_ADDRESS = 'info@deforexopleiding.nl';
const FROM_NAME = 'De Forex Opleiding';

let cachedTransport = null;

function getTransport() {
  if (cachedTransport) return cachedTransport;

  if (!process.env.IMAP_PASS_INFO) {
    throw new Error('IMAP_PASS_INFO env var ontbreekt');
  }

  cachedTransport = nodemailer.createTransport({
    host: 'smtp.strato.com',
    port: 465,
    secure: true,
    auth: {
      user: FROM_ADDRESS,
      pass: process.env.IMAP_PASS_INFO,
    },
  });

  return cachedTransport;
}

/**
 * Verstuur een email via Strato SMTP.
 *
 * @param {{ to: string|string[], subject: string, text: string, html: string }} opts
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
export async function sendMail({ to, subject, text, html }) {
  if (!to || !subject || (!text && !html)) {
    return { success: false, error: 'Missing required fields' };
  }

  const recipients = Array.isArray(to) ? to : [to];

  try {
    const transport = getTransport();
    const info = await transport.sendMail({
      from: `"${FROM_NAME}" <${FROM_ADDRESS}>`,
      to: recipients.join(', '),
      subject,
      text: text || stripHtml(html),
      html,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error('[mailer] send error:', err.message);
    return { success: false, error: err.message };
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ── Events-afzender (events@deforexopleiding.nl) ─────────────────────────────
const EVENTS_FROM_ADDRESS = 'events@deforexopleiding.nl';
const EVENTS_FROM_NAME = 'De Forex Opleiding';
let cachedEventsTransport = null;

function getEventsTransport() {
  if (cachedEventsTransport) return cachedEventsTransport;
  const pass = process.env.EVENTS_MAIL_PASS;
  if (!pass) return null; // niet geconfigureerd → caller valt terug op info@
  cachedEventsTransport = nodemailer.createTransport({
    host: 'smtp.strato.com',
    port: 465,
    secure: true,
    auth: { user: process.env.EVENTS_MAIL_USER || EVENTS_FROM_ADDRESS, pass },
  });
  return cachedEventsTransport;
}

/**
 * Verstuur events-automation-mail vanaf events@deforexopleiding.nl.
 * Valt veilig terug op info@ als EVENTS_MAIL_PASS ontbreekt.
 *
 * Optionele `attachments`: nodemailer-compatible array, bv.
 *   [{ filename: 'flyer.pdf', path: 'https://...public.../mail-attachments/...' }]
 * Nodemailer haalt het bestand op via de path (HTTP-URL of lokaal pad) en
 * stuurt het mee als e-mailbijlage. Leeg/ontbrekend → niet meesturen.
 *
 * @returns {Promise<{success:boolean, messageId?:string, from:string, fallback:boolean, error?:string}>}
 */
export async function sendEventMail({ to, subject, text, html, attachments }) {
  if (!to || !subject || (!text && !html)) {
    return { success: false, from: EVENTS_FROM_ADDRESS, fallback: false, error: 'Missing required fields' };
  }
  const recipients = Array.isArray(to) ? to : [to];
  const eventsTransport = getEventsTransport();
  const useEvents = !!eventsTransport;
  const fromAddr = useEvents ? EVENTS_FROM_ADDRESS : FROM_ADDRESS;
  const fromName = useEvents ? EVENTS_FROM_NAME : FROM_NAME;
  try {
    const transport = eventsTransport || getTransport();
    const mail = {
      from: `"${fromName}" <${fromAddr}>`,
      to: recipients.join(', '),
      subject,
      text: text || stripHtml(html),
      html,
    };
    if (Array.isArray(attachments) && attachments.length > 0) {
      mail.attachments = attachments;
    }
    const info = await transport.sendMail(mail);
    return { success: true, messageId: info.messageId, from: fromAddr, fallback: !useEvents };
  } catch (err) {
    console.error('[mailer] sendEventMail error:', err.message);
    return { success: false, from: fromAddr, fallback: !useEvents, error: err.message };
  }
}

export function wrapEmailHtml(title, bodyHtml, opts = {}) {
  const footerInner = (opts && opts.footerHtml) || `<p style="margin:0; color:#6b7280; font-size:12px;">
                Agency Command Center — Follow-up Module<br>
                De Forex Opleiding NL B.V.
              </p>`;
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0; padding:0; background:#f5f5f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f5f5f5; padding:20px 0;">
    <tr>
      <td align="center">
        <table cellpadding="0" cellspacing="0" border="0" width="600" style="background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.08);">
          <tr>
            <td style="background:#093d54; padding:24px 32px;">
              <h1 style="color:#ffffff; margin:0; font-size:20px; font-weight:600;">${escapeHtml(title)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="background:#f8f9fa; padding:16px 32px; border-top:1px solid #e5e7eb;">
              ${footerInner}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Haalt actieve admin-recipients uit profiles tabel.
 * Vereist supabaseAdmin (RLS bypass).
 */
export async function getAdminRecipients(supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, email, role, full_name')
    .in('role', ['super_admin', 'manager']);

  if (error) {
    console.error('[mailer] getAdminRecipients error:', error.message);
    return [];
  }

  return (data || []).filter(p => p.email && p.email.includes('@'));
}
