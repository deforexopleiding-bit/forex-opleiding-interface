// api/mentor-coaching-debug.js
//
// Diagnostic — toont de coaching-telling voor (mentor, maand) zoals de
// payout-generate-core die ziet: het blok `lms` bevat de bronnen + tellers
// van api/_lib/coaching-earnings.js (alleen het LMS). Helpt te bepalen
// waarom het maandtotaal van een mentor afwijkt.
//
// Sinds 9 okt 2026 zonder Bubble (dicht). Voor een maand vóór oktober 2026
// telt de helper alleen het LMS-deel; dan staan `melding` en `opgeslagen`
// (de coachingregels van de opgeslagen uitbetaling, als die er is) erbij,
// zodat te zien is wat er werkelijk is uitgerekend toen Bubble nog meetelde.
//
// Permission: mentor.payout.manage (super_admin / admin / manager).
//
// Query:
//   ?mentor_user_id=<uuid>  (verplicht)
//   ?period_month=YYYY-MM    (verplicht; dag wordt genegeerd)
//
// Faalt nooit met 5xx op een bronfout: die komt als { error, code } in `lms`.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { computeCoachingEarnings, OUDE_BRON_EINDE } from './_lib/coaching-earnings.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function dayStartMs(y, mo, d) {
  return Date.UTC(y, mo - 1, d);
}

function isoFromTs(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function periodFromMonth(s) {
  const m = MONTH_RE.exec(s);
  if (!m) return null;
  const y  = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return null;
  const fromMs = dayStartMs(y, mo, 1);
  const lastDt = new Date(Date.UTC(y, mo, 0));
  const lastDay = lastDt.getUTCDate();
  const toMs   = dayStartMs(y, mo, lastDay);
  return {
    from        : isoFromTs(fromMs),
    to          : isoFromTs(toMs),
    fromMs,
    toMsIncl    : toMs + (24 * 60 * 60 * 1000) - 1,
    monthStartIso: `${y}-${String(mo).padStart(2,'0')}-01`,
  };
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

  const mentorUserId = typeof req.query?.mentor_user_id === 'string' ? req.query.mentor_user_id.trim() : '';
  const periodMonth  = typeof req.query?.period_month  === 'string' ? req.query.period_month.trim()  : '';
  if (!mentorUserId || !UUID_RE.test(mentorUserId)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) vereist' });
  }
  const period = periodFromMonth(periodMonth);
  if (!period) {
    return res.status(400).json({ error: 'period_month moet YYYY-MM zijn' });
  }

  let lms;
  try {
    const r = await computeCoachingEarnings({
      mentorUserId,
      from: period.from,
      to  : period.to,
    });
    const m = r._meta || {};
    lms = {
      bronnen             : m.bronnen,
      venster             : m.venster,
      melding             : m.melding || null,
      lms_sessies_gelezen : m.lms_sessies_gelezen,
      lms_zelfde_moment   : m.lms_zelfde_moment,
      lms_zonder_student  : m.lms_zonder_student,
      lms_teamtraining    : m.lms_teamtraining,
      breakdown           : r.breakdown,
      grand_total         : r.grand_total,
    };
  } catch (e) {
    lms = { error: e?.message || String(e), code: e?.code || null };
  }

  // Oude maand: de opgeslagen coachingregels erbij. Faalzacht.
  let opgeslagen = null;
  if (period.monthStartIso < OUDE_BRON_EINDE) {
    try {
      const { data: pay, error: pErr } = await supabaseAdmin
        .from('mentor_payouts')
        .select('id, status, coaching_total')
        .eq('mentor_user_id', mentorUserId)
        .eq('period_month', period.monthStartIso)
        .maybeSingle();
      if (pErr) throw new Error(pErr.message);
      if (pay) {
        const { data: regels, error: rErr } = await supabaseAdmin
          .from('mentor_payout_lines')
          .select('kind, label, qty, unit_incl, amount_incl')
          .eq('payout_id', pay.id);
        if (rErr) throw new Error(rErr.message);
        opgeslagen = {
          status        : pay.status,
          coaching_total: pay.coaching_total,
          regels        : (regels || []).filter((x) => String(x.kind || '').startsWith('coaching_')),
        };
      }
    } catch (e) {
      opgeslagen = { error: e?.message || String(e) };
    }
  }

  return res.status(200).json({
    ok            : true,
    mentor_user_id: mentorUserId,
    period_month  : period.monthStartIso,
    from          : period.from,
    to            : period.to,
    lms,
    opgeslagen,
  });
}
