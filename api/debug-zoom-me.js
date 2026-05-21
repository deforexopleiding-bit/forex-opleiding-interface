// api/debug-zoom-me.js
// Tijdelijk debug-endpoint: check welke Zoom-user de Server-to-Server OAuth credentials zijn.
// Verwijderen na gebruik.

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (!req.headers.authorization?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Auth required' });
  }

  try {
    const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
    if (!ZOOM_ACCOUNT_ID || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET) {
      return res.status(500).json({ error: 'Zoom credentials ontbreken in env' });
    }

    const tokenRes = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64'),
        },
      }
    );
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      return res.status(500).json({ error: `Zoom OAuth failed: ${tokenRes.status} ${txt}` });
    }
    const { access_token } = await tokenRes.json();

    const meRes = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const me = await meRes.json();

    return res.status(200).json({
      zoom_me_id:         me.id,
      zoom_me_email:      me.email,
      zoom_me_first_name: me.first_name,
      zoom_me_last_name:  me.last_name,
      zoom_me_type:       me.type,
      zoom_me_account_id: me.account_id,
      zoom_me_role:       me.role_name,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
