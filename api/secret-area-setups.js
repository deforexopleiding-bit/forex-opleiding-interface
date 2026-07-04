// api/secret-area-setups.js
//
// Strategie-trainer — CRUD voor de FMES-setup-bibliotheek (Secret Area).
// Owner-gated (requireOwner EERST → 403). Alle storage/DB-ops via service-role
// (supabaseAdmin) MET expliciete user_id-filter als tweede laag; RLS op
// public.sa_setups (user_id = auth.uid()) is de eerste laag. De private bucket
// 'sa-strategy-setups' wordt nooit publiek geëxposeerd — de frontend krijgt
// uitsluitend kortlevende signed URLs. Geen token/secret in response of logs.
//
// Acties (query ?action=…):
//   POST   ?action=upload           { data_base64, content_type, filename, ...labels } → nieuwe rij + signed_url
//   GET    ?action=list             [&model&is_positive&instrument]                    → alle setups (signed thumbnails)
//   GET    ?action=get&id=UUID                                                         → volledige rij + signed_url
//   PATCH  ?action=update&id=UUID   { …labels }                                        → bijgewerkte rij + signed_url
//   DELETE ?action=delete&id=UUID                                                      → { ok } (rij + storage-bestand weg)
//
// Screenshot is niet vervangbaar via update — delete + opnieuw uploaden.
//
// Responses: puur JSON. 400 validatie | 403 owner-gate | 404 niet gevonden |
// 500 server/db | 503 bucket ontbreekt.

import crypto from 'node:crypto';
import { requireOwner } from './_lib/secretArea.js';
import { supabaseAdmin } from './supabase.js';

const BUCKET       = 'sa-strategy-setups';
const MAX_BYTES    = 6 * 1024 * 1024;   // 6 MB binary (ruim voor chart-screenshots)
const SIGNED_TTL   = 600;               // 10 min geldig
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const EXT          = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };
const MODELS       = new Set(['confirmation', 'continuation', 'range_break']);
const TIMEFRAMES   = new Set(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D', 'W']);
const INSTRUMENT_RE = /^[A-Z]{3}_[A-Z]{3}$/;
const EXTRA_INSTR  = new Set(['XAU_USD']);
const ELEMENT_KEYS = ['sweep', 'displacement', 'mss', 'fib_071', 'ob', 'volume_gap', 'h4_bias', 'entry', 'sl', 'tp'];
const SELECT_COLS  = 'id, created_at, updated_at, user_id, model, is_positive, instrument, timeframe, setup_date, elements, description, storage_path';

function isAllowedInstrument(i) { return typeof i === 'string' && (EXTRA_INSTR.has(i) || INSTRUMENT_RE.test(i)); }
function cleanElements(obj) {
  const out = {};
  for (const k of ELEMENT_KEYS) out[k] = !!(obj && typeof obj === 'object' && obj[k]);
  return out;
}
function isValidDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)); }

/** Kortlevende signed URL voor een storage-path (of null bij fout/leeg). */
async function signedUrlFor(path) {
  if (!path) return null;
  try {
    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUrl(path, SIGNED_TTL);
    if (error) return null;
    return data?.signedUrl || null;
  } catch (_) { return null; }
}

/** Rij → response-object met signed_url erbij. */
async function withSignedUrl(row) {
  return { ...row, signed_url: await signedUrlFor(row?.storage_path) };
}

/**
 * Valideer + normaliseer label-velden uit de body.
 * partial=true → alleen aanwezige keys (update); anders volledige set (upload).
 * @returns {{ fields: object } | { error: string }}
 */
