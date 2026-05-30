// api/kb-items.js
//
// Centraal endpoint voor de nieuwe kennisbank (kb_items tabel).
//
//   GET    /api/kb-items                          → lijst (filters: ?agent=&search=&is_profile=)
//   GET    /api/kb-items?id=<uuid>                → detail
//   GET    /api/kb-items?action=versions&id=<id>  → versie-historie laatste 10
//   GET    /api/kb-items?action=search&q=&agent=  → full-text search via tsvector
//   POST   /api/kb-items                          → create (body)
//   PUT    /api/kb-items?id=<uuid>                → update (body) — trigger snapshot
//   DELETE /api/kb-items?id=<uuid>                → delete
//   POST   /api/kb-items?action=restore&id=<id>&version=<n>  → versie terugzetten
//
// Auth: createUserClient(req). RLS dekt zichtbaarheid. Write-paden ook gated
// via requirePermission op feature-keys (kennisbank.item.create/edit/delete).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const VALID_AGENTS = new Set(['simon', 'lisa', 'leon', 'aron', 'shared']);

function sanitizeAgents(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return ['shared'];
  const cleaned = [...new Set(arr.filter(a => VALID_AGENTS.has(a)))];
  return cleaned.length ? cleaned : ['shared'];
}

function clampTitle(t) {
  const s = String(t || '').trim();
  if (!s) return null;
  return s.slice(0, 200);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const supabase = createUserClient(req);
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const id     = req.query?.id;
  const action = req.query?.action;

  // ── GET routes ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (id && !action)          return handleDetail(res, supabase, id);
    if (action === 'versions')  return handleVersions(res, supabase, id);
    if (action === 'search')    return handleSearch(res, supabase, req.query);
    return handleList(res, supabase, req.query);
  }

  // ── POST: create OF restore-version ───────────────────────────────────────
  if (req.method === 'POST') {
    if (action === 'restore') {
      const editAllowed = await requirePermission(req, 'kennisbank.item.edit');
      if (!editAllowed) return res.status(403).json({ error: 'Geen rechten om versie terug te zetten' });
      return handleRestoreVersion(res, supabase, id, req.query?.version, user.id);
    }
    const createAllowed = await requirePermission(req, 'kennisbank.item.create');
    if (!createAllowed) return res.status(403).json({ error: 'Geen rechten om kb-item aan te maken' });
    return handleCreate(req, res, supabase, user.id);
  }

  // ── PUT: update ───────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    if (!id) return res.status(400).json({ error: 'Query-param id (uuid) vereist' });
    // Profile-edit heeft eigen permission (gevoeliger).
    const { data: existing } = await supabase.from('kb_items').select('is_profile, created_by').eq('id', id).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Kb-item niet gevonden' });
    const featureKey = existing.is_profile ? 'kennisbank.profile.edit' : 'kennisbank.item.edit';
    const allowed = await requirePermission(req, featureKey);
    if (!allowed) return res.status(403).json({ error: `Geen rechten (${featureKey})` });
    return handleUpdate(req, res, supabase, id, user.id);
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'Query-param id (uuid) vereist' });
    const allowed = await requirePermission(req, 'kennisbank.item.delete');
    if (!allowed) return res.status(403).json({ error: 'Geen rechten om kb-item te verwijderen' });
    return handleDelete(res, supabase, id);
  }

  res.setHeader('Allow', 'GET, POST, PUT, DELETE');
  return res.status(405).json({ error: `Method ${req.method} not allowed` });
}

// ── Handlers ────────────────────────────────────────────────────────────────

async function handleList(res, supabase, query) {
  const { agent, search, is_profile } = query || {};
  let q = supabase
    .from('kb_items')
    .select('id, title, content, question, answer, is_profile, agents, helpfulness_score, times_used, times_helpful, created_at, updated_at, auto_generated')
    .order('helpfulness_score', { ascending: false })
    .limit(500);
  if (agent && VALID_AGENTS.has(agent)) q = q.contains('agents', [agent]);
  if (is_profile === 'true')  q = q.eq('is_profile', true);
  if (is_profile === 'false') q = q.eq('is_profile', false);
  if (search) {
    const term = `%${String(search).replace(/[%_]/g, m => '\\' + m)}%`;
    q = q.or(`title.ilike.${term},content.ilike.${term},question.ilike.${term},answer.ilike.${term}`);
  }
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ items: data || [], count: (data || []).length });
}

async function handleDetail(res, supabase, id) {
  const { data, error } = await supabase
    .from('kb_items').select('*').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data)  return res.status(404).json({ error: 'Kb-item niet gevonden' });
  return res.status(200).json({ item: data });
}

