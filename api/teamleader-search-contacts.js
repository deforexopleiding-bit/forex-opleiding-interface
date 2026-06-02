// api/teamleader-search-contacts.js
// POST { email?, phone? } → { tl_matches: [...] }
// Voor wizard stap 2 (Klantgegevens) duplicate-check tegen het TL-klantenbestand.
//
// 1. /contacts.list met email/term-filter → basis-matches (id, naam, email, tel).
// 2. Per match best-effort /contacts.info → volledig adres (line_1, postcode,
//    plaats) zodat de wizard die kan autofillen. Een falende info-call laat de
//    basisvelden intact (geen harde fout).
//
// TL kent geen signature; deze endpoint is auth-gated (sales.customer.create).
// Bij geen token / API-fout → lege tl_matches + reason, zodat de wizard-flowh
// gewoon doorgaat zonder match.

import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

// Splits een TL line_1 ("Topperreend 60") in straat + huisnummer (best-effort).
function splitStreet(line1) {
  if (!line1) return { street: null, number: null };
  const m = String(line1).trim().match(/^(.*?)\s+(\d+\s*[a-zA-Z]?(?:[-\/]\d+)?)$/);
  if (m) return { street: m[1].trim(), number: m[2].replace(/\s+/g, '') };
  return { street: line1.trim(), number: null };
}

// Map een TL-contactobject (info of list) → wizard-match met adresvelden.
function mapContact(c) {
  const addr = (Array.isArray(c.addresses) ? c.addresses : []);
  const primary = addr.find(a => a.type === 'primary') || addr[0] || null;
  const a = primary?.address || {};
  const { street, number } = splitStreet(a.line_1);
  const parts = [a.line_1, [a.postal_code, a.city].filter(Boolean).join(' ')].filter(Boolean);
  return {
    tl_id:           c.id,
    first_name:      c.first_name || '',
    last_name:       c.last_name || '',
    name:            `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.emails?.[0]?.email || c.id,
    email:           c.emails?.[0]?.email || null,
    phone:           c.telephones?.[0]?.number || null,
    address_street:  street,
    address_number:  number,
    address_postal:  a.postal_code || null,
    address_city:    a.city || null,
    address:         parts.join(', ') || null,
    created_at:      c.added_at || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.customer.create'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.customer.create)' });
  }

  const { email, phone } = req.body || {};
  // Geen zoekterm → niets te zoeken (skip TL search).
  if (!email && !phone) return res.status(200).json({ tl_matches: [], reason: 'no_query' });

  const tok = await getActiveToken();
  if (!tok) return res.status(200).json({ tl_matches: [], reason: 'no_token' });

  try {
    // 1. TL contacts.list met email/term-filter — endpoint: POST /contacts.list
    // TL verwacht filter.email als OBJECT { type, email } (plain string → HTTP 400,
    // live bevestigd). Voor MVP alleen 'primary' (vrijwel alle klanten hebben er 1).
    const body = { filter: {}, page: { size: 10, number: 1 } };
    if (email) body.filter.email = { type: 'primary', email: String(email).trim().toLowerCase() };
    if (phone) body.filter.term = String(phone).trim();

    const r = await tlFetch('/contacts.list', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[tl-search] contacts.list', r.status, txt.slice(0, 200));
      return res.status(200).json({ tl_matches: [], reason: 'api_error', status: r.status });
    }
    const data = await r.json();
    const baseList = data.data || [];

    // 2. Per match best-effort verrijken met volledig adres via contacts.info.
    //    (contacts.list bevat doorgaans geen addresses[]; info wel.)
    const matches = [];
    for (const base of baseList) {
      let full = base;
      try {
        const ir = await tlFetch('/contacts.info', { method: 'POST', body: JSON.stringify({ id: base.id }) });
        if (ir.ok) { const idata = await ir.json(); if (idata.data) full = idata.data; }
        else console.warn('[tl-search] contacts.info', ir.status, 'id=', base.id);
      } catch (e) { console.warn('[tl-search] contacts.info exception id=', base.id, e.message); }
      matches.push(mapContact(full));
    }

    return res.status(200).json({ tl_matches: matches });
  } catch (e) {
    console.warn('[tl-search] exception:', e.message);
    return res.status(200).json({ tl_matches: [], reason: 'exception', error: e.message });
  }
}
