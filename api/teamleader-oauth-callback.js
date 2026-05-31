// api/teamleader-oauth-callback.js
// GET ?code=X&state=Y → validate state + exchange + persist + redirect naar admin.
//
// TL roept dit via browser-redirect aan ZONDER Bearer-header, dus geen
// createUserClient/sessie-check. We herleiden de user uit de HMAC-getekende
// state (gezet door teamleader-oauth-init). Alleen redirects, geen JSON.

import { exchangeCode, persistInitial } from './_lib/teamleader-token.js';
import { validateState } from './_lib/teamleader-state.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const { code, state, error } = req.query || {};

  if (error) {
    return res.redirect(302, `/modules/admin.html?tl_error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return res.redirect(302, '/modules/admin.html?tl_error=missing_code_or_state');
  }

  // State-validatie: HMAC-signatuur + timestamp (max 10 min). Levert user_id.
  let parsed;
  try {
    parsed = validateState(state);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return res.redirect(302, '/modules/admin.html?tl_error=invalid_state');
  }

  try {
    const tok = await exchangeCode(code);
    await persistInitial(tok, parsed.user_id);
    return res.redirect(302, '/modules/admin.html?tl_connected=1');
  } catch (e) {
    console.error('[tl-callback]', e.message);
    return res.redirect(302, '/modules/admin.html?tl_error=token_exchange_failed');
  }
}
