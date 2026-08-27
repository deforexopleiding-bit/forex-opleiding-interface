// api/logboek-stream-list.js
// GET → unified tijdlijn van 3 streams (activity_log + call_log + snapshot_log),
// gesorteerd op tijd desc, gepagineerd, met signed URLs voor snapshots.
//
// SUPER_ADMIN ONLY. Enige beschermer van PII-screenshots (signed URLs bypassen
// storage-RLS voor 5 minuten). GEEN pad voor non-super_admin: 403 vóór elke
// query, geen data, geen URLs.
//
// Query-params:
//   from        ISO   (default: now - 7d)
//   to          ISO   (default: now)
//   user_id     uuid  (optioneel filter)
//   q           text  (substring ILIKE op action/module/action_hint/meta.source)
//   streams     csv   (activity,call,snapshot; default alle 3)
//   page        int   (default 1, min 1)
//   page_size   int   (default 50, max 100)
//
// Response:
//   { items: [...], page, page_size, has_more, totals_hint: {activity,call,snapshot} }

import { supabaseAdmin, verifyAdmin } from './supabase.js';
import { checkRateLimit } from './_lib/rate-limit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LOOKBACK_DAYS  = 7;
const MAX_PAGE_SIZE          = 100;
const SIGNED_URL_TTL_SECONDS = 5 * 60;
const CORRELATION_WINDOW_MS  = 2000;

// Strip PostgREST-special chars + SQL-wildcards uit user-input voordat we het
// in .or()-interpolatie plakken. Voorkomt query-breuk of injection van extra
// filter-clausules (bv. qStr="a,module.ilike.%xyz%" of qStr="a)").
function _sanitizeIlikeTerm(raw) {
  return String(raw || '').trim()
    .replace(/[,()*:%\\]/g, '')
    .slice(0, 100);
}

