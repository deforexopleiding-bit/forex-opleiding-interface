import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { safeError } from './_lib/safe-error.js';
import { sanitizeEmailHtml } from './_lib/email-html-sanitizer.js';
import { supabaseAdmin } from './supabase.js';
import { requireCrmStaff } from './_lib/crm-roles.js';
import { signAttachmentToken } from './_lib/attachment-token.js';

// v=22 email-round: DB-fallback voor intern-gegenereerde mails.
// Interne notificatie-mails (bv. leads@ "Nieuwe lead: …" uit de forex-opleiding
// notificatie-flow) worden direct in `email_messages` geschreven met
// body_html/body_text kolommen, maar zitten NIET als IMAP-message met dat UID
// in de INBOX (of zijn ondertussen verplaatst/gearchiveerd). fetchOne(uid)
// returnt dan niks → 404. Fix: bij `email_id` in de body-payload, val terug
// op de row in Supabase als IMAP faalt.
async function loadBodyFromDb(emailId) {
  if (!emailId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from('email_messages')
      .select('subject, from_address, from_name, to_address, cc_address, date_received, body_text, body_html, attachments')
      .eq('id', emailId)
      .maybeSingle();
    if (error || !data) return null;
    return data;
  } catch (_) { return null; }
}
function buildResponseFromDbRow(row) {
  const bodyHtmlSafe = row.body_html
    ? sanitizeEmailHtml(String(row.body_html), { blockExternalImages: true }).html
    : '';
  return {
    subject: row.subject || '',
    from:    row.from_name ? `${row.from_name} <${row.from_address || ''}>` : (row.from_address || ''),
    to:      row.to_address || '',
    cc:      row.cc_address || '',
    date:    row.date_received || null,
    text:    row.body_text || (row.body_html ? String(row.body_html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : ''),
    hasHtml: !!row.body_html,
    body_html_safe: bodyHtmlSafe,
    external_images_blocked: 0,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    source: 'db', // debug-hint: welke bron leverde de body
  };
}

const ACCOUNTS = [
  { user: 'leads@deforexopleiding.nl',         passEnv: 'IMAP_PASS' },
  { user: 'info@deforexopleiding.nl',          passEnv: 'IMAP_PASS_INFO' },
  { user: 'partners@deforexopleiding.nl',      passEnv: 'IMAP_PASS_PARTNERS' },
  { user: 'administratie@deforexopleiding.nl', passEnv: 'IMAP_PASS_ADMINISTRATIE' },
  { user: 'onboarding@deforexopleiding.nl',    passEnv: 'IMAP_PASS_ONBOARDING' },
  { user: 'events@deforexopleiding.nl',        passEnv: 'IMAP_PASS_EVENTS' },
  { user: 'welkom@deforexopleiding.nl',        passEnv: 'IMAP_PASS_WELKOM' }
];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed — use POST' });
  }

  // Dit endpoint gaf de VOLLEDIGE mailbody terug zonder enige auth-check: een
  // POST met mailbox+uid (of email_id) was genoeg. Nu een expliciete rolpoort,
  // dezelfde als public.is_crm_staff() in RLS — een geldig JWT alleen is niet
  // genoeg, want elk auto-aangemaakt viewer/student-account heeft er een.
  const auth = await requireCrmStaff(req);
  if (!auth) return res.status(403).json({ error: 'Toegang geweigerd. CRM-rol vereist.' });

  const body = typeof req.body === 'string'
    ? JSON.parse(req.body || '{}')
    : (req.body || {});
  const { mailbox, uid, email_id: emailId } = body;

  // v=22: als de caller alleen email_id doorstuurt (intern gegenereerde mail
  // zonder betrouwbare IMAP-uid), sla IMAP volledig over.
  if ((!mailbox || uid === undefined || uid === null || uid === '') && emailId) {
    const dbRow = await loadBodyFromDb(emailId);
    if (dbRow && (dbRow.body_text || dbRow.body_html)) {
      return res.status(200).json(buildResponseFromDbRow(dbRow));
    }
    return res.status(404).json({ error: 'Geen body-inhoud in DB voor deze mail.' });
  }

  if (!mailbox || uid === undefined || uid === null || uid === '') {
    return res.status(400).json({ error: 'Body moet "mailbox" en "uid" bevatten (of "email_id").' });
  }

  // Kortlevend token voor /api/email-attachment. De frontend hangt dit als
  // `&t=` aan de bijlage-links, want die worden via een browser-navigatie
  // geopend en kunnen geen Authorization-header meesturen. Mint hier omdat
  // deze call al geauthenticeerd is én al de bijlagenlijst teruggeeft — geen
  // extra round-trip nodig. Fail-soft: zonder token blijft de body gewoon
  // laden, alleen de bijlage-links werken dan niet.
  let attachmentToken = null;
  let attachmentTokenExpiresAt = null;
  try {
    const t = signAttachmentToken({ mailbox, uid });
    attachmentToken          = t.token;
    attachmentTokenExpiresAt = t.expiresAt;
  } catch (e) {
    console.error('[email-body] attachment-token minten mislukt:', e.message);
  }

  const account = ACCOUNTS.find((a) => a.user === mailbox);
  if (!account) return res.status(400).json({ error: `Onbekende mailbox: ${mailbox}` });

  const pass = process.env[account.passEnv];
  if (!pass) {
    return res.status(500).json({
      error: `Wachtwoord voor ${mailbox} is niet geconfigureerd (env var ${account.passEnv}).`
    });
  }

  const { IMAP_HOST, IMAP_PORT } = process.env;
  if (!IMAP_HOST) return res.status(500).json({ error: 'IMAP_HOST is niet geconfigureerd.' });

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: parseInt(IMAP_PORT || '993', 10),
    secure: true,
    auth: { user: account.user, pass },
    logger: false,
    socketTimeout: 9000
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
      if (!msg || !msg.source) {
        // v=22: IMAP-miss → DB-fallback. Interne notificatie-mails
        // (leads@ "Nieuwe lead: …") staan wel in email_messages met
        // body-kolommen maar hun IMAP-uid komt niet (meer) voor in INBOX.
        const dbRow = await loadBodyFromDb(emailId);
        if (dbRow && (dbRow.body_text || dbRow.body_html)) {
          return res.status(200).json({
            attachment_token:            attachmentToken,
            attachment_token_expires_at: attachmentTokenExpiresAt,
            ...buildResponseFromDbRow(dbRow),
          });
        }
        return res.status(404).json({ error: 'E-mail niet gevonden in postvak (en geen DB-fallback).' });
      }
      const parsed = await simpleParser(msg.source);

      // Plain-text bij voorkeur (veilig en beknopt). Als alleen HTML
      // beschikbaar is gebruiken we mailparser's textAsHtml-fallback,
      // omgezet naar plain text via een eenvoudige strip — voor nu
      // tonen we geen rauwe HTML in de UI om injectie-risico te vermijden.
      let text = parsed.text || '';
      if (!text && parsed.html) {
        text = String(parsed.html)
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }

      const fromEntry = parsed.from?.value?.[0];
      const toEntries = parsed.to?.value || [];

      // Bijlagen metadata (geen content — aparte download via /api/email-attachment)
      const attachments = (parsed.attachments || []).map((a, i) => ({
        index:       i,
        filename:    a.filename || `bijlage-${i + 1}`,
        contentType: a.contentType || 'application/octet-stream',
        size:        a.size || a.content?.length || 0,
      }));

      // Fase 2B: XSS-safe HTML sanitizer. Frontend rendert via iframe
      // sandbox srcdoc — twee lagen defense. Externe images geblokkeerd
      // tot user "afbeeldingen tonen" klikt.
      let bodyHtmlSafe = '';
      let externalImagesBlocked = 0;
      if (parsed.html) {
        const s = sanitizeEmailHtml(String(parsed.html), { blockExternalImages: true });
        bodyHtmlSafe = s.html;
        externalImagesBlocked = s.externalImagesBlocked;
      }

      return res.status(200).json({
        attachment_token:            attachmentToken,
        attachment_token_expires_at: attachmentTokenExpiresAt,
        subject: parsed.subject || '',
        from: fromEntry
          ? (fromEntry.name ? `${fromEntry.name} <${fromEntry.address}>` : fromEntry.address)
          : (parsed.from?.text || ''),
        to: toEntries.length
          ? toEntries.map((t) => t.name ? `${t.name} <${t.address}>` : t.address).join(', ')
          : (parsed.to?.text || ''),
        cc: parsed.cc?.text || '',
        date: parsed.date ? new Date(parsed.date).toISOString() : null,
        text,
        hasHtml:     Boolean(parsed.html),
        body_html_safe: bodyHtmlSafe,
        external_images_blocked: externalImagesBlocked,
        attachments,
      });
    } finally {
      lock.release();
    }
  } catch (err) {
    // v=22: hard IMAP-error (timeout, connect-fail) → DB-fallback als email_id
    // aanwezig. Zo blijft de reader werken bij transient IMAP-issues.
    if (emailId) {
      const dbRow = await loadBodyFromDb(emailId);
      if (dbRow && (dbRow.body_text || dbRow.body_html)) {
        try { await client.logout(); } catch {}
        return res.status(200).json({
          attachment_token:            attachmentToken,
          attachment_token_expires_at: attachmentTokenExpiresAt,
          ...buildResponseFromDbRow(dbRow),
        });
      }
    }
    return safeError(res, 500, err, 'Mailbody kon niet worden opgehaald.');
  } finally {
    try { await client.logout(); } catch {}
  }
}
