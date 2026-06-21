// api/_lib/coaching-earnings.js
//
// Gedeelde helper voor coaching-verdiensten. Wordt gebruikt door zowel
// mentor-coaching-earnings.js (UI op de Coaching-tab) als mentor-payout-generate.js
// (snapshot voor maand-rapport). Door dezelfde helper te gebruiken matcht het
// rapport exact wat de mentor op de Coaching-tab ziet.
//
// Input:
//   { bubbleUserId: string, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' (inclusief) }
//
// Output (incl btw — tarieven 35/50/25/100):
//   { one_on_one : { count, rate, total },
//     team       : { count, rate, total },
//     no_show    : { count, rate, total },
//     funded     : { count, rate, total },
//     grand_total: number }
//
// Funded telt altijd 0 (placeholder voor latere certificaat-koppeling).

import { bubbleList } from './bubble.js';

export const RATE_1ON1   = 35;
export const RATE_TEAM   = 50;
export const RATE_NOSHOW = 25;
export const RATE_FUNDED = 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IN_BATCH_LIMIT = 30;

function asBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true','yes','ja','1'].includes(s)) return true;
    if (['false','no','nee','0'].includes(s)) return false;
  }
  return !!v;
}

function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) {
    if (u[k] !== undefined) return u[k];
  }
  return undefined;
}

function dayStartMs(s) {
  if (!s || !DATE_RE.test(s)) return null;
  const t = Date.UTC(
    parseInt(s.slice(0, 4), 10),
    parseInt(s.slice(5, 7), 10) - 1,
    parseInt(s.slice(8, 10), 10),
  );
  return Number.isFinite(t) ? t : null;
}

function inRange(rawDate, fromMs, toMsInclusive) {
  if (!rawDate) return false;
  const t = (typeof rawDate === 'number') ? rawDate : new Date(String(rawDate)).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= fromMs && t <= toMsInclusive;
}

export function emptyBreakdown() {
  return {
    one_on_one : { count: 0, rate: RATE_1ON1,   total: 0 },
    team       : { count: 0, rate: RATE_TEAM,   total: 0 },
    no_show    : { count: 0, rate: RATE_NOSHOW, total: 0 },
    funded     : { count: 0, rate: RATE_FUNDED, total: 0 },
  };
}

// Hoofdfunctie. Gooit door op bubble-errors zodat de caller (endpoint of
// generate-script) zelf de error kan mappen naar HTTP-status.
//
// Retourneert ALTIJD een { breakdown, grand_total } shape — bij missende
// bubble-koppeling moet de caller dat vooraf opvangen (deze helper neemt aan
// dat bubbleUserId geldig is).
export async function computeCoachingEarnings({ bubbleUserId, from, to }) {
  if (!bubbleUserId) {
    const b = emptyBreakdown();
    return { breakdown: b, grand_total: 0, students_count: 0, sessions_fetched: 0, team_count_raw: 0 };
  }
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    throw new Error('coaching-earnings: from/to moeten YYYY-MM-DD zijn');
  }
  const fromMs = dayStartMs(from);
  const toMs   = dayStartMs(to);
  if (fromMs == null || toMs == null) throw new Error('coaching-earnings: ongeldige datum');
  const toMsInclusive = toMs + (24 * 60 * 60 * 1000) - 1;
  if (fromMs > toMsInclusive) throw new Error('coaching-earnings: from > to');

  // STAP A — studenten van deze mentor.
  const studentsConstraints = [
    { key: 'mentor_user',            constraint_type: 'equals', value: bubbleUserId },
    { key: 'role_option_os___roles', constraint_type: 'equals', value: 'student' },
  ];
  const { results: studentRows } = await bubbleList('user', studentsConstraints, { limit: 500 });
  const studentIds = (studentRows || []).map((u) => String(u._id || '')).filter(Boolean);

  // STAP B — 1-op-1 sessies voor die studenten (batched i.v.m. 'in' URL-limiet).
  let sessionRows = [];
  if (studentIds.length > 0) {
    if (studentIds.length <= IN_BATCH_LIMIT) {
      try {
        const { results } = await bubbleList(
          '1-1-session',
          [{ key: 'member_user', constraint_type: 'in', value: studentIds }],
          { limit: 2000 },
        );
        sessionRows = results || [];
      } catch (e) {
        console.warn('[coaching-earnings] in-constraint sessions faalde, fallback per-student:', e?.message || e);
        sessionRows = [];
      }
    }
    if (sessionRows.length === 0 && studentIds.length > 0) {
      for (let i = 0; i < studentIds.length; i += IN_BATCH_LIMIT) {
        const batch = studentIds.slice(i, i + IN_BATCH_LIMIT);
        const batchResults = await Promise.all(batch.map((sid) =>
          bubbleList('1-1-session',
            [{ key: 'member_user', constraint_type: 'equals', value: sid }],
            { limit: 500 },
          ).then((r) => r.results || []).catch(() => [])
        ));
        for (const arr of batchResults) sessionRows.push(...arr);
      }
    }
  }

  // 1-op-1 (€35): isDone && GEEN no-show && completed_date in range.
  // No-show (€25): no-show && completed_date in range. (Was starting_date —
  // dat veroorzaakte dubbeltelling/onverwachte bedragen omdat no-shows soms
  // op een ander datumveld stonden dan de afgewikkelde sessies.)
  let oneOnOne = 0;
  let noShow   = 0;
  for (const s of sessionRows) {
    const done   = asBool(readFirst(s, ['isdone_boolean', 'isDone']));
    const ns     = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
    const compDt = readFirst(s, ['completed_date_date', 'completed date']);
    const inWin  = inRange(compDt, fromMs, toMsInclusive);
    if (done && !ns && inWin) oneOnOne += 1;
    if (ns         && inWin) noShow   += 1;
  }

  // STAP C — teamtrainingen met deze mentor als tutor.
  let teamRows = [];
  try {
    const { results } = await bubbleList(
      'team-training',
      [{ key: 'tutor_user', constraint_type: 'equals', value: bubbleUserId }],
      { limit: 1000 },
    );
    teamRows = results || [];
  } catch (e) {
    console.warn('[coaching-earnings] team-training fetch faalde:', e?.message || e);
    teamRows = [];
  }
  let team = 0;
  for (const tt of teamRows) {
    const done = asBool(readFirst(tt, ['isdone_boolean', 'isDone']));
    const dt   = readFirst(tt, ['completeddate_date', 'completedDate']);
    if (done && inRange(dt, fromMs, toMsInclusive)) team += 1;
  }

  const breakdown = {
    one_on_one : { count: oneOnOne, rate: RATE_1ON1,   total: oneOnOne * RATE_1ON1   },
    team       : { count: team,     rate: RATE_TEAM,   total: team     * RATE_TEAM   },
    no_show    : { count: noShow,   rate: RATE_NOSHOW, total: noShow   * RATE_NOSHOW },
    funded     : { count: 0,        rate: RATE_FUNDED, total: 0                       },
  };
  const grand_total = breakdown.one_on_one.total
                    + breakdown.team.total
                    + breakdown.no_show.total
                    + breakdown.funded.total;

  return {
    breakdown,
    grand_total,
    students_count   : studentIds.length,
    sessions_fetched : sessionRows.length,
    team_count_raw   : teamRows.length,
  };
}
