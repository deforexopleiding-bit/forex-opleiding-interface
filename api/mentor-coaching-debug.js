// api/mentor-coaching-debug.js
//
// Diagnostic — toont de 1-op-1 sessie-telling voor (mentor, maand) zoals de
// payout-generate-core die ziet. Helpt te bepalen waarom het maandtotaal van
// een mentor afwijkt: laat keys + datums + booleans zien zonder PII.
//
// Permission: mentor.payout.manage (super_admin / admin / manager).
//
// Query:
//   ?mentor_user_id=<uuid>  (verplicht)
//   ?period_month=YYYY-MM    (verplicht; dag wordt genegeerd)
//
// PRIVACY: ALLEEN keys, datums, booleans en interne bubble-IDs in de output.
// Geen namen, e-mails of vrije-tekstvelden. De volledige Bubble-rij wordt
// ALLEEN gebruikt om sessionSampleKeys (= Object.keys van eerste sessie) te
// bouwen; de individuele rij gaat NIET mee.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleList } from './_lib/bubble.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
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

  try {
    // Resolve bubble_user_id.
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('bubble_user_id, is_active')
      .eq('user_id', mentorUserId)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.bubble_user_id) {
      return res.status(200).json({
        ok                    : true,
        mentor_user_id        : mentorUserId,
        period_month          : period.monthStartIso,
        from                  : period.from,
        to                    : period.to,
        linked                : false,
        students_count        : 0,
        sessions_fetched      : 0,
        sessionSampleKeys     : [],
        oneOnOne_count        : 0,
        doneAndNoshow_in_range: 0,
        counted               : [],
      });
    }

    // Studenten ophalen — zelfde constraints als de helper.
    const studentsConstraints = [
      { key: 'mentor_user',            constraint_type: 'equals', value: tm.bubble_user_id },
      { key: 'role_option_os___roles', constraint_type: 'equals', value: 'student' },
    ];
    const { results: studentRows } = await bubbleList('user', studentsConstraints, { limit: 500 });
    const studentIds = (studentRows || []).map((u) => String(u._id || '')).filter(Boolean);

    // 1-op-1 sessies ophalen — zelfde batching als de helper.
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
          console.warn('[mentor-coaching-debug] in-constraint sessions faalde, fallback per-student:', e?.message || e);
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

    // Tellen — exact dezelfde regels als coaching-earnings.js.
    let oneOnOne = 0;
    let doneAndNoshow = 0;
    const counted = [];
    const MAX_COUNTED = 120;
    for (const s of sessionRows) {
      const done    = asBool(readFirst(s, ['isdone_boolean', 'isDone']));
      const ns      = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
      const compDt  = readFirst(s, ['completed_date_date', 'completed date']);
      const memberId = readFirst(s, ['member_user', 'member']);
      const inWin   = inRange(compDt, period.fromMs, period.toMsIncl);
      if (done && inWin) {
        oneOnOne += 1;
        if (counted.length < MAX_COUNTED) {
          counted.push({
            c   : compDt || null,
            done: !!done,
            ns  : !!ns,
            m   : memberId ? String(memberId) : null,
          });
        }
      }
      if (done && ns && inWin) {
        doneAndNoshow += 1;
      }
    }

    const sessionSampleKeys = sessionRows[0] ? Object.keys(sessionRows[0]) : [];

    return res.status(200).json({
      ok                    : true,
      mentor_user_id        : mentorUserId,
      period_month          : period.monthStartIso,
      from                  : period.from,
      to                    : period.to,
      linked                : true,
      students_count        : studentIds.length,
      sessions_fetched      : sessionRows.length,
      sessionSampleKeys,
      oneOnOne_count        : oneOnOne,
      doneAndNoshow_in_range: doneAndNoshow,
      counted,
    });
  } catch (e) {
    console.error('[mentor-coaching-debug]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
