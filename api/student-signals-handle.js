// api/student-signals-handle.js
//
// POST → admin/manager handelt een student_signal af.
//
// Permission: students.all.view (manager via migratie 016; super_admin via '*').
// Auth: createUserClient.auth.getUser → user.id. 401 zonder. 403 zonder gate.
//
// Body: { signal_id (uuid), uitkomst_type ('opgelost' | 'geen_gehoor_opnieuw'
//         | 'student_gestopt' | 'anders'), uitkomst? (text) }.
//
// Status afgeleid uit uitkomst_type:
//   'geen_gehoor_opnieuw' → status='opnieuw_opvolgen' (blijft actief).
//   else                  → status='afgehandeld'.
//
// Zet: uitkomst_type, uitkomst, handled_by_user_id=user.id, handled_at=now(),
//      updated_at=now() (DB-default zou triggeren maar we zetten 'm expliciet
//      voor consistentie). 404 als signal niet bestaat.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UITKOMST_TYPES = new Set([
  'opgelost', 'geen_gehoor_opnieuw', 'student_gestopt', 'anders',
]);
const MAX_UITKOMST = 2000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'students.all.view'))) {
    return res.status(403).json({ error: 'Geen rechten (students.all.view)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const signalId = typeof body.signal_id === 'string' ? body.signal_id.trim() : '';
  if (!UUID_RE.test(signalId)) {
    return res.status(400).json({ error: 'signal_id (uuid) vereist' });
  }
  const uitkomstType = typeof body.uitkomst_type === 'string' ? body.uitkomst_type.trim() : '';
  if (!UITKOMST_TYPES.has(uitkomstType)) {
    return res.status(400).json({ error: 'uitkomst_type ongeldig' });
  }
  let uitkomst = null;
  if (body.uitkomst != null) {
    const t = String(body.uitkomst).trim();
    if (t.length > MAX_UITKOMST) {
      return res.status(400).json({ error: `uitkomst max ${MAX_UITKOMST} tekens` });
    }
    uitkomst = t || null;
  }

  const nextStatus = (uitkomstType === 'geen_gehoor_opnieuw') ? 'opnieuw_opvolgen' : 'afgehandeld';
  const nowIso = new Date().toISOString();

  try {
    // 404-check: signal moet bestaan voor we proberen te updaten. Pre-check
    // is goedkoper dan een UPDATE-zonder-rows-tellen.
    const { data: exists, error: eErr } = await supabaseAdmin
      .from('student_signals')
      .select('id')
      .eq('id', signalId)
      .maybeSingle();
    if (eErr)    throw new Error('signal lookup: ' + eErr.message);
    if (!exists) return res.status(404).json({ error: 'Signal niet gevonden' });

    const { error: uErr } = await supabaseAdmin
      .from('student_signals')
      .update({
        uitkomst_type      : uitkomstType,
        uitkomst           : uitkomst,
        status             : nextStatus,
        handled_by_user_id : user.id,
        handled_at         : nowIso,
        updated_at         : nowIso,
      })
      .eq('id', signalId);
    if (uErr) throw new Error('signal update: ' + uErr.message);

    return res.status(200).json({ ok: true, status: nextStatus });
  } catch (e) {
    console.error('[student-signals-handle]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
