// api/_lib/create-appointment-from-lead.js
//
// Zet een bel-lead om naar een ECHTE GHL-afspraak (Zoom-kalender) +
// follow_up_appointments-rij. Wordt aangeroepen vanuit de cockpit-
// uitkomst 'zoom_ingepland' zodat de call in Dave's agenda staat, GHL
// een Zoom-link genereert, en de afspraak in de Afspraken-tab
// verschijnt. Geen contact-creatie in GHL: als er geen contact-
// koppeling is → harde 422 zodat er geen kale zoom-lead achterblijft.
//
// Contact-lookup volgorde:
//   1) lead.source_ref.ghl_contact_id (event-leads krijgen dit via
//      event-followup-to-lead).
//   2) lead.customer_id → customers.ghl_contact_id.
//   3) → throw { code: 'NO_GHL_CONTACT' }.
//
// Bij GHL-fout: throw { code: 'GHL_API', ghlStatus, ghlBody } zodat de
// caller mapGhlError kan draaien voor een nette Nederlandse melding.

import { supabaseAdmin } from '../supabase.js';
import { createGhlAppointment } from './ghl-appointment.js';

export async function resolveGhlContactId(lead) {
  // 1) Event-lead: source_ref.ghl_contact_id (numeriek of string).
  const fromRef = lead?.source_ref?.ghl_contact_id;
  if (fromRef && typeof fromRef === 'string' && fromRef.trim()) {
    return fromRef.trim();
  }

  // 2) Retention/manual-lead met customer_id → customers.ghl_contact_id.
  if (lead?.customer_id) {
    try {
      const { data } = await supabaseAdmin
        .from('customers')
        .select('ghl_contact_id')
        .eq('id', lead.customer_id)
        .maybeSingle();
      const id = String(data?.ghl_contact_id || '').trim();
      if (id) return id;
    } catch (e) {
      // Fail-soft: fetch-fout → return null zodat caller nette 422 kan geven.
      console.warn('[create-appointment-from-lead] customer lookup:', e?.message || e);
    }
  }

  return null;
}

