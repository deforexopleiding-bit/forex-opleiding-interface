// api/student-assessment-history.js
//
// GET → admin-only beoordelingshistorie voor één student over ALLE maanden
// en ALLE mentoren. Bron: mentor_student_assessments (1 rij per mentor ×
// student × maand). Verrijkt per rij mentor_name (team_members.name +
// profiles.full_name/email fallback, active row wint).
//
// Permission: students.all.view — alleen super_admin (via '*') + manager
// (via migratie 016) zien deze historie. 401 zonder sessie, 403 zonder gate.
//
// Query: ?student_id=<bubble_student_id>  (vereist; anders 400).
//
// Response 200:
//   { ok: true, student_id, history: [{
//       period_month, status, score, active_tasks_done, note,
//       mentor_user_id, mentor_name, updated_at
//   }] }
//
// Lege historie → history: []. Mentor-resolutie is fail-soft (geen match
// → mentor_name = null); de rij blijft leverbaar.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1. Auth.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // 2. Gate — alleen super_admin/manager zien dit.
  if (!(await requirePermission(req, 'students.all.view'))) {
    return res.status(403).json({ error: 'Geen rechten (students.all.view)' });
  }

  // 3. Validate input.
  const studentId = typeof req.query?.student_id === 'string' ? req.query.student_id.trim() : '';
  if (!studentId) return res.status(400).json({ error: 'student_id vereist' });

  try {
    // 4. Fetch alle assessments voor deze student (alle maanden, alle mentoren).
    //    period_month is YYYY-MM-01 (DATE). DESC = nieuwste maand bovenaan.
    //    Secundair sorteer op updated_at zodat — binnen dezelfde maand —
    //    de meest recente update bovenaan komt (bij meerdere mentoren).
    const { data: rows, error: rErr } = await supabaseAdmin
      .from('mentor_student_assessments')
      .select('period_month, status, score, active_tasks_done, note, mentor_user_id, updated_at')
      .eq('student_id', studentId)
      .order('period_month', { ascending: false })
      .order('updated_at',  { ascending: false })
      .limit(500);
    if (rErr) throw new Error('assessments fetch: ' + rErr.message);

    const list = Array.isArray(rows) ? rows : [];
    if (list.length === 0) {
      return res.status(200).json({ ok: true, student_id: studentId, history: [] });
    }

    // 5. Mentor-name resolutie (fail-soft per error-tak).
    const mentorIds = Array.from(new Set(list.map((r) => r.mentor_user_id).filter(Boolean)));
    const mentorNameById = new Map();
    if (mentorIds.length > 0) {
      try {
        const { data: tms } = await supabaseAdmin
          .from('team_members')
          .select('user_id, name, is_active')
          .in('user_id', mentorIds);
        const tmByUid = new Map();
        for (const tm of (tms || [])) {
          // Active row wint over inactive — consistent met mentor-admin-list.
          const prev = tmByUid.get(tm.user_id);
          if (!prev || (tm.is_active !== false && prev.is_active === false)) tmByUid.set(tm.user_id, tm);
        }
        const { data: profs } = await supabaseAdmin
          .from('profiles')
          .select('id, full_name, email')
          .in('id', mentorIds);
        const profById = new Map();
        for (const p of (profs || [])) profById.set(p.id, p);
        for (const uid of mentorIds) {
          const tm = tmByUid.get(uid);
          const pr = profById.get(uid);
          const name = tm?.name || pr?.full_name || pr?.email || null;
          if (name) mentorNameById.set(uid, name);
        }
      } catch (e) {
        console.warn('[student-assessment-history] mentor-resolve:', e?.message || e);
      }
    }

    const history = list.map((r) => ({
      period_month       : r.period_month,
      status             : r.status,
      score              : (r.score == null) ? null : Number(r.score),
      active_tasks_done  : (r.active_tasks_done == null) ? null : !!r.active_tasks_done,
      note               : r.note || null,
      mentor_user_id     : r.mentor_user_id || null,
      mentor_name        : r.mentor_user_id ? (mentorNameById.get(r.mentor_user_id) || null) : null,
      updated_at         : r.updated_at,
    }));

    return res.status(200).json({ ok: true, student_id: studentId, history });
  } catch (e) {
    console.error('[student-assessment-history]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
