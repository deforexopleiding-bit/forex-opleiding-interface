// api/dev-tl-contact-info.js
// TIJDELIJK read-only debug endpoint voor RECON: haalt raw contacts.info
// op voor een gegeven TL contact-id en dumpt het volledige addresses[]-
// subobject zodat we exact kunnen zien welke velden TL WERKELIJK returnt
// (bevestiging dat er geen apart number/house_number/etc veld bestaat).
//
// Auth: super_admin only. Geen data-mutatie; alleen GET. Verwijderen
// zodra de recon compleet is.
//
// Usage: GET /api/dev-tl-contact-info?id=<tl-contact-uuid>
//   → { ok, id, name, addresses, addresses_count, full }

import { createUserClient } from './supabase.js';
import { tlFetch } from './_lib/teamleader-token.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Beperk tot super_admin — dit is een tijdelijk recon-endpoint.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (profile?.role !== 'super_admin') {
    return res.status(403).json({ error: 'super_admin only' });
  }

  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';
  if (!id || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'id (uuid) vereist' });
  }

  try {
    const r = await tlFetch('/contacts.info', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    const raw = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({
        error: `TL HTTP ${r.status}`,
        body_snippet: raw.slice(0, 500),
      });
    }
    let json;
    try { json = JSON.parse(raw); }
    catch (_) {
      return res.status(500).json({ error: 'JSON parse fail', raw: raw.slice(0, 500) });
    }

    const data = json?.data || null;
    const addresses = Array.isArray(data?.addresses) ? data.addresses : [];
    const nameParts = [data?.first_name, data?.last_name].filter(Boolean).join(' ').trim();
    return res.status(200).json({
      ok: true,
      id,
      name: nameParts || null,
      addresses,
      addresses_count: addresses.length,
      // Volledige data-blob (voor het geval er address-relevante velden
      // buiten `addresses[]` staan, bv. custom fields).
      full: data,
    });
  } catch (e) {
    console.error('[dev-tl-contact-info]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
