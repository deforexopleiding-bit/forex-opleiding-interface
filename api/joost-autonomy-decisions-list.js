// api/joost-autonomy-decisions-list.js
// GET -> lijst van recente Joost autonomy-beslissingen (audit_log filter).
//
// Bron: audit_log WHERE action='joost.autonomy_decision' ORDER BY created_at DESC.
// Gebruikt door de admin "Decision Log" tab (modules/admin.html) om door alle
// recente autonomy-beslissingen heen te scrollen — inclusief BLOCKED-redenen,
// stop_action en de decision_log-trace.
//
// Permission: finance.joost.use OR admin.joost_autonomy (OR-check). Reden:
//   - finance.joost.use   : finance-medewerkers mogen inzien wat Joost autonomy
//                           doet in hun module (transparantie).
//   - admin.joost_autonomy: admins mogen overal inzien voor configuratie-tuning.
//
// Query params:
//   limit         integer (optioneel, default 50, max 200)
//   conv_id       uuid    (optioneel — filter op enkele conversatie)
//   blocked_only  boolean (optioneel — alleen BLOCKED_*-beslissingen)
//
// Response 200:
//   {
//     decisions: [
//       {
//         id, created_at, conversation_id, user_id, reason_text,
//         decision: { ... volledige after_json blob ... }
//       },
//       ...
//     ],
//     count: integer
//   }
//
// Error responses:
//   401  geen sessie
//   403  geen rechten
//   405  method not allowed
//   500  database-fout

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;
const HARD_MAX_LIMIT = 200;

function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // ---- Auth ----
  const supabase = createUserClient(req);
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // ---- Permission (OR-check) ----
  const canUse = await requirePermission(req, 'finance.joost.use');
  const canAdmin = canUse ? true : await requirePermission(req, 'admin.joost_autonomy');
  if (!canUse && !canAdmin) {
    return res.status(403).json({
      error: 'Geen rechten (finance.joost.use of admin.joost_autonomy)',
    });
  }

  // ---- Query params ----
  let limit = DEFAULT_LIMIT;
  if (req.query.limit != null) {
    const parsed = parseInt(String(req.query.limit), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(parsed, HARD_MAX_LIMIT);
    }
  }

  const convId = typeof req.query.conv_id === 'string' ? req.query.conv_id.trim() : '';
  if (convId && !isUuid(convId)) {
    return res.status(400).json({ error: 'conv_id moet geldige uuid zijn' });
  }

  const blockedOnly = req.query.blocked_only === 'true' || req.query.blocked_only === '1';

  try {
    let q = supabaseAdmin
      .from('audit_log')
      .select('id, created_at, user_id, entity_id, reason_text, after_json')
      .eq('action', 'joost.autonomy_decision')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (convId) q = q.eq('entity_id', convId);

    const { data, error } = await q;
    if (error) throw new Error('audit_log lookup: ' + error.message);

    let rows = Array.isArray(data) ? data : [];
    if (blockedOnly) {
      rows = rows.filter(r => r.after_json && r.after_json.blocked_reason);
    }

    const decisions = rows.map(r => ({
      id:              r.id,
      created_at:      r.created_at,
      conversation_id: r.entity_id,
      user_id:         r.user_id,
      reason_text:     r.reason_text,
      decision:        r.after_json || {},
    }));

    return res.status(200).json({ decisions, count: decisions.length });
  } catch (e) {
    console.error('[joost-autonomy-decisions-list]', e && e.message);
    return res.status(500).json({ error: e && e.message ? e.message : 'Interne fout' });
  }
}
