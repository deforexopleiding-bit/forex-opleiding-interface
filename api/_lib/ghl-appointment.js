import fetch from 'node-fetch';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15'; // calendars API version

// Nieuwe GHL appointment aanmaken (POST). Gebruikt door follow-up-outcomes bij
// follow_up_type='agenda' — vervolg-call krijgt eigen GHL-appointment in plaats
// van parent's appointment te verplaatsen (voorkomt UNIQUE constraint conflict
// in follow_up_appointments.ghl_appointment_id én laat parent intact in GHL).
//
// Returnt: { id, zoom_meeting_id, zoom_join_url, raw }.
// zoom_meeting_id/join_url defensief geëxtraheerd uit meerdere mogelijke
// response-shapes; bij ontbrekend → null (poll-cron vult later via Zoom-match).
export async function createGhlAppointment({
  calendarId,
  locationId,
  contactId,
  assignedUserId,
  startTime,
  endTime,
  title,
}) {
  if (!calendarId)  throw new Error('calendarId vereist');
  if (!locationId)  throw new Error('locationId vereist');
  if (!contactId)   throw new Error('contactId vereist');
  if (!startTime)   throw new Error('startTime vereist');
  if (!endTime)     throw new Error('endTime vereist');

  const token = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!token) {
    throw new Error('GHL token ontbreekt in env');
  }

  const payload = {
    calendarId,
    locationId,
    contactId,
    startTime,
    endTime,
    appointmentStatus: 'confirmed',
    // Accepteer slots buiten de standaard beschikbaarheid (weekend/avond).
    // Een mens bewust verplaatst/plant — GHL free-slot-check moet niet
    // blokkeren. Als GHL het veld anders noemt en dit faalt, toont de
    // error-log de exacte veldnaam die GHL verwacht.
    ignoreFreeSlotValidation: true,
  };
  if (title)          payload.title          = title;
  if (assignedUserId) payload.assignedUserId = assignedUserId;

  const res = await fetch(
    `${GHL_BASE}/calendars/events/appointments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    const err = new Error(`GHL appointment create failed: ${res.status} ${errBody}`);
    err.ghlStatus = res.status;
    err.ghlBody   = errBody;
    throw err;
  }

  const data = await res.json();

  // Diagnose-log: response-shape niet 100% gedocumenteerd voor zoom-velden.
  // Eén log per create-call zodat we de exacte keys kunnen verifiëren in
  // Vercel logs en daarna de defensieve fallback hieronder kunnen versmallen.
  console.log('[ghl-create-appt] response keys:', Object.keys(data || {}),
    'meetingLocation keys:', data?.meetingLocation ? Object.keys(data.meetingLocation) : null);

  const id = data?.id || data?.appointment?.id || data?.event?.id;
  if (!id) {
    throw new Error('GHL create response zonder id: ' + JSON.stringify(data).slice(0, 200));
  }

  const zoom_meeting_id =
       data?.zoomMeetingId
    ?? data?.zoom?.meetingId
    ?? data?.meetingLocation?.zoomMeetingId
    ?? data?.meetingLocation?.meetingId
    ?? null;

  const zoom_join_url =
       data?.zoomJoinUrl
    ?? data?.zoom?.joinUrl
    ?? data?.meetingLocation?.zoomLink
    ?? data?.meetingLocation?.joinUrl
    ?? null;

  return { id, zoom_meeting_id, zoom_join_url, raw: data };
}

export async function updateGhlAppointmentTime(appointmentId, newStartIso, newEndIso) {
  if (!appointmentId) {
    throw new Error('appointmentId vereist');
  }

  const token = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!token) {
    throw new Error('GHL token ontbreekt in env');
  }

  const res = await fetch(
    `${GHL_BASE}/calendars/events/appointments/${appointmentId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startTime: newStartIso,
        endTime: newEndIso,
        // Accepteer weekend/avond bij verplaatsen; verkleint 422's.
        ignoreFreeSlotValidation: true,
      }),
    }
  );

  if (!res.ok) {
    const errBody = await res.text();
    console.error('[ghl-update-appt] failed', {
      appointmentId,
      status: res.status,
      body: (errBody || '').slice(0, 2000),
    });
    const err = new Error(`GHL appointment update failed: ${res.status} ${errBody}`);
    err.ghlStatus = res.status;
    err.ghlBody = errBody;
    throw err;
  }

  return await res.json();
}

// Update ALLEEN het appointmentStatus-veld van een bestaande GHL-appointment.
// Gebruikt voor de cockpit-uitkomst-flow: showed (gesprek gehad),
// noshow (niet verschenen), confirmed (undo-restore) of cancelled
// (geannuleerd — voor consistentie; annuleer-endpoint doet dit al zelf).
//
// Geldige waarden: 'confirmed' | 'showed' | 'noshow' | 'cancelled'.
//
// Bij niet-OK response: throws Error met ghlStatus + ghlBody. Caller
// (typisch fail-soft) pusht dat naar warnings[] zonder de DB-mutatie
// te blokkeren.
export async function updateGhlAppointmentStatus(appointmentId, appointmentStatus) {
  if (!appointmentId)      throw new Error('appointmentId vereist');
  if (!appointmentStatus)  throw new Error('appointmentStatus vereist');
  const allowed = new Set(['confirmed', 'showed', 'noshow', 'cancelled']);
  if (!allowed.has(appointmentStatus)) {
    throw new Error(`appointmentStatus ongeldig: ${appointmentStatus}`);
  }

  const token = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!token) throw new Error('GHL token ontbreekt in env');

  const res = await fetch(
    `${GHL_BASE}/calendars/events/appointments/${appointmentId}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appointmentStatus }),
    }
  );

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    console.error('[ghl-update-appt-status] failed', {
      appointmentId,
      appointmentStatus,
      status: res.status,
      body: (errBody || '').slice(0, 2000),
    });
    const err = new Error(`GHL appointment status update failed: ${res.status}`);
    err.ghlStatus = res.status;
    err.ghlBody   = errBody;
    throw err;
  }

  return await res.json().catch(() => ({}));
}
