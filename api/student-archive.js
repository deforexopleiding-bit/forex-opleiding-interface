// api/student-archive.js
//
// POST → archiveer of zet-terug een student in Bubble.
//
// Permission: students.all.view (super_admin via '*', manager via 016).
// Auth: createUserClient.auth.getUser → user.id. 401 zonder. 403 zonder gate.
//
// Body: { bubble_student_id (text), action ('archive' | 'restore') }.
//
// Bubble-write: bubblePatch('user', bubble_student_id, { archived_boolean: <bool> }).
//   action='archive'  → archived_boolean = true
//   action='restore'  → archived_boolean = false
// Zelfde bubblePatch-patroon als onboarding-assign-mentor.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubblePatch } from './_lib/bubble.js';

const ACTIONS = new Set(['archive', 'restore']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'students.all.view'))) {
    return res.status(403).json({ error: 'Geen rechten (students.all.view)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const bubbleStudentId = typeof body.bubble_student_id === 'string'
    ? body.bubble_student_id.trim() : '';
  if (!bubbleStudentId) return res.status(400).json({ error: 'bubble_student_id vereist' });

  const action = typeof body.action === 'string' ? body.action.trim() : '';
  if (!ACTIONS.has(action)) {
    return res.status(400).json({ error: "action moet 'archive' of 'restore' zijn" });
  }
  const archived = (action === 'archive');

  try {
    await bubblePatch('user', bubbleStudentId, { archived_boolean: archived });
    return res.status(200).json({ ok: true, bubble_student_id: bubbleStudentId, archived });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[student-archive] bubble patch fail:', e?.code || '', msg);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: msg });
    }
    return res.status(502).json({ error: msg });
  }
}
