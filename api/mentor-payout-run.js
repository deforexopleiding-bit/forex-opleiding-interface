// api/mentor-payout-run.js
//
// F5.1 — Uitbetalings-run: bundelt alle 'vrijgegeven' ledger-entries van een
// mentor in een specifieke maand tot één mentor_payouts-rij. Entries krijgen
// status 'uitbetaald' + payout_id + paid_at. Total = sum(amounts) — bonus is
// positief, uitgaven zijn NEGATIEF, dus total is netto-uitbetaling.
//
// Permission: mentor.payout.run.
//
// Body (JSON):
//   { mentor_user_id: uuid, period_month: 'YYYY-MM-01' }
//
// Response 200:
//   { ok, payout_id, mentor_user_id, period_month, total, entries_count,
//     bonus_total, expense_total, status: 'uitbetaald', paid_at }
// 400 validatie / 401-403 auth / 404 mentor zonder vrijgegeven entries /
// 409 mentor heeft al een 'open' payout voor die periode / 500 DB
//
// Idempotency: als er al een payout-rij voor (mentor_user_id, period_month)
// bestaat met status='open' returnen we 409 met de bestaande id zodat de
// caller niet per ongeluk een 2e batch maakt. Voor status='uitbetaald'
// betekent dat de periode al definitief is — ook 409 (USE_NEW_PERIOD).
//
// Period_month: we accepteren 'YYYY-MM' of 'YYYY-MM-DD' (de dag wordt
// genegeerd; we normaliseren naar de 1e van die maand). period_month is een
// date-kolom; we sluiten ervoor [period_start, period_end+1mo) op released_at.
//
// "1 MAAND ACHTERAF"-REGEL (sinds 2026-07):
//   Payout voor maand M pakt:
//     * event/handmatige (cashtraject) bonussen vrijgevallen in M-1 (vorige maand)
//     * reguliere (abonnement-gedreven) bonussen vrijgevallen in M (huidige maand)
//   Type-detectie via idempotency_key: 'cashtraject:*' → handmatig;
//   ':bonus:' in de key → event; anders → regulier.
//   Het LABEL/period_month op de payout-rij blijft de gekozen maand M.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { createNotification } from './_lib/notify.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeMonth(s) {
  if (typeof s !== 'string') return null;
  return _monthPeriod(s);
}

// 'YYYY-MM' / 'YYYY-MM-DD' → { start, end } (start = 1e vd maand, end = 1e vd volgende maand).
function _monthPeriod(s) {
  const m1 = s.match(/^(\d{4})-(\d{2})$/);
  const m2 = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  const m = m1 || m2;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12) return null;
  const mm = String(mo).padStart(2, '0');
  const start = `${y}-${mm}-01`;
  // Volgende maand voor de excl-bovengrens
  const nextMo = mo === 12 ? 1 : mo + 1;
  const nextY  = mo === 12 ? y + 1 : y;
  const end = `${nextY}-${String(nextMo).padStart(2, '0')}-01`;
  return { start, end };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// 'YYYY-MM-DD…' → 'YYYY-MM-01' (bucket-start van die maand).
