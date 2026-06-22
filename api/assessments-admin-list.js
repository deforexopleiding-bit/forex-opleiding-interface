// api/assessments-admin-list.js
//
// ADMIN — overzicht van student-assessments over alle mentors heen.
//
// Permission: mentor.assessments.admin.
//
// Query (alle optioneel; geen filter = alles):
//   ?mentor_user_id=<uuid>
//   ?month=YYYY-MM
//   ?student_id=<bubble-id>
//
// Response 200:
//   { ok, rows: [ {
//       mentor_user_id, mentor_name,
//       student_id, student_name,
//       period_month, status, score, active_tasks_done, note, updated_at
//   } ] }  // sort: period_month desc, mentor_name asc, student_name asc

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUBBLE_ID_RE = /^[A-Za-z0-9_.\-x]{8,128}$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

function normalizeMonthStart(s) {
  const m = MONTH_RE.exec(String(s || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isInteger(y) || y < 2020 || y > 2100) return null;
  if (!Number.isInteger(mo) || mo < 1 || mo > 12)  return null;
  return `${y}-${String(mo).padStart(2, '0')}-01`;
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
  if (!(await requirePermission(req, 'mentor.assessments.admin'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.assessments.admin)' });
  }

  const filterMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  if (filterMentorId && !UUID_RE.test(filterMentorId)) {
    return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
  }

  let filterMonth = '';
  if (typeof req.query?.month === 'string' && req.query.month.trim()) {
    filterMonth = normalizeMonthStart(req.query.month);
    if (!filterMonth) return res.status(400).json({ error: 'month moet YYYY-MM zijn' });
  }

  const filterStudent = typeof req.query?.student_id === 'string'
    ? req.query.student_id.trim() : '';
  if (filterStudent && !BUBBLE_ID_RE.test(filterStudent)) {
    return res.status(400).json({ error: 'student_id (bubble-id) ongeldig' });
  }

  try {
    let q = supabaseAdmin
      .from('mentor_student_assessments')
      .select('mentor_user_id, student_id, student_name, period_month, status, score, active_tasks_done, note, updated_at')
      .order('period_month', { ascending: false })
      .limit(1000);
    if (filterMentorId) q = q.eq('mentor_user_id', filterMentorId);
    if (filterMonth)    q = q.eq('period_month',  filterMonth);
    if (filterStudent)  q = q.eq('student_id',    filterStudent);
    const { data: rows, error: rowErr } = await q;
    if (rowErr) throw new Error('assessments fetch: ' + rowErr.message);

    const list = rows || [];

    // Mentor-naam per uniek mentor_user_id ophalen — zelfde pattern als
    // mentor-payouts-admin-list / funded-certs-admin-list.
    const mentorIds = Array.from(new Set(list.map((r) => r.mentor_user_id).filter(Boolean)));
    const nameMap = new Map();
    if (mentorIds.length > 0) {
      const { data: tmRows, error: tmErr } = await supabaseAdmin
        .from('team_members')
        .select('user_id, name')
        .in('user_id', mentorIds);
      if (tmErr) throw new Error('team_members fetch: ' + tmErr.message);
      for (const r of (tmRows || [])) {
        if (r.user_id && r.name) nameMap.set(r.user_id, r.name);
      }
    }

    const out = list.map((r) => ({
      mentor_user_id    : r.mentor_user_id,
      mentor_name       : nameMap.get(r.mentor_user_id) || null,
      student_id        : r.student_id,
      student_name      : r.student_name || null,
      period_month      : r.period_month,
      status            : r.status,
      score             : (r.score == null) ? null : Number(r.score),
      active_tasks_done : (r.active_tasks_done == null) ? null : !!r.active_tasks_done,
      note              : r.note || null,
      updated_at        : r.updated_at,
    }));

    // Aanvullende JS-sort op mentor_name + student_name binnen dezelfde
    // period_month (DB-order is al period_month desc).
    out.sort((a, b) => {
      const md = String(b.period_month || '').localeCompare(String(a.period_month || ''));
      if (md !== 0) return md;
      const am = (a.mentor_name || '').toLowerCase();
      const bm = (b.mentor_name || '').toLowerCase();
      if (am !== bm) return am.localeCompare(bm, 'nl');
      return (a.student_name || '').toLowerCase().localeCompare((b.student_name || '').toLowerCase(), 'nl');
    });

    return res.status(200).json({ ok: true, rows: out });
  } catch (e) {
    console.error('[assessments-admin-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
