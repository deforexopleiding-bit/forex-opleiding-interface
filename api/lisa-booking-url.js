// api/lisa-booking-url.js
//
// Read-only endpoint dat de geconfigureerde Lisa-boekingslink (agenda-URL)
// teruggeeft. Gebruikt door de Lisa-Gesprekken UI: knop "Stuur boekingslink"
// prefillt de compose met een korte standaard-tekst + deze link, zodat de
// gebruiker 'em kan bewerken vóór verzenden via de intervene-flow.
//
// Response:
//   200 { url: string|null, configured: boolean, source: 'env'|'none' }
//
// Auth: verifyAdmin (hard). Geen RBAC-perm — read-only en admin-only.
//
// Setup: zet env-var LISA_BOOKING_URL in Vercel (alle environments,
// NIET Sensitive — puur publieke agenda-URL). Voorbeeld:
//   LISA_BOOKING_URL=https://agenda.deforexopleiding.nl/dave-15min
// (of welk sub-pad dan ook — endpoint valideert alleen dat het een
// http(s)-URL is).

import { verifyAdmin } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  const raw = String(process.env.LISA_BOOKING_URL || '').trim();
  const isValid = /^https?:\/\/.+/i.test(raw);
  return res.status(200).json({
    url: isValid ? raw : null,
    configured: isValid,
    source: isValid ? 'env' : 'none',
  });
}
