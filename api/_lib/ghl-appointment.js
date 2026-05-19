import fetch from 'node-fetch';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15'; // calendars API version

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
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GHL appointment update failed: ${res.status} ${errText}`);
  }

  return await res.json();
}
