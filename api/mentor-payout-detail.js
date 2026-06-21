// api/mentor-payout-detail.js
//
// Payout fase 1 — detail per rapport (kop + regels).
//
// GET ?payout_id=uuid → één mentor_payouts-rij + bijbehorende
// mentor_payout_lines, met mentor-info.
//
// DUAL-GATE:
//   - eigenaar-mentor (mentor_user_id = auth.uid()):
//       * mentor.module.access EN status IN ('goedgekeurd','uitbetaald')
//       * (concepten zijn voor de mentor onzichtbaar — alleen finance ziet die)
//   - anders: mentor.payout.manage.
//
// Response 200:
//   { ok, payout: {
//       id, mentor_user_id, mentor_name, mentor_email, period_month, status,
//       bonus_total, coaching_total, total, total_excl, btw_amount,
//       generated_at, approved_at, approved_by, paid_at, created_at,
//       lines: [
//         { id, kind, label, qty, unit_incl, amount_incl, amount_excl },
//         // kinds: bonus | coaching_1on1 | coaching_team | coaching_noshow |
//         //        coaching_funded | reiskosten | vast | handmatig
//       ],
//       adjustments: [
//         // alle mentor_payout_adjustments voor (mentor, period); UI gebruikt
//         // dit om edit/delete-knoppen aan handmatige posten te koppelen.
//         { id, label, amount_incl, amount_excl }
//       ]
//   } }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MENTOR_VISIBLE_STATUSES = new Set(['goedgekeurd', 'uitbetaald']);

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

  const payoutId = typeof req.query?.payout_id === 'string' ? req.query.payout_id.trim() : '';
  if (!payoutId || !UUID_RE.test(payoutId)) {
    return res.status(400).json({ error: 'payout_id (uuid) vereist' });
  }

  try {
    // 1) Payout-rij ophalen.
    const { data: payout, error: payErr } = await supabaseAdmin
      .from('mentor_payouts')
      .select('id, mentor_user_id, period_month, status, total, bonus_total, coaching_total, total_excl, btw_amount, generated_at, approved_at, approved_by, paid_at, created_at')
      .eq('id', payoutId)
      .maybeSingle();
    if (payErr) throw new Error('payout fetch: ' + payErr.message);
    if (!payout) return res.status(404).json({ error: 'Rapport niet gevonden' });

    // 2) Dual-gate — eigenaar-mentor of admin.
    const isOwner = payout.mentor_user_id === user.id;
    if (isOwner) {
      // Mentor zelf — mag concepten NIET zien.
      if (!MENTOR_VISIBLE_STATUSES.has(payout.status || '')) {
        return res.status(403).json({ error: 'Rapport nog niet zichtbaar (status=concept)' });
      }
      if (!(await requirePermission(req, 'mentor.module.access'))) {
        return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
      }
    } else {
      if (!(await requirePermission(req, 'mentor.payout.manage'))) {
        return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
      }
    }

    // 3) Lines + adjustments parallel ophalen. Adjustments worden alleen
    //    aan admins/manager getoond — bij owner-view (mentor zelf) tonen we
    //    een lege array zodat de UI geen edit/delete-knoppen kan renderen.
    const BTW_RATE = 1.21;
    const round2   = (n) => Math.round((Number(n) || 0) * 100) / 100;

    const linesPromise = supabaseAdmin
      .from('mentor_payout_lines')
      .select('id, kind, label, qty, unit_incl, amount_incl, amount_excl')
      .eq('payout_id', payoutId)
      .order('id', { ascending: true });

    const adjPromise = isOwner
      ? Promise.resolve({ data: [], error: null })
      : supabaseAdmin
          .from('mentor_payout_adjustments')
          .select('id, label, amount_incl')
          .eq('mentor_user_id', payout.mentor_user_id)
          .eq('period_month', payout.period_month)
          .order('id', { ascending: true });

    const [{ data: linesRaw, error: lineErr }, { data: adjRaw, error: adjErr }] =
      await Promise.all([linesPromise, adjPromise]);
    if (lineErr) throw new Error('lines fetch: ' + lineErr.message);
    if (adjErr)  throw new Error('adjustments fetch: ' + adjErr.message);

    const lines = (linesRaw || []).map((l) => ({
      id          : l.id,
      kind        : l.kind,
      label       : l.label,
      qty         : l.qty == null ? null : Number(l.qty),
      unit_incl   : l.unit_incl == null ? null : Number(l.unit_incl),
      amount_incl : Number(l.amount_incl) || 0,
      amount_excl : Number(l.amount_excl) || 0,
    }));

    const adjustments = (adjRaw || []).map((a) => {
      const inc = Number(a.amount_incl) || 0;
      return {
        id          : a.id,
        label       : String(a.label || ''),
        amount_incl : inc,
        amount_excl : round2(inc / BTW_RATE),
      };
    });

    // 4) Mentor-info (naam/email).
    let mentor_name = null;
    let mentor_email = null;
    if (payout.mentor_user_id) {
      const { data: tm, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('name, email')
        .eq('user_id', payout.mentor_user_id)
        .maybeSingle();
      if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
      mentor_name  = tm?.name  || null;
      mentor_email = tm?.email || null;
    }

    return res.status(200).json({
      ok    : true,
      payout: {
        id              : payout.id,
        mentor_user_id  : payout.mentor_user_id,
        mentor_name,
        mentor_email,
        period_month    : payout.period_month,
        status          : payout.status || null,
        bonus_total     : Number(payout.bonus_total)    || 0,
        coaching_total  : Number(payout.coaching_total) || 0,
        total           : Number(payout.total)          || 0,
        total_excl      : Number(payout.total_excl)     || 0,
        btw_amount      : Number(payout.btw_amount)     || 0,
        generated_at    : payout.generated_at,
        approved_at     : payout.approved_at,
        approved_by     : payout.approved_by,
        paid_at         : payout.paid_at,
        created_at      : payout.created_at,
        lines,
        adjustments,
      },
    });
  } catch (e) {
    console.error('[mentor-payout-detail]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
