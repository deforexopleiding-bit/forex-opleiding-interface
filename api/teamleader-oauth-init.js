// api/teamleader-oauth-init.js
// GET (Bearer-auth) → { oauth_url }. Frontend doet window.location = oauth_url.
//
// We retourneren JSON i.p.v. een 302 omdat de knop via apiFetch (Bearer) wordt
// aangeroepen; een server-side redirect zou de fetch cross-origin naar TL volgen.
// De state wordt HMAC-getekend zodat de (anonieme) callback de user kan herleiden.

import { createUserClient } from './supabase.js';
import { signState } from './_lib/teamleader-state.js';

const AUTHORIZE_URL = 'https://focus.teamleader.eu/oauth2/authorize';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const clientId    = process.env.TEAMLEADER_CLIENT_ID;
  const redirectUri = process.env.TEAMLEADER_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'TL env vars ontbreken (TEAMLEADER_CLIENT_ID/_REDIRECT_URI)' });
  }

  let state;
  try {
    state = signState(user.id);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    redirect_uri:  redirectUri,
    state,
  });
  return res.status(200).json({ oauth_url: `${AUTHORIZE_URL}?${params.toString()}` });
}
