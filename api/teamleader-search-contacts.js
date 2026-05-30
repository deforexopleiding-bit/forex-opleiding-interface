// api/teamleader-search-contacts.js
// POST { email?, phone? } → { tl_matches: [...] }
// Voor wizard stap 1 duplicate-check tegen TL.

import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';
import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
  const tok = await getActiveToken();
  if (!tok) return res.status(200).json({ tl_matches: [], reason: 'no_token' });

  try {
    // TL contacts.list met email_filter — endpoint: POST /contacts.list
    const body = {
      filter: {},
      page:   { size: 10, number: 1 },
    };
    if (email) body.filter.email = String(email).trim().toLowerCase();
    if (phone) body.filter.term = String(phone).trim();

    const r = await tlFetch('/contacts.list', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      console.warn('[tl-search]', r.status, txt);
      return res.status(200).json({ tl_matches: [], reason: 'api_error', status: r.status });
    }
    const data = await r.json();
    const matches = (data.data || []).map(c => ({
      tl_id:        c.id,
      name:         `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email || c.id,
      email:        c.emails?.[0]?.email || null,
      phone:        c.telephones?.[0]?.number || null,
      created_at:   c.added_at || null,
    }));
    return res.status(200).json({ tl_matches: matches });
  } catch (e) {
    return res.status(200).json({ tl_matches: [], reason: 'exception', error: e.message });
  }
}
