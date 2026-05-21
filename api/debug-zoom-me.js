export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  console.log('[debug-zoom-me] handler entry, method:', req.method);

  try {
    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;

    console.log('[debug-zoom-me] env check:', {
      has_account_id: !!accountId,
      has_client_id: !!clientId,
      has_client_secret: !!clientSecret,
    });

    if (!accountId || !clientId || !clientSecret) {
      return res.status(500).json({
        error: 'Zoom credentials ontbreken in env',
        env: {
          has_account_id: !!accountId,
          has_client_id: !!clientId,
          has_client_secret: !!clientSecret,
        }
      });
    }

    console.log('[debug-zoom-me] fetching OAuth token...');
    const tokenRes = await fetch(
      `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${accountId}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
        },
      }
    );

    console.log('[debug-zoom-me] OAuth response status:', tokenRes.status);

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.log('[debug-zoom-me] OAuth failed body:', errText.slice(0, 500));
      return res.status(500).json({
        step: 'oauth_token',
        status: tokenRes.status,
        body: errText.slice(0, 500),
      });
    }

    const tokenJson = await tokenRes.json();
    const token = tokenJson.access_token;
    console.log('[debug-zoom-me] OAuth token received, length:', token?.length || 0);

    console.log('[debug-zoom-me] fetching /users/me...');
    const meRes = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });

    console.log('[debug-zoom-me] /users/me status:', meRes.status);

    if (!meRes.ok) {
      const errText = await meRes.text();
      console.log('[debug-zoom-me] /users/me failed body:', errText.slice(0, 500));
      return res.status(meRes.status).json({
        step: 'users_me',
        status: meRes.status,
        body: errText.slice(0, 500),
      });
    }

    const me = await meRes.json();
    console.log('[debug-zoom-me] me data:', JSON.stringify(me).slice(0, 300));

    return res.status(200).json({
      zoom_me_id:         me.id,
      zoom_me_email:      me.email,
      zoom_me_first_name: me.first_name,
      zoom_me_last_name:  me.last_name,
      zoom_me_type:       me.type,
      zoom_me_account_id: me.account_id,
      zoom_me_role:       me.role_name,
      zoom_me_status:     me.status,
    });
  } catch (err) {
    console.error('[debug-zoom-me] exception:', err.message, err.stack);
    return res.status(500).json({
      error: err.message,
      stack: err.stack?.slice(0, 500),
    });
  }
}
