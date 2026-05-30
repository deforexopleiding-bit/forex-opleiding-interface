// api/teamleader-oauth-init.js
// GET → redirect (302) naar TL authorize-URL met state.

import crypto from 'crypto';
import { createUserClient } from './supabase.js';

const AUTHORIZE_URL = 'https://focus.teamleader.eu/oauth2/authorize';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const clientId    = process.env.TEAMLEADER_CLIENT_ID;
  const redirectUri = process.env.TEAMLEADER_REDIRECT_URI;
  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'TL env vars ontbreken (TEAMLEADER_CLIENT_ID/_REDIRECT_URI)' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  // State zou in sessie/cookie moeten — voor MVP via signed-state met user-id check op callback.
  // Eenvoudige aanpak: state = base64(user_id|random), valideer op callback dat user_id matcht.
  const stateVal = Buffer.from(`${user.id}|${state}`).toString('base64url');

  const params = new URLSearchParams({
    client_id:     clientId,
    response_type: 'code',
    redirect_uri:  redirectUri,
    state:         stateVal,
  });
  const url = `${AUTHORIZE_URL}?${params.toString()}`;
  res.writeHead(302, { Location: url });
  res.end();
}
