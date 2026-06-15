// api/mentor-ledger-set-status.js
//
// F5.1 — Handmatige status-toggle voor een ledger-entry. Bestaat zodat een
// manager/admin een status kan corrigeren zonder te wachten op de auto-hooks
// (die in een latere release komen — zie INTEGRATIE-TODO in
// api/_lib/mentor-ledger-engine.js).
//
// Permission: mentor.ledger.write (nieuwe key uit PR D).
//
// Body (JSON):
//   { entry_id: uuid, new_status: 'pending'|'wachten_op_betaling'|
//                                  'vrijgegeven'|'geannuleerd'|'uitbetaald',
//     reason?: string }
//
// Response 200:
//   { ok, entry_id, previous_status, new_status, released_at?, note }
// 400 validatie / 401-403 auth / 404 entry / 409 ongeldige transition / 500 DB
//
// Side-effects bij sommige overgangen:
//   - naar 'vrijgegeven': zet released_at = now() (als nog null)
//   - naar 'uitbetaald':  WORDT NIET HIER GEDAAN — gebruik mentor-payout-run
//     die de payout_id koppelt (voorkomt orphan 'uitbetaald'-entries).
//
// Audit-trail: handmatige reden wordt aan note geappend (timestamp prefix).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { canTransition } from './_lib/mentor-ledger-engine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = new Set(['pending', 'wachten_op_betaling', 'vrijgegeven', 'geannuleerd', 'uitbetaald']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.ledger.write'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.ledger.write)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const entryId = typeof body.entry_id === 'string' ? body.entry_id.trim() : '';
  if (!entryId || !UUID_RE.test(entryId)) {
    return res.status(400).json({ error: 'entry_id (uuid) vereist' });
  }
  const newStatus = typeof body.new_status === 'string' ? body.new_status.trim() : '';
  if (!VALID_STATUSES.has(newStatus)) {
    return res.status(400).json({ error: 'new_status ongeldig' });
  }
  if (newStatus === 'uitbetaald') {
    return res.status(400).json({
      error: 'Status "uitbetaald" gaat via mentor-payout-run (die de payout_id koppelt).',
      code : 'USE_PAYOUT_RUN',
    });
  }
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;

  try {
    const { data: entry, error: entErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .select('id, status, note, released_at')
      .eq('id', entryId)
      .maybeSingle();
    if (entErr) throw new Error('entry fetch: ' + entErr.message);
    if (!entry) return res.status(404).json({ error: 'Ledger-entry niet gevonden' });

    if (entry.status === newStatus) {
      return res.status(200).json({
        ok             : true,
        entry_id       : entryId,
        previous_status: entry.status,
        new_status     : newStatus,
        note           : 'no-op (status was al ' + newStatus + ')',
      });
    }

    if (!canTransition(entry.status, newStatus)) {
      return res.status(409).json({
        error          : `Transition ${entry.status} → ${newStatus} niet toegestaan`,
        code           : 'INVALID_TRANSITION',
        previous_status: entry.status,
      });
    }

    const upd = { status: newStatus };
    if (newStatus === 'vrijgegeven' && !entry.released_at) {
      upd.released_at = new Date().toISOString();
    }
    if (reason) {
      const ts = new Date().toISOString();
      const trail = `[${ts}] ${entry.status}→${newStatus}: ${reason}`;
      upd.note = entry.note ? (entry.note + '\n' + trail) : trail;
    }

    const { error: updErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .update(upd)
      .eq('id', entryId);
    if (updErr) throw new Error('update: ' + updErr.message);

    return res.status(200).json({
      ok             : true,
      entry_id       : entryId,
      previous_status: entry.status,
      new_status     : newStatus,
      released_at    : upd.released_at || entry.released_at || null,
      note           : 'OK',
    });
  } catch (e) {
    console.error('[mentor-ledger-set-status]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
