// api/activity-log-list.js
//
// PR2 activiteitenlogboek — lees-endpoint voor het viewer-scherm.
// Client kan niet direct lezen (RLS blokkeert authenticated+anon); dit
// endpoint doet de query met de service-role client na een expliciete
// permission-check op 'audit.log.view'.
//
// Query-params (allemaal optioneel):
//   user_id     — uuid, filter op activity_log.user_id
//   role        — text, filter op activity_log.user_role
//   module      — text, filter op activity_log.module (sidebar-module string)
//   success     — 'true'/'false', filter op activity_log.success
//   q           — vrije tekst, ilike op user_email/action/endpoint
//   from        — ISO-datum, .gte('created_at', ...)
//   to          — ISO-datum, .lte('created_at', ...)
//   page        — int (default 1)
//   page_size   — int (default 50, max 200)
//
// Response: { rows: [...], total: N, page: 1, page_size: 50 }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

// PostgREST .or() heeft komma's als scheiding en `%` als wildcard.
// We slaan `%`, `,`, en `*` weg uit user-input om syntax-breaks te vermijden.
function sanitizeQ(raw) {
  return String(raw).replace(/[%,*]/g, '').trim();
}

function parseIsoDate(raw) {
  if (!raw) return null;
  const d = new Date(String(raw));
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth (via user-scoped client zodat we een user hebben voor logging + duidelijke 401).
  const userSb = createUserClient(req);
  const { data: { user } } = await userSb.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Permission-gate.
  const allowed = await requirePermission(req, 'audit.log.view');
  if (!allowed) return res.status(403).json({ error: 'Geen rechten (audit.log.view)' });

  // Params.
  const userIdParam = req.query?.user_id ? String(req.query.user_id).trim() : '';
  const roleParam   = req.query?.role    ? String(req.query.role).trim()    : '';
  const modParam    = req.query?.module  ? String(req.query.module).trim() : '';
  const succParam   = req.query?.success ? String(req.query.success).trim() : '';
  const qParam      = req.query?.q       ? sanitizeQ(req.query.q)           : '';
  const fromIso     = parseIsoDate(req.query?.from);
  const toIso       = parseIsoDate(req.query?.to);
  const page        = clampInt(req.query?.page,      1,   1, 100000);
  const pageSize    = clampInt(req.query?.page_size, 50,  1, 200);

  if (userIdParam && !UUID_RE.test(userIdParam)) {
    return res.status(400).json({ error: 'Ongeldige user_id' });
  }

  const fromRow = (page - 1) * pageSize;
  const toRow   = fromRow + pageSize - 1;

  try {
    let q = supabaseAdmin
      .from('activity_log')
      .select(
        'id, user_id, user_email, user_role, action, endpoint, method, status_code, success, module, ip, user_agent, detail, created_at',
        { count: 'exact' }
      );

    if (userIdParam)       q = q.eq('user_id',    userIdParam);
    if (roleParam)         q = q.eq('user_role',  roleParam);
    if (modParam)          q = q.eq('module',     modParam);
    if (succParam === 'true')  q = q.eq('success', true);
    if (succParam === 'false') q = q.eq('success', false);
    if (fromIso)           q = q.gte('created_at', fromIso);
    if (toIso)             q = q.lte('created_at', toIso);
    if (qParam) {
      const like = `%${qParam}%`;
      q = q.or(`user_email.ilike.${like},action.ilike.${like},endpoint.ilike.${like}`);
    }

    q = q.order('created_at', { ascending: false }).range(fromRow, toRow);

    const { data, count, error } = await q;
    if (error) {
      console.error('[activity-log-list]', error.message);
      return res.status(500).json({ error: 'DB-fout bij ophalen logboek' });
    }

    return res.status(200).json({
      rows      : data || [],
      total     : count || 0,
      page,
      page_size : pageSize,
    });
  } catch (e) {
    console.error('[activity-log-list] exception', e?.message || e);
    return res.status(500).json({ error: 'Interne fout' });
  }
}
