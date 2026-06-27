// api/student-signals-create.js
//
// POST → mentor meldt een aandachtspunt voor één van zijn eigen studenten.
//
// Permission: mentor.module.access (mentor heeft die). 403 zonder.
// Auth: createUserClient(req).auth.getUser() → user.id. 401 zonder.
//
// SECURITY / ownership:
//   - Eigen studenten via getMentorStudents(user.id) — getMentorBubbleId +
//     fetchBubbleStudents → bubble_student_id moet bij de mentor horen,
//     anders 403. Geen ?email / ?name / mentor_user_id client-input
//     wordt vertrouwd.
//   - student_name + student_email (lowercased) komen UIT die resolutie,
//     niet van de client. Body alleen: bubble_student_id, type, toelichting.
//
// Body : { bubble_student_id (text), type ('eerste_call' | 'reageert_niet'
//          | 'niet_bereikbaar' | 'geen_reactie_bellen' | 'anders'),
//          toelichting? (text) }
// Insert: status='open', mentor_user_id=user.id.
// Response 201: { ok: true, id }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getMentorStudents } from './_lib/mentorStudents.js';

const TYPES = new Set([
  'eerste_call', 'reageert_niet', 'niet_bereikbaar',
  'geen_reactie_bellen', 'anders',
]);
const MAX_TOELICHTING = 2000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'mentor.module.access'))) {
    return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const bubbleStudentId = typeof body.bubble_student_id === 'string' ? body.bubble_student_id.trim() : '';
  if (!bubbleStudentId) return res.status(400).json({ error: 'bubble_student_id vereist' });

  const type = typeof body.type === 'string' ? body.type.trim() : '';
  if (!TYPES.has(type)) return res.status(400).json({ error: 'type ongeldig' });

  let toelichting = null;
  if (body.toelichting != null) {
    const t = String(body.toelichting).trim();
    if (t.length > MAX_TOELICHTING) {
      return res.status(400).json({ error: `toelichting max ${MAX_TOELICHTING} tekens` });
    }
    toelichting = t || null;
  }

  try {
    // Ownership-check via gedeelde Bubble-resolutie.
    const { linked, students } = await getMentorStudents(user.id);
    if (!linked) {
      return res.status(403).json({ error: 'Mentor heeft geen Bubble-koppeling' });
    }
    const owned = students.find((s) => s && s.bubble_student_id === bubbleStudentId);
    if (!owned) {
      return res.status(403).json({ error: 'Student hoort niet bij deze mentor' });
    }

    // student_name + student_email SERVER-SIDE uit Bubble-row, niet client.
    const studentName  = (owned.name  || '').trim() || null;
    const studentEmail = owned.email ? String(owned.email).trim().toLowerCase() : null;

    const { data, error } = await supabaseAdmin
      .from('student_signals')
      .insert({
        bubble_student_id : bubbleStudentId,
        student_name      : studentName,
        student_email     : studentEmail,
        type              : type,
        toelichting       : toelichting,
        mentor_user_id    : user.id,
        status            : 'open',
      })
      .select('id')
      .single();
    if (error) throw new Error('insert: ' + error.message);

    return res.status(201).json({ ok: true, id: data.id });
  } catch (e) {
    console.error('[student-signals-create]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
