// api/mentor-coaching-earnings.js
//
// GET → coaching-verdiensten v1: telt 1-op-1 sessies + team-trainingen +
// no-shows binnen een periode en rekent ze om naar bedragen (incl. btw).
// Read-only proxy op bubble.io.
//
// Dual-gate (consistent met andere mentor-endpoints):
//   - ?mentor_user_id=… → admin (mentor.admin.view, die id).
//   - afwezig            → self  (mentor.module.access, auth.uid()).
//
// Query:
//   from=YYYY-MM-DD, to=YYYY-MM-DD (inclusief). Default: huidige maand
//   (1e t/m laatste dag).
//
// Tarieven incl. btw (constanten in dit bestand):
//   1-op-1 = €35, team-training = €50, no-show = €25, funded = €100.
//
// Funded: telt voorlopig altijd 0 (activeert bij certificaat-upload in een
// latere PR). Wel als regel in de breakdown zodat de UI de tarieven kan tonen.
//
// CLIENT-SIDE datumcheck is bron-van-waarheid: we filteren in JS op
// completed_date_date / starting_date_date / completeddate_date binnen
// [from, to]. Eventuele server-side date-constraints zijn alleen handig om
// de fetch te begrenzen, maar de uiteindelijke telling is hier.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleList } from './_lib/bubble.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const RATE_1ON1   = 35;
const RATE_TEAM   = 50;
const RATE_NOSHOW = 25;
const RATE_FUNDED = 100;

// 'in'-constraint vermijden bij grote student-lijsten: hierboven splitsen
// we per-student om URL-lengte-issues op de Bubble Data API te voorkomen.
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

// Parse YYYY-MM-DD naar millisec (UTC start-of-day).
function dayStartMs(s) {
  if (!s || !DATE_RE.test(s)) return null;
  const t = Date.UTC(
    parseInt(s.slice(0, 4), 10),
    parseInt(s.slice(5, 7), 10) - 1,
    parseInt(s.slice(8, 10), 10),
  );
  return Number.isFinite(t) ? t : null;
}

// YYYY-MM-DD voor "vandaag" in UTC.
function todayUtc() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function firstOfMonthUtc(ref = new Date()) {
  const y = ref.getUTCFullYear();
  const m = String(ref.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function lastOfMonthUtc(ref = new Date()) {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0)); // dag-0 = laatste van vorige maand
  const mm = String(last.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(last.getUTCDate()).padStart(2, '0');
  return `${last.getUTCFullYear()}-${mm}-${dd}`;
}

// Check of een bubble-datumveld binnen [fromMs, toMs] valt (inclusief).
// Bubble levert datums meestal als ISO-string ('2025-06-15T00:00:00Z').
function inRange(rawDate, fromMs, toMsInclusive) {
  if (!rawDate) return false;
  const t = (typeof rawDate === 'number') ? rawDate : new Date(String(rawDate)).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= fromMs && t <= toMsInclusive;
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

  // Dual-gate.
  const requestedMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  let effectiveUserId;
  let scope;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) {
      return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    }
    if (!(await requirePermission(req, 'mentor.admin.view'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    }
    effectiveUserId = requestedMentorId;
    scope = 'admin';
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    }
    effectiveUserId = user.id;
    scope = 'self';
  }

  // Datum-range.
  let from = typeof req.query?.from === 'string' ? req.query.from.trim() : '';
  let to   = typeof req.query?.to   === 'string' ? req.query.to.trim()   : '';
  if (!from || !DATE_RE.test(from)) from = firstOfMonthUtc();
  if (!to   || !DATE_RE.test(to))   to   = lastOfMonthUtc();
  const fromMs = dayStartMs(from);
  const toMs   = dayStartMs(to);
  if (fromMs == null || toMs == null) {
    return res.status(400).json({ error: 'from/to moeten YYYY-MM-DD zijn' });
  }
  // 'to' is inclusief het hele etmaal → +24u-1ms.
  const toMsInclusive = toMs + (24 * 60 * 60 * 1000) - 1;
  if (fromMs > toMsInclusive) {
    return res.status(400).json({ error: 'from mag niet na to liggen' });
  }

  const debugOn = req.query?.debug === '1';

  try {
    // Mentor bubble_user_id resolven.
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('bubble_user_id, is_active')
      .eq('user_id', effectiveUserId)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.bubble_user_id) {
      return res.status(200).json({
        ok: true, scope, linked: false, from, to,
        breakdown: emptyBreakdown(),
        grand_total: 0,
      });
    }

    // STAP A — studenten van deze mentor.
    const studentsConstraints = [
      { key: 'mentor_user',            constraint_type: 'equals', value: tm.bubble_user_id },
      { key: 'role_option_os___roles', constraint_type: 'equals', value: 'student' },
    ];
    const { results: studentRows } = await bubbleList('user', studentsConstraints, { limit: 500 });
    const studentIds = (studentRows || []).map((u) => String(u._id || '')).filter(Boolean);

    // STAP B — 1-op-1 sessies van die studenten.
    // 'in'-constraint kan op de Bubble Data API stuk gaan bij hele lange
    // arrays. Fallback: per-student parallel, in batches van IN_BATCH_LIMIT.
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
          // 'in'-constraint geweigerd → val terug op per-student.
          console.warn('[mentor-coaching-earnings] in-constraint sessions faalde, fallback per-student:', e?.message || e);
          sessionRows = [];
        }
      }
      if (sessionRows.length === 0 && studentIds.length > 0) {
        // Per-student fetch in batches voor concurrency-cap.
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

    // Tel sessies binnen [from,to] op basis van isdone_boolean / noshow_boolean.
    let oneOnOne = 0;
    let noShow   = 0;
    for (const s of sessionRows) {
      const done   = asBool(readFirst(s, ['isdone_boolean', 'isDone']));
      const ns     = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
      const compDt = readFirst(s, ['completed_date_date', 'completed date']);
      const startDt = readFirst(s, ['starting_date_date', 'starting date']);
      if (done && inRange(compDt, fromMs, toMsInclusive)) oneOnOne += 1;
      if (ns   && inRange(startDt, fromMs, toMsInclusive)) noShow   += 1;
    }

    // STAP C — teamtrainingen waar deze mentor de tutor is.
    let teamRows = [];
    try {
      const { results } = await bubbleList(
        'team-training',
        [{ key: 'tutor_user', constraint_type: 'equals', value: tm.bubble_user_id }],
        { limit: 1000 },
      );
      teamRows = results || [];
    } catch (e) {
      console.warn('[mentor-coaching-earnings] team-training fetch faalde:', e?.message || e);
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

    const payload = {
      ok: true,
      scope,
      linked: true,
      from,
      to,
      breakdown,
      grand_total,
    };

    if (debugOn) {
      const firstSession = sessionRows[0] || null;
      const firstTeam    = teamRows[0]    || null;
      payload.debug = {
        students_count    : studentIds.length,
        sessions_fetched  : sessionRows.length,
        teamCountRaw      : teamRows.length,
        sessionSampleKeys : firstSession ? Object.keys(firstSession) : [],
        teamSampleKeys    : firstTeam    ? Object.keys(firstTeam)    : [],
      };
    }

    return res.status(200).json(payload);
  } catch (e) {
    console.error('[mentor-coaching-earnings]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}

function emptyBreakdown() {
  return {
    one_on_one : { count: 0, rate: RATE_1ON1,   total: 0 },
    team       : { count: 0, rate: RATE_TEAM,   total: 0 },
    no_show    : { count: 0, rate: RATE_NOSHOW, total: 0 },
    funded     : { count: 0, rate: RATE_FUNDED, total: 0 },
  };
}
