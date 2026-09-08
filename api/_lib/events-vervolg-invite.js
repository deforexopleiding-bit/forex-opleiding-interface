// api/_lib/events-vervolg-invite.js
//
// STAP 2 — invite (mail + WhatsApp) die de toegelaten gate-aanmelder naar de
// BRANDED dfo-website vervolgpagina stuurt om de aanmelding definitief te maken.
// Parallel aan events-questionnaire-invite.js (die naar de CRM-assessment-pagina
// wijst); we laten dat origineel intact en bouwen een eigen variant.
//
// Verschillen:
//   - URL     : ${DFO_WEBSITE_BASE_URL}/vervolg?t=<choice_token>  (merk-domein)
//   - Template: EVENTS_VERVOLG_TEMPLATE_NAME, default 'event_vragenlijst_definitief'
//
// Gebruikt door: api/public-event-vervolg-invite.js (aangeroepen door de
// dfo-website gate-book, x-internal-token).

import { supabaseAdmin } from '../supabase.js';
import { sendEventMail, wrapEmailHtml } from '../mailer.js';
import { sendEventWhatsAppTemplate } from './events-send.js';
import { logComms, mapMailStatus, mapSendStatus } from './comms-log.js';

const DFO_BASE      = (process.env.DFO_WEBSITE_BASE_URL || 'https://www.deforexopleiding.nl').replace(/\/+$/, '');
const TEMPLATE_NAME = process.env.EVENTS_VERVOLG_TEMPLATE_NAME || 'event_vragenlijst_definitief';
const TEMPLATE_LANG = 'nl';

function escHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtEventDateNL(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('nl-NL', {
      timeZone: 'Europe/Amsterdam', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return d.toISOString(); }
}

async function sendVervolgMail({ firstName, vervolgLink, eventTitle, eventStartsAt, toEmail }) {
  if (!toEmail) return { ok: false, skipped: true, reason: 'no-email' };
  const titleStr  = eventTitle || 'het event';
  const subject   = 'Maak je inschrijving definitief voor ' + titleStr;
  const naam      = firstName || 'jij';
  const datumLine = eventStartsAt ? ' op ' + fmtEventDateNL(eventStartsAt) : '';

  const html = wrapEmailHtml(subject, `
    <p>Hoi ${escHtml(naam)},</p>
    <p>Goed nieuws — je bent toegelaten voor de <strong>${escHtml(titleStr)}</strong>${escHtml(datumLine)}.</p>
    <p>Je plek is nog <strong>niet definitief</strong>. Vul kort onze vragenlijst in (2 minuten), dan zetten we je inschrijving definitief en sturen we je de voorbereiding.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${escHtml(vervolgLink)}" style="display:inline-block;background:#2563eb;color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none">Vragenlijst invullen</a>
    </p>
    <p>Vul je gegevens niet in, dan vervalt je plek automatisch.</p>
    <p style="margin-top:32px">Tot snel!<br>— Team De Forex Opleiding</p>
  `);
  const text = `Hoi ${naam}, je bent toegelaten voor ${titleStr}${datumLine}. Maak je inschrijving definitief via de korte vragenlijst: ${vervolgLink} — Team De Forex Opleiding`;

  try {
    const result = await sendEventMail({ to: toEmail, subject, text, html });
    if (!result || result.success !== true) {
      const reason = result?.error || 'unknown mailer error';
      console.error('[events-vervolg-invite] mail failed:', reason, '| to:', toEmail);
      return { ok: false, error: reason };
    }
    return { ok: true, messageId: result.messageId || null };
  } catch (e) {
    console.error('[events-vervolg-invite] mail throw:', e?.message || e, '| to:', toEmail);
    return { ok: false, error: e?.message || 'mail send failed (throw)' };
  }
}

/**
 * Stuur de Stap-2-uitnodiging (WhatsApp + e-mail) voor één attendee.
 * @param {object} opts
 * @param {string} opts.attendeeId
 * @param {string} [opts.sentByUserId]
 */
export async function sendEventAttendeeVervolg({ attendeeId, sentByUserId = null }) {
  if (!attendeeId) return { ok: false, error: 'attendee_id ontbreekt' };
  try {
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id, assessment_response_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee fetch: ' + attErr.message);
    if (!attendee) return { ok: false, error: 'Deelnemer niet gevonden' };
    if (!attendee.choice_token) return { ok: false, error: 'Deelnemer mist choice_token' };

    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, location, niveau, capacity, status')
      .eq('id', attendee.event_id)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return { ok: false, error: 'Event niet gevonden' };

    const vervolgLink = `${DFO_BASE}/vervolg?t=${encodeURIComponent(attendee.choice_token)}`;

    const [waResult, mailResult] = await Promise.all([
      sendEventWhatsAppTemplate({ attendee, event, templateName: TEMPLATE_NAME, languageCode: TEMPLATE_LANG, sentByUserId }),
      sendVervolgMail({ firstName: attendee.first_name, vervolgLink, eventTitle: event.title, eventStartsAt: event.starts_at, toEmail: attendee.email }),
    ]);

    try {
      const waMap = mapSendStatus(waResult);
      await logComms({ attendeeId: attendee.id, eventId: attendee.event_id, channel: 'whatsapp', status: waMap.status, templateName: TEMPLATE_NAME, sentByUserId, metaWamid: waResult?.meta_wamid || null, failureReason: waMap.reason });
    } catch (e) { console.error('[events-vervolg-invite comms wa]', e?.message || e); }
    try {
      const mailMap = mapMailStatus(mailResult);
      await logComms({ attendeeId: attendee.id, eventId: attendee.event_id, channel: 'email', status: mailMap.status, subject: 'Maak je inschrijving definitief voor ' + (event.title || 'het event'), sentByUserId, messageId: mailResult?.messageId || null, failureReason: mailMap.reason });
    } catch (e) { console.error('[events-vervolg-invite comms mail]', e?.message || e); }

    return { ok: !!(waResult?.ok || mailResult?.ok), vervolg_link: vervolgLink, mail: mailResult, whatsapp: waResult };
  } catch (e) {
    console.error('[events-vervolg-invite] fatal:', e?.message || e);
    return { ok: false, error: e?.message || 'vervolg invite send failed' };
  }
}
