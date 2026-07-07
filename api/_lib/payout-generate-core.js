// api/_lib/payout-generate-core.js
//
// Gedeelde core voor het opbouwen van een payout-concept. Wordt gebruikt door:
//   - api/mentor-payout-generate.js  (bulk/single via admin-UI)
//   - api/mentor-payout-adjustment-save.js   (recompute na handmatige post)
//   - api/mentor-payout-adjustment-delete.js (recompute na verwijderen)
//
// computeAndUpsertConcept({ mentorUserId, monthStart, actorId })
//   → Berekent het concept voor (mentor, maand) en upsert het in
//     mentor_payouts + mentor_payout_lines. Snapshot-only — RAAKT DE LEDGER
//     NIET AAN. Skip als bestaand rapport status='goedgekeurd' of 'uitbetaald'.
//
// monthStart wordt verwacht als 'YYYY-MM-DD' (de 1e van de maand). De helper
// leidt monthEnd (start volgende maand) en monthLast (laatste dag) zelf af.
//
// Lines worden bij elke run volledig herbouwd (delete-all + insert) zodat de
// snapshot deterministisch is en geen vergeten rijen achterblijven.
//
// Bronnen (alles incl btw — excl = round2(incl / 1.21)):
//   1) BONUS    → mentor_ledger_entries (vrijgegeven, niet aan payout gekoppeld).
//   2) COACHING → coaching-earnings helper (1on1/team/no-show/funded).
//   3) TRAVEL   → mentor_payout_config + mentor_travel_days (alleen als enabled).
//   4) RECURRING→ mentor_recurring_items (actief).
//   5) MANUAL   → mentor_payout_adjustments (mag negatief).
//
// Response shape (caller bepaalt zelf wat er teruggaat naar de client):
//   { skipped:true, mentor_user_id, payout_id, status } |
//   { skipped:false, mentor_user_id, payout_id, status:'concept',
//     bonus_total, coaching_total, travel_total, recurring_total, manual_total,
//     total, total_excl, btw_amount, lines:[...] }

import { supabaseAdmin } from '../supabase.js';
import { computeCoachingEarnings } from './coaching-earnings.js';

export const BTW_RATE = 1.21;

