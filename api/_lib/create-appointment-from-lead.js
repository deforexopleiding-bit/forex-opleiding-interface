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

import fetch from 'node-fetch';
import { supabaseAdmin } from '../supabase.js';
import { createGhlAppointment } from './ghl-appointment.js';

const GHL_BASE = 'https://services.leadconnectorhq.com';
// GHL contacts-API gebruikt een andere Version dan de calendars-API.
// Bevestigd in api/_lib/ghl-contact.js: '2021-07-28'.
const GHL_CONTACTS_VERSION = '2021-07-28';

// Roep GHL contacts/upsert aan om een bestaand contact te vinden (op
// e-mail/telefoon dedup) of een nieuw contact te maken. Returnt het
// contact-id als string. Throws { code:'GHL_API', ghlStatus, ghlBody }
// bij API-fout — caller vertaalt naar 422 via mapGhlError.
async function ghlUpsertContact({ email, phone, firstName, lastName }) {
  const token      = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    const err = new Error('GHL configuratie ontbreekt op de server');
    err.code = 'GHL_CONFIG_MISSING';
    throw err;
  }

  const body = { locationId };
  if (email     && String(email).trim())     body.email     = String(email).trim();
  if (phone     && String(phone).trim())     body.phone     = String(phone).trim();
  if (firstName && String(firstName).trim()) body.firstName = String(firstName).trim();
  if (lastName  && String(lastName).trim())  body.lastName  = String(lastName).trim();

  const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method : 'POST',
    headers: {
      Authorization : `Bearer ${token}`,
      Version       : GHL_CONTACTS_VERSION,
      'Content-Type': 'application/json',
      Accept        : 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    const err = new Error(`GHL contacts/upsert ${res.status}`);
    err.code      = 'GHL_API';
    err.ghlStatus = res.status;
    err.ghlBody   = (errBody || '').slice(0, 500);
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  const contact = data?.contact || data?.data?.contact || data;
  const id = contact?.id || contact?.contact_id || data?.id || null;
  if (!id || typeof id !== 'string') {
    const err = new Error('GHL contacts/upsert response zonder id');
    err.code      = 'GHL_API';
    err.ghlStatus = res.status;
    err.ghlBody   = 'no-id-in-response';
    throw err;
  }
  return String(id).trim();
}

// Split "Voornaam Achternaam" defensief. Enige naam → firstName only.
function splitName(fullName) {
  const raw = String(fullName || '').trim();
  if (!raw) return { firstName: null, lastName: null };
  const parts = raw.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Write-back de vers-verkregen contact-id naar customers zodat een
// vervolg-lookup 'm direct vindt (voorkomt dubbele upserts). Fail-soft:
// als de write faalt, log alleen — de afspraak-flow moet NIET blokkeren.
async function writeBackCustomerGhlContactId(customerId, ghlContactId) {
  if (!customerId || !ghlContactId) return;
  try {
    const { error } = await supabaseAdmin
      .from('customers')
      .update({ ghl_contact_id: ghlContactId })
      .eq('id', customerId);
    if (error) {
      // 42703 = kolom ontbreekt in dit schema — helemaal geen probleem, skip.
      if (error.code !== '42703') {
        console.warn('[create-appointment-from-lead] write-back customers.ghl_contact_id:', error.message);
      }
    }
  } catch (e) {
    console.warn('[create-appointment-from-lead] write-back exception:', e?.message || e);
  }
}

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
      // Fail-soft: fetch-fout → val door naar upsert.
      console.warn('[create-appointment-from-lead] customer lookup:', e?.message || e);
    }
  }

  // 3) Upsert op e-mail/telefoon. Vereist minstens één van beide —
  //    anders is er NIETS om op te dedupliceren en zou upsert alsnog
  //    een dubbelspook-contact maken bij elke retry.
  const email = String(lead?.lead_email || '').trim();
  const phone = String(lead?.lead_phone || '').trim();
  if (!email && !phone) {
    return null; // caller returnt NO_GHL_CONTACT met nette melding.
  }
  const { firstName, lastName } = splitName(lead?.lead_name);
  const contactId = await ghlUpsertContact({ email, phone, firstName, lastName });

  // 4) Write-back — puur voor performance/volgende-keer. Fail-soft.
  if (lead?.customer_id) {
    await writeBackCustomerGhlContactId(lead.customer_id, contactId);
  }
  return contactId;
}

