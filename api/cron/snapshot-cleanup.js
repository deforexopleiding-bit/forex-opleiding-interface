// api/cron/snapshot-cleanup.js
//
// Dagelijkse cron — 7-dagen retentie voor snapshot_log + storage-bucket
// 'activity-snapshots'. Twee sweeps:
//   1) Logische sweep: snapshot_log-rijen met captured_at < now - 7d
//      → verwijder storage-object + rij.
//   2) Orphan sweep: storage-objecten waarvan .created_at metadata > 7d oud
//      is EN geen match in snapshot_log (upload lukte maar insert faalde,
//      of rij handmatig verwijderd) → hard-delete uit bucket.
//
// Auth: checkCronAuth (Authorization: Bearer $CRON_SECRET).
// Schedule: dagelijks 03:30 UTC (vóór 04:00 activity_log-cleanup;
// activity_log = 90d retentie, snapshots = 7d — sneller pad).
//
// Idempotent: elke run pakt alleen state > 7d oud. Als er niets is: no-op.
// Response: { ok, logical: {cutoff, rows_deleted, storage_removed}, orphan: {removed}, error? }.

import { checkCronAuth, supabaseAdmin } from '../supabase.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const BUCKET        = 'activity-snapshots';
const LIST_PAGE     = 1000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cronAuth = checkCronAuth(req);
  if (!cronAuth.ok) return res.status(cronAuth.status).json(cronAuth.body);

  const cutoffIso = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();
  const result    = { ok: true, logical: {}, orphan: {} };

  // ── 1) Logische sweep — snapshot_log-rijen + storage-objecten ────────
  try {
    const { data: oldRows, error: selErr } = await supabaseAdmin
      .from('snapshot_log')
      .select('id, storage_path')
      .lt('captured_at', cutoffIso)
      .limit(LIST_PAGE);
    if (selErr) throw new Error('select: ' + selErr.message);

    const paths = (oldRows || []).map(r => r.storage_path).filter(Boolean);
    let storageRemoved = 0;
    if (paths.length) {
      const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
      if (rmErr) console.warn('[snapshot-cleanup] storage.remove logical:', rmErr.message);
      else storageRemoved = paths.length;
    }

    let rowsDeleted = 0;
    if ((oldRows || []).length) {
      const ids = oldRows.map(r => r.id);
      const { data: delRows, error: delErr } = await supabaseAdmin
        .from('snapshot_log').delete().in('id', ids).select('id');
      if (delErr) throw new Error('delete: ' + delErr.message);
      rowsDeleted = (delRows || []).length;
    }

    result.logical = { cutoff: cutoffIso, rows_deleted: rowsDeleted, storage_removed: storageRemoved };
    console.log('[snapshot-cleanup] logical:', JSON.stringify(result.logical));
  } catch (e) {
    console.error('[snapshot-cleanup] logical sweep:', e?.message || e);
    result.ok = false;
    result.logical = { error: e?.message || 'exception' };
  }

  // ── 2) Orphan sweep — bucket-objecten > 7d zonder snapshot_log-match ──
  //     Storage list geeft alleen 1 niveau; we lopen per user-folder.
  try {
    const { data: rootDirs, error: rootErr } = await supabaseAdmin.storage
      .from(BUCKET).list('', { limit: LIST_PAGE, sortBy: { column: 'name', order: 'asc' } });
    if (rootErr) throw new Error('list root: ' + rootErr.message);

    const orphanPaths = [];
    const nowMs       = Date.now();
    for (const dir of (rootDirs || [])) {
      if (!dir?.name) continue;
      const { data: files, error: fErr } = await supabaseAdmin.storage
        .from(BUCKET).list(dir.name, { limit: LIST_PAGE, sortBy: { column: 'created_at', order: 'asc' } });
      if (fErr) { console.warn('[snapshot-cleanup] list folder', dir.name, fErr.message); continue; }
      for (const f of (files || [])) {
        if (!f?.name || !f?.created_at) continue;
        const ageMs = nowMs - new Date(f.created_at).getTime();
        if (ageMs < SEVEN_DAYS_MS) continue;
        const path = `${dir.name}/${f.name}`;
        const { data: match } = await supabaseAdmin
          .from('snapshot_log').select('id').eq('storage_path', path).maybeSingle();
        if (!match) orphanPaths.push(path);
      }
    }

    let orphansRemoved = 0;
    if (orphanPaths.length) {
      const { error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove(orphanPaths);
      if (rmErr) console.warn('[snapshot-cleanup] storage.remove orphans:', rmErr.message);
      else orphansRemoved = orphanPaths.length;
    }
    result.orphan = { removed: orphansRemoved };
    console.log('[snapshot-cleanup] orphan:', JSON.stringify(result.orphan));
  } catch (e) {
    console.error('[snapshot-cleanup] orphan sweep:', e?.message || e);
    result.ok = false;
    result.orphan = { error: e?.message || 'exception' };
  }

  return res.status(200).json(result);
}
