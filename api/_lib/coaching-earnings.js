// api/_lib/coaching-earnings.js
//
// Gedeelde helper voor coaching-verdiensten. Wordt gebruikt door:
//   - mentor-coaching-earnings.js (UI op de Coaching-tab van mentor-dashboard)
//   - mentor-payout-generate.js  (snapshot voor maand-rapport)
//   - mentor-detail.html (admin per-mentor)
// Door dezelfde helper te gebruiken matcht het rapport exact wat de mentor zelf ziet.
//
// Input (ongewijzigd):
//   { bubbleUserId: string, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' (inclusief) }
//
// Output (incl btw — tarieven 35/50/25/100):
//   { breakdown:  { one_on_one, team, no_show, funded }, grand_total,
//     students_count, sessions_fetched, team_count_raw,
//     _meta: { fetchedRaw, afterCbFilter, alphaDone, alphaNoshow,
//              cbConstraintApplied, fetchPaths } }
//
// ─── Attributie (sinds Created-By-omzetting) ─────────────────────────────
// 1-op-1 sessies worden geattribueerd op session['Created By'] = mentor —
// niet langer via de huidige mentor_user-koppeling van de student. Reden:
// mentoren maken zelf sessies aan in Bubble, en wisselingen in
// student-mentor-relaties veranderen historische telling niet meer (geen
// "drifted students"-fenomeen). Filterregels:
//   - session['Created By']                              === mentorBubbleId
//   - session.learn_type1_option_os___learning_type      === 'Alpha Program'
//   - session.isdone_boolean                             === true
//   - session.starting_date_date in [from, to] (inclusief)
// GEEN eis op member_user (orphans tellen mee). GEEN dedup (dubbele calls
// tellen — same-day-dupes zijn business intent, niet een bug).
//
// Bedragen:
//   calls (€35)  = isdone && !noshow
//   noshow (€25) = isdone && noshow
//
// Team-coaching (€50) blijft ongewijzigd via tutor_user op team-training.
// Funded (€100) telt voorlopig altijd 0.

import { bubbleList } from './bubble.js';

export const RATE_1ON1   = 35;
export const RATE_TEAM   = 50;
export const RATE_NOSHOW = 25;
export const RATE_FUNDED = 100;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

// Bubble option-set → leesbare string ('Alpha Program' etc).
function pickOption(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const d = v.display || v.text || v.value || null;
    return d ? String(d).trim() || null : null;
  }
  return null;
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
export async function computeCoachingEarnings({ bubbleUserId, from, to }) {
  if (!bubbleUserId) {
    const b = emptyBreakdown();
    return {
      breakdown        : b,
      grand_total      : 0,
      students_count   : 0,
      sessions_fetched : 0,
      team_count_raw   : 0,
      _meta            : {
        fetchedRaw          : 0,
        afterCbFilter       : 0,
        alphaDone           : 0,
        alphaNoshow         : 0,
        cbConstraintApplied : false,
        fetchPaths          : [],
      },
    };
  }
  if (!DATE_RE.test(String(from || '')) || !DATE_RE.test(String(to || ''))) {
    throw new Error('coaching-earnings: from/to moeten YYYY-MM-DD zijn');
  }
  const fromMs = dayStartMs(from);
  const toMs   = dayStartMs(to);
  if (fromMs == null || toMs == null) throw new Error('coaching-earnings: ongeldige datum');
  const toMsInclusive = toMs + (24 * 60 * 60 * 1000) - 1;
  if (fromMs > toMsInclusive) throw new Error('coaching-earnings: from > to');

  // Bubble greater-than/less-than op date-constraints zijn strikt; stuur
  // monthStart-1ms en monthEnd+1ms zodat de randen wél meedoen.
  const fromIsoStrict = new Date(fromMs - 1).toISOString();
  const toIsoStrict   = new Date(toMsInclusive + 1).toISOString();
  const dateConstraints = [
    { key: 'starting_date_date', constraint_type: 'greater than', value: fromIsoStrict },
    { key: 'starting_date_date', constraint_type: 'less than',    value: toIsoStrict   },
  ];
  const cbConstraint = { key: 'Created By', constraint_type: 'equals', value: bubbleUserId };

  // ── 1-op-1 sessies — Created-By-attributie ─────────────────────────────
  // Probeer eerst server-side filter op Created By (efficiënt voor brede ranges).
  // Bij falen vallen we terug op alleen de date-constraints; JS filtert dan.
  const FETCH_CAP = 3000;
  const fetchPaths = [];
  let sessionRows = [];
  let cbConstraintApplied = false;
  try {
    const { results } = await bubbleList(
      '1-1-session',
      [...dateConstraints, cbConstraint],
      { limit: FETCH_CAP },
    );
    sessionRows = results || [];
    cbConstraintApplied = true;
    fetchPaths.push('date+cb');
  } catch (e) {
    console.warn('[coaching-earnings] Created-By server-constraint faalde, fallback date-only:', e?.message || e);
    try {
      const { results } = await bubbleList(
        '1-1-session',
        dateConstraints,
        { limit: FETCH_CAP },
      );
      sessionRows = results || [];
      fetchPaths.push('date-only');
    } catch (e2) {
      console.warn('[coaching-earnings] 1-1-session fetch faalde:', e2?.message || e2);
      sessionRows = [];
      fetchPaths.push('date-only-failed');
    }
  }

  // JS-veiligheidsnet: ongeacht of server-side cb-constraint pakte, hier
  // is de filtering autoritatief. Geen member_user-eis, geen dedup.
  let oneOnOne = 0;
  let noShow   = 0;
  let afterCbFilter = 0;
  for (const s of sessionRows) {
    const cb = readFirst(s, ['Created By', 'created_by']);
    if (!cb || String(cb) !== bubbleUserId) continue;
    afterCbFilter += 1;

    const lt = pickOption(readFirst(s, ['learn_type1_option_os___learning_type']));
    if (lt !== 'Alpha Program') continue;

    const done = asBool(readFirst(s, ['isdone_boolean', 'isDone']));
    if (!done) continue;

    const sd = readFirst(s, ['starting_date_date', 'starting date']);
    if (!inRange(sd, fromMs, toMsInclusive)) continue;

    const ns = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
    if (ns) noShow   += 1;
    else    oneOnOne += 1;
  }

  // ── Team-trainingen (€50) — ONGEWIJZIGD via tutor_user ────────────────
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
    // students_count is sinds Created-By-attributie irrelevant — de mentor's
    // huidige student-bucket bepaalt niet meer de telling. Houden we op 0
    // i.p.v. de oude student-walk te doen (extra Bubble-roundtrip).
    students_count   : 0,
    sessions_fetched : sessionRows.length,
    team_count_raw   : teamRows.length,
    _meta: {
      fetchedRaw          : sessionRows.length,
      afterCbFilter,
      alphaDone           : oneOnOne,
      alphaNoshow         : noShow,
      cbConstraintApplied,
      fetchPaths,
    },
  };
}