// Orchestreert: contact resolven → GHL-appointment aanmaken →
// follow_up_appointments-rij inserten. Returnt de nieuwe appointment-id
// + zoom-velden. Gooit typed errors bij falen.
export async function createAppointmentForLead({
  lead,
  scheduledAt,             // ISO string (verplicht)
  durationMinutes = 30,
}) {
  if (!lead || !lead.id) {
    const err = new Error('lead vereist');
    err.code = 'BAD_INPUT';
    throw err;
  }
  if (!scheduledAt) {
    const err = new Error('scheduledAt vereist');
    err.code = 'BAD_INPUT';
    throw err;
  }

  const startDate = new Date(scheduledAt);
  if (isNaN(startDate.getTime())) {
    const err = new Error('scheduledAt ongeldig');
    err.code = 'BAD_INPUT';
    throw err;
  }
  const endDate = new Date(startDate.getTime() + durationMinutes * 60 * 1000);

  // 1) Contact-koppeling — hard 422 als er niks is.
  const ghlContactId = await resolveGhlContactId(lead);
  if (!ghlContactId) {
    const err = new Error('Geen GHL-contact voor deze lead');
    err.code = 'NO_GHL_CONTACT';
    throw err;
  }

  // 2) Env-vars.
  const calendarId = process.env.GHL_CALENDAR_ID;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!calendarId || !locationId) {
    const err = new Error('GHL configuratie ontbreekt op de server');
    err.code = 'GHL_CONFIG_MISSING';
    throw err;
  }

  // 3) GHL-appointment aanmaken. Fail = wrap met ghlStatus/ghlBody.
  let ghl;
  try {
    ghl = await createGhlAppointment({
      calendarId,
      locationId,
      contactId     : ghlContactId,
      assignedUserId: process.env.GHL_DAVE_USER_ID || undefined,
      startTime     : startDate.toISOString(),
      endTime       : endDate.toISOString(),
      title         : lead.lead_name || 'Zoom-afspraak',
    });
  } catch (ghlErr) {
    const err = new Error('GHL-appointment aanmaken faalde');
    err.code      = 'GHL_API';
    err.ghlStatus = ghlErr?.ghlStatus || 500;
    err.ghlBody   = ghlErr?.ghlBody   || String(ghlErr?.message || '');
    throw err;
  }

  // 4) follow_up_appointments row insert. Als dit faalt heeft de klant
  //    wel al een GHL-afspraak → we gooien en de caller kan een note
  //    schrijven zodat de sales weet dat 'ie handmatig moet check'en.
  //    (Geen rollback via GHL delete: veiliger de afspraak te laten
  //    staan dan een zombie-uitnodiging naar de klant te sturen.)
  const insertRow = {
    parent_appointment_id: null,
    lead_name           : lead.lead_name  || null,
    lead_email          : lead.lead_email || null,
    lead_phone          : lead.lead_phone || null,
    lead_ghl_contact_id : ghlContactId,
    scheduled_at        : startDate.toISOString(),
    duration_minutes    : durationMinutes,
    status              : 'scheduled',
    voicememo_status    : 'pending',
    owner_id            : lead.owner_id || null,
    ghl_appointment_id  : ghl?.id              ?? null,
    zoom_meeting_id     : ghl?.zoom_meeting_id ?? null,
    zoom_join_url       : ghl?.zoom_join_url   ?? null,
  };

  // 42703 fail-soft: strip optionele kolommen die in oudere schema's
  // kunnen ontbreken.
  const OPTIONAL_KEYS = ['duration_minutes', 'voicememo_status', 'parent_appointment_id'];
  let attempt = { ...insertRow };
  let inserted = null;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await supabaseAdmin
      .from('follow_up_appointments')
      .insert(attempt)
      .select('id, scheduled_at, status, zoom_join_url, ghl_appointment_id')
      .maybeSingle();
    if (!error) { inserted = data; break; }
    if (error.code === '42703') {
      const msg = String(error.message || '').toLowerCase();
      let stripped = false;
      for (const k of OPTIONAL_KEYS) {
        if (msg.includes(k) && k in attempt) { delete attempt[k]; stripped = true; }
      }
      if (!stripped) {
        const err = new Error('DB insert follow_up_appointments: ' + error.message);
        err.code = 'DB_INSERT';
        err.ghl_appointment_id = ghl?.id || null;
        throw err;
      }
      continue;
    }
    const err = new Error('DB insert follow_up_appointments: ' + error.message);
    err.code = 'DB_INSERT';
    err.ghl_appointment_id = ghl?.id || null;
    throw err;
  }
  if (!inserted?.id) {
    const err = new Error('DB insert follow_up_appointments: geen resultaat');
    err.code = 'DB_INSERT';
    err.ghl_appointment_id = ghl?.id || null;
    throw err;
  }

  return {
    appointment_id     : inserted.id,
    scheduled_at       : inserted.scheduled_at,
    ghl_appointment_id : ghl?.id              || null,
    zoom_meeting_id    : ghl?.zoom_meeting_id || null,
    zoom_join_url      : ghl?.zoom_join_url   || null,
  };
}

// Mapt GHL HTTP-fouten naar leesbare NL-teksten. Gecopieerd van
// follow-up-outcomes.js zodat deze helper standalone werkt zonder
// afhankelijkheid van dat endpoint.
export function mapGhlError(status, body) {
  const b = String(body || '');
  if (status === 400) {
    if (b.includes('slot') || b.includes('available')) {
      return 'Slot niet beschikbaar in Dave\'s GHL-kalender (mogelijk weekend, buiten werktijd, of conflict)';
    }
    return `Ongeldige aanvraag bij GHL: ${b.slice(0, 120)}`;
  }
  if (status === 401) return 'Geen GHL-toegang (token-issue) — neem contact op met beheerder';
  if (status === 404) return 'Contact/kalender bestaat niet meer in GHL';
  if (status >= 500) return 'GHL is tijdelijk niet beschikbaar — probeer het over enkele minuten opnieuw';
  return `GHL-fout ${status}: ${b.slice(0, 120)}`;
}
