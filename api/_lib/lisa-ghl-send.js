// api/_lib/lisa-ghl-send.js
// Helper om Lisa-berichten naar GoHighLevel (Instagram) te sturen via de Conversations API.
// Native fetch (Node 18+, ESM). Token: GHL_PIT_TOKEN of GHL_API_KEY (zelfde als follow-up-modules).

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-04-15';

function ghlToken() {
  return process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY || null;
}

/**
 * Verstuur een bericht naar GHL (type IG = Instagram).
 * @param {string} contactId
 * @param {string} message
 * @param {{conversationId?:string, locationId?:string}} options
 * @returns {Promise<{ok:boolean, message_id?:string, error?:string, raw?:object}>}
 */
export async function sendToGhl(contactId, message, options = {}) {
  const token = ghlToken();
  if (!token) return { ok: false, error: 'GHL_PIT_TOKEN/GHL_API_KEY ontbreekt in env' };
  if (!contactId || !message) return { ok: false, error: 'contactId + message vereist' };

  try {
    const body = {
      type: 'IG',
      contactId,
      message,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    };
    const response = await fetch(`${GHL_API}/conversations/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_VERSION,
        'Content-Type': 'application/json',
        ...(options.locationId ? { LocationId: options.locationId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[lisa-ghl-send] GHL send error:', response.status, errorText);
      return { ok: false, error: `GHL API ${response.status}: ${errorText}` };
    }
    const data = await response.json().catch(() => ({}));
    return { ok: true, message_id: data.messageId || data.id || null, raw: data };
  } catch (err) {
    console.error('[lisa-ghl-send] exception:', err?.message || err);
    return { ok: false, error: err?.message || 'onbekende fout' };
  }
}

/**
 * Haal contactgegevens op uit GHL (best-effort; null bij fout).
 */
export async function getGhlContact(contactId) {
  const token = ghlToken();
  if (!token || !contactId) return null;
  try {
    const response = await fetch(`${GHL_API}/contacts/${contactId}`, {
      headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION },
    });
    if (!response.ok) return null;
    const data = await response.json().catch(() => ({}));
    return data.contact || data || null;
  } catch (err) {
    console.error('[lisa-ghl-send] getGhlContact error:', err?.message || err);
    return null;
  }
}

// ── Response-delay (F10) ──────────────────────────────────────────────────────
/** Bereken response-delay in ms o.b.v. settings + fase (fixed/random/per_phase). */
export function computeResponseDelay(settings, phase) {
  if (!settings) return 0;
  const mode = settings.response_delay_mode || 'random';
  if (mode === 'fixed') return Math.max(0, (settings.response_delay_fixed_seconds || 45) * 1000);
  if (mode === 'per_phase') {
    const perPhase = settings.response_delay_per_phase || {};
    const v = parseInt(perPhase[phase], 10);
    return Math.max(0, (isNaN(v) ? 45 : v) * 1000);
  }
  // random (default)
  const min = Math.max(0, settings.response_delay_min_seconds || 30);
  const max = Math.max(min, settings.response_delay_max_seconds || 90);
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Stuur een typing-indicator naar GHL. Fail-soft (mogelijk niet ondersteund voor IG). */
export async function sendTypingIndicator(contactId, options = {}) {
  const token = ghlToken();
  if (!token || !contactId) return { ok: false, error: 'no_token_or_contact' };
  try {
    const body = { type: 'IG', contactId, isTyping: true, ...(options.conversationId ? { conversationId: options.conversationId } : {}) };
    const response = await fetch(`${GHL_API}/conversations/messages/typing`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, Version: GHL_VERSION, 'Content-Type': 'application/json',
        ...(options.locationId ? { LocationId: options.locationId } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const txt = await response.text();
      console.log('[lisa-typing] failed:', response.status, txt.slice(0, 120));
      return { ok: false, error: String(response.status) };
    }
    return { ok: true };
  } catch (err) {
    console.log('[lisa-typing] exception:', err?.message || err);
    return { ok: false, error: err?.message || 'onbekende fout' };
  }
}
