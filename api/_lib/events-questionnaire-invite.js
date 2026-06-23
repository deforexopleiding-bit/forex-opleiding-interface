// api/_lib/events-questionnaire-invite.js
//
// Herbruikbare invite-flow voor de VRAGENLIJST (assessment) per event-
// attendee. Parallel aan api/_lib/events-invite.js (die de keuze-link
// verstuurt). Beide zenden een WhatsApp-template + e-mail los van elkaar
// en rapporteren per-kanaal.
//
// Verschillen met events-invite.js:
//   - URL-pad   : /modules/assessment.html?t=<choice_token>
//                 (dezelfde URL die ook gebruikt wordt door
//                 attendee.vragenlijst_link in template-variables.js)
//   - Template  : EVENTS_QUESTIONNAIRE_TEMPLATE_NAME, default
//                 'vragenlijst_herinnering'
//   - Subject   : "Vul je vragenlijst in voor <event.title>"
//   - Body      : korte uitnodiging om de vragenlijst af te ronden
//
// Gebruikt door:
//   - api/events-attendee-send-questionnaire.js (operator-knop in
//     events-detail.html kebab-menu)
//
// CONFIGURATIE:
//   PUBLIC_BASE_URL                          (env, fallback vercel.app)
//   EVENTS_QUESTIONNAIRE_TEMPLATE_NAME       (env, fallback 'vragenlijst_herinnering')

import { supabaseAdmin } from '../supabase.js';
import { sendEventMail, wrapEmailHtml } from '../mailer.js';
import { sendEventWhatsAppTemplate } from './events-send.js';
import { logComms, mapMailStatus, mapSendStatus } from './comms-log.js';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app';
const TEMPLATE_NAME   = process.env.EVENTS_QUESTIONNAIRE_TEMPLATE_NAME || 'vragenlijst_herinnering_v3';
const TEMPLATE_LANG   = 'nl';

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Nederlandse datum-tijd voor "op <datum>" in de mail. starts_at is een
// timestamptz; we tonen 'm in Europe/Amsterdam-tijd.
function fmtEventDateNL(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString('nl-NL', {
      timeZone: 'Europe/Amsterdam',
      day      : 'numeric',
      month    : 'long',
      year     : 'numeric',
      hour     : '2-digit',
      minute   : '2-digit',
    });
  } catch {
    return d.toISOString();
  }
}

async function sendQuestionnaireMail({ firstName, vragenlijstLink, eventTitle, eventStartsAt, toEmail }) {
  if (!toEmail) return { ok: false, skipped: true, reason: 'no-email' };

  const titleStr  = eventTitle || 'het event';
  const subject   = 'Vul je vragenlijst in voor ' + titleStr;
  const naam      = firstName || 'jij';
  const datumLine = eventStartsAt ? ' op ' + fmtEventDateNL(eventStartsAt) : '';

  const html = wrapEmailHtml(subject, `
    <p>Hoi ${escHtml(naam)},</p>
    <p>Bedankt voor je aanmelding voor de <strong>${escHtml(titleStr)}</strong>${escHtml(datumLine)}.</p>
    <p>Om je inschrijving definitief te maken vragen we je nog kort een vragenlijst in te vullen — duurt geen 2 minuten.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${escHtml(vragenlijstLink)}" style="display:inline-block;background:#093d54;color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none">Vul de vragenlijst in</a>
    </p>
    <p style="margin-top:32px">Tot snel!<br>— Team De Forex Opleiding</p>
  `);

  const text = `Hoi ${naam}, vul de vragenlijst in voor ${titleStr}${datumLine}: ${vragenlijstLink} — Team De Forex Opleiding`;

  try {
    const result = await sendEventMail({ to: toEmail, subject, text, html });
    if (!result || result.success !== true) {
      const reason = result?.error || 'unknown mailer error';
      console.error('[events-questionnaire-invite] mail send failed:', reason, '| to:', toEmail);
      return { ok: false, error: reason };
    }
    return { ok: true, messageId: result.messageId || null };
  } catch (e) {
    console.error('[events-questionnaire-invite] mail throw:', e?.message || e, '| to:', toEmail);
    return { ok: false, error: e?.message || 'mail send failed (throw)' };
  }
}

/**
 * Stuur vragenlijst-uitnodiging (WhatsApp + e-mail) voor een attendee.
 *
 * @param {object} opts
 * @param {string} opts.attendeeId      - uuid van de attendee-rij
 * @param {string} opts.sentByUserId    - uuid van de operator (audit-koppeling)
 * @returns {Promise<{ok:boolean, error?:string, vragenlijst_link?:string, mail?:object, whatsapp?:object}>}
 */
export async function sendEventAttendeeQuestionnaire({ attendeeId, sentByUserId }) {
  if (!attendeeId) return { ok: false, error: 'attendee_id ontbreekt' };

  try {
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id, assessment_response_id')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee fetch: ' + attErr.message);
    if (!attendee) return { ok: false, error: 'Deelnemer niet gevonden' };
    if (!attendee.choice_token) {
      return { ok: false, error: 'Deelnemer mist choice_token' };
    }

    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, location, niveau, capacity, status')
      .eq('id', attendee.event_id)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return { ok: false, error: 'Event niet gevonden' };

    // Zelfde URL-vorm als attendee.vragenlijst_link in template-variables.js
    // (regel ~444). Belangrijk dat ze identiek zijn — de WhatsApp-template
    // resolveert via die variabele, de e-mail bouwt hier zelf de link.
    const vragenlijstLink = `${PUBLIC_BASE_URL}/modules/assessment.html?t=${encodeURIComponent(attendee.choice_token)}`;

    const [waResult, mailResult] = await Promise.all([
      sendEventWhatsAppTemplate({
        attendee,
        event,
        templateName : TEMPLATE_NAME,
        languageCode : TEMPLATE_LANG,
        sentByUserId : sentByUserId || null,
      }),
      sendQuestionnaireMail({
        firstName       : attendee.first_name,
        vragenlijstLink,
        eventTitle      : event.title,
        eventStartsAt   : event.starts_at,
        toEmail         : attendee.email,
      }),
    ]);

    // Log comms — zelfde fail-soft try/catch als events-invite.js.
    try {
      const waMap = mapSendStatus(waResult);
      await logComms({
        attendeeId:    attendee.id,
        eventId:       attendee.event_id,
        channel:       'whatsapp',
        status:        waMap.status,
        templateName:  TEMPLATE_NAME,
        sentByUserId:  sentByUserId || null,
        metaWamid:     waResult?.meta_wamid || null,
        failureReason: waMap.reason,
      });
    } catch (e) {
      console.error('[events-questionnaire-invite comms-log wa]', e?.message || e);
    }
    try {
      const mailMap = mapMailStatus(mailResult);
      await logComms({
        attendeeId:    attendee.id,
        eventId:       attendee.event_id,
        channel:       'email',
        status:        mailMap.status,
        subject:       'Vul je vragenlijst in voor ' + (event.title || 'het event'),
        sentByUserId:  sentByUserId || null,
        messageId:     mailResult?.messageId || null,
        failureReason: mailMap.reason,
      });
    } catch (e) {
      console.error('[events-questionnaire-invite comms-log mail]', e?.message || e);
    }

    const ok = !!(waResult?.ok || mailResult?.ok);
    return {
      ok,
      vragenlijst_link: vragenlijstLink,
      mail: mailResult,
      whatsapp: waResult,
    };
  } catch (e) {
    console.error('[events-questionnaire-invite] fatal:', e?.message || e);
    return { ok: false, error: e?.message || 'questionnaire invite send failed' };
  }
}
