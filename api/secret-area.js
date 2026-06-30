// api/secret-area.js
//
// Verborgen "Secret Area" — alleen één specifieke user mag de pagina
// überhaupt zien (GET = access-check) én pas na PIN-check daadwerkelijk
// de inhoud unlocken (POST). Beide checks server-side; PIN + user_id
// staan uitsluitend in env vars (SECRET_AREA_USER_ID, SECRET_AREA_PIN),
// nooit in de repo en nooit in het response.
//
// Fail-closed:
//   - ontbrekende Bearer/Geen user             → { allowed:false } / { ok:false }
//   - ontbrekende env vars                     → idem
//   - ongeldige PIN                            → 401 { ok:false }
//   - verkeerde user (POST)                    → 403 { ok:false }
//
// PIN wordt NOOIT gelogd of teruggegeven. Geen console.log met body/PIN-
// inhoud. Constant-time vergelijken voor de PIN om timing-side-channels
// te beperken (klein effect over HTTP maar gratis te krijgen).

import { createUserClient } from './supabase.js';

function _constantTimeEquals(a, b) {
  const sa = String(a == null ? '' : a);
  const sb = String(b == null ? '' : b);
  if (sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

async function _getAuthUserId(req) {
  try {
    const supabase = createUserClient(req);
    const { data: { user } } = await supabase.auth.getUser();
    return user && user.id ? String(user.id) : null;
  } catch (_) {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const ownerId = process.env.SECRET_AREA_USER_ID || '';
  const pinEnv  = process.env.SECRET_AREA_PIN     || '';

  if (req.method === 'GET') {
    // Pure access-check: mag deze caller de pagina überhaupt zien?
    if (!ownerId) return res.status(200).json({ allowed: false });
    const userId = await _getAuthUserId(req);
    const allowed = !!(userId && userId === ownerId);
    return res.status(200).json({ allowed });
  }

  if (req.method === 'POST') {
    // Unlock met PIN. Alleen de eigenaar mag überhaupt proberen; daarna
    // moet de PIN ook nog kloppen.
    if (!ownerId || !pinEnv) {
      return res.status(401).json({ ok: false });
    }
    const userId = await _getAuthUserId(req);
    if (!userId) {
      return res.status(401).json({ ok: false });
    }
    if (userId !== ownerId) {
      return res.status(403).json({ ok: false });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const pin  = (typeof body.pin === 'string') ? body.pin : '';
    if (!_constantTimeEquals(pin, pinEnv)) {
      return res.status(401).json({ ok: false });
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'GET of POST verwacht' });
}
