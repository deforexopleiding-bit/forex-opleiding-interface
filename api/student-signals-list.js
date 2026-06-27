// api/student-signals-list.js
//
// GET → lijst student_signals, dual-mode:
//   - students.all.view  → ADMIN: alle signals, verrijkt met mentor_name
//                          + phone (CI email-match op customers, fail-soft).
//   - mentor.module.access → MENTOR: alleen eigen (mentor_user_id=user.id),
//                            zonder verrijking.
//   - Geen van beide → 403.
//
// Query:
//   ?status= (text)  default actief = 'open,opnieuw_opvolgen'.
//                    'all' = geen filter; anders comma-separated lijst.
//
// Response 200: { signals: [...] } — nieuwste eerst.
// Per signal: id, bubble_student_id, student_name, student_email, phone?,
//             type, toelichting, mentor_user_id, mentor_name?, status,
//             uitkomst_type, uitkomst, handled_at, created_at.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const STATUSES = new Set(['open', 'opnieuw_opvolgen', 'afgehandeld']);
const ILIKE_CHUNK = 100;

function escapeIlikePattern(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}
function isSafeForIlikeOr(s) {
  return typeof s === 'string' && s.length > 0
    && !s.includes(',') && !s.includes('(') && !s.includes(')');
}

function parseStatusFilter(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return ['open', 'opnieuw_opvolgen'];
  }
  const v = raw.trim().toLowerCase();
  if (v === 'all') return null; // geen filter
  const parts = v.split(',').map((p) => p.trim()).filter(Boolean).filter((p) => STATUSES.has(p));
  return parts.length > 0 ? parts : ['open', 'opnieuw_opvolgen'];
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
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // Dual-mode resolve. Admin wint als beide gates positief zijn — geeft
  // meer info en is een super-set van het mentor-resultaat.
  const isAdmin   = await requirePermission(req, 'students.all.view');
  const isMentor  = !isAdmin && await requirePermission(req, 'mentor.module.access');
  if (!isAdmin && !isMentor) {
    return res.status(403).json({ error: 'Geen rechten (students.all.view of mentor.module.access)' });
  }

  const statusFilter = parseStatusFilter(req.query?.status);

  try {
    let query = supabaseAdmin
      .from('student_signals')
      .select('id, bubble_student_id, student_name, student_email, type, source, toelichting, mentor_user_id, status, uitkomst_type, uitkomst, handled_at, reason_given_at, created_at')
      .order('created_at', { ascending: false })
      .limit(1000);
    if (statusFilter) query = query.in('status', statusFilter);
    if (!isAdmin)     query = query.eq('mentor_user_id', user.id); // mentor: hard self-filter

    const { data: signals, error } = await query;
    if (error) throw new Error('signals fetch: ' + error.message);
    const rows = Array.isArray(signals) ? signals : [];

    if (rows.length === 0) return res.status(200).json({ signals: [] });

    // Mentor-modus: geen verrijking, return rauw.
    if (!isAdmin) {
      return res.status(200).json({
        signals: rows.map((r) => ({ ...r, phone: null, mentor_name: null })),
      });
    }

    // Admin-modus: mentor_name + phone (fail-soft).
    // 1) mentor_name via team_members + profiles (zelfde pattern als
    //    mentor-admin-list).
    const mentorIds = Array.from(new Set(rows.map((r) => r.mentor_user_id).filter(Boolean)));
    const mentorNameById = new Map();
    if (mentorIds.length > 0) {
      try {
        const { data: tms } = await supabaseAdmin
          .from('team_members')
          .select('user_id, name, is_active')
          .in('user_id', mentorIds);
        const tmByUid = new Map();
        for (const tm of (tms || [])) {
          // Actieve rij wint over inactieve.
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
        console.warn('[student-signals-list] mentor-resolve:', e?.message || e);
      }
    }

    // 2) Phone via email → customers.phone (CI, fail-soft).
    const emails = Array.from(new Set(
      rows.map((r) => (r.student_email ? String(r.student_email).trim().toLowerCase() : ''))
          .filter(Boolean)
          .filter(isSafeForIlikeOr)
    ));
    const phoneByEmail = new Map();
    if (emails.length > 0) {
      try {
        for (let i = 0; i < emails.length; i += ILIKE_CHUNK) {
          const slice = emails.slice(i, i + ILIKE_CHUNK);
          const filter = slice.map((e) => `email.ilike.${escapeIlikePattern(e)}`).join(',');
          const { data: custs } = await supabaseAdmin
            .from('customers')
            .select('email, phone')
            .or(filter);
          for (const c of (custs || [])) {
            if (!c || !c.email) continue;
            const eLc = String(c.email).trim().toLowerCase();
            if (!eLc) continue;
            const phone = (c.phone && String(c.phone).trim()) || null;
            if (phone && !phoneByEmail.has(eLc)) phoneByEmail.set(eLc, phone);
          }
        }
      } catch (e) {
        console.warn('[student-signals-list] phone-resolve:', e?.message || e);
      }
    }

    const out = rows.map((r) => ({
      ...r,
      mentor_name : r.mentor_user_id ? (mentorNameById.get(r.mentor_user_id) || null) : null,
      phone       : r.student_email
        ? (phoneByEmail.get(String(r.student_email).trim().toLowerCase()) || null)
        : null,
    }));

    return res.status(200).json({ signals: out });
  } catch (e) {
    console.error('[student-signals-list]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