function _monthStartOf(iso) {
  const s = String(iso || '');
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-01` : null;
}

// 'YYYY-MM-01' → 'YYYY-(MM-1)-01' (vorige-maand bucket-start).
function _prevMonthStartOf(monthStartIso) {
  const s = String(monthStartIso || '');
  const m = s.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const y  = Number(m[1]);
  const mo = Number(m[2]);
  const py = mo === 1 ? y - 1 : y;
  const pm = mo === 1 ? 12    : mo - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
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
  if (!(await requirePermission(req, 'mentor.payout.run'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.payout.run)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const mentorId = typeof body.mentor_user_id === 'string' ? body.mentor_user_id.trim() : '';
  if (!mentorId || !UUID_RE.test(mentorId)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) vereist' });
  }
  const period = normalizeMonth(body.period_month);
  if (!period) {
    return res.status(400).json({ error: 'period_month moet YYYY-MM of YYYY-MM-DD zijn' });
  }

  try {
    // 1) Bestaande payout-rij voor die mentor + periode?
    const { data: existing } = await supabaseAdmin
      .from('mentor_payouts')
      .select('id, status, total, paid_at')
      .eq('mentor_user_id', mentorId)
      .eq('period_month', period.start)
      .maybeSingle();
    if (existing) {
      return res.status(409).json({
        error    : `Voor deze mentor + periode bestaat al een payout (status=${existing.status})`,
        code     : existing.status === 'uitbetaald' ? 'PERIOD_ALREADY_PAID' : 'PERIOD_OPEN',
        payout_id: existing.id,
      });
    }

    // 2) Vrijgegeven entries — met "1 maand achteraf"-regel voor event +
    //    handmatige (cashtraject) bonussen. Payout voor maand M pakt:
    //      * event/handmatig-bonussen vrijgevallen in M-1 (vorige maand)
    //      * reguliere (abonnement-gedreven) bonussen vrijgevallen in M
    //    Praktisch: één query over [M-1, M+1), daarna JS-filter op type +
    //    juiste maand-bucket. Type-detectie via idempotency_key:
    //      * 'cashtraject:*'        → handmatig
    //      * bevat ':bonus:'        → event-bonus (event-afronding)
    //      * anders                 → regulier (subscription/betaal-flow)
    const prevMonthStart = _prevMonthStartOf(period.start);
    const curMonthStart  = period.start;
    const { data: entries, error: entErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .select('id, entry_type, amount, released_at, idempotency_key')
      .eq('mentor_user_id', mentorId)
      .eq('status', 'vrijgegeven')
      .gte('released_at', prevMonthStart)
      .lt('released_at', period.end);
    if (entErr) throw new Error('entries fetch: ' + entErr.message);

    const rowsAll = entries || [];
    const rows = rowsAll.filter((e) => {
      const key  = String(e.idempotency_key || '');
      const isCash  = key.startsWith('cashtraject:');
      const isEvent = /:bonus:/.test(key);
      const bucket  = _monthStartOf(e.released_at);
      if (isCash || isEvent) return bucket === prevMonthStart;
      return bucket === curMonthStart;
    });
    if (rows.length === 0) {
      return res.status(404).json({
        error: 'Geen vrijgegeven entries in deze periode',
        code : 'NO_ENTRIES',
      });
    }

    let bonusTotal = 0;
    let expenseTotal = 0;
    for (const e of rows) {
      const amt = Number(e.amount) || 0;
      if (e.entry_type === 'bonus')  bonusTotal   += amt;
      if (e.entry_type === 'uitgave') expenseTotal += amt; // amount is negatief
    }
    const total = round2(bonusTotal + expenseTotal); // expense is negatief -> netto

    const nowIso = new Date().toISOString();

    // 3) Insert payout-rij
    const { data: payoutRow, error: insErr } = await supabaseAdmin
      .from('mentor_payouts')
      .insert({
        mentor_user_id: mentorId,
        period_month  : period.start,
        total         : total,
        status        : 'uitbetaald',
        created_by    : user.id,
        paid_at       : nowIso,
      })
      .select('id')
      .single();
    if (insErr) throw new Error('payout insert: ' + insErr.message);

    // 4) Entries koppelen + naar 'uitbetaald'
    const entryIds = rows.map((r) => r.id);
    const { error: updErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .update({
        status   : 'uitbetaald',
        payout_id: payoutRow.id,
        paid_at  : nowIso,
      })
      .in('id', entryIds);
    if (updErr) {
      // Best-effort rollback: payout wist en error returnen
      await supabaseAdmin.from('mentor_payouts').delete().eq('id', payoutRow.id).then(() => null).catch(() => null);
      throw new Error('entries update: ' + updErr.message);
    }

    // Fail-soft dual-write: mentor notificeren over de uitbetaling.
    const NL_MONTHS_RUN = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
    let periodNLRun = '';
    if (typeof period.start === 'string') {
      const m = period.start.match(/^(\d{4})-(\d{2})/);
      if (m) periodNLRun = (NL_MONTHS_RUN[parseInt(m[2], 10) - 1] || m[2]) + ' ' + m[1];
    }
    createNotification({
      toUserId:   mentorId,
      type:       'payout.paid',
      title:      'Uitbetaling gedaan' + (periodNLRun ? (' · ' + periodNLRun) : ''),
      body:       'Je uitbetaling is verwerkt',
      linkUrl:    '/modules/mentor-dashboard.html',
      entityType: 'payout',
      entityId:   payoutRow.id,
      createdBy:  user.id,
    }).catch(() => {});

    return res.status(200).json({
      ok            : true,
      payout_id     : payoutRow.id,
      mentor_user_id: mentorId,
      period_month  : period.start,
      total         : total,
      entries_count : rows.length,
      bonus_total   : round2(bonusTotal),
      expense_total : round2(expenseTotal),
      status        : 'uitbetaald',
      paid_at       : nowIso,
    });
  } catch (e) {
    console.error('[mentor-payout-run]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
