// api/_lib/teamleader-token.js
// Helpers voor Teamleader OAuth-tokens. Eén actieve token-rij (latest wins).

import { supabaseAdmin } from '../supabase.js';

const TOKEN_ENDPOINT = 'https://focus.teamleader.eu/oauth2/access_token';
const REFRESH_WINDOW_SEC = 300; // refresh als token < 5 min geldig is

export async function getActiveToken() {
  const { data } = await supabaseAdmin.from('teamleader_oauth_tokens')
    .select('*').order('updated_at', { ascending: false }).limit(1).maybeSingle();
  return data || null;
}

async function saveToken(tok, authorizedByUserId = null) {
  // Tabel-pattern: 1 actieve rij. Delete oude + insert nieuwe in 1 transactie-style.
  // (Supabase JS heeft geen transactions — we accepteren mini-race.)
  await supabaseAdmin.from('teamleader_oauth_tokens').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  const { data, error } = await supabaseAdmin.from('teamleader_oauth_tokens').insert({
    access_token:           tok.access_token,
    refresh_token:          tok.refresh_token,
    expires_at:             new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString(),
    token_type:             tok.token_type || 'Bearer',
    scope:                  tok.scope || null,
    authorized_by_user_id:  authorizedByUserId,
    updated_at:             new Date().toISOString(),
  }).select('*').single();
  if (error) throw new Error('token save mislukt: ' + error.message);
  return data;
}

export async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id:     process.env.TEAMLEADER_CLIENT_ID || '',
    client_secret: process.env.TEAMLEADER_CLIENT_SECRET || '',
    code,
    grant_type:    'authorization_code',
    redirect_uri:  process.env.TEAMLEADER_REDIRECT_URI || '',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`TL token-exchange HTTP ${res.status}: ${data.error_description || data.error || 'unknown'}`);
  return data;
}

export async function refreshIfNeeded() {
  const tok = await getActiveToken();
  if (!tok) return null;
  const expiresInSec = (new Date(tok.expires_at).getTime() - Date.now()) / 1000;
  if (expiresInSec > REFRESH_WINDOW_SEC) return tok; // nog vers genoeg

  const body = new URLSearchParams({
    client_id:     process.env.TEAMLEADER_CLIENT_ID || '',
    client_secret: process.env.TEAMLEADER_CLIENT_SECRET || '',
    refresh_token: tok.refresh_token,
    grant_type:    'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('[teamleader-token] refresh fail:', data);
    return null;
  }
  return saveToken({ ...data, refresh_token: data.refresh_token || tok.refresh_token }, tok.authorized_by_user_id);
}

export async function persistInitial(tok, userId) { return saveToken(tok, userId); }

// Wrapper for TL API calls with auto-refresh.
export async function tlFetch(path, opts = {}) {
  const tok = await refreshIfNeeded();
  if (!tok) throw new Error('Geen geldige Teamleader-token');
  const headers = {
    'Authorization': `Bearer ${tok.access_token}`,
    'Content-Type':  'application/json',
    ...(opts.headers || {}),
  };
  const url = path.startsWith('http') ? path : `https://api.focus.teamleader.eu${path}`;
  const res = await fetch(url, { ...opts, headers });
  return res;
}
