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

// Lees eerste niet-undefined uit een lijst van kandidaat-keys. Gebruikt voor
// Bubble's suffix-conventie (key_text / key_number / key_option_os___name)
// met bare-name als fallback voor pre-conventie data.
function readFirst(u, keys) {
  if (!u) return undefined;
  for (const k of keys) {
    if (u[k] !== undefined) return u[k];
  }
  return undefined;
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

    // 2) Bubble: alle 'user'-rijen met mentor_user=bubble_user_id + role=student.
    //    Suffix-conventie: 'mentor_user' (User-link) + 'role_option_os___roles'
    //    (option-set 'roles'). De waarde voor option-set role-constraint is de
    //    leesbare optie 'student'.
    const constraints = [
      { key: 'mentor_user',              constraint_type: 'equals', value: tm.bubble_user_id },
      { key: 'role_option_os___roles',   constraint_type: 'equals', value: 'student' },
    ];
    const { results } = await bubbleList('user', constraints, { limit: 500 });

    // 3) Map → API-shape (suffix-keys met bare-name fallback).
    const students = (results || []).map((u) => {
      const { name, email } = bubbleUserDisplay(u);
      const program          = pickOption(readFirst(u, ['learning_type_option_os___learning_type', 'learning type']));
      const onboardingStatus = pickOption(readFirst(u, ['onboarding_status_option_os___onboarding_status', 'Onboarding Status']));
      const membership       = pickOption(readFirst(u, ['membership_option_os___membership', 'membership']));
      const callsDone   = num(readFirst(u, ['1_call_completed_number',   '1_call_completed']));
      const callsTotal  = num(readFirst(u, ['1_call_alpha_total_number', '1_call_total_number', '1_call_delta_total_number', '1_call_alpha_total']));
      const groupDone   = num(readFirst(u, ['group_call_completed_number', 'group_call_completed']));
      const groupTotal  = num(readFirst(u, ['group_call_total_number',     'group_call_total']));
      const noShows     = num(readFirst(u, ['no_show_count_number',       'no show count']));
      return {
        bubble_student_id : String(u._id || ''),
        name,
        email,
        program,
        membership,
        onboarding_status : onboardingStatus,
        calls_1on1_done   : callsDone,
        calls_1on1_total  : callsTotal,
        group_done        : groupDone,
        group_total       : groupTotal,
        no_shows          : noShows,
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
