// api/mentor-student-detail.js
//
// GET ?student_id=<studentsleutel> → sessies + taken + voortgang voor één
// student. Dual-gate (zelfde patroon als mentor-my-students).
//
// BRON: het LMS (sinds 9 okt 2026, was Bubble).
//   - OWNERSHIP-CHECK: hlms_student.mentor_id moet het hlms_personeel-id van
//     de (effectieve) mentor zijn — isStudentVanMentor in
//     api/_lib/mentorStudents.js. Anders 403. Bij het admin-pad is dat de
//     target-mentor: een admin kijkt mee naar die mentor zijn studenten.
//   - sessies: hlms_sessie van deze student (nieuwste eerst, max 50).
//   - taken:   hlms_sessie_taak van die sessies.
//   - voortgang: gebruikte sessies / trajecttotaal (zoals de LMS-teller).
//
// Response 200:
//   { ok, scope, student_id,
//     sessions: [{ date, is_done, no_show, agenda, stage, status }],
//     tasks: [{ id, progress, due_date, end_date, items: [...], type_of_task }],
//     progress: <0..100>|null,
//     contact: { email, phone } }
//
// contact: e-mail + telefoon uit het LMS; ontbreekt de telefoon daar, dan
// zoeken we de klant op e-mail (case-insensitief) in customers. Fail-soft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import {
  isStudentVanMentor, vereisLms, telSessiesPerStudent, mapLmsStudentRow, httpStatusVoor,
} from './_lib/mentorStudents.js';

// Ilike-safe helpers (spiegel van mentor-students-invoice-status.js): PostgREST
// .or() interpreteert ',' en ')' als delimiters; die zitten niet in geldige
// e-mails maar defensief filteren we ze weg. LIKE-wildcards % en _ escapen
// naar een letterlijke gelijkheid (voorkomt patroon-matching false positives).
function isSafeForIlikeOr(email) {
  return typeof email === 'string' && email.length > 0
    && !email.includes(',') && !email.includes('(') && !email.includes(')');
}
function escapeIlikePattern(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Studentsleutel: oud id (cijfers + 'x') of een LMS-uuid.
const STUDENT_ID_RE = /^[A-Za-z0-9_.\-x]{8,128}$/;

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

  const studentId = typeof req.query?.student_id === 'string' ? req.query.student_id.trim() : '';
  if (!studentId || !STUDENT_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'student_id vereist' });
  }

  try {
    const eigen = await isStudentVanMentor(effectiveUserId, studentId);
    if (!eigen.ok) {
      const nietGevonden = /niet gevonden/.test(eigen.reden || '');
      return res.status(nietGevonden ? 404 : 403).json({ error: eigen.reden || 'Student valt niet onder jouw mentorschap' });
    }
    const lmsId = eigen.student.lms_student_id;
    const lms = vereisLms();

    const { data: sesRows, error: sErr } = await lms
      .from('hlms_sessie')
      .select('id, start_tijd, status, agenda')
      .eq('student_id', lmsId)
      .order('start_tijd', { ascending: false })
      .limit(50);
    if (sErr) {
      const e = new Error('hlms_sessie lezen: ' + sErr.message);
      e.code = 'DFO_LMS_ONBEREIKBAAR';
      throw e;
    }
    const sessions = (sesRows || []).map((r) => ({
      date:    r.start_tijd || null,
      is_done: r.status === 'afgerond',
      no_show: r.status === 'no_show',
      agenda:  r.agenda || null,
      stage:   null,
      status:  r.status || null,
    }));

    // Taken van die sessies. Fail-soft: zonder taken blijft de rest staan.
    let tasks = [];
    const sesIds = (sesRows || []).map((r) => r.id).filter(Boolean);
    if (sesIds.length > 0) {
      const { data: taakRows, error: tErr } = await lms
        .from('hlms_sessie_taak')
        .select('id, titel, omschrijving, afgevinkt, afgevinkt_op, aangemaakt_op')
        .in('sessie_id', sesIds)
        .order('aangemaakt_op', { ascending: false })
        .limit(100);
      if (tErr) {
        console.warn('[mentor-student-detail] hlms_sessie_taak:', tErr.message);
      } else {
        tasks = (taakRows || []).map((t) => ({
          id:           t.id,
          progress:     t.afgevinkt ? 100 : 0,
          due_date:     null,
          end_date:     t.afgevinkt_op || null,
          items:        t.omschrijving ? [String(t.omschrijving)] : [],
          type_of_task: t.titel || 'Taak',
        }));
      }
    }

    // Voortgang = gebruikte sessies / trajecttotaal.
    let progress = null;
    {
      const { data: stu } = await lms
        .from('hlms_student')
        .select('id, calls_gedaan, calls_startsaldo, calls_totaal, email, telefoon')
        .eq('id', lmsId)
        .maybeSingle();
      if (stu) {
        const telling = await telSessiesPerStudent([lmsId]);
        const v = mapLmsStudentRow(stu, telling ? (telling.get(String(lmsId)) || { afgerond: 0, noShow: 0 }) : null);
        if (v.calls_1on1_total > 0) {
          progress = Math.max(0, Math.min(100, Math.round((v.calls_1on1_done / v.calls_1on1_total) * 100)));
        }
      }
    }

    // ── Contact (fail-soft) ────────────────────────────────────────────────
    const emailLc = eigen.student.email || null;
    let contact = { email: emailLc, phone: eigen.student.telefoon || null };
    if (!contact.phone && emailLc && isSafeForIlikeOr(emailLc)) {
      try {
        const { data: custRows, error: cErr } = await supabaseAdmin
          .from('customers')
          .select('email, phone')
          .ilike('email', escapeIlikePattern(emailLc))
          .limit(1);
        if (cErr) {
          console.warn('[mentor-student-detail] customers lookup:', cErr.message);
        } else if (custRows && custRows.length > 0) {
          const c = custRows[0];
          contact = {
            email: (c.email && String(c.email).trim()) || emailLc,
            phone: (c.phone && String(c.phone).trim()) || null,
          };
        }
      } catch (e) {
        console.warn('[mentor-student-detail] customers lookup catch:', e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      scope,
      student_id: studentId,
      sessions,
      tasks,
      progress,
      contact,
    });
  } catch (e) {
    console.error('[mentor-student-detail]', e?.message || e);
    return res.status(httpStatusVoor(e)).json({ error: e?.message || 'Interne fout' });
  }
}
