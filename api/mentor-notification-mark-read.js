// api/mentor-notification-mark-read.js
//
// POST — markeer 1 of meer eigen meldingen als gelezen.
//
// Body: { id: uuid } OF { ids: [uuid, ...] }.
//
// OWNERSHIP-gate: UPDATE wordt ALTIJD gefilterd op mentor_user_id = user.id.
// Een mentor kan NOOIT andermans melding op gelezen zetten — ongeacht of hij
// per ongeluk een vreemde id meestuurt. Spiegel van inbox-mark-read-stijl.
//
// Permission: mentor.module.access.
//
// Response 200: { ok:true, updated: <aantal rijen daadwerkelijk geüpdatet> }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  let ids = [];
  if (Array.isArray(body.ids)) {
    ids = body.ids.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
  } else if (typeof body.id === 'string' && body.id.trim()) {
    ids = [body.id.trim()];
  }
  if (ids.length === 0)  return res.status(400).json({ error: 'id of ids verplicht' });
  if (ids.length > 200)  return res.status(400).json({ error: 'maximaal 200 ids per call' });
  for (const x of ids) {
    if (!UUID_RE.test(x)) return res.status(400).json({ error: 'ongeldige uuid in ids' });
  }

  try {
    const nowIso = new Date().toISOString();
    // KRITIEK: filter ALTIJD mee op mentor_user_id = user.id. Zonder die
    // clause zou een mentor met een willekeurige uuid andermans melding
    // kunnen marker. Met de mentor-clause is dat onmogelijk: ids die niet
    // van deze user zijn matchen simpelweg niet en blijven onaangeraakt.
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('mentor_notifications')
      .update({ read_at: nowIso })
      .in('id', ids)
      .eq('mentor_user_id', user.id)
      .is('read_at', null)
      .select('id');
    if (updErr) throw new Error('notifications mark-read: ' + updErr.message);

    return res.status(200).json({ ok: true, updated: (updated || []).length });
  } catch (e) {
    console.error('[mentor-notification-mark-read]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
