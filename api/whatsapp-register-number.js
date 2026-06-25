// api/whatsapp-register-number.js
//
// SUPER_ADMIN-only éénmalige WhatsApp Cloud API "register number"-call.
//
// Roept POST {graph}/{phone_number_id}/register aan met PIN; gebruikt onze
// eigen system-user-token (META_WHATSAPP_ACCESS_TOKEN) die asset-toegang
// heeft tot de WABA. Een externe Explorer-token zou hier struikelen op
// error_subcode 33 — daarom MOET dit serverside via onze token.
//
// Wat dit endpoint NIET doet:
//   - Geen DB-write (registratie is een Meta-side mutatie).
//   - Geen token/PIN logging of return — Meta's error-body wordt 1-op-1
//     doorgegeven (Meta retourneert daar geen secrets in).
//
// Auth: Bearer-JWT → profile.role === 'super_admin'. Geen RBAC-feature-key:
// dit is een operatie buiten de RBAC-catalog (rotatie/setup-actie).
//
// Body:
//   { phone_number_id: '<digits>',   // regex ^\\d+$
//     pin           : '<6 digits>' } // regex ^\\d{6}$
//
// Response 200 success:
//   { success: true, meta_response: <Meta JSON, typisch { success:true }> }
// Response 200 Meta-fail (we returnen ALTIJD 200; UI inspecteert .success):
//   { success: false, status: <meta-http-status>, meta_error: <meta-error-body> }
// Andere:
//   401  geen sessie
//   403  geen super_admin
//   400  body / phone_number_id / pin ontbreekt of ongeldig
//   503  META_WHATSAPP_ACCESS_TOKEN niet geconfigureerd
//   502  Meta netwerk-fout / niet-JSON respons

import { createUserClient, supabaseAdmin } from './supabase.js';
import { META_BASE_URL } from './_lib/meta-whatsapp.js';

const PNID_RE = /^\d+$/;
const PIN_RE  = /^\d{6}$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  // ── Auth: super_admin only ─────────────────────────────────────────────
  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

  const { data: profile, error: profErr } = await supabaseAdmin
    .from('profiles')
    .select('id, role, is_active')
    .eq('id', user.id)
    .single();
  if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
  if (!profile.is_active)   return res.status(403).json({ error: 'Account inactief' });
  if (profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Alleen super_admin' });
  }

  // ── Body validatie ─────────────────────────────────────────────────────
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const phoneNumberId = typeof body.phone_number_id === 'string' ? body.phone_number_id.trim() : '';
  const pin           = typeof body.pin === 'string' ? body.pin.trim() : '';
  if (!phoneNumberId)             return res.status(400).json({ error: 'phone_number_id vereist' });
  if (!PNID_RE.test(phoneNumberId)) return res.status(400).json({ error: 'phone_number_id moet uitsluitend cijfers bevatten' });
  if (!pin)                       return res.status(400).json({ error: 'pin vereist' });
  if (!PIN_RE.test(pin))          return res.status(400).json({ error: 'pin moet exact 6 cijfers zijn' });

  // ── Token ──────────────────────────────────────────────────────────────
  const token = process.env.META_WHATSAPP_ACCESS_TOKEN || null;
  if (!token) {
    return res.status(503).json({
      error: 'META_WHATSAPP_ACCESS_TOKEN niet geconfigureerd. Vraag aan super_admin.',
    });
  }

  // ── Meta-call: POST /{phone_number_id}/register ────────────────────────
  // Direct fetch (de gedeelde metaFetch-wrapper is private en vereist
  // bovendien een phone_number_id-env-default; deze call gebruikt een
  // arbitrair phone_number_id uit de body).
  const url = `${META_BASE_URL}/${encodeURIComponent(phoneNumberId)}/register`;
  let metaRes;
  try {
    metaRes = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        pin,
      }),
    });
  } catch (e) {
    // Netwerk-fout. NOOIT token of pin in error-msg.
    console.error('[whatsapp-register-number] fetch fail:', e?.message || e);
    return res.status(502).json({
      success: false,
      error:   'Meta netwerk-fout',
      detail:  String(e?.message || 'unknown').slice(0, 200),
    });
  }

  // Probeer altijd JSON te parsen — Meta returnt typisch
  // { success:true } op 200 en { error:{...} } bij 4xx/5xx.
  let parsed = null;
  try { parsed = await metaRes.json(); } catch { parsed = null; }

  if (metaRes.ok) {
    // Success-pad. Log alleen status + phone_number_id (geen token/pin).
    console.log(
      '[whatsapp-register-number] ok phone_number_id=' + phoneNumberId +
      ' status=' + metaRes.status
    );
    return res.status(200).json({
      success: true,
      meta_response: parsed || { status: metaRes.status },
    });
  }

  // Meta-fout. Geef hun error-body 1-op-1 mee aan de UI. Bevat geen
  // secrets — alleen { error: { message, type, code, error_subcode, ... } }.
  const metaError = parsed && parsed.error ? parsed.error : (parsed || { message: 'unknown' });
  console.error(
    '[whatsapp-register-number] meta-fail phone_number_id=' + phoneNumberId +
    ' status=' + metaRes.status +
    ' code=' + (metaError?.code || '?') +
    ' subcode=' + (metaError?.error_subcode || '?') +
    ' msg=' + (String(metaError?.message || '').slice(0, 200))
  );
  return res.status(200).json({
    success:    false,
    status:     metaRes.status,
    meta_error: metaError,
  });
}
