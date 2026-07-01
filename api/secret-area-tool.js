// api/secret-area-tool.js
// GET    ?id  → tool + examples[] (met signed URLs)
// POST        → nieuwe tool { name, description }
// PUT    ?id  → tool update
// DELETE ?id  → tool + examples (best-effort DB cascade)
// Owner-gated.

import { supabaseAdmin } from './supabase.js';
import { requireOwner } from './_lib/secretArea.js';

const BUCKET = 'secret-area';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNED_TTL_SEC = 60 * 60; // 1u

async function signPath(path) {
  if (!path) return null;
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET)
      .createSignedUrl(path, SIGNED_TTL_SEC);
    if (error) { console.warn('[sa-tool] sign:', error.message); return null; }
    return data?.signedUrl || null;
  } catch (e) { console.warn('[sa-tool] sign exception:', e?.message || e); return null; }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  const id = typeof req.query?.id === 'string' ? req.query.id.trim() : '';

  try {
    if (req.method === 'GET') {
      if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      const [{ data: tool }, { data: examples }] = await Promise.all([
        supabaseAdmin.from('sa_tools')
          .select('*').eq('id', id).eq('owner_id', ctx.userId).maybeSingle(),
        supabaseAdmin.from('sa_tool_examples')
          .select('*').eq('tool_id', id).eq('owner_id', ctx.userId)
          .order('created_at', { ascending: false }),
      ]);
      if (!tool) return res.status(404).json({ error: 'Tool niet gevonden' });
      const examplesOut = [];
      for (const ex of (examples || [])) {
        examplesOut.push({ ...ex, image_url: await signPath(ex.image_path) });
      }
      return res.status(200).json({ tool, examples: examplesOut });
    }

    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const row = {
        owner_id:    ctx.userId,
        name:        typeof body.name        === 'string' ? body.name.slice(0, 200)         : 'Nieuwe tool',
        description: typeof body.description === 'string' ? body.description.slice(0, 5000) : null,
      };
      const { data: created, error } = await supabaseAdmin
        .from('sa_tools').insert(row).select('*').single();
      if (error) throw new Error('insert: ' + error.message);
      return res.status(201).json({ tool: created });
    }

    if (req.method === 'PUT') {
      if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const patch = {};
      if (typeof body.name        === 'string') patch.name        = body.name.slice(0, 200);
      if (typeof body.description === 'string') patch.description = body.description.slice(0, 5000);
      const { data: updated, error } = await supabaseAdmin
        .from('sa_tools').update(patch)
        .eq('id', id).eq('owner_id', ctx.userId).select('*').maybeSingle();
      if (error) throw new Error('update: ' + error.message);
      if (!updated) return res.status(404).json({ error: 'Tool niet gevonden' });
      return res.status(200).json({ tool: updated });
    }

    if (req.method === 'DELETE') {
      if (!id || !UUID_RE.test(id)) return res.status(400).json({ error: 'id (uuid) vereist' });
      // Examples eerst opruimen (best-effort; DB cascade neemt anders over).
      await supabaseAdmin.from('sa_tool_examples')
        .delete().eq('tool_id', id).eq('owner_id', ctx.userId);
      const { error } = await supabaseAdmin.from('sa_tools')
        .delete().eq('id', id).eq('owner_id', ctx.userId);
      if (error) throw new Error('delete: ' + error.message);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('[sa-tool]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