export function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// 'YYYY-MM-01' → 'YYYY-(MM-1)-01' (vorige-maand bucket-start).
function _prevMonthStartOfCore(monthStartIso) {
  const s = String(monthStartIso || '');
  const m = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const y  = Number(m[1]);
  const mo = Number(m[2]);
  const py = mo === 1 ? y - 1 : y;
  const pm = mo === 1 ? 12    : mo - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

// monthStart='YYYY-MM-DD' → { start, end, last } (start/end zijn ISO-datums,
// last is de laatste dag van de maand voor coaching-range-inclusive).
export function periodFromMonthStart(monthStart) {
  if (typeof monthStart !== 'string') return null;
  const m = monthStart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return null;
  const mm    = String(mo).padStart(2, '0');
  const start = `${y}-${mm}-01`;
  const lastDt = new Date(Date.UTC(y, mo, 0));
  const last   = `${lastDt.getUTCFullYear()}-${String(lastDt.getUTCMonth()+1).padStart(2,'0')}-${String(lastDt.getUTCDate()).padStart(2,'0')}`;
  const nextMo = mo === 12 ? 1 : mo + 1;
  const nextY  = mo === 12 ? y + 1 : y;
  const end    = `${nextY}-${String(nextMo).padStart(2, '0')}-01`;
  return { start, end, last };
}

// Normaliseer 'YYYY-MM' en 'YYYY-MM-DD' naar monthStart (1e van de maand).
export function normalizeMonthStart(s) {
  if (typeof s !== 'string') return null;
  const m1 = s.match(/^(\d{4})-(\d{2})$/);
  const m2 = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  const m = m1 || m2;
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return null;
  return `${y}-${String(mo).padStart(2, '0')}-01`;
}

export async function computeAndUpsertConcept({ mentorUserId, monthStart, actorId }) {
  if (!mentorUserId) throw new Error('computeAndUpsertConcept: mentorUserId vereist');
  const period = periodFromMonthStart(monthStart);
  if (!period) throw new Error('computeAndUpsertConcept: monthStart moet YYYY-MM-DD zijn');

  // 1) Resolve team_member voor bubble_user_id (coaching). Fail-soft.
  const { data: tm, error: tmErr } = await supabaseAdmin
    .from('team_members')
    .select('bubble_user_id')
    .eq('user_id', mentorUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (tmErr) throw new Error(`team_members lookup (${mentorUserId}): ${tmErr.message}`);
  const bubbleUserId = tm?.bubble_user_id || null;

  // 2) Bestaande payout-rij ophalen — skip bij definitieve status.
  const { data: existing, error: existErr } = await supabaseAdmin
    .from('mentor_payouts')
    .select('id, status')
    .eq('mentor_user_id', mentorUserId)
    .eq('period_month', period.start)
    .maybeSingle();
  if (existErr) throw new Error(`payouts lookup (${mentorUserId}): ${existErr.message}`);
  if (existing && (existing.status === 'goedgekeurd' || existing.status === 'uitbetaald')) {
    return {
      skipped       : true,
      mentor_user_id: mentorUserId,
      payout_id     : existing.id,
      status        : existing.status,
      reason        : 'al definitief',
    };
  }

  // 3) BONUS — event/bonus-venster voor rapportmaand M.
  //    Model: coaching = maand M zelf (via computeCoachingEarnings hieronder);
  //    event/bonus = t/m eind maand M-1 (bovengrens = 1e vd rapportmaand M,
  //    exclusief). Zo dekt het juni-rapport (rapportmaand M = juni) mei-
  //    bonussen; juni-bonussen schuiven naar het juli-rapport.
  //    Geen ondergrens + status='vrijgegeven' + payout_id IS NULL = inhaal-
  //    vangnet voor oudere niet-uitbetaalde bonussen zonder dubbeltelling.
  //    GEEN type-onderscheid: event/handmatig/regulier volgen dezelfde regel.
  const { data: ledgerRows, error: ledErr } = await supabaseAdmin
    .from('mentor_ledger_entries')
    .select('amount, released_at')
    .eq('mentor_user_id', mentorUserId)
    .eq('status', 'vrijgegeven')
    .is('payout_id', null)
    .lt('released_at', period.start);
  if (ledErr) throw new Error(`ledger fetch (${mentorUserId}): ${ledErr.message}`);
  const bonusTotal = round2((ledgerRows || []).reduce((s, r) => s + (Number(r.amount) || 0), 0));

  // 4) COACHING — helper.
  let coachingBreakdown = null;
  let coachingTotal = 0;
  if (bubbleUserId) {
    try {
      const r = await computeCoachingEarnings({
        bubbleUserId,
        mentorUserId,
        from: period.start,
        to  : period.last,
      });
      coachingBreakdown = r.breakdown || null;
      coachingTotal     = round2(r.grand_total || 0);
    } catch (e) {
      console.warn(`[payout-generate-core] coaching faalde voor ${mentorUserId}: ${e?.message || e}`);
      coachingBreakdown = null;
      coachingTotal     = 0;
    }
  }

  // 5) TRAVEL — alleen als config.travel_enabled.
  const { data: cfg, error: cfgErr } = await supabaseAdmin
    .from('mentor_payout_config')
    .select('travel_enabled, travel_day_rate_incl')
    .eq('mentor_user_id', mentorUserId)
    .maybeSingle();
  if (cfgErr) throw new Error(`payout-config lookup (${mentorUserId}): ${cfgErr.message}`);
  const travelEnabled = !!cfg?.travel_enabled;
  const travelRate    = Number(cfg?.travel_day_rate_incl) || 0;
  let travelDays = 0;
  let travelTotal = 0;
  if (travelEnabled) {
    const { data: tdRow, error: tdErr } = await supabaseAdmin
      .from('mentor_travel_days')
      .select('days')
      .eq('mentor_user_id', mentorUserId)
      .eq('period_month', period.start)
      .maybeSingle();
    if (tdErr) throw new Error(`travel-days lookup (${mentorUserId}): ${tdErr.message}`);
    travelDays  = Number(tdRow?.days) || 0;
    travelTotal = round2(travelDays * travelRate);
  }

  // 6) RECURRING — actieve vaste posten. Een post telt alleen mee als
  //    start_month IS NULL (vanaf altijd) OF start_month <= huidige maand
  //    (post is al ingegaan).
  const { data: recurringRows, error: recErr } = await supabaseAdmin
    .from('mentor_recurring_items')
    .select('label, amount_incl, start_month')
    .eq('mentor_user_id', mentorUserId)
    .eq('active', true)
    .or(`start_month.is.null,start_month.lte.${period.start}`);
  if (recErr) throw new Error(`recurring fetch (${mentorUserId}): ${recErr.message}`);
  const recurringItems = (recurringRows || []).map((r) => ({
    label       : String(r.label || ''),
    amount_incl : round2(r.amount_incl),
  }));
  const recurringTotal = round2(recurringItems.reduce((s, r) => s + r.amount_incl, 0));

  // 7) MANUAL — handmatige posten in deze maand (mag negatief).
  const { data: adjRows, error: adjErr } = await supabaseAdmin
    .from('mentor_payout_adjustments')
    .select('id, label, amount_incl')
    .eq('mentor_user_id', mentorUserId)
    .eq('period_month', period.start);
  if (adjErr) throw new Error(`adjustments fetch (${mentorUserId}): ${adjErr.message}`);
  const manualItems = (adjRows || []).map((r) => ({
    id          : r.id,
    label       : String(r.label || ''),
    amount_incl : round2(r.amount_incl),
  }));
  const manualTotal = round2(manualItems.reduce((s, r) => s + r.amount_incl, 0));

  // 8) Totalen.
  const totalIncl = round2(bonusTotal + coachingTotal + travelTotal + recurringTotal + manualTotal);
  const totalExcl = round2(totalIncl / BTW_RATE);
  const btwAmount = round2(totalIncl - totalExcl);
  const nowIso    = new Date().toISOString();

  // 9) Upsert payouts-rij.
  let payoutId;
  if (existing) {
    const { error: updErr } = await supabaseAdmin
      .from('mentor_payouts')
      .update({
        total          : totalIncl,
        bonus_total    : bonusTotal,
        coaching_total : coachingTotal,
        total_excl     : totalExcl,
        btw_amount     : btwAmount,
        generated_at   : nowIso,
      })
      .eq('id', existing.id);
    if (updErr) throw new Error(`payouts update (${mentorUserId}): ${updErr.message}`);
    payoutId = existing.id;

    const { error: delErr } = await supabaseAdmin
      .from('mentor_payout_lines')
      .delete()
      .eq('payout_id', payoutId);
    if (delErr) throw new Error(`lines delete (${mentorUserId}): ${delErr.message}`);
  } else {
    const insertRow = {
      mentor_user_id : mentorUserId,
      period_month   : period.start,
      total          : totalIncl,
      bonus_total    : bonusTotal,
      coaching_total : coachingTotal,
      total_excl     : totalExcl,
      btw_amount     : btwAmount,
      status         : 'concept',
      generated_at   : nowIso,
    };
    if (actorId) insertRow.created_by = actorId;
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('mentor_payouts')
      .insert(insertRow)
      .select('id')
      .single();
    if (insErr) throw new Error(`payouts insert (${mentorUserId}): ${insErr.message}`);
    payoutId = inserted.id;
  }

  // 10) Lines opbouwen. Volgorde: bonus → coaching-categorieën → travel →
  //     recurring → manual. Lege regels overslaan (qty=0 én amount=0).
  const lineInserts = [];

  if (bonusTotal !== 0) {
    lineInserts.push({
      payout_id   : payoutId,
      kind        : 'bonus',
      label       : 'Event-bonus (vrijgegeven termijnen)',
      qty         : null,
      unit_incl   : null,
      amount_incl : bonusTotal,
      amount_excl : round2(bonusTotal / BTW_RATE),
    });
  }

  if (coachingBreakdown) {
    const COACH_DEFS = [
      { key: 'one_on_one', kind: 'coaching_1on1',   label: '1-op-1 sessies' },
      { key: 'team',       kind: 'coaching_team',   label: 'Teamtrainingen' },
      { key: 'no_show',    kind: 'coaching_noshow', label: 'No-shows'       },
      { key: 'funded',     kind: 'coaching_funded', label: 'Funded-students'},
    ];
    for (const def of COACH_DEFS) {
      const cell      = coachingBreakdown[def.key] || {};
      const qty       = Number(cell.count) || 0;
      const unitIncl  = Number(cell.rate)  || 0;
      const amtIncl   = round2(Number(cell.total) || 0);
      if (qty === 0 && amtIncl === 0) continue;
      lineInserts.push({
        payout_id   : payoutId,
        kind        : def.kind,
        label       : def.label,
        qty,
        unit_incl   : unitIncl,
        amount_incl : amtIncl,
        amount_excl : round2(amtIncl / BTW_RATE),
      });
    }
  }

  if (travelEnabled && travelDays > 0) {
    lineInserts.push({
      payout_id   : payoutId,
      kind        : 'reiskosten',
      label       : 'Reiskosten',
      qty         : travelDays,
      unit_incl   : travelRate,
      amount_incl : travelTotal,
      amount_excl : round2(travelTotal / BTW_RATE),
    });
  }

  for (const r of recurringItems) {
    if (r.amount_incl === 0) continue;
    lineInserts.push({
      payout_id   : payoutId,
      kind        : 'vast',
      label       : r.label || 'Vaste maandpost',
      qty         : null,
      unit_incl   : null,
      amount_incl : r.amount_incl,
      amount_excl : round2(r.amount_incl / BTW_RATE),
    });
  }

  for (const a of manualItems) {
    if (a.amount_incl === 0) continue;
    lineInserts.push({
      payout_id   : payoutId,
      kind        : 'handmatig',
      label       : a.label || 'Handmatige post',
      qty         : null,
      unit_incl   : null,
      amount_incl : a.amount_incl,
      amount_excl : round2(a.amount_incl / BTW_RATE),
    });
  }

  let lines = [];
  if (lineInserts.length > 0) {
    const { data: inserted, error: lineErr } = await supabaseAdmin
      .from('mentor_payout_lines')
      .insert(lineInserts)
      .select('id, kind, label, qty, unit_incl, amount_incl, amount_excl');
    if (lineErr) throw new Error(`lines insert (${mentorUserId}): ${lineErr.message}`);
    lines = inserted || [];
  }

  return {
    skipped         : false,
    mentor_user_id  : mentorUserId,
    payout_id       : payoutId,
    status          : 'concept',
    bonus_total     : bonusTotal,
    coaching_total  : coachingTotal,
    travel_total    : travelTotal,
    recurring_total : recurringTotal,
    manual_total    : manualTotal,
    total           : totalIncl,
    total_excl      : totalExcl,
    btw_amount      : btwAmount,
    lines,
  };
}
