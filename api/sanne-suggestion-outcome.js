// api/sanne-suggestion-outcome.js
// POST { suggestion_id, outcome, notes? } -> updates status + outcome_at + outcome_notes.
//
// outcome-enum → status:
//   'used'      -> USED       (Sanne's tekst 1-op-1 gebruikt)
//   'edited'    -> EDITED     (Sanne's tekst als basis, gebruiker heeft aangepast)
//   'dismissed' -> DISMISSED  (Sanne genegeerd)
//
// Permission: email.module.access.
//
// Idempotent-veilig: als de rij al een terminal-status heeft, retourneer 200 + no-op.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOME_TO_STATUS = { used: 'USED', edited: 'EDITED', dismissed: 'DISMISSED' };
const TERMINAL_STATUSES = new Set(['USED', 'EDITED', 'DISMISSED', 'SENT_AUTONOMOUSLY']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const userClient = createUserClient(req);
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'email.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (email.module.access)' });
  }

  const b = req.body || {};
  const sugId = typeof b.suggestion_id === 'string' ? b.suggestion_id.trim() : '';
  const outcome = typeof b.outcome === 'string' ? b.outcome.trim().toLowerCase() : '';
  const notes = typeof b.notes === 'string' ? b.notes.slice(0, 500) : null;

  if (!sugId || !UUID_RE.test(sugId)) return res.status(400).json({ error: 'suggestion_id (uuid) verplicht' });
  if (!OUTCOME_TO_STATUS[outcome]) return res.status(400).json({ error: 'outcome moet used|edited|dismissed zijn' });

  const targetStatus = OUTCOME_TO_STATUS[outcome];

  try {
    const { data: existing, error: readErr } = await supabaseAdmin.from('sanne_suggestions')
      .select('id, status').eq('id', sugId).maybeSingle();
    if (readErr) return res.status(500).json({ error: readErr.message });
    if (!existing) return res.status(404).json({ error: 'Suggestie niet gevonden' });
    if (TERMINAL_STATUSES.has(existing.status)) {
      return res.status(200).json({ ok: true, no_op: true, current_status: existing.status });
    }

    const { data: upd, error: updErr } = await supabaseAdmin.from('sanne_suggestions')
      .update({ status: targetStatus, outcome_at: new Date().toISOString(), outcome_notes: notes })
      .eq('id', sugId).select('id, status, outcome_at').maybeSingle();
    if (updErr) return res.status(500).json({ error: updErr.message });

    return res.status(200).json({ ok: true, suggestion: upd });
  } catch (e) {
    console.error('[sanne-suggestion-outcome]', e?.message);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
