// api/_lib/afspraak-faillog.js
//
// Persistente faillog voor de afspraak-berichtenflow (kennismakingsgesprekken).
// Maakt STILLE verzendfouten zichtbaar: elke mislukte WhatsApp- (of mail-)
// verzending wordt weggeschreven met moment, kanaal, reden en tijdstip.
//
// Volledig fail-soft: een log-fout mag de cron NOOIT breken.

import { supabaseAdmin } from '../supabase.js';

/**
 * @param {object} o
 * @param {string} o.appointmentId  follow_up_appointments.id
 * @param {string} o.moment         'bevestiging' | 'r24' | 'r2' | 'r30' | 'r5'
 * @param {string} o.kanaal         'whatsapp' | 'email'
 * @param {string} [o.templateName] WA-template (bij whatsapp)
 * @param {string} [o.reason]       foutreden
 * @param {number|null} [o.httpStatus]
 * @param {string} [o.toPhone]
 */
export async function logAfspraakFail({ appointmentId, moment, kanaal, templateName = null, reason = null, httpStatus = null, toPhone = null }) {
  try {
    await supabaseAdmin.from('afspraak_bericht_faillog').insert({
      appointment_id: appointmentId || null,
      moment: moment || null,
      kanaal: kanaal || null,
      template_name: templateName || null,
      reason: reason != null ? String(reason).slice(0, 500) : null,
      http_status: Number.isFinite(httpStatus) ? httpStatus : null,
      to_phone: toPhone || null,
    });
  } catch (e) {
    console.warn('[afspraak-faillog] insert (soft):', e?.message || e);
  }
}
