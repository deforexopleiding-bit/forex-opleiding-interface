// api/teamleader-email-templates.js
// GET → lijst TL email-templates voor de verstuur-dropdown.
// Cached 1 uur in-memory (templates wijzigen zelden).
//
// Bron: TL mailTemplates.list (bevestigd aanwezig in apiary; exacte
// response-velden niet live geverifieerd → defensief gemapt op id/name).

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { tlFetch, getActiveToken } from './_lib/teamleader-token.js';

const _cache = new Map(); // type → { at, data }
const TTL_MS = 60 * 60 * 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'sales.deal.view'))) {
    return res.status(403).json({ error: 'Geen rechten (sales.deal.view)' });
  }

  // filter.type is VERPLICHT bij mailTemplates.list → default 'quotation'.
  const type = (req.query?.type || '').trim() || 'quotation';
  const cacheKey = type;
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return res.status(200).json({ templates: hit.data, cached: true });
  }

  try {
    const tok = await getActiveToken();
    if (!tok) return res.status(200).json({ templates: [], reason: 'no_token' });

    const r = await tlFetch('/mailTemplates.list', { method: 'POST', body: JSON.stringify({ filter: { type } }) });
    if (!r.ok) {
      const txt = await r.text();
      return res.status(200).json({ templates: [], reason: 'api_error', status: r.status, body: txt.slice(0, 200) });
    }
    const data = await r.json();
    const templates = (data.data || []).map(t => ({
      id:   t.id,
      name: t.name || t.subject || t.id,
      type: t.type || null,
      language: t.language || null,
    }));
    _cache.set(cacheKey, { at: Date.now(), data: templates });
    return res.status(200).json({ templates });
  } catch (e) {
    console.error('[tl-email-templates]', e.message);
    return res.status(200).json({ templates: [], reason: 'exception', error: e.message });
  }
}
