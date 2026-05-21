export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  console.log('[debug-zoom-me] handler entry');

  try {
    const accountId = process.env.ZOOM_ACCOUNT_ID;
    const clientId = process.env.ZOOM_CLIENT_ID;
    const clientSecret = process.env.ZOOM_CLIENT_SECRET;

    // OAuth token
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
    const scopes = tokenJson.scope || 'unknown';

    console.log('[debug-zoom-me] token scopes:', scopes);

    // Test meerdere endpoints
    const results = { token_scopes: scopes };

    // Test 1: /users/me
    const meRes = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    results.users_me = {
      status: meRes.status,
      body: meRes.ok ? (await meRes.json()) : (await meRes.text()).slice(0, 200),
    };

    // Test 2: /users/me/meetings?type=upcoming
    const meetingsMe = await fetch('https://api.zoom.us/v2/users/me/meetings?type=upcoming&page_size=10', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meetingsBody = meetingsMe.ok ? await meetingsMe.json() : await meetingsMe.text();
    results.meetings_me = {
      status: meetingsMe.status,
      body: meetingsMe.ok
        ? {
            total: meetingsBody.total_records,
            count: meetingsBody.meetings?.length,
            first_meeting: meetingsBody.meetings?.[0] || null,
          }
        : meetingsBody.slice(0, 300),
    };

    // Test 3: /users (list all users)
    const usersRes = await fetch('https://api.zoom.us/v2/users?page_size=10', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const usersBody = usersRes.ok ? await usersRes.json() : await usersRes.text();
    results.users_list = {
      status: usersRes.status,
      body: usersRes.ok
        ? {
            total: usersBody.total_records,
            users: usersBody.users?.map(u => ({ id: u.id, email: u.email, type: u.type })),
          }
        : usersBody.slice(0, 300),
    };

    console.log('[debug-zoom-me] results:', JSON.stringify(results).slice(0, 500));

    return res.status(200).json(results);
  } catch (err) {
    console.error('[debug-zoom-me] exception:', err.message);
    return res.status(500).json({ error: err.message, stack: err.stack?.slice(0, 500) });
  }
}