function parseLabels(body, partial) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('model')) {
    const m = body.model;
    if (m === null || m === '') out.model = null;
    else if (typeof m === 'string' && MODELS.has(m)) out.model = m;
    else return { error: 'model moet confirmation|continuation|range_break of null zijn' };
  } else if (!partial) out.model = null;

  if (has('is_positive')) {
    if (typeof body.is_positive !== 'boolean') return { error: 'is_positive moet boolean zijn' };
    out.is_positive = body.is_positive;
  } else if (!partial) out.is_positive = true;

  if (has('instrument')) {
    const i = typeof body.instrument === 'string' ? body.instrument.trim().toUpperCase() : '';
    if (i && !isAllowedInstrument(i)) return { error: 'instrument niet toegestaan (^[A-Z]{3}_[A-Z]{3}$ of XAU_USD)' };
    out.instrument = i || null;
  } else if (!partial) out.instrument = null;

  if (has('timeframe')) {
    const t = typeof body.timeframe === 'string' ? body.timeframe.trim().toUpperCase() : '';
    if (t && !TIMEFRAMES.has(t)) return { error: 'timeframe moet M1|M5|M15|M30|H1|H4|D|W zijn' };
    out.timeframe = t || null;
  } else if (!partial) out.timeframe = null;

  if (has('setup_date')) {
    const d = body.setup_date;
    if (d === null || d === '') out.setup_date = null;
    else if (isValidDate(d)) out.setup_date = d;
    else return { error: 'setup_date moet YYYY-MM-DD zijn' };
  } else if (!partial) out.setup_date = null;

  if (has('elements')) out.elements = cleanElements(body.elements);
  else if (!partial) out.elements = cleanElements(null);

  if (has('description')) {
    const d = body.description;
    if (d != null && typeof d !== 'string') return { error: 'description moet tekst zijn' };
    out.description = d ? String(d).slice(0, 5000) : '';
  } else if (!partial) out.description = '';

  return { fields: out };
}

// ── Actie-handlers ──────────────────────────────────────────────────────────

async function handleUpload(req, res, userId) {
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt (JSON verwacht)' });

  const contentType = typeof body.content_type === 'string' ? body.content_type.trim().toLowerCase() : '';
  const dataB64     = typeof body.data_base64 === 'string' ? body.data_base64 : '';
  if (!contentType || !dataB64) return res.status(400).json({ error: 'content_type + data_base64 vereist' });
  if (!ALLOWED_MIME.has(contentType)) return res.status(400).json({ error: `content_type '${contentType}' niet toegestaan (PNG/JPEG/WEBP)` });

  let buf;
  try { buf = Buffer.from(dataB64, 'base64'); }
  catch { return res.status(400).json({ error: 'data_base64 geen geldige base64' }); }
  if (!buf || buf.length === 0) return res.status(400).json({ error: 'data_base64 decodeert naar 0 bytes' });
  if (buf.length > MAX_BYTES) return res.status(400).json({ error: `Bestand te groot (${buf.length} bytes, max ${MAX_BYTES})` });

  const parsed = parseLabels(body, false);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const setupId = crypto.randomUUID();
  const ext = EXT[contentType] || 'png';
  const path = `${userId}/${setupId}.${ext}`;

  const { error: upErr } = await supabaseAdmin.storage.from(BUCKET).upload(path, buf, { contentType, upsert: false });
  if (upErr) {
    if (/not found|does not exist|bucket/i.test(upErr.message || '')) {
      return res.status(503).json({ error: `Storage bucket '${BUCKET}' niet gevonden (draai migratie 020)` });
    }
    console.error('[secret-area-setups] storage upload:', upErr.message);
    return res.status(500).json({ error: 'Upload mislukt' });
  }

  const insertRow = { id: setupId, user_id: userId, storage_path: path, ...parsed.fields };
  const { data: row, error: dbErr } = await supabaseAdmin
    .from('sa_setups').insert(insertRow).select(SELECT_COLS).single();
  if (dbErr || !row) {
    // Best-effort rollback van het net-geüploade bestand.
    try { await supabaseAdmin.storage.from(BUCKET).remove([path]); } catch (_) {}
    console.error('[secret-area-setups] insert:', dbErr?.message || 'geen rij');
    return res.status(500).json({ error: 'Opslaan mislukt' });
  }

  return res.status(200).json({ ok: true, setup: await withSignedUrl(row) });
}

