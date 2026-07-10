// api/mentor-student-overdue-invoices.js
//
// GET ?email=<student-email>[&mentor_user_id=<uuid>]
//   → detail-lijst van TE LATE facturen van díe student.
//
// SCOPE-GUARD (essentieel voor privacy):
//   De opgevraagde student-email MOET voorkomen in de eigen-studenten-set
//   van de ingelogde mentor (of van de mentor_user_id die admin-gemachtigd
//   opvraagt). Anders → 403. Nooit vertrouwen op de client-parameter zonder
//   check.
//
// OVERDUE-DEFINITIE (identiek aan mentor-students-invoice-status.js /
// finance-invoices deriveDisplayStatus):
//   status='open' AND due_date < vandaag AND credited_amount < amount_total.
//
// Response:
//   {
//     items: [{
//       invoice_id, invoice_number, invoice_date (issue_date),
//       amount_total, amount_open, due_date, status
//     }],
//     kpi: { count, sum_open }
//   }
//   items[] altijd array. Lege set → { items: [], kpi: { count: 0, sum_open: 0 } }.
//
// Read-only. Geen writes.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getMentorStudentEmails } from './_lib/mentorStudents.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Zelfde defensieve helpers als mentor-students-invoice-status.js.
function isSafeForIlikeOr(email) {
  return typeof email === 'string' && email.length > 0
    && !email.includes(',') && !email.includes('(') && !email.includes(')');
}
function escapeIlikePattern(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1) Auth.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) return res.status(401).json({ error: 'Niet geauthenticeerd' });

  // 2) Dual-gate (self / admin-view).
  const requestedMentorId = typeof req.query?.mentor_user_id === 'string' ? req.query.mentor_user_id.trim() : '';
  let effectiveUserId;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    if (!(await requirePermission(req, 'mentor.admin.view'))) return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    effectiveUserId = requestedMentorId;
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    effectiveUserId = user.id;
  }

  // 3) Student-email param + normalisatie.
  const rawEmail = typeof req.query?.email === 'string' ? req.query.email.trim() : '';
  if (!rawEmail) return res.status(400).json({ error: 'email vereist' });
  const emailLc = rawEmail.toLowerCase();

  try {
    // 4) Eigen studenten ophalen.
    const { linked, emails } = await getMentorStudentEmails(effectiveUserId);
    if (!linked) return res.status(403).json({ error: 'Mentor-koppeling ontbreekt' });
    const studentEmails = new Set((emails || []).map((e) => String(e).trim().toLowerCase()));

    // 5) SCOPE-GUARD: opgevraagde email MOET in de eigen-studenten-set zitten.
    if (!studentEmails.has(emailLc)) {
      return res.status(403).json({ error: 'Geen toegang tot deze student' });
    }
    if (!isSafeForIlikeOr(emailLc)) {
      return res.status(200).json({ items: [], kpi: { count: 0, sum_open: 0 } });
    }

    // 6) Customer-ids voor deze email (case-insensitief).
    const { data: custRows, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, email')
      .or(`email.ilike.${escapeIlikePattern(emailLc)}`);
    if (cErr) throw new Error('customers fetch: ' + cErr.message);
    const customerIds = (custRows || []).map((c) => c.id).filter(Boolean);
    if (customerIds.length === 0) {
      return res.status(200).json({ items: [], kpi: { count: 0, sum_open: 0 } });
    }

    // 7) Facturen ophalen met dezelfde overdue-definitie.
    const today = new Date().toISOString().slice(0, 10);
    const { data: invRows, error: iErr } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, issue_date, due_date, amount_total, amount_paid, credited_amount, status')
      .in('customer_id', customerIds)
      .eq('status', 'open')
      .lt('due_date', today)
      .order('due_date', { ascending: true });
    if (iErr) throw new Error('invoices fetch: ' + iErr.message);

    const items = [];
    let sumOpen = 0;
    for (const inv of invRows || []) {
      const total    = Number(inv.amount_total)    || 0;
      const credited = Number(inv.credited_amount) || 0;
      if (total <= 0) continue;
      if (credited >= total) continue; // volledig gecrediteerd → uit
      const paid = Number(inv.amount_paid) || 0;
      const open = Math.max(0, total - paid);
      items.push({
        invoice_id    : inv.id,
        invoice_number: inv.invoice_number,
        invoice_date  : inv.issue_date,
        due_date      : inv.due_date,
        amount_total  : r2(total),
        amount_open   : r2(open),
        status        : inv.status,
      });
      sumOpen += open;
    }

    return res.status(200).json({
      items,
      kpi: { count: items.length, sum_open: r2(sumOpen) },
    });
  } catch (e) {
    console.error('[mentor-student-overdue-invoices]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) return res.status(502).json({ error: e.message });
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
