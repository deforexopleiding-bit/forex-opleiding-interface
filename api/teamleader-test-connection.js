// api/teamleader-test-connection.js
// GET → { connected, user_info?, expires_at? }

import { tlFetch, getActiveToken, refreshIfNeeded } from './_lib/teamleader-token.js';
import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const tok = await getActiveToken();
  if (!tok) return res.status(200).json({ connected: false, reason: 'no_token' });

  try {
    await refreshIfNeeded();
    const r = await tlFetch('/users.me', { method: 'POST', body: JSON.stringify({}) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return res.status(200).json({ connected: false, reason: 'api_error', status: r.status, body: txt });
    }
    const data = await r.json();
    return res.status(200).json({
      connected:    true,
      user_info:    data.data || null,
      expires_at:   tok.expires_at,
    });
  } catch (e) {
    return res.status(200).json({ connected: false, reason: 'exception', error: e.message });
  }
}
