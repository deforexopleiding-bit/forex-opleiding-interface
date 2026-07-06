// api/mentor-cash-traject-status.js
// POST { id, action: 'pause' | 'resume' | 'delete' }
// → { ok:true, traject? }
// Permission: mentor.ledger.write.
//
// pause  → status='paused', paused_at=now(). Cron slaat 'paused' trajects
//          over → resterende termijnen schuiven vanzelf.
// resume → status='active', paused_at=null. Cron pakt de eerstvolgende
//          termijn op basis van (# reeds aangemaakt ledger-entries), dus
//          pauze-maanden schuiven de resterende vrijvalperiode naar achteren
//          zonder complexe datumrekening.
// delete → verwijder de traject-rij. Al aangemaakte ledger-entries BLIJVEN
//          staan (die zijn al verdiend); alleen toekomstige vrijval stopt.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS   = new Set(['pause', 'resume', 'delete']);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.ledger.write'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.ledger.write)' });
  }

  const { id, action } = req.body || {};
  if (!UUID_RE.test(String(id || ''))) return res.status(400).json({ error: 'id vereist' });
  if (!ACTIONS.has(String(action || ''))) return res.status(400).json({ error: 'action moet pause/resume/delete zijn' });

  try {
    const { data: cur } = await supabaseAdmin
      .from('mentor_cash_trajects').select('id, status').eq('id', id).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'traject niet gevonden' });

    if (action === 'delete') {
      const { error: delErr } = await supabaseAdmin.from('mentor_cash_trajects').delete().eq('id', id);
      if (delErr) throw new Error('delete: ' + delErr.message);
      return res.status(200).json({ ok: true });
    }

    const patch = action === 'pause'
      ? { status: 'paused', paused_at: new Date().toISOString() }
      : { status: 'active', paused_at: null };

    // Idempotentie: als de gewenste status al gelijk is → OK zonder update.
    if (cur.status === patch.status) {
      return res.status(200).json({ ok: true, traject: cur, unchanged: true });
    }
    // Completed → resume-lock: een voltooid traject niet ongewild reactiveren.
    if (cur.status === 'completed' && action === 'resume') {
      return res.status(409).json({ error: 'traject is voltooid — resume niet mogelijk' });
    }

    const { data: updated, error: upErr } = await supabaseAdmin
      .from('mentor_cash_trajects').update(patch).eq('id', id).select('*').maybeSingle();
    if (upErr) throw new Error('update: ' + upErr.message);
    return res.status(200).json({ ok: true, traject: updated });
  } catch (e) {
    console.error('[mentor-cash-traject-status]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
