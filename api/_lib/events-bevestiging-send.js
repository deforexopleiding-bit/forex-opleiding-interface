// api/_lib/events-bevestiging-send.js
//
// FUNNEL-EIGEN bevestiging zodra een website-aanmelder Definitief wordt
// (assessment_response_id gezet in event-vervolg-finalize). Stuurt WhatsApp
// 'bevestiging_pdf' + de bevestigingsmail (exacte tekst uit rapport A.1), met
// praktische info uit de events-rij (location/starts_at + optioneel
// description_md).
//
// GHL-VEILIG: dit pad wordt alleen aangeroepen vanuit het website-vervolg-pad
// en verstuurt via de gedeelde stuurWaEnMail-helper; raakt event_automations /
// automation_enabled / de engine niet.

import { supabaseAdmin } from '../supabase.js';
import { stuurWaEnMail, SOORTEN } from './event-website-berichten.js';
import { bevestigingMail, datumNL, tijdNL } from './event-website-teksten.js';

const TEMPLATE = 'bevestiging_pdf';
// bevestiging_pdf heeft in de DB al een meta_param_mapping; we geven 'm óók als
// fallback mee zodat de send niet stukloopt mocht die ooit ontbreken.
const WA_MAPPING = { body: { 1: 'attendee.voornaam', 2: 'event.titel', 3: 'event.datum', 4: 'event.starttijd' } };

/**
 * @param {object} o
 * @param {string} o.attendeeId
 * @returns {Promise<{ok:boolean, mail?:object, whatsapp?:object, error?:string}>}
 */
export async function sendEventAttendeeBevestiging({ attendeeId }) {
  if (!attendeeId) return { ok: false, error: 'attendee_id ontbreekt' };
  try {
    const { data: attendee, error: attErr } = await supabaseAdmin
      .from('event_attendees')
      .select('id, event_id, first_name, last_name, email, phone, choice_token, customer_id, assessment_response_id, created_via')
      .eq('id', attendeeId)
      .maybeSingle();
    if (attErr) throw new Error('attendee fetch: ' + attErr.message);
    if (!attendee) return { ok: false, error: 'Deelnemer niet gevonden' };

    const { data: event, error: evErr } = await supabaseAdmin
      .from('events')
      .select('id, title, starts_at, ends_at, location, description_md, capacity, status')
      .eq('id', attendee.event_id)
      .maybeSingle();
    if (evErr) throw new Error('event fetch: ' + evErr.message);
    if (!event) return { ok: false, error: 'Event niet gevonden' };

    const mail = bevestigingMail({
      voornaam: attendee.first_name,
      titel: event.title,
      datum: datumNL(event.starts_at),
      starttijd: tijdNL(event.starts_at),
      locatie: event.location || '',
      descriptionMd: event.description_md || '',
    });

    return await stuurWaEnMail({ attendee, event, waTemplate: TEMPLATE, waMappingOverride: WA_MAPPING, mail, soort: SOORTEN.BEVESTIGING });
  } catch (e) {
    console.error('[events-bevestiging-send] fatal:', e?.message || e);
    return { ok: false, error: e?.message || 'bevestiging send failed' };
  }
}
