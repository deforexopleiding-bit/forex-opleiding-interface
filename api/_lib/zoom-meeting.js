import fetch from 'node-fetch';

// Zoom API: update meeting time
// Vereist: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET env vars

async function getZoomAccessToken() {
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;

  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom credentials ontbreken in env');
  }

  const tokenRes = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
    {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
      },
    }
  );

  if (!tokenRes.ok) {
    throw new Error(`Zoom OAuth failed: ${tokenRes.status}`);
  }

  const { access_token } = await tokenRes.json();
  return access_token;
}

export async function updateZoomMeetingTime(meetingId, newStartIso, durationMinutes = 30) {
  if (!meetingId) {
    throw new Error('meetingId vereist');
  }

  const token = await getZoomAccessToken();

  const res = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      start_time: newStartIso,
      duration: durationMinutes,
      timezone: 'Europe/Amsterdam',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Zoom meeting update failed: ${res.status} ${errText}`);
  }

  return { success: true };
}

export async function deleteZoomMeeting(meetingId) {
  if (!meetingId) throw new Error('meetingId vereist');
  const token = await getZoomAccessToken();
  const res = await fetch(`https://api.zoom.us/v2/meetings/${meetingId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  // 204 = succesvol verwijderd, 404 = al verwijderd (beide acceptabel)
  if (!res.ok && res.status !== 204 && res.status !== 404) {
    const errText = await res.text();
    throw new Error(`Zoom meeting delete failed: ${res.status} ${errText}`);
  }
  return { success: true };
}

export async function listUpcomingZoomMeetings(userId) {
  if (!userId) {
    console.warn('[zoom] listUpcomingZoomMeetings: no userId provided');
    return [];
  }
  try {
    const token = await getZoomAccessToken();
    const res = await fetch(
      `https://api.zoom.us/v2/users/${userId}/meetings?type=upcoming&page_size=300`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      const errText = await res.text();
      console.warn('[zoom] listUpcomingZoomMeetings failed:', res.status, errText.slice(0, 200));
      return [];
    }
    const json = await res.json();
    return json.meetings || [];
  } catch (err) {
    console.warn('[zoom] listUpcomingZoomMeetings exception:', err.message);
    return [];
  }
}
