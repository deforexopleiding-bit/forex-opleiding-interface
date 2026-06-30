// api/manager-notification-mark-read.js
//
// POST — markeer 1 of meer manager-meldingen als gelezen. Gedeeld postvak;
// een melding die door manager A gelezen wordt verdwijnt voor iedereen.
//
// Body: { id: uuid } OF { ids: [uuid, ...] }.
// Speciaal: { ids: 'all' } markeert ALLE unread (handig voor 'alles gelezen').
//
// Permission-gate: seesAll (onboarding.admin / super_admin). Mentor → 403.
//
// Response 200: { ok:true, updated: <aantal rijen daadwerkelijk geüpdatet> }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { getOnboardingScope } from './_lib/onboardingScope.js';

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

  const scopeInfo = await getOnboardingScope(req);
  if (!scopeInfo.seesAll) {
    return res.status(403).json({ error: 'Geen rechten (onboarding.admin vereist).' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const wantAll = (body.ids === 'all') || (body.id === 'all');
  let ids = [];
  if (!wantAll) {
    if (Array.isArray(body.ids)) {
      ids = body.ids.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
    } else if (typeof body.id === 'string' && body.id.trim()) {
      ids = [body.id.trim()];
    }
    if (ids.length === 0)  return res.status(400).json({ error: 'id, ids of "all" verplicht' });
    if (ids.length > 200)  return res.status(400).json({ error: 'maximaal 200 ids per call' });
    for (const x of ids) {
      if (!UUID_RE.test(x)) return res.status(400).json({ error: 'ongeldige uuid in ids' });
    }
  }

  try {
    const nowIso = new Date().toISOString();
    let q = supabaseAdmin
      .from('manager_notifications')
      .update({ read_at: nowIso, read_by: user.id })
      .is('read_at', null);
    if (!wantAll) q = q.in('id', ids);
    const { data: updated, error: updErr } = await q.select('id');
    if (updErr) throw new Error('manager_notifications mark-read: ' + updErr.message);

    return res.status(200).json({ ok: true, updated: (updated || []).length });
  } catch (e) {
    console.error('[manager-notification-mark-read]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
