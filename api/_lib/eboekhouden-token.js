// api/_lib/eboekhouden-token.js
// Session-token cache + ebFetch() wrapper voor de e-Boekhouden REST API
// (api.e-boekhouden.nl/v1/). Spiegel-implementatie van teamleader-token.js
// maar simpler: e-Boekhouden gebruikt een twee-staps auth-flow waarbij de
// permanente accessToken een kortstondige sessionToken oplevert.
//
// Auth-flow:
//   1. POST /v1/session  { accessToken, source } → { token, expiresIn }
//   2. Alle volgende calls: Authorization: Bearer <sessionToken>
//   3. Bij verlopen → SECURITY_010 of HTTP 401 → recreate session
//
// Env-vars (Vercel productie, Sensitive):
//   EBH_API_TOKEN  — permanente API-token uit e-Boekhouden Beheer
//   EBH_SOURCE     — app-identifier max 10 chars (default: 'DFO_CC')
//
// Geen DB-state: session-token leeft alleen in-memory per Vercel function-
// instance. Bij cold-start wordt nieuwe sessie aangemaakt — geen probleem
// want hourly cron heeft genoeg tijdsbudget voor één extra POST.

const BASE_URL = 'https://api.e-boekhouden.nl/v1';
const SESSION_PATH = '/session';
const DEFAULT_SOURCE = 'DFO_CC';

// In-memory session-cache met manuele TTL-tracking. Vercel hergebruikt warm
// functions tussen invocations, dus dit voorkomt onnodige session-recreates
// in dezelfde cold-start-periode.
let _sessionToken = null;
let _sessionExpiresAt = 0;       // epoch ms
const TTL_SAFETY_MARGIN_MS = 60_000;  // ververs 60s vóór echte expiratie

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Maakt een nieuwe sessie aan via POST /v1/session.
 * Cacht het sessionToken + berekent een expires-timestamp.
 */
async function createSession() {
  const accessToken = process.env.EBH_API_TOKEN;
  const source = (process.env.EBH_SOURCE || DEFAULT_SOURCE).slice(0, 10);
  if (!accessToken) {
    throw new Error('EBH_API_TOKEN niet geconfigureerd in env');
  }
  const r = await fetch(BASE_URL + SESSION_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ accessToken, source }),
  });
  const text = await r.text().catch(() => '');
  if (!r.ok) {
    throw new Error(`e-Boekhouden /session HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { throw new Error('e-Boekhouden /session response niet parsebaar'); }
  if (!data?.token) throw new Error('e-Boekhouden /session response zonder token-veld');
  _sessionToken = data.token;
  const expiresInSec = Number(data.expiresIn) || 1800;   // default 30 min
  _sessionExpiresAt = Date.now() + (expiresInSec * 1000) - TTL_SAFETY_MARGIN_MS;
  return _sessionToken;
}

/**
 * Geeft een geldig sessionToken (recreate bij expired).
 */
async function getSessionToken() {
  if (!_sessionToken || Date.now() >= _sessionExpiresAt) {
    await createSession();
  }
  return _sessionToken;
}

/**
 * Invalideer de huidige sessie-cache (bv. bij SECURITY_010 / 401).
 */
function invalidateSession() {
  _sessionToken = null;
  _sessionExpiresAt = 0;
}

/**
 * Wrapper rond fetch met:
 *   - automatische session-token resolve + retry bij 401/SECURITY_010
 *   - exp-backoff bij 429 (max 3 retries)
 *
 * @param {string} method  'GET' | 'POST' | 'PATCH' | 'DELETE'
 * @param {string} path    e.g. '/mutation', '/ledger/1010/balance'
 * @param {object} [opts]
 * @param {object} [opts.body]   request body (auto-JSON-stringified)
 * @param {object} [opts.query]  query params (auto-URL-encoded)
 * @returns {Promise<Response>} fetch Response
 */
export async function ebFetch(method, path, opts = {}) {
  const body = opts.body != null ? JSON.stringify(opts.body) : undefined;
  let url = BASE_URL + (path.startsWith('/') ? path : '/' + path);
  if (opts.query && typeof opts.query === 'object') {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v == null) continue;
      qs.set(k, String(v));
    }
    const qsStr = qs.toString();
    if (qsStr) url += (url.includes('?') ? '&' : '?') + qsStr;
  }

  let attempt = 0;
  let sessionRetried = false;
  while (true) {
    const token = await getSessionToken();
    const r = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });
    // 401 of SECURITY_010 in body → invalideer cache + één retry.
    if (r.status === 401 && !sessionRetried) {
      console.warn('[eboekhouden] 401 → invalideer sessie + retry');
      invalidateSession();
      sessionRetried = true;
      continue;
    }
    // 429 → exp-backoff retry (max 3x).
    if (r.status === 429 && attempt < 3) {
      const wait = 2000 * Math.pow(2, attempt);
      console.warn(`[eboekhouden] 429 → backoff ${wait}ms (attempt ${attempt + 1}/3)`);
      await sleep(wait);
      attempt++;
      continue;
    }
    return r;
  }
}

// Test-helper voor unit-tests (niet gebruikt in productie).
export function _resetSessionCacheForTests() {
  _sessionToken = null;
  _sessionExpiresAt = 0;
}
