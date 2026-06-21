// api/mentor-payout-generate.js
//
// Payout fase 1 — Genereer-concept rapport.
//
// POST → bouwt voor een (of alle) mentor(s) een snapshot van de verdiensten
// in een bepaalde maand. Schrijft naar mentor_payouts + mentor_payout_lines
// als status='concept'. RAAKT DE LEDGER NIET AAN (geen status/payout_id
// updates op mentor_ledger_entries). De finance-medewerker / strateeg
// controleert het rapport later; pas in fase 2/3 wordt het definitief
// gemaakt en de ledger gekoppeld.
//
// Permission: mentor.payout.manage (super_admin / admin / manager).
//
// Body (JSON):
//   { period_month: 'YYYY-MM' | 'YYYY-MM-DD' (verplicht — dag wordt genegeerd),
//     mentor_user_id?: uuid (optioneel — zonder = bulk over alle actieve mentors) }
//
// Alle bedragen INCLUSIEF btw (snapshot):
//   - bonus_total    = som van mentor_ledger_entries.amount voor de mentor in [monthStart, nextMonthStart),
//                      status='vrijgegeven', payout_id IS NULL.
//   - coaching_total = computeCoachingEarnings.grand_total voor [monthStart, monthLast].
//   - total_incl     = round2(bonus + coaching).
//   - total_excl     = round2(total_incl / 1.21).
//   - btw_amount     = round2(total_incl - total_excl).
//
// UPSERT-gedrag op (mentor_user_id, period_month=monthStart):
//   - bestaat niet  → INSERT status='concept', totals/coaching_total/btw, generated_at=now, created_by=auth.uid().
//   - status='concept' → UPDATE totals + generated_at; verwijder oude payout_lines en herbouw.
//   - status='goedgekeurd' | 'uitbetaald' → NIET overschrijven; skipped:true in response.
//
// Response 200:
//   { ok, period_month, mentors: [
//       { mentor_user_id, payout_id, status, bonus_total, coaching_total,
//         total, total_excl, btw_amount, lines, skipped?, reason? }, ...
//   ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeCoachingEarnings } from './_lib/coaching-earnings.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BTW_RATE = 1.21;

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function normalizeMonth(s) {
  if (typeof s !== 'string') return null;
  const m1 = s.match(/^(\d{4})-(\d{2})$/);
  const m2 = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  const m = m1 || m2;
  if (!m) return null;
  const y  = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return null;
  const mm     = String(mo).padStart(2, '0');
  const start  = `${y}-${mm}-01`;
  const lastDt = new Date(Date.UTC(y, mo, 0));
  const lastIso = `${lastDt.getUTCFullYear()}-${String(lastDt.getUTCMonth()+1).padStart(2,'0')}-${String(lastDt.getUTCDate()).padStart(2,'0')}`;
  const nextMo = mo === 12 ? 1 : mo + 1;
  const nextY  = mo === 12 ? y + 1 : y;
  const end    = `${nextY}-${String(nextMo).padStart(2, '0')}-01`;
  return { start, end, last: lastIso };
}

