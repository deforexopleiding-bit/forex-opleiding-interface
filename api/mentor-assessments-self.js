// api/mentor-assessments-self.js
//
// SELF — lijst assessments van de ingelogde mentor voor een maand.
//
// Permission: mentor.module.access.
//
// Query:
//   ?month=YYYY-MM  (optioneel; default = huidige maand UTC)
//
// Response 200:
//   { ok, period_month,
//     assessments: [ { student_id, student_name, status, score,
//                      active_tasks_done, note, updated_at } ] }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const MONTH_RE = /^(\d{4})-(\d{2})$/;

function currentMonthStartUtc() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  let periodMonth = currentMonthStartUtc();
  if (typeof req.query?.month === 'string' && req.query.month.trim()) {
    const m = normalizeMonthStart(req.query.month);
    if (!m) return res.status(400).json({ error: 'month moet YYYY-MM zijn' });
    periodMonth = m;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('mentor_student_assessments')
      .select('student_id, student_name, status, score, active_tasks_done, note, updated_at')
      .eq('mentor_user_id', user.id)
      .eq('period_month', periodMonth)
      .order('updated_at', { ascending: false })
      .limit(500);
    if (error) throw new Error('assessments fetch: ' + error.message);

    return res.status(200).json({
      ok           : true,
      period_month : periodMonth,
      assessments  : (data || []).map((r) => ({
        student_id        : r.student_id,
        student_name      : r.student_name || null,
        status            : r.status,
        score             : (r.score == null) ? null : Number(r.score),
        active_tasks_done : (r.active_tasks_done == null) ? null : !!r.active_tasks_done,
        note              : r.note || null,
        updated_at        : r.updated_at,
      })),
    });
  } catch (e) {
    console.error('[mentor-assessments-self]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
