// api/notifications-mark-read.js
//
// POST — markeer 1 of meerdere eigen meldingen als gelezen, OF alles. Een
// user kan ALLEEN z'n eigen rijen marken; de UPDATE filtert altijd hard
// op .eq('user_id', user.id).
//
// Auth: createUserClient + getUser → 401 als geen user.
// GEEN requirePermission-gate: meldingen zijn er voor iedereen die ingelogd is.
//
// Body:
//   { id: uuid }      — markeer één
//   { ids: [uuid…] }  — markeer N (max 200)
//   { all: true }     — markeer ALLE eigen ongelezen rijen
//
// Response 200: { ok: true, updated: <aantal> }.

import { createUserClient, supabaseAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const markAll = body.all === true;

  let ids = [];
  if (!markAll) {
    if (Array.isArray(body.ids)) {
      ids = body.ids.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
    } else if (typeof body.id === 'string' && body.id.trim()) {
      ids = [body.id.trim()];
    }
    if (ids.length === 0)  return res.status(400).json({ error: 'id, ids of "all":true verplicht' });
    if (ids.length > 200)  return res.status(400).json({ error: 'maximaal 200 ids per call' });
    for (const x of ids) {
      if (!UUID_RE.test(x)) return res.status(400).json({ error: 'ongeldige uuid in ids' });
    }
  }

  try {
    const nowIso = new Date().toISOString();
    // KRITIEK: ALTIJD .eq('user_id', user.id) — voorkomt dat een user
    // andermans rij kan marken zelfs als 'ie het id ergens vandaan haalt.
    let updQuery = supabaseAdmin
      .from('notifications')
      .update({ read_at: nowIso })
      .eq('user_id', user.id)
      .is('read_at', null);
    if (!markAll) updQuery = updQuery.in('id', ids);
    const { data: updated, error: updErr } = await updQuery.select('id');
    if (updErr) throw new Error('notifications mark-read: ' + updErr.message);

    return res.status(200).json({ ok: true, updated: (updated || []).length });
  } catch (e) {
    console.error('[notifications-mark-read]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
