// api/onboarding.js
// Anoniem (token = secret), GEEN auth.
//   GET  ?token=X        → { first_name, status, expired } voor de onboarding-pagina
//   POST { token }       → markeer onboarding_status='completed' (idempotent)
//
// [M-06 fix 2026-08-25] Onboarding-token expiry + one-time-use na completion.
//   Zie migratie 042_onboarding_token_expiry.sql. Kolom
//   `customers.onboarding_token_expires_at`:
//   - < now() én status != 'completed' → 410 Gone met vriendelijke NL-melding
//     (voorheen: token blijft eeuwig geldig — link-leak in doorgestuurde mail
//    of Referer-header betekende permanente inlog-vector op klant-status).
//   - status == 'completed' → GET toont status voor de klant (bevestiging);
//    POST is idempotent no-op (retourneert `{ success: true, already: true }`)
//     zonder onboarding_completed_at te overschrijven.

import { supabaseAdmin } from './supabase.js';

const EXPIRED_MESSAGE =
  'Deze onboarding-link is verlopen. Neem contact op met kantoor voor een nieuwe link.';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const token = req.method === 'GET' ? req.query?.token : (req.body || {}).token;
  if (!token) return res.status(400).json({ error: 'token vereist' });

  try {
    const { data: c } = await supabaseAdmin.from('customers')
      .select('id, first_name, onboarding_status, onboarding_token_expires_at, onboarding_completed_at')
      .eq('onboarding_token', token)
      .maybeSingle();
    if (!c) return res.status(404).json({ error: 'Onboarding-link niet gevonden of verlopen' });

    // [M-06] Expiry-check. Alleen relevant als niet-voltooid — completed-tokens
    // blijven bruikbaar als read-only bevestiging voor de klant.
    const isCompleted = c.onboarding_status === 'completed';
    const expiresAt = c.onboarding_token_expires_at ? new Date(c.onboarding_token_expires_at) : null;
    const isExpired = !isCompleted && expiresAt && expiresAt.getTime() < Date.now();

    if (isExpired) {
      // 410 Gone: token bestond ooit maar is verlopen. Vriendelijke NL-melding
      // voor de klant-facing pagina; die kan dit direct tonen.
      return res.status(410).json({
        error: EXPIRED_MESSAGE,
        expired: true,
        status: c.onboarding_status,
      });
    }

    if (req.method === 'GET') {
      return res.status(200).json({
        first_name: c.first_name || '',
        status: c.onboarding_status,
        completed_at: c.onboarding_completed_at || null,
      });
    }
    if (req.method === 'POST') {
      // [M-06] Idempotent na completion: geen dubbele UPDATE (zou
      // onboarding_completed_at overschrijven en analytics vervuilen).
      if (isCompleted) {
        return res.status(200).json({
          success: true,
          already: true,
          completed_at: c.onboarding_completed_at || null,
        });
      }
      await supabaseAdmin.from('customers').update({
        onboarding_status: 'completed', onboarding_completed_at: new Date().toISOString(),
      }).eq('id', c.id);
      return res.status(200).json({ success: true });
    }
    return res.status(405).json({ error: 'GET of POST' });
  } catch (e) {
    console.error('[onboarding]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