function _parseIsoOrDefault(raw, fallbackMs) {
  const d = raw ? new Date(String(raw)) : null;
  return (d && !isNaN(d.getTime())) ? d : new Date(fallbackMs);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'GET only' }); }

  // ── Super-admin gate ─────────────────────────────────────────────────
  // Twee lagen: verifyAdmin (checkt JWT + profiles.role IN ADMIN_ROLES +
  // is_active) EN profile.role === 'super_admin'. Signed URLs uit dit
  // endpoint bypassen storage-RLS voor 5 min → dit is de ENIGE bescherming.
  // Non-super_admin → 403 direct; geen enkel stream-fetch of URL-generatie.
  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Admin only' });
  if (admin.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super_admin only' });
  }

  const rl = await checkRateLimit({ req, bucket: 'logboek-stream', maxHits: 60, withinSeconds: 60 });
  if (rl.limited) return res.status(429).json({ error: 'Rate limited' });

  try {
    const q         = req.query || {};
    const now       = Date.now();
    const from      = _parseIsoOrDefault(q.from, now - DEFAULT_LOOKBACK_DAYS * 86400_000);
    const to        = _parseIsoOrDefault(q.to,   now);
    const user_id   = q.user_id && UUID_RE.test(q.user_id) ? String(q.user_id) : null;
    const qStr      = q.q ? _sanitizeIlikeTerm(q.q) : '';
    const page      = Math.max(1, parseInt(q.page || '1', 10) || 1);
    const page_size = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(q.page_size || '50', 10) || 50));
    const streamsIn = q.streams ? String(q.streams).split(',').map(s => s.trim().toLowerCase()) : ['activity','call','snapshot'];
    const wantAct   = streamsIn.includes('activity');
    const wantCall  = streamsIn.includes('call');
    const wantSnap  = streamsIn.includes('snapshot');
    // Ruis-filter: default alleen echte writes op activity-stream. Toggle via
    // include_views=true haalt page-views (GET → *.view / *.access) terug voor
    // deep-dive. Method-filter is robuuster dan action-string-matching.
    const includeViews = String(q.include_views || 'false').toLowerCase() === 'true';
    const activityMethodFilter = includeViews ? null : ['POST', 'PUT', 'PATCH', 'DELETE'];

    if (from >= to) return res.status(400).json({ error: 'from >= to' });

    const perStreamLimit = page * page_size * 3;   // over-fetch buffer voor merger
    const fromIso = from.toISOString();
    const toIso   = to.toISOString();

    const actOrClause  = qStr ? `action.ilike.%${qStr}%,module.ilike.%${qStr}%,endpoint.ilike.%${qStr}%` : null;
    const snapOrClause = qStr ? `action_hint.ilike.%${qStr}%,view_url.ilike.%${qStr}%` : null;

    // ── Items-queries per stream ────────────────────────────────────────
    let activityQ = null;
    if (wantAct) {
      activityQ = supabaseAdmin.from('activity_log')
        .select('id, created_at, user_id, user_email, action, endpoint, method, status_code, success, module, detail')
        .gte('created_at', fromIso).lt('created_at', toIso)
        .order('created_at', { ascending: false }).limit(perStreamLimit);
      if (user_id) activityQ = activityQ.eq('user_id', user_id);
      if (actOrClause) activityQ = activityQ.or(actOrClause);
      if (activityMethodFilter) activityQ = activityQ.in('method', activityMethodFilter);
    }

    let callQ = null;
    if (wantCall) {
      callQ = supabaseAdmin.from('call_log')
        .select('id, started_at, user_id, to_number, line, duration_sec, outcome_hint, customer_id, lead_id, meta')
        .gte('started_at', fromIso).lt('started_at', toIso)
        .order('started_at', { ascending: false }).limit(perStreamLimit);
      if (user_id) callQ = callQ.eq('user_id', user_id);
      // qStr op call_log = client-side filter (meta jsonb; DB-side ILIKE fiddly).
    }

    let snapshotQ = null;
    if (wantSnap) {
      snapshotQ = supabaseAdmin.from('snapshot_log')
        .select('id, user_id, user_email, captured_at, view_url, view_title, action_hint, storage_path, size_kb')
        .gte('captured_at', fromIso).lt('captured_at', toIso)
        .order('captured_at', { ascending: false }).limit(perStreamLimit);
      if (user_id) snapshotQ = snapshotQ.eq('user_id', user_id);
      if (snapOrClause) snapshotQ = snapshotQ.or(snapOrClause);
    }

    // ── Totals (counts) — dezelfde filter-conditie als items ────────────
    async function _countStream(table, tsCol, orClause, methodFilter) {
      let cq = supabaseAdmin.from(table).select('id', { count: 'exact', head: true })
        .gte(tsCol, fromIso).lt(tsCol, toIso);
      if (user_id) cq = cq.eq('user_id', user_id);
      if (orClause) cq = cq.or(orClause);
      if (methodFilter) cq = cq.in('method', methodFilter);
      const { count } = await cq;
      return count || 0;
    }

    const [actRes, callRes, snapRes, actCount, callCount, snapCount] = await Promise.all([
      activityQ ?? Promise.resolve({ data: [] }),
      callQ     ?? Promise.resolve({ data: [] }),
      snapshotQ ?? Promise.resolve({ data: [] }),
      wantAct   ? _countStream('activity_log', 'created_at',  actOrClause, activityMethodFilter) : 0,
      wantCall  ? _countStream('call_log',     'started_at',  null,        null)                 : 0,
      wantSnap  ? _countStream('snapshot_log', 'captured_at', snapOrClause, null)                : 0,
    ]);

    // ── Normalize items ─────────────────────────────────────────────────
    const items = [];
    for (const r of (actRes?.data || [])) {
      items.push({
        stream:      'activity', id: r.id, ts: r.created_at,
        user_id:     r.user_id, user_email: r.user_email,
        module:      r.module,   action:    r.action,
        endpoint:    r.endpoint, method:    r.method,
        status_code: r.status_code, success: r.success,
        detail:      r.detail,
      });
    }
    for (const r of (callRes?.data || [])) {
      // Nummer PII-masken (kop + tail): +31 6 12 34 56 78 → '+31 6 12 … 78'.
      const num = String(r.to_number || '');
      const masked = num.replace(/^(\+\d{2}\s?\d{2})(\d.*?)(\d{2})$/, '$1 $2… $3').slice(0, 24) || num;
      const src = (r.meta && typeof r.meta === 'object') ? String(r.meta.source || '') : '';
      // Client-side qStr filter voor call (meta.source substring).
      if (qStr && !src.toLowerCase().includes(qStr.toLowerCase()) &&
          !String(r.outcome_hint || '').toLowerCase().includes(qStr.toLowerCase())) continue;
      items.push({
        stream:       'call',  id: r.id, ts: r.started_at,
        user_id:      r.user_id, user_email: null,
        to_number:    masked,
        line:         r.line,
        duration_sec: r.duration_sec,
        outcome_hint: r.outcome_hint,
        meta_source:  src,
        meta:         r.meta,
      });
    }
    for (const r of (snapRes?.data || [])) {
      items.push({
        stream:       'snapshot', id: r.id, ts: r.captured_at,
        user_id:      r.user_id, user_email: r.user_email,
        view_url:     r.view_url, view_title: r.view_title,
        action_hint:  r.action_hint,
        storage_path: r.storage_path,
        size_kb:      r.size_kb,
      });
    }

    // Sort desc op ts.
    items.sort((a, b) => (a.ts < b.ts ? 1 : -1));

    // ── Actor-name enrichment: batch profiles lookup ────────────────────
    // Full_name uit profiles i.p.v. afgekapte email/uuid.
    const uniqUserIds = [...new Set(items.map(i => i.user_id).filter(Boolean))];
    const nameById = new Map();
    if (uniqUserIds.length) {
      try {
        const { data: profs } = await supabaseAdmin
          .from('profiles').select('id, full_name, email')
          .in('id', uniqUserIds);
        for (const p of (profs || [])) {
          nameById.set(p.id, p.full_name || p.email || null);
        }
      } catch (e) {
        console.warn('[logboek-stream-list] profiles lookup fail:', e?.message);
      }
    }
    for (const it of items) {
      it.actor_name = nameById.get(it.user_id) || it.user_email || null;
    }

    // ── Correlation-pass: bundel snapshots ↔ activity ─────────────────
    const activityIndex = new Map();
    for (const it of items) if (it.stream === 'activity') activityIndex.set(it.id, it);
    for (const s of items.filter(i => i.stream === 'snapshot')) {
      const sTs   = new Date(s.ts).getTime();
      const sHint = String(s.action_hint || '').toLowerCase();
      for (const a of activityIndex.values()) {
        if (a.user_id !== s.user_id) continue;
        const dt = Math.abs(new Date(a.ts).getTime() - sTs);
        if (dt > CORRELATION_WINDOW_MS) continue;
        const aWords = String(a.action || '').toLowerCase().split(/[._-]/).filter(w => w.length > 2);
        const matches = aWords.filter(w => sHint.includes(w)).length;
        if (matches >= 1) {
          (a.bundled_with = a.bundled_with || []).push('snapshot:' + s.id);
          (s.bundled_with = s.bundled_with || []).push('activity:' + a.id);
          break;
        }
      }
    }

    // ── Paginate ────────────────────────────────────────────────────────
    const offset = (page - 1) * page_size;
    const pageItems = items.slice(offset, offset + page_size);
    const has_more  = items.length > (offset + page_size);

    // ── Signed URLs voor snapshots op deze pagina (5min TTL) ────────────
    const snapshotItems = pageItems.filter(i => i.stream === 'snapshot' && i.storage_path);
    await Promise.all(snapshotItems.map(async (s) => {
      try {
        const { data: signed } = await supabaseAdmin.storage
          .from('activity-snapshots').createSignedUrl(s.storage_path, SIGNED_URL_TTL_SECONDS);
        s.signed_url = signed?.signedUrl || null;
        s.signed_url_ttl_seconds = SIGNED_URL_TTL_SECONDS;
      } catch (e) {
        console.warn('[logboek-stream-list] signed-url fail:', s.id, e?.message);
        s.signed_url = null;
      }
      delete s.storage_path;   // niet lekken naar client
    }));

    return res.status(200).json({
      items:      pageItems,
      page, page_size,
      has_more,
      totals_hint: { activity: actCount, call: callCount, snapshot: snapCount },
    });
  } catch (e) {
    console.error('[logboek-stream-list]', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