async function handleList(req, res, userId) {
  const q = req.query || {};
  let query = supabaseAdmin.from('sa_setups').select(SELECT_COLS).eq('user_id', userId).order('created_at', { ascending: false });

  if (typeof q.model === 'string' && MODELS.has(q.model)) query = query.eq('model', q.model);
  if (q.is_positive === 'true') query = query.eq('is_positive', true);
  else if (q.is_positive === 'false') query = query.eq('is_positive', false);
  if (typeof q.instrument === 'string' && isAllowedInstrument(q.instrument.trim().toUpperCase())) {
    query = query.eq('instrument', q.instrument.trim().toUpperCase());
  }

  const { data, error } = await query;
  if (error) { console.error('[secret-area-setups] list:', error.message); return res.status(500).json({ error: 'Ophalen mislukt' }); }
  const setups = await Promise.all((data || []).map(withSignedUrl));
  return res.status(200).json({ ok: true, count: setups.length, setups });
}

async function handleGet(req, res, userId, id) {
  const { data: row, error } = await supabaseAdmin
    .from('sa_setups').select(SELECT_COLS).eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) { console.error('[secret-area-setups] get:', error.message); return res.status(500).json({ error: 'Ophalen mislukt' }); }
  if (!row) return res.status(404).json({ error: 'Setup niet gevonden' });
  return res.status(200).json({ ok: true, setup: await withSignedUrl(row) });
}

async function handleUpdate(req, res, userId, id) {
  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt (JSON verwacht)' });

  const parsed = parseLabels(body, true);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!Object.keys(parsed.fields).length) return res.status(400).json({ error: 'Geen bij te werken velden' });

  const patch = { ...parsed.fields, updated_at: new Date().toISOString() };
  const { data: row, error } = await supabaseAdmin
    .from('sa_setups').update(patch).eq('id', id).eq('user_id', userId).select(SELECT_COLS).maybeSingle();
  if (error) { console.error('[secret-area-setups] update:', error.message); return res.status(500).json({ error: 'Bijwerken mislukt' }); }
  if (!row) return res.status(404).json({ error: 'Setup niet gevonden' });
  return res.status(200).json({ ok: true, setup: await withSignedUrl(row) });
}

async function handleDelete(req, res, userId, id) {
  const { data: row, error } = await supabaseAdmin
    .from('sa_setups').select('id, storage_path').eq('id', id).eq('user_id', userId).maybeSingle();
  if (error) { console.error('[secret-area-setups] delete-fetch:', error.message); return res.status(500).json({ error: 'Verwijderen mislukt' }); }
  if (!row) return res.status(404).json({ error: 'Setup niet gevonden' });

  if (row.storage_path) {
    try { await supabaseAdmin.storage.from(BUCKET).remove([row.storage_path]); }
    catch (e) { console.error('[secret-area-setups] storage remove:', e?.message || 'fout'); } // best-effort
  }
  const { error: delErr } = await supabaseAdmin.from('sa_setups').delete().eq('id', id).eq('user_id', userId);
  if (delErr) { console.error('[secret-area-setups] delete-row:', delErr.message); return res.status(500).json({ error: 'Verwijderen mislukt' }); }
  return res.status(200).json({ ok: true, id });
}

// ── Router ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  // 1) Owner-gate ALS EERSTE.
  const ctx = await requireOwner(req);
  if (!ctx) return res.status(403).json({ error: 'Geen toegang' });

  const q = req.query || {};
  const action = String(q.action || '');
  const id = typeof q.id === 'string' ? q.id.trim() : '';
  const idNeeded = ['get', 'update', 'delete'].includes(action);
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (idNeeded && !UUID_RE.test(id)) return res.status(400).json({ error: 'geldige id (uuid) vereist' });

  try {
    if (req.method === 'POST'   && action === 'upload') return await handleUpload(req, res, ctx.userId);
    if (req.method === 'GET'    && action === 'list')   return await handleList(req, res, ctx.userId);
    if (req.method === 'GET'    && action === 'get')    return await handleGet(req, res, ctx.userId, id);
    if (req.method === 'PATCH'  && action === 'update') return await handleUpdate(req, res, ctx.userId, id);
    if (req.method === 'DELETE' && action === 'delete') return await handleDelete(req, res, ctx.userId, id);
  } catch (e) {
    console.error('[secret-area-setups] onverwacht:', e?.message || 'fout');
    return res.status(500).json({ error: 'Serverfout' });
  }

  return res.status(400).json({ error: 'onbekende actie/method (upload|list|get|update|delete)' });
}
