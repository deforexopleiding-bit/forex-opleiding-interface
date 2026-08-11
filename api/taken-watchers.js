// api/taken-watchers.js
//
// M:N tussen taken en profielen. Zelfde auth+error-shape als
// api/taken-attachments.js — geen Storage, alleen SQL.
//
// GET    ?task_id=<uuid> → 200 { watchers: [{ id, task_id, profile_id,
//        added_by, added_at, notify_mode, profile_name, profile_email }] }
//        Read-only lijst — RLS bepaalt zichtbaarheid (participant / owner /
//        watcher / super_admin).
//
// POST   { task_id, profile_id, notify_mode? }
//        notify_mode: 'default' (default) | 'none'
//        added_by = auth.uid()
//        → 201 { watcher: {...} }
//        UNIQUE (task_id, profile_id) → 409 op duplicate
//
// DELETE ?id=<uuid>  → 204
//        RLS staat watcher-zelf (unsubscribe), task-owner en ADMIN toe.
//
// LET OP: geen create-if-not-exists shortcut op DELETE — client geeft de
// concrete watcher-id op (idem tickets-pattern). Voor "unsubscribe by
// profile_id + task_id" moet client eerst een SELECT doen; endpoint blijft
// bewust simpel/idempotent-per-id.

import { createUserClient } from './supabase.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  if (req.method === 'GET')    return handleList(req, res, supabase);
  if (req.method === 'POST')   return handleCreate(req, res, supabase, user);
  if (req.method === 'DELETE') return handleDelete(req, res, supabase);
}

async function handleList(req, res, supabase) {
  const task_id = req.query?.task_id;
  if (!task_id || typeof task_id !== 'string') {
    return res.status(400).json({ error: 'Query-param task_id (uuid) vereist' });
  }
  const { data, error } = await supabase
    .from('taken_watchers')
    .select(`
      id, task_id, profile_id, added_by, added_at, notify_mode,
      profile:profiles!taken_watchers_profile_id_fkey ( full_name, email )
    `)
    .eq('task_id', task_id)
    .order('added_at', { ascending: true });

  if (error) {
    console.error('[taken-watchers] list error:', error.code, error.message);
    if (error.code === '42501') return res.status(403).json({ error: 'Geen rechten om watchers te bekijken' });
    return res.status(500).json({ error: error.message });
  }
  const watchers = (data || []).map((w) => ({
    id: w.id, task_id: w.task_id, profile_id: w.profile_id,
    added_by: w.added_by, added_at: w.added_at, notify_mode: w.notify_mode,
    profile_name: w.profile?.full_name || null,
    profile_email: w.profile?.email || null,
  }));
  return res.status(200).json({ watchers });
}

async function handleCreate(req, res, supabase, user) {
  const body = req.body || {};
  const { task_id, profile_id, notify_mode } = body;

  if (!task_id || typeof task_id !== 'string') {
    return res.status(400).json({ error: 'task_id (uuid) vereist' });
  }
  if (!profile_id || typeof profile_id !== 'string') {
    return res.status(400).json({ error: 'profile_id (uuid) vereist' });
  }

  const nm = notify_mode === 'none' ? 'none' : 'default';

  const row = {
    task_id,
    profile_id,
    added_by: user.id,
    notify_mode: nm,
  };

  const { data, error } = await supabase
    .from('taken_watchers')
    .insert(row)
    .select('id, task_id, profile_id, added_by, added_at, notify_mode')
    .single();

  if (error) {
    console.error('[taken-watchers] insert error:', error.code, error.message);
    if (error.code === '23505') {
      // UNIQUE (task_id, profile_id) — al watcher, geen state-verandering
      return res.status(409).json({ error: 'Profiel is al watcher op deze taak' });
    }
    if (error.code === '42501') {
      return res.status(403).json({ error: 'Geen rechten om watcher toe te voegen' });
    }
    if (error.code === '23503') {
      // FK-violatie: task_id of profile_id bestaat niet
      return res.status(400).json({ error: 'Ongeldige task_id of profile_id' });
    }
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json({ watcher: data });
}

async function handleDelete(req, res, supabase) {
  const id = req.query?.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Query-param id (uuid) vereist' });
  }

  const { error: delErr, count } = await supabase
    .from('taken_watchers')
    .delete({ count: 'exact' })
    .eq('id', id);

  if (delErr) {
    console.error('[taken-watchers] delete error:', delErr.code, delErr.message);
    if (delErr.code === '42501') {
      return res.status(403).json({ error: 'Geen rechten om deze watcher te verwijderen' });
    }
    return res.status(500).json({ error: delErr.message });
  }
  if (count === 0) {
    return res.status(404).json({ error: 'Watcher niet gevonden of geen toegang' });
  }

  return res.status(204).end();
}
