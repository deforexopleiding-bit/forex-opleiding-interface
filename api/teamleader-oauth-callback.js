// api/teamleader-oauth-callback.js
// GET ?code=X&state=Y → exchange + persist + redirect naar admin.

import { exchangeCode, persistInitial } from './_lib/teamleader-token.js';
import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { code, state, error } = req.query || {};

  if (error) {
    return res.redirect(302, `/modules/admin.html?tl_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect(302, '/modules/admin.html?tl_error=missing_code_or_state');
  }

  // State-validatie: decode + check user matcht huidige sessie.
  let stateUserId = null;
  try {
    const decoded = Buffer.from(String(state), 'base64url').toString('utf-8');
    stateUserId = decoded.split('|')[0];
  } catch {
    return res.redirect(302, '/modules/admin.html?tl_error=invalid_state');
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || user.id !== stateUserId) {
    return res.redirect(302, '/modules/admin.html?tl_error=auth_mismatch');
  }

  try {
    const tok = await exchangeCode(code);
    await persistInitial(tok, user.id);
    return res.redirect(302, '/modules/admin.html?tl_connected=1');
  } catch (e) {
    console.error('[tl-callback]', e.message);
    return res.redirect(302, `/modules/admin.html?tl_error=${encodeURIComponent(e.message)}`);
  }
}
