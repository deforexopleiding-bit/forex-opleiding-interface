// api/setter-payout-run.js
//
// POST { setter_user_id: <uuid>, period_start: 'YYYY-MM-DD', period_end: 'YYYY-MM-DD', note?: text }
//
// Bundelt alle setter_ledger_entries met status='vrijgegeven' voor deze
// setter in de periode → 1 setter_payouts-rij. Zet alle bijhorende
// entries op status='uitbetaald' + payout_id + paid_at.
//
// Gate: setter.payout.manage.
// Idempotent: hetzelfde (setter, period) meerdere keren draaien met dezelfde
// vrijgegeven-set = geen dubbele bundels (want entries zijn na 1e run
// 'uitbetaald' → niet meer opgenomen).
//
// INCASSO-VEILIG: schrijft alleen setter_payouts + setter_ledger_entries.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'setter.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (setter.payout.manage)' });
  }

  const { setter_user_id, period_start, period_end, note } = req.body || {};
  if (!UUID_RE.test(String(setter_user_id || ''))) return res.status(400).json({ error: 'setter_user_id (uuid) vereist' });
  if (!DATE_RE.test(String(period_start || ''))) return res.status(400).json({ error: 'period_start (YYYY-MM-DD) vereist' });
  if (!DATE_RE.test(String(period_end   || ''))) return res.status(400).json({ error: 'period_end (YYYY-MM-DD) vereist' });

  try {
    const { data: entries, error: eErr } = await supabaseAdmin
      .from('setter_ledger_entries')
      .select('id, amount')
      .eq('setter_user_id', setter_user_id)
      .eq('status', 'vrijgegeven')
      .gte('created_at', `${period_start}T00:00:00Z`)
      .lte('created_at', `${period_end}T23:59:59Z`);
    if (eErr) throw eErr;

    const rows = entries || [];
    if (rows.length === 0) {
      return res.status(200).json({ ok: true, message: 'Geen vrijgegeven entries in deze periode', payout: null, entry_count: 0 });
    }
    const total = round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0));

    // Payout-rij aanmaken.
    const { data: payout, error: pErr } = await supabaseAdmin
      .from('setter_payouts')
      .insert({
        setter_user_id, total_amount: total, status: 'open',
        period_start, period_end, entry_count: rows.length,
        note: note ? String(note).slice(0, 500) : null,
        created_by: user.id,
      })
      .select('id, total_amount, entry_count, status')
      .single();
    if (pErr) throw pErr;

    // Entries markeren.
    const ids = rows.map((r) => r.id);
    const nowIso = new Date().toISOString();
    const { error: uErr } = await supabaseAdmin
      .from('setter_ledger_entries')
      .update({ status: 'uitbetaald', payout_id: payout.id, paid_at: nowIso })
      .in('id', ids);
    if (uErr) throw uErr;

    // Zet payout status ook op uitbetaald (in dit MVP betekent bundelen =
    // uitbetaald; als je later een "eerst bundel, dan betalen"-flow wilt,
    // zet dit dan status='open' + aparte betaal-endpoint).
    await supabaseAdmin
      .from('setter_payouts')
      .update({ status: 'uitbetaald', paid_at: nowIso })
      .eq('id', payout.id);

    return res.status(200).json({
      ok: true, payout: { ...payout, status: 'uitbetaald', paid_at: nowIso },
      entry_count: rows.length,
      total_amount: total,
    });
  } catch (e) {
    console.error('[setter-payout-run]', e?.message || e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
