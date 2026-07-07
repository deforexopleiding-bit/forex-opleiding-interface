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

    // Bonus-entries van deze payout (sinds PR #629 hebben ze payout_id gezet).
    // Voor oudere rapporten van vóór #629 blijft deze lijst leeg → UI toont
    // dan "Geen bonus-opbouw beschikbaar".
    const bonusEntriesPromise = supabaseAdmin
      .from('mentor_ledger_entries')
      .select('id, amount, entry_type, released_at, customer_id, note, idempotency_key')
      .eq('payout_id', payoutId)
      .order('released_at', { ascending: true });

    const [{ data: linesRaw, error: lineErr }, { data: adjRaw, error: adjErr }, { data: bonusRaw, error: bonusErr }] =
      await Promise.all([linesPromise, adjPromise, bonusEntriesPromise]);
    if (lineErr)  throw new Error('lines fetch: ' + lineErr.message);
    if (adjErr)   throw new Error('adjustments fetch: ' + adjErr.message);
    if (bonusErr) throw new Error('bonus entries fetch: ' + bonusErr.message);

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

    // 5) Bonus-breakdown: klant-labels + term-hint + source per entry.
    const bonusRows = (bonusRaw || []).filter((e) => e.entry_type === 'bonus');
    const custIds   = [...new Set(bonusRows.map((e) => e.customer_id).filter(Boolean))];
    const custById  = new Map();
    if (custIds.length) {
      const { data: custRows, error: custErr } = await supabaseAdmin
        .from('customers')
        .select('id, first_name, last_name, company_name, is_company, email')
        .in('id', custIds);
      if (custErr) throw new Error('customers fetch: ' + custErr.message);
      for (const c of (custRows || [])) custById.set(c.id, c);
    }
    const customerLabel = (c) => {
      if (!c) return null;
      if (c.is_company) return c.company_name || c.email || '(klant)';
      const nm = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
      return nm || c.email || '(klant)';
    };
    // Traject-label uit note: "Handmatig traject: <label> — termijn N/M".
    const noteTrajectLabel = (note) => {
      if (typeof note !== 'string') return null;
      const m = note.match(/^Handmatig traject:\s*(.+?)\s*—/);
      return m ? m[1].trim() : null;
    };
    const derive = (e) => {
      const key = String(e.idempotency_key || '');
      // Traject: "cashtraject:<uuid>:<termIdx>:mentor:<userId>"
      const cashMatch = key.match(/^cashtraject:[^:]+:(\d+):mentor:/);
      if (cashMatch) {
        return {
          label    : customerLabel(custById.get(e.customer_id)) || noteTrajectLabel(e.note) || '(traject)',
          term_hint: `termijn ${cashMatch[1]}`,
          source   : 'coaching_traject',
        };
      }
      // Event-child (proportional / paidrel-term): term = eventuele nummer.
      // "<parentId>:paidrel-term:<N>" of "<parentId>:pay:<paymentId>" of ":paidamount:<cents>"
      const paidRelMatch = key.match(/:paidrel-term:(\d+)/);
      return {
        label    : customerLabel(custById.get(e.customer_id)) || '(onbekend)',
        term_hint: paidRelMatch ? `termijn ${paidRelMatch[1]}` : '',
        source   : 'event',
      };
    };
    const BREAKDOWN_CAP = 50;
    const breakdownAll = bonusRows.map((e) => {
      const d = derive(e);
      return {
        label       : d.label,
        term_hint   : d.term_hint,
        amount      : round2(Number(e.amount) || 0),
        released_at : e.released_at || null,
        source      : d.source,
      };
    }).sort((a, b) => b.amount - a.amount);
    let bonus_breakdown = breakdownAll;
    let bonus_rest_count  = 0;
    let bonus_rest_amount = 0;
    if (breakdownAll.length > BREAKDOWN_CAP) {
      bonus_breakdown = breakdownAll.slice(0, BREAKDOWN_CAP);
      const rest = breakdownAll.slice(BREAKDOWN_CAP);
      bonus_rest_count  = rest.length;
      bonus_rest_amount = round2(rest.reduce((s, x) => s + x.amount, 0));
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
        bonus_breakdown,
        bonus_rest_count,
        bonus_rest_amount,
      },
    });
  } catch (e) {
    console.error('[mentor-payout-detail]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
