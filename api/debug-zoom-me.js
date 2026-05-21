export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const DAVE_USER_ID = 'AyZaG0JZTk6ZNWmO0_OWDg';

  try {
    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;

    const tokenRes = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        },
      }
    );
    if (!tokenRes.ok) {
      return res.status(500).json({ step: 'oauth', status: tokenRes.status });
    }
    const tokenJson = await tokenRes.json();
    const token = tokenJson.access_token;

    // Test Dave's upcoming meetings
    const meetingsRes = await fetch(
      `https://api.zoom.us/v2/users/${DAVE_USER_ID}/meetings?type=upcoming&page_size=300`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!meetingsRes.ok) {
      const errText = await meetingsRes.text();
      return res.status(200).json({
        step: 'dave_meetings',
        status: meetingsRes.status,
        body: errText.slice(0, 500),
      });
    }

    const meetings = await meetingsRes.json();

    return res.status(200).json({
      total: meetings.total_records,
      count: meetings.meetings?.length || 0,
      first_three: (meetings.meetings || []).slice(0, 3).map(m => ({
        id: m.id,
        topic: m.topic,
        start_time: m.start_time,
        duration: m.duration,
        join_url: m.join_url,
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
