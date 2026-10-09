// api/mentor-1on1-sessions.js
//
// GET → per-sessie 1-op-1 lijst voor de ingelogde mentor (SELF-scope):
//   - planned   : niet afgehandeld EN start_tijd >= nu   (oplopend)
//   - completed : status 'afgerond'                      (aflopend)
// Bedoeld voor het "1-op-1 sessies"-blok op de Studenten-pagina.
//
// BRON: het LMS (hlms_sessie). Sinds 9 okt 2026 niet meer uit Bubble.
// Mentor → hlms_personeel.id via e-mail (zie api/_lib/mentorStudents.js);
// sessies op hlms_sessie.mentor_id = dat id (wie de call deed).
//
// RBAC (fail-closed): mentor.module.access.
//
// Bedragen: per afgeronde sessie RATE_1ON1 uit api/_lib/coaching-earnings.js
// (alleen de constante; de echte verloning rekent coaching-earnings zelf).
//
// `member_user` en de sleutels van `noshow_by_student` zijn de studentsleutel
// (zie mentorStudents.js: oud id als die er is, anders hlms_student.id) —
// dezelfde waarde als `student_id` in /api/mentor-my-students.
//
// Response 200:
//   { planned:[...], completed:[...], rate, currency:'EUR',
//     counts:{planned,completed}, noshow_by_student, warning? }
// 503 als het LMS niet bereikbaar is.

import { createUserClient } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { RATE_1ON1 } from './_lib/coaching-earnings.js';
import {
  getMentorLmsKoppeling, getMentorStudents, vereisLms, httpStatusVoor,
} from './_lib/mentorStudents.js';

const FETCH_CAP = 3000;
// Voor de nummering moeten ALLE sessies van een student meekomen.
const LOOKBACK_FROM_ISO = '2024-01-01T00:00:00Z';
const NIET_GEPLAND = new Set(['afgerond', 'no_show', 'geannuleerd']);

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

  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const emptyResp = {
    planned:   [],
    completed: [],
    rate:      RATE_1ON1,
    currency:  'EUR',
    counts:    { planned: 0, completed: 0 },
    noshow_by_student: {},
  };

  try {
    const k = await getMentorLmsKoppeling(user.id);
    if (!k.linked) {
      return res.status(200).json({
        ...emptyResp,
        warning: 'Deze mentor is niet gekoppeld aan het LMS (' + k.reden + ').',
      });
    }

    // Student-map (hlms_student.id → { sleutel, name, calls_1on1_total }).
    const { students } = await getMentorStudents(user.id, { metTelling: false });
    const perLmsId = new Map();
    for (const s of students) {
      if (s.lms_student_id) perLmsId.set(s.lms_student_id, s);
    }

    const lms = vereisLms();
    const toIso = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await lms
      .from('hlms_sessie')
      .select('id, student_id, start_tijd, status')
      .eq('mentor_id', k.personeelId)
      .gte('start_tijd', LOOKBACK_FROM_ISO)
      .lte('start_tijd', toIso)
      .order('start_tijd', { ascending: true })
      .limit(FETCH_CAP);
    if (error) {
      const e = new Error('hlms_sessie lezen: ' + error.message);
      e.code = 'DFO_LMS_ONBEREIKBAAR';
      throw e;
    }

    const nowMs = Date.now();
    const qualified = [];
    const noshowByStudent = new Map();
    for (const r of data || []) {
      const iso = r.start_tijd ? new Date(r.start_tijd).toISOString() : null;
      if (!iso) continue;
      const startMs = new Date(iso).getTime();
      const meta = r.student_id ? perLmsId.get(String(r.student_id)) : null;
      const member = meta ? meta.student_id : (r.student_id ? String(r.student_id) : null);
      if (r.status === 'no_show' && member) {
        const prev = noshowByStudent.get(member);
        if (!prev || iso > prev) noshowByStudent.set(member, iso);
      }
      const done = r.status === 'afgerond';
      const planned = !NIET_GEPLAND.has(String(r.status || '')) && startMs >= nowMs;
      if (!done && !planned) continue;
      qualified.push({ id: r.id, starts_at: iso, startMs, done, member, meta });
    }

    // Nummering per student, oplopend op start_tijd.
    const sessionNumber = new Map();
    const byStudent = new Map();
    for (const q of qualified) {
      if (!q.member) continue;
      if (!byStudent.has(q.member)) byStudent.set(q.member, []);
      byStudent.get(q.member).push(q);
    }
    for (const list of byStudent.values()) {
      list.sort((a, b) => a.startMs - b.startMs);
      list.forEach((q, idx) => { sessionNumber.set(q.id, idx + 1); });
    }

    const planned = [];
    const completed = [];
    for (const q of qualified) {
      const base = {
        id:             q.id,
        starts_at:      q.starts_at,
        student_name:   q.meta?.name || '—',
        member_user:    q.member,
        session_number: q.member ? (sessionNumber.get(q.id) ?? null) : null,
        session_total:  q.meta && q.meta.calls_1on1_total ? q.meta.calls_1on1_total : null,
      };
      if (q.done) completed.push({ ...base, amount: RATE_1ON1 });
      else planned.push(base);
    }
    planned.sort((a, b)   => String(a.starts_at).localeCompare(String(b.starts_at)));
    completed.sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)));

    const noshow_by_student = {};
    for (const [key, v] of noshowByStudent.entries()) noshow_by_student[key] = v;

    return res.status(200).json({
      planned,
      completed,
      rate:     RATE_1ON1,
      currency: 'EUR',
      counts:   { planned: planned.length, completed: completed.length },
      noshow_by_student,
    });
  } catch (e) {
    console.error('[mentor-1on1-sessions]', e?.message || e);
    return res.status(httpStatusVoor(e)).json({ error: e?.message || 'Interne fout' });
  }
}
