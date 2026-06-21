// api/mentor-payouts-admin-list.js
//
// Payout fase 1 — admin-overzicht van rapporten.
//
// GET → lijst mentor_payouts (optioneel gefilterd op period_month) met
// team_members join voor mentor-naam + email. Sorteer op mentor_name.
//
// Permission: mentor.payout.manage (super_admin / admin / manager).
//
// Query:
//   ?period_month=YYYY-MM (optioneel — wordt genormaliseerd naar YYYY-MM-01).
//
// Response 200:
//   { ok, period_month, payouts: [
//       { id, mentor_user_id, mentor_name, mentor_email, period_month,
//         status, bonus_total, coaching_total, total, total_excl, btw_amount,
//         generated_at, approved_at, paid_at }, ...
//   ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

function normalizeMonthStart(s) {
  if (typeof s !== 'string') return null;
  const m1 = s.match(/^(\d{4})-(\d{2})$/);
  const m2 = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  const m = m1 || m2;
  if (!m) return null;
  const y  = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return null;
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const periodStart = normalizeMonthStart(req.query?.period_month);
  if (req.query?.period_month && !periodStart) {
    return res.status(400).json({ error: 'period_month moet YYYY-MM zijn' });
  }

  try {
    let q = supabaseAdmin
      .from('mentor_payouts')
      .select('id, mentor_user_id, period_month, status, total, bonus_total, coaching_total, total_excl, btw_amount, generated_at, approved_at, paid_at')
      .order('created_at', { ascending: false })
      .limit(500);
    if (periodStart) q = q.eq('period_month', periodStart);
    const { data: payouts, error: payErr } = await q;
    if (payErr) throw new Error('payouts fetch: ' + payErr.message);

    // Mentor-naam/email via team_members (per user_id). We doen één bulk-lookup
    // op het gevulde set mentor-IDs i.p.v. embedded PostgREST-join, want
    // team_members heeft geen FK-relatie naar mentor_payouts.mentor_user_id;
    // dezelfde patroon als andere admin-endpoints (mentor-detail).
    const mentorIds = Array.from(new Set((payouts || []).map((p) => p.mentor_user_id).filter(Boolean)));
    const nameMap = new Map();
    const emailMap = new Map();
    if (mentorIds.length > 0) {
      const { data: tmRows, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, name, email')
        .in('user_id', mentorIds);
      if (tmErr) throw new Error('team_members fetch: ' + tmErr.message);
      for (const r of (tmRows || [])) {
        if (r.user_id) {
          if (r.name)  nameMap.set(r.user_id, r.name);
          if (r.email) emailMap.set(r.user_id, r.email);
        }
      }
    }

    const out = (payouts || []).map((p) => ({
      id              : p.id,
      mentor_user_id  : p.mentor_user_id,
      mentor_name     : nameMap.get(p.mentor_user_id)  || null,
      mentor_email    : emailMap.get(p.mentor_user_id) || null,
      period_month    : p.period_month,
      status          : p.status || null,
      bonus_total     : Number(p.bonus_total)    || 0,
      coaching_total  : Number(p.coaching_total) || 0,
      total           : Number(p.total)          || 0,
      total_excl      : Number(p.total_excl)     || 0,
      btw_amount      : Number(p.btw_amount)     || 0,
      generated_at    : p.generated_at,
      approved_at     : p.approved_at,
      paid_at         : p.paid_at,
    }));

    // Sort op mentor_name (NL locale), null laatst.
    out.sort((a, b) => {
      const an = (a.mentor_name || a.mentor_email || '').toLowerCase();
      const bn = (b.mentor_name || b.mentor_email || '').toLowerCase();
      if (!an && !bn) return 0;
      if (!an) return 1;
      if (!bn) return -1;
      return an.localeCompare(bn, 'nl');
    });

    return res.status(200).json({
      ok          : true,
      period_month: periodStart || null,
      payouts     : out,
    });
  } catch (e) {
    console.error('[mentor-payouts-admin-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
