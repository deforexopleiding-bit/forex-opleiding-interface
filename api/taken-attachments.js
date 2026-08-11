// api/taken-attachments.js
//
// 1-op-1 kopie van api/ticket-attachments.js. Bucket + tabel + prefix aangepast:
// tickets-attachments  -> taken-attachments
// ticket_attachments   -> taken_attachments
// ticket_id            -> task_id
//
// GET    ?task_id=<uuid> → 200 { attachments: [{ id, task_id, comment_id,
//        storage_path, external_url, filename, mime_type, created_by,
//        created_at }] }
//        Read-only lijst per taak — RLS bepaalt zichtbaarheid.
//
// POST   { task_id?, comment_id?, storage_path?, external_url?, filename?, mime_type? }
//        XOR: exact één van (task_id, comment_id) én exact één van
//        (storage_path, external_url). created_by = auth.uid().
//        → 201 { attachment: {...} }
//
// DELETE ?id=<uuid>  → 204
//        Voor storage_path-attachments: ook delete uit bucket via admin
//        (anders blijven files orphan in storage).
//
// LET OP: taken_attachments.comment_id is gereserveerd (geen FK) voor
// toekomstige taken_comments-uitbreiding. Nu accepteren we 'm alleen als
// XOR-alternatief voor task_id; API returnt 400 als beide leeg zijn.

import { createUserClient, supabaseAdmin } from './supabase.js';

const BUCKET = 'taken-attachments';

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
    .from('taken_attachments')
    .select(`
      id, task_id, comment_id, storage_path, external_url,
      filename, mime_type, created_by, created_at
    `)
    .eq('task_id', task_id)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[taken-attachments] list error:', error.code, error.message);
    if (error.code === '42501') return res.status(403).json({ error: 'Geen rechten om bijlagen te bekijken' });
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ attachments: data || [] });
}

async function handleCreate(req, res, supabase, user) {
  const body = req.body || {};
  const { task_id, comment_id, storage_path, external_url, filename, mime_type } = body;

  // XOR parent
  const hasTask    = !!task_id;
  const hasComment = !!comment_id;
  if (hasTask === hasComment) {
    return res.status(400).json({ error: 'Precies één van task_id of comment_id vereist' });
  }
  // XOR source
  const hasStorage = typeof storage_path === 'string' && storage_path.trim();
  const hasUrl     = typeof external_url === 'string' && external_url.trim();
  if (!!hasStorage === !!hasUrl) {
    return res.status(400).json({ error: 'Precies één van storage_path of external_url vereist' });
  }

  if (hasUrl) {
    try {
      const u = new URL(external_url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return res.status(400).json({ error: 'external_url moet http(s) zijn' });
      }
    } catch {
      return res.status(400).json({ error: 'external_url is geen geldige URL' });
    }
  }

  const row = {
    task_id:      hasTask    ? task_id    : null,
    comment_id:   hasComment ? comment_id : null,
    storage_path: hasStorage ? storage_path.trim() : null,
    external_url: hasUrl     ? external_url.trim() : null,
    filename:     typeof filename === 'string' && filename.trim() ? filename.trim().slice(0, 255) : null,
    mime_type:    typeof mime_type === 'string' && mime_type.trim() ? mime_type.trim().slice(0, 100) : null,
    created_by:   user.id,
  };

  const { data, error } = await supabase
    .from('taken_attachments')
    .insert(row)
    .select(`
      id, task_id, comment_id, storage_path, external_url, filename, mime_type,
      created_by, created_at
    `)
    .single();

  if (error) {
    console.error('[taken-attachments] insert error:', error.code, error.message);
    if (error.code === '42501') {
      return res.status(403).json({ error: 'Geen rechten om bijlage toe te voegen' });
    }
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json({ attachment: data });
}

async function handleDelete(req, res, supabase) {
  const id = req.query?.id;
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'Query-param id (uuid) vereist' });
  }

  // Eerst de rij ophalen (voor storage_path om uit bucket te verwijderen).
  // RLS bepaalt of we 'm überhaupt mogen zien — als niet zichtbaar dan 404.
  const { data: existing, error: fetchErr } = await supabase
    .from('taken_attachments')
    .select('id, storage_path')
    .eq('id', id)
    .maybeSingle();

  if (fetchErr) {
    console.error('[taken-attachments] fetch error:', fetchErr.message);
    return res.status(500).json({ error: fetchErr.message });
  }
  if (!existing) {
    return res.status(404).json({ error: 'Bijlage niet gevonden of geen toegang' });
  }

  const { error: delErr, count } = await supabase
    .from('taken_attachments')
    .delete({ count: 'exact' })
    .eq('id', id);

  if (delErr) {
    console.error('[taken-attachments] delete error:', delErr.code, delErr.message);
    if (delErr.code === '42501') {
      return res.status(403).json({ error: 'Geen rechten om deze bijlage te verwijderen' });
    }
    return res.status(500).json({ error: delErr.message });
  }
  if (count === 0) {
    return res.status(404).json({ error: 'Bijlage niet gevonden' });
  }

  // Storage cleanup (best-effort). Bij failure: orphan blob, geen API-fout terug.
  if (existing.storage_path) {
    const { error: stErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .remove([existing.storage_path]);
    if (stErr) {
      console.warn('[taken-attachments] storage delete failed (orphan blob):', stErr.message);
    }
  }

  return res.status(204).end();
}
