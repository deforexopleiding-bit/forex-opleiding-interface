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
