// api/students-overview.js
//
// GET → ORG-BRED studenten-overzicht voor super_admin / manager.
// Read-only, verrijkt met mentor-info, onboarding_id, assessment-status
// (huidige maand) en aantal te late facturen.
//
// Permission: students.all.view (manager via migratie 016; super_admin
// bypasst via '*'). 403 zonder. 401 zonder sessie.
//
// Robuust: elk verrijkingsblok (mentor / onboarding_id / assessment / overdue)
// faalt-zacht. Een mislukte fetch betekent dat dat veld in de respons NULL
// of 0 is, niet dat het hele endpoint 5xx returnt.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { fetchAllBubbleStudents, mapBubbleStudentRow } from './_lib/mentorStudents.js';
import { bubbleUserDisplay } from './_lib/bubble.js';

const ILIKE_CHUNK = 100;

function escapeIlikePattern(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}
function isSafeForIlikeOr(email) {
  return typeof email === 'string' && email.length > 0
    && !email.includes(',') && !email.includes('(') && !email.includes(')');
}

function currentMonthStartUtc() {
  const n = new Date();
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1. Auth + gate.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'students.all.view'))) {
    return res.status(403).json({ error: 'Geen rechten (students.all.view)' });
  }

  try {
    // 2. Bubble: alle studenten org-breed via gedeelde helper. bubbleList
    //    paginiert intern tot cap=2000; voldoende voor onze schaal.
    const rawStudents = await fetchAllBubbleStudents();
    const students   = rawStudents.map(mapBubbleStudentRow)
      .filter((s) => s && s.bubble_student_id);

    if (students.length === 0) {
      return res.status(200).json({ students: [] });
    }

    // 3. Mentor-resolutie: alle team_members → map bubble_user_id → { user_id, name }.
    const mentorByBubble = new Map();
    try {
      const { data: tms } = await supabaseAdmin
        .from('team_members')
        .select('user_id, bubble_user_id, name, is_active')
        .eq('is_active', true)
        .not('bubble_user_id', 'is', null);
      for (const tm of (tms || [])) {
        if (tm && tm.bubble_user_id) {
          mentorByBubble.set(String(tm.bubble_user_id), {
            user_id: tm.user_id || null,
            name   : tm.name || null,
          });
        }
      }
    } catch (e) {
      console.warn('[students-overview] mentor-resolve faalde:', e?.message || e);
      // Lege map → mentor_name/mentor_user_id worden null op alle studenten.
    }

    // 4. onboarding_id-mapping: bubble_user_id → onboardings.id.
    //    A2 (her-toewijzen) heeft dit nodig; we leveren 'm al mee.
    const onboardingByBubble = new Map();
    try {
      const bubbleStudentIds = students.map((s) => s.bubble_student_id).filter(Boolean);
      // Chunked .in() voor het geval er > ~1000 ids zijn.
      const CHUNK = 500;
      for (let i = 0; i < bubbleStudentIds.length; i += CHUNK) {
        const slice = bubbleStudentIds.slice(i, i + CHUNK);
        const { data: rows } = await supabaseAdmin
          .from('onboardings')
          .select('id, bubble_user_id')
          .in('bubble_user_id', slice);
        for (const r of (rows || [])) {
          if (r && r.bubble_user_id && r.id) {
            // Eén onboarding per student: bij multiple wint de laatste (
            // geen voorgeschreven volgorde — A2 mag dit aanscherpen).
            onboardingByBubble.set(String(r.bubble_user_id), r.id);
          }
        }
      }
    } catch (e) {
      console.warn('[students-overview] onboarding-resolve faalde:', e?.message || e);
    }

    // 5. Beoordelingsstatus (huidige maand) — ALLE mentoren.
    const periodMonth = currentMonthStartUtc();
    const assessmentByStudent = new Map(); // bubble_student_id → status
    try {
      const { data: rows } = await supabaseAdmin
        .from('mentor_student_assessments')
        .select('student_id, status, updated_at')
        .eq('period_month', periodMonth)
        .order('updated_at', { ascending: false });
      // Eén status per student; eerste hit (= meest recent door order) wint.
      for (const r of (rows || [])) {
        if (r && r.student_id && !assessmentByStudent.has(String(r.student_id))) {
          assessmentByStudent.set(String(r.student_id), r.status || null);
        }
      }
    } catch (e) {
      console.warn('[students-overview] assessments-resolve faalde:', e?.message || e);
    }

    // 6. Te late facturen per email, org-breed.
    //    Zelfde overdue-definitie als mentor-students-invoice-status:
    //    status='open' & due_date<vandaag & credited<amount_total.
    const overdueByEmail = new Map();
    try {
      const emails = Array.from(new Set(
        students.map((s) => (s.email ? String(s.email).trim().toLowerCase() : ''))
                .filter(Boolean)
      ));
      const safeEmails = emails.filter(isSafeForIlikeOr);

      // Email → Set<customer_id>
      const emailToCustomerIds = new Map();
      for (let i = 0; i < safeEmails.length; i += ILIKE_CHUNK) {
        const slice = safeEmails.slice(i, i + ILIKE_CHUNK);
        const filter = slice.map((e) => `email.ilike.${escapeIlikePattern(e)}`).join(',');
        const { data: rows } = await supabaseAdmin
          .from('customers')
          .select('id, email')
          .or(filter);
        for (const r of (rows || [])) {
          if (!r || !r.id || !r.email) continue;
          const eLc = String(r.email).trim().toLowerCase();
          if (!eLc) continue;
          let s = emailToCustomerIds.get(eLc);
          if (!s) { s = new Set(); emailToCustomerIds.set(eLc, s); }
          s.add(r.id);
        }
      }
      if (emailToCustomerIds.size > 0) {
        const customerIdToEmail = new Map();
        for (const [eLc, ids] of emailToCustomerIds.entries()) {
          for (const cid of ids) customerIdToEmail.set(cid, eLc);
        }
        const today = new Date().toISOString().slice(0, 10);
        const allCustomerIds = Array.from(customerIdToEmail.keys());
        // Chunked invoices-fetch voor het geval het ID-aantal groot is.
        const ICHUNK = 500;
        for (let i = 0; i < allCustomerIds.length; i += ICHUNK) {
          const slice = allCustomerIds.slice(i, i + ICHUNK);
          const { data: invoices } = await supabaseAdmin
            .from('invoices')
            .select('customer_id, status, due_date, amount_total, credited_amount')
            .in('customer_id', slice)
            .eq('status', 'open')
            .lt('due_date', today);
          for (const inv of (invoices || [])) {
            const credited = Number(inv.credited_amount) || 0;
            const total    = Number(inv.amount_total)    || 0;
            if (total <= 0) continue;
            if (credited >= total) continue;
            const cid = inv.customer_id;
            if (!cid) continue;
            const eLc = customerIdToEmail.get(cid);
            if (!eLc) continue;
            overdueByEmail.set(eLc, (overdueByEmail.get(eLc) || 0) + 1);
          }
        }
      }
    } catch (e) {
      console.warn('[students-overview] overdue-resolve faalde:', e?.message || e);
    }

    // 7. Per student verrijken + filter nul-overdue niet weg (overview wil
    //    expliciet 0 weergeven zodat de filter 'heeft te late facturen'
    //    sluitend is).
    const out = students.map((s) => {
      const mentor   = s.mentor_bubble_user_id ? mentorByBubble.get(String(s.mentor_bubble_user_id)) : null;
      const onbId    = s.bubble_student_id ? (onboardingByBubble.get(String(s.bubble_student_id)) || null) : null;
      const assess   = assessmentByStudent.get(String(s.bubble_student_id)) || 'open';
      const emailLc  = s.email ? String(s.email).trim().toLowerCase() : '';
      const overdue  = emailLc ? (overdueByEmail.get(emailLc) || 0) : 0;
      return {
        bubble_student_id  : s.bubble_student_id,
        name               : s.name,
        email              : s.email,
        program            : s.program,
        membership         : s.membership,
        onboarding_status  : s.onboarding_status,
        mentor_name        : mentor?.name || null,
        mentor_user_id     : mentor?.user_id || null,
        onboarding_id      : onbId,
        calls_1on1_done    : s.calls_1on1_done,
        calls_1on1_total   : s.calls_1on1_total,
        no_shows           : s.no_shows,
        assessment_status  : assess,
        overdue_count      : overdue,
      };
    });

    return res.status(200).json({ students: out });
  } catch (e) {
    console.error('[students-overview]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