// Voor één (mentor, period) — geeft een mentors-array-item terug.
async function generateForMentor({ mentorUserId, period, callerUserId }) {
  // 1) Resolve team_member voor bubble_user_id (coaching) — fail-soft als geen koppeling.
  const { data: tm, error: tmErr } = await supabaseAdmin
    .from('team_members')
    .select('bubble_user_id')
    .eq('user_id', mentorUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (tmErr) throw new Error(`team_members lookup (${mentorUserId}): ${tmErr.message}`);
  const bubbleUserId = tm?.bubble_user_id || null;

  // 2) Bestaande payout-rij ophalen.
  const { data: existing, error: existErr } = await supabaseAdmin
    .from('mentor_payouts')
    .select('id, status')
    .eq('mentor_user_id', mentorUserId)
    .eq('period_month', period.start)
    .maybeSingle();
  if (existErr) throw new Error(`payouts lookup (${mentorUserId}): ${existErr.message}`);

  if (existing && (existing.status === 'goedgekeurd' || existing.status === 'uitbetaald')) {
    return {
      mentor_user_id: mentorUserId,
      payout_id     : existing.id,
      status        : existing.status,
      skipped       : true,
      reason        : 'al definitief',
    };
  }

  // 3) Bonus-totaal (incl btw) — som van vrijgegeven ledger-entries in de maand,
  //    nog niet aan een payout gekoppeld.
  const { data: ledgerRows, error: ledErr } = await supabaseAdmin
    .from('mentor_ledger_entries')
    .select('amount')
    .eq('mentor_user_id', mentorUserId)
    .eq('status', 'vrijgegeven')
    .is('payout_id', null)
    .gte('released_at', period.start)
    .lt('released_at',  period.end);
  if (ledErr) throw new Error(`ledger fetch (${mentorUserId}): ${ledErr.message}`);
  const bonusTotal = round2((ledgerRows || []).reduce((s, r) => s + (Number(r.amount) || 0), 0));

  // 4) Coaching-snapshot — gebruikt dezelfde helper als de UI-tab.
  let coachingBreakdown = null;
  let coachingTotal = 0;
  if (bubbleUserId) {
    try {
      const r = await computeCoachingEarnings({
        bubbleUserId,
        from: period.start,
        to  : period.last,
      });
      coachingBreakdown = r.breakdown || null;
      coachingTotal     = round2(r.grand_total || 0);
    } catch (e) {
      // Bubble-fout mag het hele rapport niet stuk maken: coaching=0 + warning loggen.
      console.warn(`[mentor-payout-generate] coaching faalde voor ${mentorUserId}: ${e?.message || e}`);
      coachingBreakdown = null;
      coachingTotal     = 0;
    }
  }

  // 5) Totalen (incl/excl/btw).
  const totalIncl = round2(bonusTotal + coachingTotal);
  const totalExcl = round2(totalIncl / BTW_RATE);
  const btwAmount = round2(totalIncl - totalExcl);
  const nowIso    = new Date().toISOString();

  // 6) UPSERT mentor_payouts.
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

    // Bestaande regels weggooien zodat we ze schoon opnieuw kunnen invoegen.
    const { error: delErr } = await supabaseAdmin
      .from('mentor_payout_lines')
      .delete()
      .eq('payout_id', payoutId);
    if (delErr) throw new Error(`lines delete (${mentorUserId}): ${delErr.message}`);
  } else {
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('mentor_payouts')
      .insert({
        mentor_user_id : mentorUserId,
        period_month   : period.start,
        total          : totalIncl,
        bonus_total    : bonusTotal,
        coaching_total : coachingTotal,
        total_excl     : totalExcl,
        btw_amount     : btwAmount,
        status         : 'concept',
        generated_at   : nowIso,
        created_by     : callerUserId,
      })
      .select('id')
      .single();
    if (insErr) throw new Error(`payouts insert (${mentorUserId}): ${insErr.message}`);
    payoutId = inserted.id;
  }

  // 7) Lines bouwen — bonus + coaching-categorieën (één regel elk).
  //    qty/unit_incl/amount_incl/amount_excl per regel; excl = amount_incl / 1.21.
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
      const cell = coachingBreakdown[def.key] || {};
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
    mentor_user_id  : mentorUserId,
    payout_id       : payoutId,
    status          : 'concept',
    bonus_total     : bonusTotal,
    coaching_total  : coachingTotal,
    total           : totalIncl,
    total_excl      : totalExcl,
    btw_amount      : btwAmount,
    lines,
  };
}

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
  if (!(await requirePermission(req, 'mentor.payout.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const period = normalizeMonth(body.period_month);
  if (!period) {
    return res.status(400).json({ error: 'period_month moet YYYY-MM (of YYYY-MM-DD) zijn' });
  }

  const requestedMentorId = typeof body.mentor_user_id === 'string'
    ? body.mentor_user_id.trim()
    : '';
  if (requestedMentorId && !UUID_RE.test(requestedMentorId)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
  }

  try {
    // Mentor-lijst opbouwen.
    let mentorUserIds;
    if (requestedMentorId) {
      mentorUserIds = [requestedMentorId];
    } else {
      const { data: rows, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, type, is_active')
        .eq('type', 'mentor')
        .eq('is_active', true)
        .not('user_id', 'is', null);
      if (tmErr) throw new Error('mentor-lijst fetch: ' + tmErr.message);
      mentorUserIds = Array.from(new Set((rows || []).map((r) => r.user_id).filter(Boolean)));
    }

    if (mentorUserIds.length === 0) {
      return res.status(200).json({
        ok          : true,
        period_month: period.start,
        mentors     : [],
        warning     : 'Geen actieve mentors gevonden',
      });
    }

    // Sequentieel om bubble.io / Supabase niet te overbelasten en logs leesbaar te houden.
    const results = [];
    for (const mid of mentorUserIds) {
      try {
        const r = await generateForMentor({
          mentorUserId : mid,
          period,
          callerUserId : user.id,
        });
        results.push(r);
      } catch (e) {
        console.error(`[mentor-payout-generate] mentor ${mid}: ${e?.message || e}`);
        results.push({
          mentor_user_id: mid,
          error         : e?.message || String(e),
        });
      }
    }

    return res.status(200).json({
      ok          : true,
      period_month: period.start,
      mentors     : results,
    });
  } catch (e) {
    console.error('[mentor-payout-generate]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
