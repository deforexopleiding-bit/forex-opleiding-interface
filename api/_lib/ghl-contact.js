// api/_lib/ghl-contact.js
// Helper: GHL contact-data ophalen via Private Integration token

import fetch from 'node-fetch';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = '2021-07-28';

export async function fetchGhlContact(contactId) {
  if (!contactId) return null;

  const token = process.env.GHL_PIT_TOKEN || process.env.GHL_API_KEY;
  if (!token) {
    console.error('[ghl-contact] GHL_PIT_TOKEN / GHL_API_KEY ontbreekt');
    return null;
  }

  try {
    const res = await fetch(`${GHL_BASE}/contacts/${contactId}`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': GHL_VERSION,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      console.warn('[ghl-contact] fetch failed', contactId, res.status);
      return null;
    }

    const data = await res.json();
    const contact = data.contact || data;

    return {
      email: contact.email || null,
      phone: contact.phone || null,
      firstName: contact.firstName || null,
      lastName: contact.lastName || null,
    };
  } catch (err) {
    console.error('[ghl-contact] error', err.message);
    return null;
  }
}
