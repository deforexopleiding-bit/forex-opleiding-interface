// api/mentor-assessment-save.js
//
// SELF — mentor legt maandelijkse assessment van een eigen student vast.
// period_month is altijd de HUIDIGE maand (server-side, UTC). UPSERT op
// (mentor_user_id, student_id, period_month).
//
// Permission (dual-gate, identiek aan mentor-my-students):
//   - body.mentor_user_id afwezig → self  (mentor.module.access, auth.uid).
//   - body.mentor_user_id aanwezig → admin (mentor.admin.view, die uuid).
//
// Body:
//   { student_id, student_name, status, score?, active_tasks_done?, note?,
//     mentor_user_id? }
//
// status moet ∈ ('op_schema','aandacht','risico','niet_actief').
// - Bij 'niet_actief' worden score + active_tasks_done geforceerd op null
//   (note blijft optioneel toegestaan).
// - Bij overige statussen: score 1..10 verplicht; active_tasks_done boolean.
//
// Veiligheid:
//   - Ownership via het LMS (sinds 9 okt 2026, was Bubble): hlms_student.mentor_id
//     moet het hlms_personeel-id van de (effectieve) mentor zijn. student_id is
//     de studentsleutel uit api/_lib/mentorStudents.js.
//
// Response 200: { ok, assessment }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { isStudentVanMentor } from './_lib/mentorStudents.js';

const STUDENT_ID_RE = /^[A-Za-z0-9_.\-x]{8,128}$/;
const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_STATUSES = new Set(['op_schema', 'aandacht', 'risico', 'niet_actief']);


function currentMonthStartUtc() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  // Dual-gate (identiek aan api/mentor-my-students.js):
  //   - body.mentor_user_id afwezig → self (mentor.module.access, auth.uid).
  //   - aanwezig → admin (mentor.admin.view, die id).
  // Zonder deze gate zou een super_admin die vanuit de v2-studenten-module
  // met __stMentorOverride wil opslaan altijd 403 krijgen op team_members-
  // lookup (geen LMS-koppeling op eigen admin-account).
  const requestedMentorId = typeof body.mentor_user_id === 'string'
    ? body.mentor_user_id.trim() : '';
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

  const studentId   = typeof body.student_id   === 'string' ? body.student_id.trim()   : '';
  const studentName = typeof body.student_name === 'string' ? body.student_name.trim() : '';
  const status      = typeof body.status       === 'string' ? body.status.trim()       : '';
  const noteRaw     = body.note;
  const note        = (noteRaw === null || noteRaw === undefined || noteRaw === '')
    ? null
    : (typeof noteRaw === 'string' ? noteRaw.trim() : null);

  if (!studentId || !STUDENT_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'student_id vereist' });
  }
  if (!studentName) return res.status(400).json({ error: 'student_name vereist' });
  if (!VALID_STATUSES.has(status)) {
    return res.status(400).json({ error: 'status ongeldig — moet op_schema/aandacht/risico/niet_actief zijn' });
  }

  let score             = null;
  let activeTasksDone   = null;
  if (status === 'niet_actief') {
    // Geforceerd null — note mag blijven.
    score = null;
    activeTasksDone = null;
  } else {
    const scoreNum = Number(body.score);
    if (!Number.isFinite(scoreNum) || !Number.isInteger(scoreNum) || scoreNum < 1 || scoreNum > 10) {
      return res.status(400).json({ error: 'score moet een geheel getal 1..10 zijn' });
    }
    score = scoreNum;
    activeTasksDone = !!body.active_tasks_done;
  }

  const periodMonth = currentMonthStartUtc();

  try {
    // Ownership in het LMS. Dual-gate: bij admin-scope op de EFFECTIEVE
    // mentor (target), niet de admin die de call doet.
    const eigen = await isStudentVanMentor(effectiveUserId, studentId);
    if (!eigen.ok) {
      const nietGevonden = /niet gevonden/.test(eigen.reden || '');
      return res.status(nietGevonden ? 404 : 403).json({ error: eigen.reden || 'Student valt niet onder jouw mentorschap' });
    }

    // UPSERT op (mentor_user_id, student_id, period_month) — eerst lookup zodat
    // we created_by op insert kunnen zetten en updated_at op update.
    const { data: existing, error: lookErr } = await supabaseAdmin
      .from('mentor_student_assessments')
      .select('id')
      .eq('mentor_user_id', effectiveUserId)
      .eq('student_id', studentId)
      .eq('period_month', periodMonth)
      .maybeSingle();
    if (lookErr) throw new Error('assessment lookup: ' + lookErr.message);

    const nowIso = new Date().toISOString();
    if (existing) {
      const { data: updated, error: updErr } = await supabaseAdmin
        .from('mentor_student_assessments')
        .update({
          student_name      : studentName,
          status,
          score,
          active_tasks_done : activeTasksDone,
          note,
          updated_at        : nowIso,
        })
        .eq('id', existing.id)
        .select('id, mentor_user_id, student_id, student_name, period_month, status, score, active_tasks_done, note, updated_at')
        .single();
      if (updErr) throw new Error('assessment update: ' + updErr.message);
      return res.status(200).json({ ok: true, assessment: updated });
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('mentor_student_assessments')
      .insert({
        mentor_user_id    : effectiveUserId,   // target-mentor bij admin-scope
        student_id        : studentId,
        student_name      : studentName,
        period_month      : periodMonth,
        status,
        score,
        active_tasks_done : activeTasksDone,
        note,
        created_by        : user.id,           // ALTIJD de admin/mentor die schrijft
        updated_at        : nowIso,
      })
      .select('id, mentor_user_id, student_id, student_name, period_month, status, score, active_tasks_done, note, updated_at')
      .single();
    if (insErr) throw new Error('assessment insert: ' + insErr.message);
    return res.status(200).json({ ok: true, assessment: inserted });
  } catch (e) {
    console.error('[mentor-assessment-save]', e?.message || e);
    if (e?.code === 'DFO_LMS_ONBEREIKBAAR') return res.status(503).json({ error: e.message });
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