async function handleVersions(res, supabase, id) {
  if (!id) return res.status(400).json({ error: 'Query-param id vereist' });
  const { data, error } = await supabase
    .from('kb_item_versions')
    .select('id, item_id, version_number, title, content, question, answer, changed_by, created_at')
    .eq('item_id', id)
    .order('version_number', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });

  // Name-enrich changed_by via supabaseAdmin (profiles-RLS niet uniform).
  const userIds = [...new Set((data || []).map(v => v.changed_by).filter(Boolean))];
  let nameMap = {};
  if (userIds.length) {
    const { data: profs } = await supabaseAdmin.from('profiles').select('id, full_name, email').in('id', userIds);
    for (const p of profs || []) nameMap[p.id] = p.full_name || p.email || null;
  }
  const versions = (data || []).map(v => ({ ...v, changed_by_name: nameMap[v.changed_by] || null }));
  return res.status(200).json({ versions });
}

async function handleSearch(res, supabase, query) {
  const q = String(query?.q || '').trim();
  if (!q) return res.status(200).json({ items: [] });
  // tsvector full-text via Postgres. Plain-to-tsquery is veilig tegen syntax-fouten.
  let dbq = supabase
    .from('kb_items')
    .select('id, title, content, question, answer, is_profile, agents, helpfulness_score')
    .textSearch('search_text', q, { type: 'plain', config: 'dutch' })
    .limit(20);
  if (query?.agent && VALID_AGENTS.has(query.agent)) {
    dbq = dbq.contains('agents', [query.agent]);
  }
  const { data, error } = await dbq;
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ items: data || [], count: (data || []).length });
}

async function handleCreate(req, res, supabase, userId) {
  const { title, content, question, answer, agents, is_profile } = req.body || {};
  const titleClean = clampTitle(title);
  if (!titleClean) return res.status(400).json({ error: 'Titel is verplicht (1-200 chars)' });

  const row = {
    title:       titleClean,
    content:     content  ? String(content)  : null,
    question:    question ? String(question) : null,
    answer:      answer   ? String(answer)   : null,
    is_profile:  Boolean(is_profile),
    agents:      sanitizeAgents(agents),
    created_by:  userId,
    auto_generated: false,
  };
  const { data, error } = await supabase.from('kb_items').insert(row).select('*').single();
  if (error) {
    console.error('[kb-items] insert error:', error.message);
    return res.status(500).json({ error: error.message });
  }
  return res.status(201).json({ item: data });
}

async function handleUpdate(req, res, supabase, id, userId) {
  const { title, content, question, answer, agents, is_profile } = req.body || {};
  const updates = {};
  if (title    !== undefined) {
    const t = clampTitle(title);
    if (!t) return res.status(400).json({ error: 'Titel moet 1-200 chars zijn' });
    updates.title = t;
  }
  if (content  !== undefined) updates.content  = content  === null ? null : String(content);
  if (question !== undefined) updates.question = question === null ? null : String(question);
  if (answer   !== undefined) updates.answer   = answer   === null ? null : String(answer);
  if (agents   !== undefined) updates.agents   = sanitizeAgents(agents);
  if (is_profile !== undefined) updates.is_profile = Boolean(is_profile);

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'Geen velden om te updaten' });
  }

  const { data, error } = await supabase
    .from('kb_items').update(updates).eq('id', id).select('*').single();
  if (error) {
    console.error('[kb-items] update error:', error.message);
    if (error.code === '42501') return res.status(403).json({ error: 'Geen rechten via RLS' });
    return res.status(500).json({ error: error.message });
  }
  return res.status(200).json({ item: data });
}

async function handleDelete(res, supabase, id) {
  const { error } = await supabase.from('kb_items').delete().eq('id', id);
  if (error) {
    if (error.code === '42501') return res.status(403).json({ error: 'Geen rechten via RLS' });
    return res.status(500).json({ error: error.message });
  }
  return res.status(204).end();
}

async function handleRestoreVersion(res, supabase, id, version, userId) {
  if (!id || !version) return res.status(400).json({ error: 'id + version verplicht' });
  // Fetch versie-snapshot.
  const { data: snap, error: snapErr } = await supabase
    .from('kb_item_versions')
    .select('title, content, question, answer')
    .eq('item_id', id)
    .eq('version_number', Number(version))
    .maybeSingle();
  if (snapErr) return res.status(500).json({ error: snapErr.message });
  if (!snap)   return res.status(404).json({ error: 'Versie niet gevonden' });

  // UPDATE met snapshot-velden — trigger maakt nieuwe snapshot van huidige state.
  const { data, error } = await supabase
    .from('kb_items').update({
      title:    snap.title,
      content:  snap.content,
      question: snap.question,
      answer:   snap.answer,
    }).eq('id', id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(200).json({ item: data, restored_from_version: Number(version) });
}
