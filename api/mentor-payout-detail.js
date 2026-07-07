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
import { computeBonusOverview } from './mentor-bonus-overview.js';

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

    // 5) Bonus-breakdown: uit dezelfde bron als de mentor-cashflow-tooltip.
    //    Rapport maand M → pak entry voor maand M-1 uit projection_12m.
    //    De term_hint komt hier NIET meer als "termijn N" want de overview
    //    aggregeert per klant/termijn-due_date; we mappen wat 'ie geeft:
    //    { label, term (optioneel), amount, status }. Voor 'event' zetten we
    //    source op 'event', voor traject-achtige rijen kunnen we niet altijd
    //    onderscheiden — de overview merkt handmatige trajecten aan
    //    is_cash_traject in per_event/sales, maar de projection_12m breakdown
    //    heeft die info niet expliciet. Voor nu: alle regels bron 'event',
    //    de klant/termijn-info is wat de mentor zelf ziet in de tooltip.
    let bonus_breakdown = [];
    let bonus_rest_count  = 0;
    let bonus_rest_amount = 0;
    try {
      // M-1 ym-key voor deze payout: 'YYYY-MM-01' → 'YYYY-MM'.
      const pm = String(payout.period_month || '').slice(0, 7);
      if (pm) {
        // Pak M-1 via addMonths equivalent: parse jaar/mnd en trek 1 af.
        const parts = pm.split('-');
        const y = Number(parts[0]);
        const mo = Number(parts[1]);
        const pyi = mo === 1 ? y - 1 : y;
        const pmi = mo === 1 ? 12    : mo - 1;
        const mMinus1 = `${pyi}-${String(pmi).padStart(2, '0')}`;
        const bo = await computeBonusOverview(payout.mentor_user_id);
        const entry = (bo.projection_12m || []).find((m) => m.month === mMinus1);
        if (entry && Array.isArray(entry.breakdown)) {
          bonus_breakdown = entry.breakdown.map((b) => ({
            label      : String(b.label || '(onbekend)'),
            term_hint  : b.term ? `termijn ${b.term}` : '',
            amount     : round2(Number(b.amount) || 0),
            released_at: null,
            source     : b.status === 'betaald' ? 'event' : 'event',
          }));
          bonus_rest_count  = Number(entry.rest_count)  || 0;
          bonus_rest_amount = round2(Number(entry.rest_amount) || 0);
        }
      }
    } catch (e) {
      console.warn('[mentor-payout-detail] bonus-overview fetch faalde:', e?.message || e);
    }
    // Fallback: als de overview geen breakdown gaf (bv. oude data), leun op
    // de ledger-entries die aan deze payout gekoppeld zijn (audit-mechanisme
    // uit PR #629). Dit is de "backup"-bron zodat oude rapporten blijven
    // werken.
    if (bonus_breakdown.length === 0 && Array.isArray(bonusRaw) && bonusRaw.length > 0) {
      const bonusRows = bonusRaw.filter((e) => e.entry_type === 'bonus');
      const custIds   = [...new Set(bonusRows.map((e) => e.customer_id).filter(Boolean))];
      const custById  = new Map();
      if (custIds.length) {
        const { data: custRows } = await supabaseAdmin
          .from('customers')
          .select('id, first_name, last_name, company_name, is_company, email')
          .in('id', custIds);
        for (const c of (custRows || [])) custById.set(c.id, c);
      }
      const customerLabel = (c) => {
        if (!c) return null;
        if (c.is_company) return c.company_name || c.email || '(klant)';
        const nm = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
        return nm || c.email || '(klant)';
      };
      const noteTrajectLabel = (note) => {
        const m = String(note || '').match(/^Handmatig traject:\s*(.+?)\s*—/);
        return m ? m[1].trim() : null;
      };
      const derive = (e) => {
        const key = String(e.idempotency_key || '');
        const cashMatch = key.match(/^cashtraject:[^:]+:(\d+):mentor:/);
        if (cashMatch) {
          return {
            label    : customerLabel(custById.get(e.customer_id)) || noteTrajectLabel(e.note) || '(traject)',
            term_hint: `termijn ${cashMatch[1]}`,
            source   : 'coaching_traject',
          };
        }
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
      bonus_breakdown = breakdownAll.slice(0, BREAKDOWN_CAP);
      if (breakdownAll.length > BREAKDOWN_CAP) {
        const rest = breakdownAll.slice(BREAKDOWN_CAP);
        bonus_rest_count  = rest.length;
        bonus_rest_amount = round2(rest.reduce((s, x) => s + x.amount, 0));
      }
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
