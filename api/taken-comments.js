// api/taken-comments.js
//
// GET ?task_id=<uuid>  → comments ASC, enriched met author_name.
// POST { task_id, body } → insert + return { ok, comment }.
//
// Auth: vereist. Participant-or-admin check op de taak:
//   user.id ∈ { created_by, assigned_to_id } ∪ taken_assignees.assignee_id
//   OF verifyAdmin → toegestaan; anders 403.
//
// Body-validatie: trim, niet leeg, max 2000 tekens. 404 als taak niet bestaat.

import { createUserClient, supabaseAdmin, verifyAdmin } from './supabase.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 2000;

async function loadTask(taskId) {
  const { data, error } = await supabaseAdmin
    .from('taken_items')
    .select('id, created_by, assigned_to_id')
    .eq('id', taskId)
    .maybeSingle();
  if (error) throw new Error('task lookup: ' + error.message);
  return data || null;
}

async function loadAssigneeIds(taskId) {
  const { data, error } = await supabaseAdmin
    .from('taken_assignees')
    .select('assignee_id')
    .eq('task_id', taskId);
  if (error) throw new Error('assignees lookup: ' + error.message);
  return (data || []).map((r) => r.assignee_id).filter(Boolean);
}

async function checkParticipantOrAdmin(req, userId, task) {
  if (!task) return false;
  if (task.created_by === userId)     return true;
  if (task.assigned_to_id === userId) return true;
  try {
    const ids = await loadAssigneeIds(task.id);
    if (ids.includes(userId)) return true;
  } catch (e) { /* fail-soft */ }
  const admin = await verifyAdmin(req);
  return !!admin;
}

async function fetchAuthorNames(userIds) {
  const ids = Array.from(new Set((userIds || []).filter(Boolean)));
  if (ids.length === 0) return {};
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, email')
    .in('id', ids);
  if (error) {
    console.warn('[taken-comments] profile-names:', error.message);
    return {};
  }
  const map = {};
  for (const p of (data || [])) map[p.id] = p.full_name || p.email || null;
  return map;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (req.method === 'GET') {
    const taskId = typeof req.query?.task_id === 'string' ? req.query.task_id.trim() : '';
    if (!UUID_RE.test(taskId)) return res.status(400).json({ error: 'task_id (uuid) vereist' });

    try {
      const task = await loadTask(taskId);
      if (!task) return res.status(404).json({ error: 'Taak niet gevonden' });

      const ok = await checkParticipantOrAdmin(req, user.id, task);
      if (!ok) return res.status(403).json({ error: 'Geen toegang tot deze taak' });

      const { data: rows, error } = await supabaseAdmin
        .from('taken_comments')
        .select('id, user_id, body, created_at')
        .eq('task_id', taskId)
        .order('created_at', { ascending: true })
        .limit(500);
      if (error) throw new Error('comments fetch: ' + error.message);

      const nameMap = await fetchAuthorNames((rows || []).map((r) => r.user_id));
      const comments = (rows || []).map((r) => ({
        id          : r.id,
        user_id     : r.user_id,
        author_name : nameMap[r.user_id] || null,
        body        : r.body,
        created_at  : r.created_at,
      }));
      return res.status(200).json({ comments });
    } catch (e) {
      console.error('[taken-comments] GET:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object') ? req.body : null;
    if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

    const taskId = typeof body.task_id === 'string' ? body.task_id.trim() : '';
    if (!UUID_RE.test(taskId)) return res.status(400).json({ error: 'task_id (uuid) vereist' });

    const raw = body.body == null ? '' : String(body.body);
    const text = raw.trim();
    if (!text) return res.status(400).json({ error: 'body vereist' });
    if (text.length > MAX_BODY) return res.status(400).json({ error: `body max ${MAX_BODY} tekens` });

    try {
      const task = await loadTask(taskId);
      if (!task) return res.status(404).json({ error: 'Taak niet gevonden' });

      const ok = await checkParticipantOrAdmin(req, user.id, task);
      if (!ok) return res.status(403).json({ error: 'Geen toegang tot deze taak' });

      const { data: ins, error: insErr } = await supabaseAdmin
        .from('taken_comments')
        .insert({ task_id: taskId, user_id: user.id, body: text })
        .select('id, user_id, body, created_at')
        .single();
      if (insErr) throw new Error('insert: ' + insErr.message);

      const nameMap = await fetchAuthorNames([user.id]);
      const comment = {
        id          : ins.id,
        user_id     : ins.user_id,
        author_name : nameMap[user.id] || null,
        body        : ins.body,
        created_at  : ins.created_at,
      };
      return res.status(201).json({ ok: true, comment });
    } catch (e) {
      console.error('[taken-comments] POST:', e?.message || e);
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}
