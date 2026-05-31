// api/_lib/teamleader-state.js
// Signed OAuth-state voor de Teamleader-flow. De callback wordt door TL via
// browser-redirect aangeroepen ZONDER Bearer-header, dus we kunnen daar geen
// sessie valideren. In plaats daarvan dragen we de user-id mee in een
// HMAC-getekende state-parameter (init tekent met Bearer-auth, callback
// valideert de signatuur + timestamp).

import crypto from 'crypto';

function getStateSecret() {
  const s = process.env.STATE_SECRET;
  if (!s) throw new Error('STATE_SECRET env var not set');
  return s;
}

export function signState(userId) {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${userId}:${timestamp}:${nonce}`;
  const sig = crypto.createHmac('sha256', getStateSecret())
    .update(payload).digest('hex').substring(0, 32);
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

export function validateState(state, maxAgeMs = 10 * 60 * 1000) {
  try {
    const decoded = Buffer.from(String(state), 'base64url').toString();
    const [userId, timestampStr, nonce, sig] = decoded.split(':');
    if (!userId || !timestampStr || !nonce || !sig) return null;
    const payload = `${userId}:${timestampStr}:${nonce}`;
    const expected = crypto.createHmac('sha256', getStateSecret())
      .update(payload).digest('hex').substring(0, 32);
    // Timing-safe vergelijking om signatuur-leakage te voorkomen.
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const age = Date.now() - parseInt(timestampStr, 10);
    if (age > maxAgeMs || age < 0) return null;
    return { user_id: userId, timestamp: parseInt(timestampStr, 10) };
  } catch {
    return null;
  }
}
