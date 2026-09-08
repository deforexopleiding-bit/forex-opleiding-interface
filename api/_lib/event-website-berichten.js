// api/_lib/event-website-berichten.js
//
// Gedeelde helpers voor het FUNNEL-EIGEN berichtenpad (created_via='website'):
//   - verzendlog (dubbel-preventie) op tabel event_website_berichten
//   - één plek die WhatsApp (template) + mail verstuurt en per-kanaal logt
//   - dynamische keuze van het vervolg-herinnering-template
//
// GHL-VEILIG: raakt event_automations / automation_enabled / de engine niet.
// Alle callers (finalize + cron) selecteren zelf uitsluitend created_via=
// 'website' + is_test=false; deze helpers doen geen eigen attendee-selectie.

import { supabaseAdmin } from '../supabase.js';
import { sendEventMail } from '../mailer.js';
import { sendEventWhatsAppTemplate } from './events-send.js';
import { logComms, mapMailStatus, mapSendStatus } from './comms-log.js';

export const SOORTEN = {
  BEVESTIGING: 'bevestiging',
  VERVOLG_2U: 'vervolg_2u',
  VERVOLG_24U: 'vervolg_24u',
  WARMUP: 'warmup',
  REMINDER_24U: 'reminder_24u',
  REMINDER_1U: 'reminder_1u',
};

const DFO_BASE = (process.env.DFO_WEBSITE_BASE_URL || 'https://www.deforexopleiding.nl').replace(/\/+$/, '');

/** Branded /vervolg-link op basis van de choice_token. */
export function vervolgLink(choiceToken) {
  return choiceToken ? `${DFO_BASE}/vervolg?t=${encodeURIComponent(String(choiceToken))}` : '';
}

/** Is dit berichttype al voor deze attendee verstuurd? (NOT EXISTS-check) */
export async function reedsVerstuurd(attendeeId, soort) {
  const { data, error } = await supabaseAdmin
    .from('event_website_berichten')
    .select('id').eq('attendee_id', attendeeId).eq('soort', soort).maybeSingle();
  if (error) throw new Error('reedsVerstuurd: ' + error.message);
  return !!data;
}

/** Markeer verstuurd. Unique-conflict (dubbel) wordt genegeerd. */
export async function markeerVerstuurd(attendeeId, eventId, soort, kanaal) {
  const { error } = await supabaseAdmin
    .from('event_website_berichten')
    .insert({ attendee_id: attendeeId, event_id: eventId || null, soort, kanaal: kanaal || null });
  if (error && !/duplicate key|unique/i.test(error.message)) {
    throw new Error('markeerVerstuurd: ' + error.message);
  }
}

/**
 * Kies dynamisch het WhatsApp-template voor de vervolg-herinnering:
 * 'event_vervolg_herinnering' ZODRA dat bestaat en APPROVED is; anders val
 * terug op het al goedgekeurde 'event_vragenlijst_definitief'. Zo hoeft er
 * later geen code te wijzigen als de nieuwe template wordt goedgekeurd.
 * @returns {Promise<{ template: string, mapping: object }>}
 */
export async function kiesVervolgTemplate() {
  try {
    const { data } = await supabaseAdmin
      .from('whatsapp_meta_templates')
      .select('status').eq('name', 'event_vervolg_herinnering').maybeSingle();
    if (String(data?.status || '').toUpperCase() === 'APPROVED') {
      return { template: 'event_vervolg_herinnering', mapping: { body: { 1: 'attendee.voornaam', 2: 'event.titel', 3: 'attendee.vervolg_link' } } };
    }
  } catch (e) {
    console.error('[event-website-berichten] kiesVervolgTemplate (soft):', e?.message || e);
  }
  // Fallback: bestaande, goedgekeurde invite-template (4 variabelen).
  return { template: 'event_vragenlijst_definitief', mapping: { body: { 1: 'attendee.voornaam', 2: 'event.titel', 3: 'event.datum', 4: 'attendee.vervolg_link' } } };
}

/**
 * Verstuur één bericht via WhatsApp (template) + mail, en log beide kanalen.
 * Kanaal wordt overgeslagen als telefoon/e-mail ontbreekt. ok = minstens één
 * kanaal geslaagd.
 * @param {object} o
 * @param {object} o.attendee  - rij met id,event_id,first_name,last_name,email,phone,choice_token,customer_id
 * @param {object} o.event     - rij met id,title,starts_at,...
 * @param {string} o.waTemplate
 * @param {object} [o.waMappingOverride]
 * @param {{subject,text,html}} o.mail
 * @param {string} o.soort      - voor de comms-log-context
 */
export async function stuurWaEnMail({ attendee, event, waTemplate, waMappingOverride = null, mail, soort }) {
  const [waRes, mailRes] = await Promise.all([
    attendee.phone
      ? sendEventWhatsAppTemplate({ attendee, event, templateName: waTemplate, languageCode: 'nl', paramMappingOverride: waMappingOverride || undefined })
      : Promise.resolve({ ok: false, skipped: true, reason: 'no-phone' }),
    (mail && attendee.email)
      ? sendEventMail({ to: attendee.email, subject: mail.subject, text: mail.text, html: mail.html })
      : Promise.resolve({ success: false, skipped: true, reason: 'no-email' }),
  ]);

  const mailOk = mailRes && mailRes.success === true;
  try {
    const waMap = mapSendStatus(waRes);
    await logComms({ attendeeId: attendee.id, eventId: attendee.event_id, channel: 'whatsapp', status: waMap.status, templateName: waTemplate, metaWamid: waRes?.meta_wamid || null, failureReason: waMap.reason });
  } catch (e) { console.error('[event-website-berichten comms wa]', e?.message || e); }
  try {
    const mailMap = mapMailStatus(mailRes);
    await logComms({ attendeeId: attendee.id, eventId: attendee.event_id, channel: 'email', status: mailMap.status, subject: mail?.subject, messageId: mailRes?.messageId || null, failureReason: mailMap.reason });
  } catch (e) { console.error('[event-website-berichten comms mail]', e?.message || e); }

  return { ok: !!(waRes?.ok || mailOk), soort, whatsapp: waRes, mail: mailRes };
}
