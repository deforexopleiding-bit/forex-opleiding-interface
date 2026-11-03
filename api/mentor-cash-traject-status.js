// api/mentor-cash-traject-status.js
// POST { id, action: 'pause' | 'resume' | 'delete' | 'omzetten', customer_id?, deal_id?, dry_run? }
// → { ok:true, traject? } of (omzetten) het omzetplan
// Permission: mentor.ledger.write.
//
// pause    → status='paused', paused_at=now().
// resume   → GEWEIGERD (409) sinds 3 nov 2026: een traject geeft nooit meer
//            op datum vrij. Zet het om naar de factuurmotor ('omzetten').
// omzetten → zet het traject om naar de factuurmotor (api/_lib/cash-traject-
//            omzetten.js): parents per aanwezige mentor met de oorspronkelijke
//            commissie; bestaande vrijgegeven termijnen tellen als reeds
//            vrijgegeven. dry_run (standaard true) toont het plan zonder te
//            schrijven; dry_run:false voert het uit.
// delete   → verwijder de traject-rij. Al aangemaakte ledger-entries BLIJVEN
//            staan. Een omgezet traject kan niet verwijderd worden (de
//            commissie hangt dan aan de factuurmotor).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { omzetTraject } from './_lib/cash-traject-omzetten.js';

const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS   = new Set(['pause', 'resume', 'delete', 'omzetten']);

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
  if (!ACTIONS.has(String(action || ''))) return res.status(400).json({ error: 'action moet pause/resume/delete/omzetten zijn' });

  try {
    const { data: cur } = await supabaseAdmin
      .from('mentor_cash_trajects').select('id, status').eq('id', id).maybeSingle();
    if (!cur) return res.status(404).json({ error: 'traject niet gevonden' });

    if (action === 'resume') {
      return res.status(409).json({ error: 'Een traject geeft niet meer op datum vrij. Zet het om naar de factuurmotor (enkel betaalde facturen geven commissie vrij).', code: 'DATUMVRIJVAL_UIT' });
    }
    if (action === 'omzetten') {
      const { customer_id = null, deal_id = null } = req.body || {};
      if (customer_id && !UUID_RE.test(String(customer_id))) return res.status(400).json({ error: 'customer_id ongeldig' });
      if (deal_id && !UUID_RE.test(String(deal_id))) return res.status(400).json({ error: 'deal_id ongeldig' });
      const plan = await omzetTraject({ trajectId: id, customerId: customer_id, dealId: deal_id, dryRun: req.body?.dry_run !== false });
      if (!plan.ok) return res.status(422).json({ error: plan.reden, plan });
      return res.status(200).json({ ok: true, plan });
    }
    if (action === 'delete' && cur.status === 'omgezet') {
      return res.status(409).json({ error: 'Een omgezet traject kan niet verwijderd worden: de commissie loopt via de factuurmotor.' });
    }
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
