// api/_lib/comms-log.js
//
// FIX 4 — logging-helper voor event_attendee_comms_log.
//
// Insert-pad voor uitgaande mail/WhatsApp per attendee. Wordt awaited (geen
// fire-and-forget) zodat de INSERT op Vercel daadwerkelijk afrondt; alle
// fouten worden binnen deze functie opgevangen (catch-alle) → de aanroep
// gooit nooit een exceptie naar de caller, zodat een log-fout het verzenden
// NOOIT breekt.
//
// Callers:
//   - api/_lib/events-invite.js  (sendEventAttendeeInvite — invite-mail + WA)
//   - api/_lib/events-automation-engine.js (deps.sendEmail / deps.sendWhatsApp)
//
// Spec uit FIX 4 recon: schema = event_attendee_comms_log (migratie
// 2026-06-16-event-attendee-comms-log.sql).

import { supabaseAdmin } from '../supabase.js';

const VALID_CHANNELS = new Set(['email', 'whatsapp']);
const VALID_STATUSES = new Set(['sent', 'failed', 'queued', 'skipped']);

/**
 * Log één uitgaand bericht.
 *
 * @param {object} args
 * @param {string} args.attendeeId       - uuid (verplicht)
 * @param {string} [args.eventId]        - uuid van het event
 * @param {string} args.channel          - 'email' | 'whatsapp'
 * @param {string} args.status           - 'sent' | 'failed' | 'queued' | 'skipped'
 * @param {string} [args.templateName]   - WhatsApp-template-naam
 * @param {string} [args.subject]        - e-mail-subject
 * @param {string} [args.sentByUserId]   - uuid van operator (NULL bij automation)
 * @param {string} [args.automationRunId]- uuid van event_automation_runs (NULL bij manueel)
 * @param {number} [args.stepIndex]      - step-index in automation
 * @param {string} [args.metaWamid]      - WhatsApp wamid
 * @param {string} [args.messageId]      - nodemailer messageId
 * @param {string} [args.failureReason]  - bij status='failed' of 'skipped'
 *
 * @returns {Promise<{ok:boolean, id?:string, error?:string}>}
 *   - ok=true bij succesvolle insert.
 *   - ok=false met error-text bij DB-fout (gooit NIET).
 */
export async function logComms(args = {}) {
  try {
    const {
      attendeeId, eventId,
      channel, status,
      templateName, subject,
      sentByUserId, automationRunId, stepIndex,
      metaWamid, messageId, failureReason,
    } = args || {};

    if (!attendeeId) return { ok: false, error: 'attendeeId vereist' };
    if (!channel || !VALID_CHANNELS.has(channel)) {
      return { ok: false, error: `channel ongeldig (${channel})` };
    }
    if (!status || !VALID_STATUSES.has(status)) {
      return { ok: false, error: `status ongeldig (${status})` };
    }

    const row = {
      attendee_id:        attendeeId,
      event_id:           eventId || null,
      channel,
      direction:          'outbound',
      status,
      template_name:      templateName || null,
      subject:            subject || null,
      sent_by_user_id:    sentByUserId || null,
      automation_run_id:  automationRunId || null,
      step_index:         (typeof stepIndex === 'number' && Number.isFinite(stepIndex)) ? stepIndex : null,
      meta_wamid:         metaWamid || null,
      message_id:         messageId || null,
      failure_reason:     failureReason ? String(failureReason).slice(0, 2000) : null,
    };

    const { data, error } = await supabaseAdmin
      .from('event_attendee_comms_log')
      .insert(row)
      .select('id')
      .single();

    if (error) {
      console.error('[comms-log] insert failed:', error.message);
      return { ok: false, error: error.message };
    }
    return { ok: true, id: data?.id };
  } catch (e) {
    // Catch-alle — log-fout mag verzending nooit breken.
    console.error('[comms-log] unexpected:', e?.message || e);
    return { ok: false, error: e?.message || 'unknown' };
  }
}

/**
 * Helper: map een sendEventMail-result naar log-status + reason.
 *   { success:true }  → 'sent'
 *   { success:false } → 'failed' (met error als reason)
 */
export function mapMailStatus(mailResult) {
  if (!mailResult || typeof mailResult !== 'object') {
    return { status: 'failed', reason: 'no result' };
  }
  if (mailResult.success === true) return { status: 'sent', reason: null };
  return { status: 'failed', reason: mailResult.error || 'mail send failed' };
}

/**
 * Helper: map een sendEventEmail / sendEventWhatsAppTemplate-result.
 *   { ok:true }                       → 'sent'
 *   { ok:false, skipped:true }        → 'skipped'
 *   { ok:false, error/reason }        → 'failed'
 */
export function mapSendStatus(sendResult) {
  if (!sendResult || typeof sendResult !== 'object') {
    return { status: 'failed', reason: 'no result' };
  }
  if (sendResult.ok === true) return { status: 'sent', reason: null };
  if (sendResult.skipped) {
    return { status: 'skipped', reason: sendResult.reason || 'skipped' };
  }
  return { status: 'failed', reason: sendResult.error || sendResult.reason || 'send failed' };
}
