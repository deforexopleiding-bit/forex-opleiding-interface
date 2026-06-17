// api/_lib/events-invite.js
//
// Herbruikbare invite-flow voor event-attendees:
//   - bouwt keuze-link op basis van attendee.choice_token
//   - stuurt WhatsApp-template (Simone-lijn) + e-mail parallel
//   - rapporteert beide kanalen los; één faal-tak blokkeert de andere niet
//
// Gedeeld door:
//   - api/events-attendee-send-invite.js (operator-knop in detail-pagina)
//   - api/events-attendee-add.js          (optionele invite bij handmatige aanmelding)
//   - api/events-attendee-move.js         (optionele invite bij verplaatsen)
//
// CONFIGURATIE (zelfde als events-attendee-send-invite.js):
//   PUBLIC_BASE_URL                   (env, fallback vercel.app)
//   EVENTS_KEUZE_LINK_TEMPLATE_NAME   (env, fallback 'events_keuze_link')

import { supabaseAdmin } from '../supabase.js';
import { sendEventMail, wrapEmailHtml } from '../mailer.js';
import { sendEventWhatsAppTemplate } from './events-send.js';
import { logComms, mapMailStatus, mapSendStatus } from './comms-log.js';

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://forex-opleiding-interface.vercel.app';
const TEMPLATE_NAME   = process.env.EVENTS_KEUZE_LINK_TEMPLATE_NAME || 'events_keuze_link';
const TEMPLATE_LANG   = 'nl';

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendInviteMail({ firstName, keuzeLink, toEmail }) {
  if (!toEmail) return { ok: false, skipped: true, reason: 'no-email' };

  const subject = 'Kies de datum voor je Forex Masterclass';
  const naam = firstName || 'jij';

  const html = wrapEmailHtml(subject, `
    <p>Hoi ${escHtml(naam)},</p>
    <p>Leuk dat je erbij wilt zijn! Kies hieronder de datum die jou het beste past — je ziet meteen welke data nog plek hebben.</p>
    <p style="text-align:center;margin:28px 0">
      <a href="${escHtml(keuzeLink)}" style="display:inline-block;background:#093d54;color:#ffffff;padding:12px 28px;border-radius:8px;font-weight:600;text-decoration:none">Kies je datum</a>
    </p>
    <p>Heb je de korte vragenlijst nog niet ingevuld? Dat doe je in dezelfde stap; zo krijg je meteen het advies dat bij jouw niveau past.</p>
    <p style="margin-top:32px">Tot snel!<br>— Simone, De Forex Opleiding</p>
  `);

  const text = `Hoi ${naam}, kies de datum voor je Forex Masterclass: ${keuzeLink} — Simone, De Forex Opleiding`;

  try {
    await sendEventMail({ to: toEmail, subject, text, html });
    return { ok: true };
  } catch (e) {
    console.error('[events-invite] mail:', e?.message || e);
    return { ok: false, error: e?.message || 'mail send failed' };
  }
}

/**
 * Stuur invite (WhatsApp + e-mail) voor een attendee.
 *
 * @param {object} opts
 * @param {string} opts.attendeeId      - uuid van de attendee-rij
 * @param {string} opts.sentByUserId    - uuid van de operator (audit-koppeling)
 * @returns {Promise<{ok:boolean, error?:string, keuze_link?:string, mail?:object, whatsapp?:object}>}
 */
export async function sendEventAttendeeInvite({ attendeeId, sentByUserId }) {
  if (!attendeeId) return { ok: false, error: 'attendee_id ontbreekt' };

  try {
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id')
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

    const keuzeLink = `${PUBLIC_BASE_URL}/modules/event-keuze.html?t=${encodeURIComponent(attendee.choice_token)}`;

    const [waResult, mailResult] = await Promise.all([
      sendEventWhatsAppTemplate({
        attendee,
        event,
        templateName : TEMPLATE_NAME,
        languageCode : TEMPLATE_LANG,
        sentByUserId : sentByUserId || null,
      }),
      sendInviteMail({
        firstName: attendee.first_name,
        keuzeLink,
        toEmail  : attendee.email,
      }),
    ]);

    // FIX 4 — log naar event_attendee_comms_log. Awaited binnen try/catch
    // (fail-soft) zodat een log-fout het verzenden nooit breekt en de
    // INSERT op Vercel daadwerkelijk afrondt.
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
      console.error('[events-invite comms-log wa]', e?.message || e);
    }
    try {
      const mailMap = mapMailStatus(mailResult);
      await logComms({
        attendeeId:    attendee.id,
        eventId:       attendee.event_id,
        channel:       'email',
        status:        mailMap.status,
        subject:       'Kies de datum voor je Forex Masterclass',
        sentByUserId:  sentByUserId || null,
        messageId:     mailResult?.messageId || null,
        failureReason: mailMap.reason,
      });
    } catch (e) {
      console.error('[events-invite comms-log mail]', e?.message || e);
    }

    const ok = !!(waResult?.ok || mailResult?.ok);
    return {
      ok,
      keuze_link: keuzeLink,
      mail: mailResult,
      whatsapp: waResult,
    };
  } catch (e) {
    console.error('[events-invite] fatal:', e?.message || e);
    return { ok: false, error: e?.message || 'invite send failed' };
  }
}
