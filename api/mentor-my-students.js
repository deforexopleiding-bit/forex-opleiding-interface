// api/mentor-my-students.js
//
// GET → studenten van een mentor (read-only proxy op bubble.io).
// Dual-gate:
//   - ?mentor_user_id afwezig → self (mentor.module.access, auth.uid()).
//   - aanwezig → admin (mentor.admin.view, die id).
//
// Flow:
//   1. resolve mentor.bubble_user_id via team_members WHERE user_id = effective.
//      Bij NULL: respond { linked:false, students:[] } zodat de UI een nette
//      "nog niet gekoppeld"-state kan tonen.
//   2. bubbleList('user', [{key:'mentor', equals, bubble_user_id},
//                          {key:'role',   equals, 'student'}]).
//   3. Map per student naar { bubble_student_id, name, email, program,
//      membership, onboarding_status, calls_1on1_done/total, group_done/total,
//      no_shows }. Option-set-velden worden defensief gelezen (string of
//      object met .display).
//
// Response 200: { ok, scope:'self'|'admin', linked: bool, students: [...] }
// 401/403/405 zoals andere mentor-endpoints. 502/503 bij bubble-API problemen.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { bubbleList, bubbleUserDisplay } from './_lib/bubble.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Option-set-velden in Bubble komen soms als string, soms als
// `{ display: '...', text: '...' }`. Pak de leesbare vorm of null.
function pickOption(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'object') {
    const d = v.display || v.text || v.value || null;
    return d ? String(d).trim() || null : null;
  }
  return null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Programma → welk total-veld telt mee voor de 1-op-1-progress.
// Alpha gebruikt 1_call_alpha_total, Delta 1_call_delta_total. Gamma/onbekend
// → val terug op het hoogste van beide totalen (een student volgt er maar één).
function pickCallsTotal(program, u) {
  const a = num(u['1_call_alpha_total']);
  const d = num(u['1_call_delta_total']);
  const p = (program || '').toLowerCase();
  if (p.includes('alpha')) return a;
  if (p.includes('delta')) return d;
  return a || d || 0;
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

  try {
    // 1) Resolve bubble_user_id via team_members.
    const { data: tm, error: tmErr } = await supabaseAdmin
      .from('team_members')
      .select('id, bubble_user_id, is_active')
      .eq('user_id', effectiveUserId)
      .eq('is_active', true)
      .maybeSingle();
    if (tmErr) throw new Error('team_members lookup: ' + tmErr.message);
    if (!tm?.bubble_user_id) {
      return res.status(200).json({ ok: true, scope, linked: false, students: [] });
    }

    // 2) Bubble: alle 'user'-rijen met mentor=bubble_user_id + role=student.
    const constraints = [
      { key: 'mentor', constraint_type: 'equals', value: tm.bubble_user_id },
      { key: 'role',   constraint_type: 'equals', value: 'student' },
    ];
    const { results } = await bubbleList('user', constraints, { limit: 500 });

    // Tijdelijke debug-tak (?debug=1) — keys + caller-id + 1 student-sample.
    // GEEN namen/e-mails: alleen veld-keys, bubble-IDs (interne) en call-tellers.
    if (req.query?.debug === '1') {
      const firstRaw = (results && results[0]) || null;
      return res.status(200).json({
        debug: {
          caller_bubble_id : tm.bubble_user_id,
          count            : Array.isArray(results) ? results.length : 0,
          sampleKeys       : firstRaw ? Object.keys(firstRaw) : [],
          mentorField      : {
            value        : firstRaw ? (firstRaw.mentor ?? null) : null,
            type         : firstRaw ? typeof firstRaw.mentor : 'undefined',
            isArray      : firstRaw ? Array.isArray(firstRaw.mentor) : false,
            matchesCaller: firstRaw ? (String(firstRaw.mentor || '') === String(tm.bubble_user_id || '')) : false,
          },
          callProbe        : {
            '1_call_completed'  : firstRaw ? (firstRaw['1_call_completed']   ?? null) : null,
            '1_call_alpha_total': firstRaw ? (firstRaw['1_call_alpha_total'] ?? null) : null,
            '1_call_delta_total': firstRaw ? (firstRaw['1_call_delta_total'] ?? null) : null,
            'no show count'     : firstRaw ? (firstRaw['no show count']      ?? null) : null,
          },
        },
      });
    }

    // 3) Map → API-shape.
    const students = (results || []).map((u) => {
      const { name, email } = bubbleUserDisplay(u);
      const program          = pickOption(u['learning type']);
      const onboardingStatus = pickOption(u['Onboarding Status']);
      const membership       = pickOption(u.membership) || (typeof u.membership === 'string' ? u.membership : null);
      return {
        bubble_student_id : String(u._id || ''),
        name,
        email,
        program,
        membership,
        onboarding_status : onboardingStatus,
        calls_1on1_done   : num(u['1_call_completed']),
        calls_1on1_total  : pickCallsTotal(program, u),
        group_done        : num(u['group_call_completed']),
        group_total       : num(u['group_call_total']),
        no_shows          : num(u['no show count']),
      };
    }).filter((s) => s.bubble_student_id);

    students.sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));

    return res.status(200).json({ ok: true, scope, linked: true, students });
  } catch (e) {
    console.error('[mentor-my-students]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
