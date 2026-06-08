// api/admin-whatsapp-numbers-available.js
// GET → lijst beschikbare Meta WABA phone-numbers via Graph API
// (/{WHATSAPP_BUSINESS_ACCOUNT_ID}/phone_numbers). SUPER_ADMIN ONLY.
//
// In-memory module-scoped cache met TTL 5 min (Vercel-functies zijn ephemeral
// → cache leeft alleen binnen warme container. Bij cold start: 1 extra Meta-call.
// phone_numbers verandert ~1x/maand, dus dit is goedkoop).
//
// Response: { items: [...], cached: boolean, expires_in_sec: number }
//
// Env vereist: META_WHATSAPP_ACCESS_TOKEN + META_WHATSAPP_BUSINESS_ACCOUNT_ID.
// Bij ontbreken: 503. Bij Meta API non-2xx: 502.
//
// Query: ?force=1 omzeilt cache (debug).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { META_BASE_URL } from './_lib/meta-whatsapp.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
// Module-scoped cache — blijft warm tussen invocations binnen dezelfde container.
let _waPhoneCache = { data: null, expires_at: 0 };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  // Auth: Bearer → user → profile.role === 'super_admin'.
  try {
    const userClient = createUserClient(req);
    const { data: { user }, error: userErr } = await userClient.auth.getUser();
    if (userErr || !user) return res.status(401).json({ error: 'Unauthorized' });

    const { data: profile, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', user.id)
      .single();
    if (profErr || !profile) return res.status(403).json({ error: 'Geen profiel gevonden' });
    if (!profile.is_active) return res.status(403).json({ error: 'Account inactief' });
    if (profile.role !== 'super_admin') {
      return res.status(403).json({ error: 'Alleen super_admin' });
    }

    // Env-check (geeft 503 met heldere reden i.p.v. 500 stacktrace).
    const accessToken = process.env.META_WHATSAPP_ACCESS_TOKEN;
    const businessAccountId = process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (!accessToken || !businessAccountId) {
      const missing = [];
      if (!accessToken) missing.push('META_WHATSAPP_ACCESS_TOKEN');
      if (!businessAccountId) missing.push('META_WHATSAPP_BUSINESS_ACCOUNT_ID');
      return res.status(503).json({
        error: `Meta WhatsApp niet geconfigureerd (ontbrekend: ${missing.join(', ')})`,
        missing,
      });
    }

    const force = req.query?.force === '1' || req.query?.force === 'true';
    const now = Date.now();

    // Cache-hit (tenzij ?force=1).
    if (!force && _waPhoneCache.data && _waPhoneCache.expires_at > now) {
      return res.status(200).json({
        items: _waPhoneCache.data,
        cached: true,
        expires_in_sec: Math.floor((_waPhoneCache.expires_at - now) / 1000),
      });
    }

    // Cache-miss → Meta call.
    const fields = 'id,display_phone_number,verified_name,quality_rating,code_verification_status';
    const url = `${META_BASE_URL}/${businessAccountId}/phone_numbers?fields=${fields}`;
    let metaRes;
    try {
      metaRes = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
    } catch (e) {
      console.error('[admin-whatsapp-numbers-available] fetch exception:', e.message);
      return res.status(502).json({ error: `Meta API fetch exception: ${e.message}` });
    }

    const text = await metaRes.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }

    if (!metaRes.ok) {
      const err = parsed && parsed.error ? parsed.error : null;
      const code = err?.code ?? metaRes.status;
      const subcode = err?.error_subcode ?? '';
      const msg = err?.message ?? text.slice(0, 200);
      const fbtrace = err?.fbtrace_id ?? '';
      console.error('[admin-whatsapp-numbers-available] Meta API non-2xx', {
        http_status: metaRes.status,
        meta_error: err,
        raw_body: parsed ? undefined : text.slice(0, 500),
      });
      return res.status(502).json({
        error: `Meta API ${code}: ${msg} (subcode=${subcode}, fbtrace=${fbtrace})`,
      });
    }

    const items = Array.isArray(parsed?.data) ? parsed.data.map(p => ({
      id: p.id || null,
      display_phone_number: p.display_phone_number || null,
      verified_name: p.verified_name || null,
      quality_rating: p.quality_rating || null,
      code_verification_status: p.code_verification_status || null,
    })) : [];

    // Cache vullen.
    _waPhoneCache = { data: items, expires_at: now + CACHE_TTL_MS };

    return res.status(200).json({
      items,
      cached: false,
      expires_in_sec: Math.floor(CACHE_TTL_MS / 1000),
    });
  } catch (e) {
    console.error('[admin-whatsapp-numbers-available] exception:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
