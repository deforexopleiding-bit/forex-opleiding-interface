// api/_lib/sanne-send-mail.js
//
// Autonomous mail-send voor Sanne (Fase 2.3). Doet:
//   1) Preview-guard (VERCEL_ENV != 'production' -> alles naar Jeffrey's mail
//      met [PREVIEW]-prefix). Zelfde regel als email-send-v2.js.
//   2) SMTP-send via nodemailer met de mailbox-eigen credentials.
//   3) email_replies-insert (sent_by_id=NULL want Sanne is geen user).
//   4) email_messages.requires_action=false op de bron-mail (thread-close).
//
// KRITIEK: alleen aanroepen NA een geslaagde autonomy-evaluate met mode=
// 'autonomous_send' EN nadat de defense-in-depth 2e check ook groen is.
// Deze helper zelf checkt geen flags/mandates — die check ligt in de
// caller (sanne-suggest.js).

import nodemailer from 'nodemailer';

const SMTP_ACCOUNTS = {
  leads:         'IMAP_PASS',
  info:          'IMAP_PASS_INFO',
  partners:      'IMAP_PASS_PARTNERS',
  administratie: 'IMAP_PASS_ADMINISTRATIE',
  onboarding:    'IMAP_PASS_ONBOARDING',
  events:        'IMAP_PASS_EVENTS',
  welkom:        'IMAP_PASS_WELKOM',
};

const PREVIEW_TO_OVERRIDE = 'biemoldjeffrey@gmail.com';

/**
 * Verstuur Sanne's concept-antwoord.
 *
 * @param {object} supabase  supabaseAdmin client
 * @param {object} args
 *   - mailbox        (slug: 'info' / 'leads' / ...)
 *   - to             (klant-adres uit email.from_address)
 *   - subject        (draft_subject)
 *   - text           (draft_body_text — plain text)
 *   - html           (draft_body_html — geoptimaliseerd, mag null)
 *   - sourceEmailId  (email_messages.id — voor requires_action=false)
 *   - inReplyToMsgId (optional Message-ID header voor threading)
 * @returns { ok, messageId, accepted[], reply_id, guarded, env }
 */
export async function sanneSendMail(supabase, args) {
  const {
    mailbox, to, subject, text, html,
    sourceEmailId, inReplyToMsgId,
  } = args || {};

  if (!mailbox || !to || !subject || !text) {
    throw new Error('sanne-send: mailbox+to+subject+text verplicht');
  }
  const passEnv = SMTP_ACCOUNTS[String(mailbox).toLowerCase()];
  if (!passEnv) throw new Error(`sanne-send: onbekende mailbox ${mailbox}`);
  const password = process.env[passEnv];
  if (!password) throw new Error(`sanne-send: SMTP-wachtwoord ontbreekt (${passEnv})`);

  const smtpHost = process.env.SMTP_HOST || process.env.IMAP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
  if (!smtpHost) throw new Error('sanne-send: SMTP_HOST niet geconfigureerd');

  // Preview-guard — zelfde regel als email-send-v2.
  const vercelEnv = String(process.env.VERCEL_ENV || 'development').toLowerCase();
  const isProd = vercelEnv === 'production';
  let effectiveTo = to;
  let effectiveSubject = subject;
  let guarded = false;
  let originalTo = null;
  if (!isProd) {
    guarded = true;
    originalTo = to;
    effectiveTo = PREVIEW_TO_OVERRIDE;
    effectiveSubject = `[PREVIEW SANNE → was: ${to}] ${subject}`;
  }

  const fromAddr = `${mailbox}@deforexopleiding.nl`;
  const transporter = nodemailer.createTransport({
    host: smtpHost, port: smtpPort, secure: true,
    auth: { user: fromAddr, pass: password },
  });

  const mailOpts = {
    from: `"De Forex Opleiding" <${fromAddr}>`,
    to: effectiveTo,
    subject: effectiveSubject,
    text,
    replyTo: fromAddr,
  };
  if (html) mailOpts.html = html;
  if (inReplyToMsgId) { mailOpts.inReplyTo = inReplyToMsgId; mailOpts.references = inReplyToMsgId; }

  console.log(`[sanne-send] env=${vercelEnv} guarded=${guarded} van:${fromAddr} naar:${effectiveTo}${originalTo ? ` (orig:${originalTo})` : ''}`);

  const info = await transporter.sendMail(mailOpts);
  console.log(`[sanne-send] verstuurd — messageId:${info.messageId} accepted:${(info.accepted || []).join(', ')}`);

  // email_replies-insert. sent_by_id=NULL want Sanne is geen user.
  const sentAt = new Date().toISOString();
  let replyId = null;
  try {
    const { data: replyRow, error: replyErr } = await supabase.from('email_replies').insert({
      email_id:      null, // Sanne-flow gebruikt sanne_suggestions.email_id, niet de v1 'mailbox:uid'-string
      email_subject: effectiveSubject,
      final_reply:   text,
      from_address:  fromAddr,
      to_address:    effectiveTo,
      cc_address:    null,
      bcc_address:   null,
      sent_at:       sentAt,
      sent_by_id:    null,
      attachments:   null,
    }).select('id').maybeSingle();
    if (replyErr) console.warn('[sanne-send] email_replies insert fail-soft:', replyErr.message);
    else replyId = replyRow?.id || null;
  } catch (e) {
    console.warn('[sanne-send] email_replies insert threw:', e?.message);
  }

  // Bron-mail requires_action=false zetten zodat de reader er niet meer op wijst.
  if (sourceEmailId) {
    try {
      await supabase.from('email_messages').update({ requires_action: false }).eq('id', sourceEmailId);
    } catch (_) { /* fail-soft */ }
  }

  return {
    ok: true,
    messageId: info.messageId,
    accepted: info.accepted || [],
    reply_id: replyId,
    guarded,
    guard_target: guarded ? PREVIEW_TO_OVERRIDE : null,
    original_to: originalTo,
    env: vercelEnv,
  };
}