// Fail-soft: voeg een GHL-tag toe aan het contact (voor attributie in
// GHL zelf). Niet blokkerend — als GHL-tag-add faalt, log alleen; de
// afspraak zelf is dan al aangemaakt en booking_source zit in de DB.
// v=2026-08-27 (Opstartsessie-project DEEL 1): bron uit /opstartsessie/<slug>.
async function ghlAddContactTag(contactId, tag) {
  if (!contactId || !tag) return;
  const token = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!token) return; // zonder token overslaan — booking_source zit al in DB
  try {
    const res = await fetch(`${GHL_BASE}/contacts/${encodeURIComponent(contactId)}/tags`, {
      method : 'POST',
      headers: {
        Authorization : `Bearer ${token}`,
        Version       : GHL_CONTACTS_VERSION,
        'Content-Type': 'application/json',
        Accept        : 'application/json',
      },
      body: JSON.stringify({ tags: [String(tag)] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[create-appointment-from-lead] GHL contact-tag-add', res.status, body.slice(0, 200));
    }
  } catch (e) {
    console.warn('[create-appointment-from-lead] GHL contact-tag-add exception:', e?.message || e);
  }
}

// Orchestreert: contact resolven → GHL-appointment aanmaken →
// follow_up_appointments-rij inserten. Returnt de nieuwe appointment-id
// + zoom-velden. Gooit typed errors bij falen.
//
// v=2026-08-27 (Opstartsessie-project DEEL 1): optionele `source` param
// voor Opstartsessie-bron-tracking. Schrijft naar follow_up_appointments.
// booking_source EN plaatst fail-soft een GHL-tag "bron-<slug>" op het
// contact. Geen 20 aparte GHL-agenda's meer — één agenda, bron in ons
// eigen systeem. Bestaande callers (cockpit-uitkomst zoom_ingepland,
// leadsonderhoud direct-inschieten) laten source ongezet → NULL in DB,
// geen GHL-tag; volledig backward-compatible.
export async function createAppointmentForLead({
  lead,
  scheduledAt,             // ISO string (verplicht)
  durationMinutes = 30,
  source = null,           // optionele slug, bv. 'nieuwsbrief' / 'romy' / 'direct'
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
  // Normaliseer source-slug (lowercase, strip whitespace) — beide bewaakt
  // door de check-constraint in booking_sources, maar hier accepteren we
  // óók onbekende/typo-slugs zodat oude links telbaar blijven.
  const sourceSlug = source
    ? String(source).trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
    : null;
  const cleanSource = sourceSlug && sourceSlug.length && sourceSlug.length <= 64 ? sourceSlug : null;

  // BP2 Deel A (2026-08-31): setter-attributie op de boeking. Lookup de
  // owner_user_id op booking_sources voor deze slug — als 'ie bestaat en
  // actief is, stampen we die als setter_user_id op de appointment. Fail-
  // soft: onbekende slug / geen owner / DB-fout → NULL. Boeking gaat
  // ALTIJD door. cleanSource NULL (bv. directe boeking) → skip lookup.
  let resolvedSetter = null;
  if (cleanSource) {
    try {
      const { data: bs } = await supabaseAdmin
        .from('booking_sources')
        .select('owner_user_id')
        .eq('slug', cleanSource)
        .eq('actief', true)
        .maybeSingle();
      if (bs?.owner_user_id) resolvedSetter = bs.owner_user_id;
    } catch (e) {
      console.warn('[create-appointment-from-lead] setter-lookup (soft):', e?.message || e);
    }
  }

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
    booking_source      : cleanSource,
    setter_user_id      : resolvedSetter,       // BP2: NULL bij bronnen zonder owner
  };

  // 42703 fail-soft: strip optionele kolommen die in oudere schema's
  // kunnen ontbreken. booking_source is toegevoegd in migratie 046,
  // setter_user_id in de BP2-migratie — als die nog niet gedraaid is,
  // stript de fail-soft-lus 'em uit de insert.
  const OPTIONAL_KEYS = ['duration_minutes', 'voicememo_status', 'parent_appointment_id', 'booking_source', 'setter_user_id'];
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

  // Fail-soft: GHL-contact-tag "bron-<slug>" voor attributie in GHL zelf.
  // Non-blocking — booking_source zit al in de DB.
  if (cleanSource) {
    await ghlAddContactTag(ghlContactId, `bron-${cleanSource}`);
  }

  return {
    appointment_id     : inserted.id,
    scheduled_at       : inserted.scheduled_at,
    ghl_appointment_id : ghl?.id              || null,
    zoom_meeting_id    : ghl?.zoom_meeting_id || null,
    zoom_join_url      : ghl?.zoom_join_url   || null,
    booking_source     : cleanSource,
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
