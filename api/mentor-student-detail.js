// api/mentor-student-detail.js
//
// GET ?student_id=<bubble-id> → sessies + taken + progress voor één student.
// Dual-gate (zelfde patroon als mentor-my-students).
//
// OWNERSHIP-CHECK: bubbleGet('user', student_id) en valideer dat
// student.mentor === caller's bubble_user_id. Anders 403 (voorkomt dat
// een mentor andermans studenten kan inzien). Bij admin-pad geldt dat
// `caller's bubble_user_id` de bubble_user_id van de admin-target-mentor
// is — admin kan dus alleen meekijken naar studenten van die specifieke
// mentor, niet zomaar willekeurige bubble-IDs.
//
// Velden uit bubble:
//   - 1-1-session: member, isDone, NoShow, completed date, starting date,
//                  Agenda, stage.
//   - student-task: member, progress, due_date, end_date, Task Item, type_of_task.
//
// Progress: we kiezen pragmatisch het MAXIMUM van student-task.progress
// (over alle taken). Reden: progress kan per task-rij worden bijgehouden,
// en de "verste" task representeert de huidige fase het beste. Gemiddelde
// zou een student onevenredig laag scoren als 'ie meerdere oude taken op 0
// heeft staan. Documenteer dit zodat de UI weet dat 't een snapshot is.
//
// Response 200:
//   { ok, scope, student_id,
//     sessions: [{ date, is_done, no_show, agenda, stage }],
//     tasks: [{ id, progress, due_date, end_date, items: [...], type_of_task }],
//     progress: <0..100>|null }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleList, bubbleGet } from './_lib/bubble.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Bubble IDs zijn typisch 32+ chars met underscores/letters/cijfers;
// we accepteren defensief alfanumeriek met underscores/streepjes/punten.
const BUBBLE_ID_RE = /^[A-Za-z0-9_.\-x]{8,128}$/;

function asBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true','yes','ja','1'].includes(s)) return true;
    if (['false','no','nee','0'].includes(s)) return false;
  }
  return !!v;
}

function pickOption(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const d = v.display || v.text || v.value || null;
    return d ? String(d).trim() || null : null;
  }
  return null;
}

function pickTaskItems(v) {
  if (Array.isArray(v)) {
    return v.map((x) => (typeof x === 'string' ? x : (x?.display || x?.text || ''))).filter(Boolean);
  }
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
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

  const studentId = typeof req.query?.student_id === 'string' ? req.query.student_id.trim() : '';
  if (!studentId || !BUBBLE_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'student_id vereist' });
  }

  try {
    // Resolve mentor.bubble_user_id voor ownership-check.
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('bubble_user_id, is_active')
      .eq('user_id', effectiveUserId)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.bubble_user_id) {
      return res.status(403).json({ error: 'Mentor heeft geen bubble-koppeling' });
    }

    // OWNERSHIP-CHECK: haal de student-user op en valideer mentor-koppeling.
    const studentUser = await bubbleGet('user', studentId);
    if (!studentUser) return res.status(404).json({ error: 'Student niet gevonden' });
    const ownerMentor = String(studentUser.mentor || '').trim();
    if (!ownerMentor || ownerMentor !== tm.bubble_user_id) {
      return res.status(403).json({ error: 'Student valt niet onder jouw mentorschap' });
    }

    // Sessies + taken parallel ophalen.
    const [{ results: sessionRows }, { results: taskRows }] = await Promise.all([
      bubbleList('1-1-session', [{ key: 'member', constraint_type: 'equals', value: studentId }], { limit: 500 }),
      bubbleList('student-task', [{ key: 'member', constraint_type: 'equals', value: studentId }], { limit: 500 }),
    ]);

    const sessions = (sessionRows || []).map((s) => {
      const date = s['starting date'] || s['completed date'] || null;
      return {
        date,
        is_done : asBool(s.isDone),
        no_show : asBool(s.NoShow),
        agenda  : (typeof s.Agenda === 'string') ? s.Agenda : (s.Agenda?.display || null),
        stage   : pickOption(s.stage),
      };
    }).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

    const tasks = (taskRows || []).map((t) => ({
      id           : String(t._id || ''),
      progress     : Number.isFinite(Number(t.progress)) ? Number(t.progress) : 0,
      due_date     : t.due_date || null,
      end_date     : t.end_date || null,
      type_of_task : pickOption(t.type_of_task),
      items        : pickTaskItems(t['Task Item']),
    }));

    const progress = tasks.length
      ? Math.max(0, Math.min(100, tasks.reduce((m, t) => Math.max(m, t.progress || 0), 0)))
      : null;

    return res.status(200).json({
      ok: true,
      scope,
      student_id: studentId,
      sessions,
      tasks,
      progress,
    });
  } catch (e) {
    console.error('[mentor-student-detail]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
