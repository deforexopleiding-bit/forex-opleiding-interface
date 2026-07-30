// api/dunning-brief-email-send.js
// POST → mail de BEWAARDE PDF (uit storage) via Strato vanaf administratie@.
//
// FASE 6 blok 4 — juridische keten: bewijs = wat er verstuurd is, NIET een
// hergegenereerde versie. Deze endpoint pakt de PDF uit dunning_briefs.pdf_path,
// downloadt 'em uit de bucket, en mailt hem 1-op-1 als bijlage via het
// bestaande api/mailer.js sendMail() (Strato SMTP + administratie@ mailbox).
//
// FAIL-LOUD: als de mail faalt (SMTP timeout, ongeldig adres, etc), zetten
// we NIET sent_via/sent_at. In plaats daarvan: send_error kolom + 5xx
// response. Nooit een valse "verstuurd"-status.
//
// Request: POST { brief_id: uuid, to?: string }
//   - to optional: default = customer.email uit dunning_briefs → customers join.
// Response 200: { ok: true, sent_at, sent_to_email, message_id }
// Errors:
//   400 MISSING_BRIEF_ID / MISSING_EMAIL / ALREADY_SENT
//   404 NOT_FOUND
//   500 STORAGE_DOWNLOAD_FAILED / SMTP_FAILED / DB_UPDATE_FAILED
//
// Permission: finance.incasso.manage (dezelfde als de generator).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { sendMail } from './mailer.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'dunning-briefs';
const FROM_MAILBOX = 'administratie@deforexopleiding.nl';

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
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const briefId = body.brief_id ? String(body.brief_id).trim() : '';
  const overrideTo = body.to ? String(body.to).trim() : '';
  if (!briefId || !UUID_RE.test(briefId)) {
    return res.status(400).json({ error: 'brief_id (uuid) vereist', code: 'MISSING_BRIEF_ID' });
  }

  try {
    // 1) Rij ophalen + klant-email voor default To.
    const { data: brief, error: brErr } = await supabaseAdmin
      .from('dunning_briefs')
      .select('id, customer_id, pdf_path, sent_via, sent_at, country, template_code, customers(email, first_name, last_name, company_name, is_company)')
      .eq('id', briefId)
      .maybeSingle();
    if (brErr) throw new Error('brief lookup: ' + brErr.message);
    if (!brief) return res.status(404).json({ error: 'Brief niet gevonden', code: 'NOT_FOUND' });
    if (brief.sent_via) {
      // Al eerder verstuurd — voorkom dubbele send. UI moet dit tonen.
      return res.status(400).json({
        error: `Deze brief is al verstuurd (${brief.sent_via} op ${brief.sent_at}). Genereer een nieuwe als nodig.`,
        code: 'ALREADY_SENT',
        sent_via: brief.sent_via,
        sent_at: brief.sent_at,
      });
    }

    // 2) Bepaal To-adres: override > customer.email.
    const to = overrideTo || brief.customers?.email || '';
    if (!to) {
      return res.status(400).json({ error: 'Geen e-mailadres beschikbaar (klant heeft geen email + geen override meegegeven)', code: 'MISSING_EMAIL' });
    }

    // 3) PDF downloaden uit storage (de BEWAARDE brief, NIET hergenereren).
    const { data: fileBlob, error: dlErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(brief.pdf_path);
    if (dlErr || !fileBlob) {
      console.error('[dunning-brief-email-send] storage download failed:', dlErr?.message);
      return res.status(500).json({
        error: 'PDF-download uit storage mislukt: ' + (dlErr?.message || 'geen blob'),
        code: 'STORAGE_DOWNLOAD_FAILED',
      });
    }
    const arrayBuffer = await fileBlob.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuffer);

    // 4) Subject + body samenstellen.
    const custDisplay = brief.customers?.is_company
      ? (brief.customers.company_name || 'geachte klant')
      : `${brief.customers?.first_name || ''} ${brief.customers?.last_name || ''}`.trim() || 'geachte klant';
    const subject = brief.country === 'BE'
      ? 'Eerste (kosteloze) herinnering — De Forex Opleiding'
      : 'Belangrijke herinnering (WIK-14-dagenbrief) — De Forex Opleiding';
    const text = [
      `Beste ${custDisplay},`,
      '',
      brief.country === 'BE'
        ? 'In de bijlage vindt u onze eerste (kosteloze) herinnering betreffende openstaande facturen.'
        : 'In de bijlage vindt u onze wettelijke aanmaning (WIK-brief) betreffende openstaande facturen. U heeft 14 dagen de tijd om alsnog te betalen.',
      '',
      'Met vriendelijke groet,',
      'De Forex Opleiding NL B.V.',
      'administratie@deforexopleiding.nl',
    ].join('\n');
    const filename = `WIK-brief_${brief.country}_${brief.customer_id.slice(0, 8)}.pdf`;

    // 5) SEND via bestaande Strato-mailer (fase 4G-patroon). Fail-loud.
    const sendRes = await sendMail({
      to,
      subject,
      text,
      from: FROM_MAILBOX,
      fromName: 'De Forex Opleiding — Administratie',
      attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
    });
    if (!sendRes?.success) {
      const errMsg = sendRes?.error || 'onbekende SMTP-fout';
      console.error('[dunning-brief-email-send] SMTP failed:', errMsg);
      // Persist send_error zodat UI kan tonen wat er misging (fail-loud
      // maar zonder valse "verstuurd"-status).
      try {
        await supabaseAdmin
          .from('dunning_briefs')
          .update({ send_error: errMsg.slice(0, 500) })
          .eq('id', briefId);
      } catch (_) {}
      return res.status(500).json({
        error: 'Mail-verzenden mislukt: ' + errMsg,
        code: 'SMTP_FAILED',
      });
    }

    // 6) Success → sent_via='email' + sent_at + sent_to_email + user + clear error.
    const sentAtIso = new Date().toISOString();
    const { error: updErr } = await supabaseAdmin
      .from('dunning_briefs')
      .update({
        sent_via: 'email',
        sent_at: sentAtIso,
        sent_to_email: to,
        sent_by_user_id: user.id,
        send_error: null,
      })
      .eq('id', briefId);
    if (updErr) {
      console.error('[dunning-brief-email-send] DB update after send failed:', updErr.message);
      // Mail is verzonden maar DB-update faalde — dat is een gedeeltelijke
      // success. We loggen het en returnen 200 met een waarschuwing zodat
      // UI weet dat de mail wel weg is.
      return res.status(200).json({
        ok: true,
        warning: 'Mail verstuurd, maar status-update in DB mislukt: ' + updErr.message,
        sent_at: sentAtIso,
        sent_to_email: to,
        message_id: sendRes.messageId,
      });
    }

    // 7) dunning_log-event zodat timeline 'em toont.
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id: null, step_id: null,
        event_type: 'incasso_pre_brief_emailed',
        payload: {
          customer_id: brief.customer_id, brief_id: briefId, to,
          message_id: sendRes.messageId, sent_at: sentAtIso,
        },
      });
    } catch (_) {}

    return res.status(200).json({
      ok: true,
      sent_at: sentAtIso,
      sent_to_email: to,
      message_id: sendRes.messageId,
    });
  } catch (e) {
    console.error('[dunning-brief-email-send]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
