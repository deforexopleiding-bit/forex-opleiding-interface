// api/mentor-assessment-save.js
//
// SELF — mentor legt maandelijkse assessment van een eigen student vast.
// period_month is altijd de HUIDIGE maand (server-side, UTC). UPSERT op
// (mentor_user_id, student_id, period_month).
//
// Permission: mentor.module.access.
//
// Body:
//   { student_id, student_name, status, score?, active_tasks_done?, note? }
//
// status moet ∈ ('op_schema','aandacht','risico','niet_actief').
// - Bij 'niet_actief' worden score + active_tasks_done geforceerd op null
//   (note blijft optioneel toegestaan).
// - Bij overige statussen: score 1..10 verplicht; active_tasks_done boolean.
//
// Veiligheid:
//   - Ownership via bubble: studentUser.mentor_user_text === mentor.bubble_user_id
//     (met fallback 'mentor_user' / 'mentor' voor pre-conventie data).
//
// Response 200: { ok, assessment }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleGet } from './_lib/bubble.js';

const BUBBLE_ID_RE = /^[A-Za-z0-9_.\-x]{8,128}$/;
const VALID_STATUSES = new Set(['op_schema', 'aandacht', 'risico', 'niet_actief']);

function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) {
    if (u[k] !== undefined) return u[k];
  }
  return undefined;
}

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
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const studentId   = typeof body.student_id   === 'string' ? body.student_id.trim()   : '';
  const studentName = typeof body.student_name === 'string' ? body.student_name.trim() : '';
  const status      = typeof body.status       === 'string' ? body.status.trim()       : '';
  const noteRaw     = body.note;
  const note        = (noteRaw === null || noteRaw === undefined || noteRaw === '')
    ? null
    : (typeof noteRaw === 'string' ? noteRaw.trim() : null);

  if (!studentId || !BUBBLE_ID_RE.test(studentId)) {
    return res.status(400).json({ error: 'student_id (bubble-id) vereist' });
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
    // Mentor bubble_user_id resolven voor ownership-check.
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('bubble_user_id, is_active')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.bubble_user_id) {
      return res.status(403).json({ error: 'Mentor heeft geen bubble-koppeling' });
    }

    // Ownership: bubble student → mentor_user_text (met fallback) moet matchen.
    const studentUser = await bubbleGet('user', studentId);
    if (!studentUser) return res.status(404).json({ error: 'Student niet gevonden' });
    const ownerMentor = String(readFirst(studentUser, ['mentor_user_text', 'mentor_user', 'mentor']) || '').trim();
    if (!ownerMentor || ownerMentor !== tm.bubble_user_id) {
      return res.status(403).json({ error: 'Student valt niet onder jouw mentorschap' });
    }

    // UPSERT op (mentor_user_id, student_id, period_month) — eerst lookup zodat
    // we created_by op insert kunnen zetten en updated_at op update.
    const { data: existing, error: lookErr } = await supabaseAdmin
      .from('mentor_student_assessments')
      .select('id')
      .eq('mentor_user_id', user.id)
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
        mentor_user_id    : user.id,
        student_id        : studentId,
        student_name      : studentName,
        period_month      : periodMonth,
        status,
        score,
        active_tasks_done : activeTasksDone,
        note,
        created_by        : user.id,
        updated_at        : nowIso,
      })
      .select('id, mentor_user_id, student_id, student_name, period_month, status, score, active_tasks_done, note, updated_at')
      .single();
    if (insErr) throw new Error('assessment insert: ' + insErr.message);
    return res.status(200).json({ ok: true, assessment: inserted });
  } catch (e) {
    console.error('[mentor-assessment-save]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
