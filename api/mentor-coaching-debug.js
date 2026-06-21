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

// Bubble option-set veld → leesbare string. String blijft string; object met
// .display/.text wordt geplat naar die waarde; alles anders → null.
function pickOption(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const d = v.display || v.text || v.value || null;
    return d ? String(d).trim() || null : null;
  }
  return null;
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
    const seppeBubbleId = tm?.bubble_user_id || null;
    if (!seppeBubbleId) {
      return res.status(200).json({
        ok                    : true,
        mentor_user_id        : mentorUserId,
        seppeBubbleId         : null,
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
      { key: 'mentor_user',            constraint_type: 'equals', value: seppeBubbleId },
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

    // Learntype-verdeling: groepeer in-range sessies op learn_type1 option-set.
    // Sleutel '(none)' voor sessies zonder lt-waarde zodat alles getelt blijft.
    const byLearnType = {};
    function ensureLt(key) {
      if (!byLearnType[key]) {
        byLearnType[key] = { done: 0, done_not_noshow: 0, noshow: 0 };
      }
      return byLearnType[key];
    }
    let total_done = 0;
    let total_done_not_noshow = 0;
    let total_noshow = 0;

    // byDateField: vergelijk telling op completed_date vs starting_date over
    // ALLE opgehaalde sessies (niet alleen de in-range bucket hierboven).
    const byDateField = {
      completed_in_range: { done: 0, done_not_noshow: 0, noshow: 0 },
      starting_in_range : { done: 0, done_not_noshow: 0, noshow: 0 },
    };

    for (const s of sessionRows) {
      const done     = asBool(readFirst(s, ['isdone_boolean', 'isDone']));
      const ns       = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
      const compDt   = readFirst(s, ['completed_date_date', 'completed date']);
      const startDt  = readFirst(s, ['starting_date_date', 'starting date']);
      const memberId = readFirst(s, ['member_user', 'member']);
      const lt       = pickOption(readFirst(s, ['learn_type1_option_os___learning_type']));
      const cbVal    = readFirst(s, ['Created By', 'created_by']);
      const inWin    = inRange(compDt,  period.fromMs, period.toMsIncl);
      const inWinSt  = inRange(startDt, period.fromMs, period.toMsIncl);

      if (done && inWin) {
        oneOnOne += 1;
        if (counted.length < MAX_COUNTED) {
          counted.push({
            c   : compDt  || null,
            s   : startDt || null,
            done: !!done,
            ns  : !!ns,
            m   : memberId ? String(memberId) : null,
            lt  : lt,
            cb  : cbVal ? String(cbVal) : null,
          });
        }
        // byLearnType + totals — alleen voor in-range done sessies.
        const cell = ensureLt(lt || '(none)');
        cell.done += 1;
        total_done += 1;
        if (ns) {
          cell.noshow += 1;
          total_noshow += 1;
        } else {
          cell.done_not_noshow += 1;
          total_done_not_noshow += 1;
        }
      }
      if (done && ns && inWin) {
        doneAndNoshow += 1;
      }

      // byDateField — alleen done sessies meetellen, gesplitst op datumveld
      // dat in de maand valt. Onafhankelijk van counted/byLearnType.
      if (done && inWin) {
        byDateField.completed_in_range.done += 1;
        if (ns) byDateField.completed_in_range.noshow          += 1;
        else    byDateField.completed_in_range.done_not_noshow += 1;
      }
      if (done && inWinSt) {
        byDateField.starting_in_range.done += 1;
        if (ns) byDateField.starting_in_range.noshow          += 1;
        else    byDateField.starting_in_range.done_not_noshow += 1;
      }
    }

    const sessionSampleKeys = sessionRows[0] ? Object.keys(sessionRows[0]) : [];

    // ── createdByProbe ────────────────────────────────────────────────────
    // Fetch ALLE 1-1-sessions met starting_date_date binnen [monthStart, monthEnd),
    // ZONDER student-filter. Doel: kunnen we via "Created By" zien dat de mentor
    // sessies heeft aangemaakt die NIET in z'n huidige 36 student-bucket vallen?
    // (bv. omdat een student van mentor-koppeling is veranderd).
    //
    // Bubble's 'greater than' / 'less than' op date-constraints zijn STRIKT;
    // we sturen monthStart-1ms (zodat de 1e wél meedoet) en monthEnd+1d
    // (zodat de laatste dag wél meedoet).
    let createdByProbe = null;
    try {
      const PROBE_CAP = 3000;
      const fromIsoStrict = new Date(period.fromMs - 1).toISOString();
      const toIsoStrict   = new Date(period.toMsIncl + 1).toISOString();
      const probeConstraints = [
        { key: 'starting_date_date', constraint_type: 'greater than', value: fromIsoStrict },
        { key: 'starting_date_date', constraint_type: 'less than',    value: toIsoStrict   },
      ];
      const { results: probeRows } = await bubbleList(
        '1-1-session',
        probeConstraints,
        { limit: PROBE_CAP },
      );
      const probeArr = probeRows || [];
      const fetched  = probeArr.length;
      const capped   = fetched >= PROBE_CAP;

      // cb_histogram: top-12 distinct Created By → count (desc).
      const cbCount = new Map();
      let seppeDoneNotNs = 0;
      let seppeNoShow   = 0;
      let seppeTotal    = 0;
      const seppeStudentIdsSet = new Set();
      const studentIdsSet      = new Set(studentIds);

      // Per learn_type tellingen voor Seppe-sessies (alleen done in maand-range).
      const seppe_by_learntype = {};
      function ensureLtBucket(key) {
        if (!seppe_by_learntype[key]) {
          seppe_by_learntype[key] = { done_not_noshow: 0, noshow: 0, total: 0 };
        }
        return seppe_by_learntype[key];
      }
      // Alpha-only counters + dupe-detectie. Sleutel = `${member_user}|${day}`,
      // waarde = array van starting_date_date strings (volgorde van fetch).
      const seppe_alpha = { done_not_noshow: 0, noshow: 0 };
      const alphaDupeMap = new Map();

      for (const s of probeArr) {
        const cb = readFirst(s, ['Created By', 'created_by']);
        const cbKey = cb ? String(cb) : '(none)';
        cbCount.set(cbKey, (cbCount.get(cbKey) || 0) + 1);

        if (cb && String(cb) === seppeBubbleId) {
          seppeTotal += 1;
          const done = asBool(readFirst(s, ['isdone_boolean', 'isDone']));
          const ns   = asBool(readFirst(s, ['noshow_boolean', 'NoShow']));
          const sd   = readFirst(s, ['starting_date_date', 'starting date']);
          const inWinStart = inRange(sd, period.fromMs, period.toMsIncl);
          if (done && inWinStart) {
            if (ns) seppeNoShow    += 1;
            else    seppeDoneNotNs += 1;

            // Per-learntype + alpha-bucket en dupe-detectie alleen op done sessies
            // in de maand (anders wordt het signaal vertroebeld met out-of-range).
            const lt = pickOption(readFirst(s, ['learn_type1_option_os___learning_type']));
            const ltKey = lt || '(none)';
            const bucket = ensureLtBucket(ltKey);
            bucket.total += 1;
            if (ns) bucket.noshow          += 1;
            else    bucket.done_not_noshow += 1;

            if (ltKey === 'Alpha Program') {
              if (ns) seppe_alpha.noshow          += 1;
              else    seppe_alpha.done_not_noshow += 1;

              if (!ns) {
                const member = readFirst(s, ['member_user', 'member']);
                const day = sd ? String(sd).slice(0, 10) : null;
                if (member && day) {
                  const k = `${String(member)}|${day}`;
                  if (!alphaDupeMap.has(k)) alphaDupeMap.set(k, []);
                  alphaDupeMap.get(k).push(String(sd));
                }
              }
            }
          }
          const m = readFirst(s, ['member_user', 'member']);
          if (m) seppeStudentIdsSet.add(String(m));
        }
      }

      const cb_histogram = Array.from(cbCount.entries())
        .map(([cb, count]) => ({ cb, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);

      const seppeStudentIds = Array.from(seppeStudentIdsSet);
      const driftedStudents = seppeStudentIds.filter((sid) => !studentIdsSet.has(sid));

      // Same-day dupes: groepen met >1 entry. dupe_extra = som van (size-1).
      let dupe_groups = 0;
      let dupe_extra  = 0;
      const dupeSample = [];
      for (const [key, times] of alphaDupeMap.entries()) {
        if (times.length > 1) {
          dupe_groups += 1;
          dupe_extra  += (times.length - 1);
          if (dupeSample.length < 15) {
            const [member, day] = key.split('|');
            dupeSample.push({ member_user: member, day, times });
          }
        }
      }
      const seppe_alpha_same_day_dupes = {
        dupe_groups,
        dupe_extra,
        sample: dupeSample,
      };

      createdByProbe = {
        fetched,
        capped,
        month_total_all  : fetched,
        cb_histogram,
        seppe_match: {
          done_not_noshow: seppeDoneNotNs,
          noshow         : seppeNoShow,
          total          : seppeTotal,
        },
        seppe_by_learntype,
        seppe_alpha,
        seppe_alpha_same_day_dupes,
        seppe_students_count      : seppeStudentIds.length,
        drifted_students_count    : driftedStudents.length,
        drifted_students          : driftedStudents.slice(0, 50),
      };
    } catch (e) {
      console.warn('[mentor-coaching-debug] createdByProbe faalde:', e?.message || e);
      createdByProbe = { error: e?.message || String(e) };
    }

    return res.status(200).json({
      ok                    : true,
      mentor_user_id        : mentorUserId,
      seppeBubbleId,
      period_month          : period.monthStartIso,
      from                  : period.from,
      to                    : period.to,
      linked                : true,
      students_count        : studentIds.length,
      sessions_fetched      : sessionRows.length,
      sessionSampleKeys,
      oneOnOne_count        : oneOnOne,
      doneAndNoshow_in_range: doneAndNoshow,
      byLearnType,
      byDateField,
      total_done,
      total_done_not_noshow,
      total_noshow,
      counted,
      createdByProbe,
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
