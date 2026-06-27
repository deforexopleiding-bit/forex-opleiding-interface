// api/student-signals-reason.js
//
// POST → mentor geeft de reden voor zijn eigen open no_show-signal.
//
// Permission: mentor.module.access. 403 zonder. Auth 401 zonder.
//
// Body: { signal_id (uuid), reason (text, max 2000) }.
//
// OWNERSHIP:
//   - Signal moet bestaan (404 anders).
//   - Signal.type === 'no_show' (anders 400 — alleen no-shows hebben dit veld).
//   - Signal.mentor_user_id === user.id (anders 403 — mentor mag alleen z'n
//     eigen no-shows van reden voorzien).
//
// Update: toelichting = reason (trim), reason_given_at = now(), updated_at =
// now(). Status BLIJFT 'open' (admin ziet 'm nog steeds in de Aandachtspunten
// — pas met "Afhandelen" gaat hij naar 'afgehandeld'/'opnieuw_opvolgen').

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 2000;

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const signalId = typeof body.signal_id === 'string' ? body.signal_id.trim() : '';
  if (!UUID_RE.test(signalId)) {
    return res.status(400).json({ error: 'signal_id (uuid) vereist' });
  }
  const reasonRaw = body.reason == null ? '' : String(body.reason);
  const reason = reasonRaw.trim();
  if (!reason) {
    return res.status(400).json({ error: 'reason vereist' });
  }
  if (reason.length > MAX_REASON) {
    return res.status(400).json({ error: `reason max ${MAX_REASON} tekens` });
  }

  try {
    const { data: signal, error: sErr } = await supabaseAdmin
      .from('student_signals')
      .select('id, type, mentor_user_id, status')
      .eq('id', signalId)
      .maybeSingle();
    if (sErr) throw new Error('signal lookup: ' + sErr.message);
    if (!signal) return res.status(404).json({ error: 'Signal niet gevonden' });
    if (signal.type !== 'no_show') {
      return res.status(400).json({ error: 'Reden alleen voor no_show-signals' });
    }
    if (signal.mentor_user_id !== user.id) {
      return res.status(403).json({ error: 'Niet jouw signal' });
    }

    const nowIso = new Date().toISOString();
    const { error: uErr } = await supabaseAdmin
      .from('student_signals')
      .update({
        toelichting     : reason,
        reason_given_at : nowIso,
        updated_at      : nowIso,
      })
      .eq('id', signalId);
    if (uErr) throw new Error('signal update: ' + uErr.message);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[student-signals-reason]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
