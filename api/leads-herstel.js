// api/leads-herstel.js
// POST { ids: [uuid,...] }  (of { id: uuid })  → HERSTEL gearchiveerde leads:
//   verwijderd_op = NULL, verwijderd_door = NULL.
//
// KRITIEK — Permission: leads.delete (zelfde recht als verwijderen). Alleen
// admin (+ super_admin-wildcard). Server-side afgedwongen (fail-closed).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'leads.delete'))) {
    return res.status(403).json({ error: 'Geen rechten (leads.delete)' });
  }

  const body = req.body || {};
  const raw = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
  const ids = [...new Set(raw.map((x) => String(x).trim()).filter((x) => UUID_RE.test(x)))];
  if (!ids.length) return res.status(400).json({ error: 'geen geldige lead-id(s)' });

  try {
    const { data, error } = await supabaseAdmin
      .from('leads')
      .update({ verwijderd_op: null, verwijderd_door: null })
      .in('id', ids)
      .not('verwijderd_op', 'is', null)   // alleen gearchiveerde leads
      .select('id');
    if (error) throw new Error('leads herstellen: ' + error.message);
    return res.status(200).json({ ok: true, hersteld: (data || []).length });
  } catch (e) {
    console.error('[leads-herstel]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
