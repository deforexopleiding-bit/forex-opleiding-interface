// api/lisa-conversations-count.js
// GET → aantal actieve Lisa-conversaties (live, niet sandbox).
// Definitie 'active' = phase IN ('intro','doel','situatie','band','call').
// Zie ACTIVE_PHASES in api/lisa-conversations.js — dezelfde definitie hergebruikt
// zodat het dashboard-getal matcht wat de Lisa-module in filter=active toont.
//
// Query-params:
//   status   'active' (default) | 'qualified' | 'disqualified' | 'cold' | 'all'
//
// Response:
//   { count: N, status }
//
// Permission: verifyAdmin (Lisa is admin-tool). Dashboard-viewers zonder
// admin-rol krijgen 403 → tegel valt terug op MOCK-badge, geen crash.
// Read-only. Geen writes.

import { supabaseAdmin, verifyAdmin } from './supabase.js';

const ACTIVE_PHASES       = ['intro', 'doel', 'situatie', 'band', 'call'];
const DISQUALIFIED_PHASES = ['disqualified'];
const QUALIFIED_PHASES    = ['qualified', 'done'];
const COLD_PHASES         = ['cold'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(403).json({ error: 'Toegang geweigerd. Admin-rol vereist.' });

  try {
    const raw = String(req.query.status || 'active').toLowerCase();
    const status = ['active', 'qualified', 'disqualified', 'cold', 'all'].includes(raw) ? raw : 'active';

    let q = supabaseAdmin
      .from('lisa_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('is_sandbox', false);

    if (status === 'active')       q = q.in('phase', ACTIVE_PHASES);
    else if (status === 'qualified')    q = q.in('phase', QUALIFIED_PHASES);
    else if (status === 'disqualified') q = q.in('phase', DISQUALIFIED_PHASES);
    else if (status === 'cold')         q = q.in('phase', COLD_PHASES);
    // 'all' = geen extra filter.

    const { count, error } = await q;
    if (error) throw new Error('lisa_conversations: ' + error.message);

    return res.status(200).json({ count: count || 0, status });
  } catch (e) {
    console.error('[lisa-conversations-count]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
