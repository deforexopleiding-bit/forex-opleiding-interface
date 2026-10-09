// api/student-detail.js
//
// GET → student-detail aggregaat voor de modal op /modules/students-overview.html.
//
// Permission: students.all.view (manager / super_admin). 401/403/400.
//
// Query:
//   ?lms_student_id=<uuid>     (hlms_student.id; voor de sessies)
//   ?student_id=<text>         (studentsleutel; alternatief als lms-id ontbreekt)
//   ?email=<text>              (optioneel; voor klant-match, CI)
//
// Drie verzamel-blokken — elk fail-soft:
//   1. customer  — match email → customers (CI ilike), eerste hit. Geen
//                  email/geen match → customer = null.
//   2. financial — invoices voor customer_id (cap 50, nieuwste eerst);
//                  open_count / overdue_count / open_total; per item een
//                  display_status (zelfde definitie als finance-invoices).
//                  Geen klant → leeg.
//   3. calls     — LMS hlms_sessie van deze student (cap 100, nieuwste
//                  eerst; sinds 9 okt 2026, was Bubble). Per item
//                  { date, done, noshow, time? }. Een onleesbaar LMS geeft
//                  calls_error in plaats van stil een lege lijst.
//
// Response 200: { ok, customer, financial, calls }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getDfoLmsClient } from './_lib/dfo-lms-db.js';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Afgeleide weergave-status — identiek aan finance-invoices.displayStatus.
function deriveDisplayStatus(inv, td) {
  const credited = Number(inv.credited_amount) || 0;
  const total    = Number(inv.amount_total)    || 0;
  if (credited > 0 && total > 0 && credited >= total) return 'credited';
  if (credited > 0) return 'partially_credited';
  if (inv.status === 'open' && inv.due_date && inv.due_date < td) return 'overdue';
  return inv.status || 'unknown';
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
  if (!(await requirePermission(req, 'students.all.view'))) {
    return res.status(403).json({ error: 'Geen rechten (students.all.view)' });
  }

  const lmsStudentIdRaw = typeof req.query?.lms_student_id === 'string' ? req.query.lms_student_id.trim() : '';
  const studentSleutel  = typeof req.query?.student_id === 'string' ? req.query.student_id.trim() : '';
  if (!lmsStudentIdRaw && !studentSleutel) return res.status(400).json({ error: 'lms_student_id of student_id vereist' });
  if (lmsStudentIdRaw && !UUID_RE.test(lmsStudentIdRaw)) return res.status(400).json({ error: 'lms_student_id (uuid) ongeldig' });

  const emailRaw = typeof req.query?.email === 'string' ? req.query.email.trim() : '';
  const emailLc = emailRaw ? emailRaw.toLowerCase() : '';

  const result = { ok: true, customer: null, financial: null, calls: [] };

  // ── 1) Customer-match via email (CI, fail-soft) ────────────────────────────
  try {
    if (emailLc && isSafeForIlikeOr(emailLc)) {
      const { data: custs } = await supabaseAdmin
        .from('customers')
        .select('id, is_company, company_name, first_name, last_name, email, phone, ' +
                'address_street, address_number, address_postal, address_city, date_of_birth')
        .or('email.ilike.' + escapeIlikePattern(emailLc))
        .limit(5);
      const c = (Array.isArray(custs) ? custs : [])
        .find((r) => r && r.email && String(r.email).trim().toLowerCase() === emailLc);
      if (c) {
        const display = c.is_company
          ? (String(c.company_name || '').trim() || null)
          : ([c.first_name, c.last_name].map((s) => String(s || '').trim()).filter(Boolean).join(' ') || null);
        result.customer = {
          customer_id     : c.id,
          name            : display,
          email           : c.email,
          phone           : c.phone || null,
          address_street  : c.address_street || null,
          address_number  : c.address_number || null,
          address_postal  : c.address_postal || null,
          address_city    : c.address_city || null,
          date_of_birth   : c.date_of_birth || null,
          is_company      : !!c.is_company,
        };
      }
    }
  } catch (e) {
    console.warn('[student-detail] customer match faalde:', e?.message || e);
  }

  // ── 2) Financial — invoices voor customer_id (fail-soft) ───────────────────
  try {
    result.financial = { open_count: 0, overdue_count: 0, open_total: 0, items: [] };
    if (result.customer?.customer_id) {
      const today = new Date().toISOString().slice(0, 10);
      const { data: invs, error: iErr } = await supabaseAdmin
        .from('invoices')
        .select('id, invoice_number, status, amount_total, amount_paid, credited_amount, issue_date, due_date, paid_date')
        .eq('customer_id', result.customer.customer_id)
        .order('issue_date', { ascending: false })
        .limit(50);
      if (iErr) throw new Error('invoices fetch: ' + iErr.message);
      const items = (invs || []).map((inv) => {
        const display = deriveDisplayStatus(inv, today);
        const total   = Number(inv.amount_total) || 0;
        const credited = Number(inv.credited_amount) || 0;
        const paid     = Number(inv.amount_paid) || 0;
        const fullyCredited = total > 0 && credited >= total;
        const isOpenLike = !fullyCredited && (inv.status === 'open' || inv.status === 'partially_paid');
        const outstanding = isOpenLike ? Math.max(0, total - paid - credited) : 0;
        if (isOpenLike) {
          result.financial.open_count++;
          result.financial.open_total += outstanding;
          if (display === 'overdue') result.financial.overdue_count++;
        }
        return {
          id              : inv.id,
          invoice_number  : inv.invoice_number || null,
          status          : inv.status,
          display_status  : display,
          amount_total    : total,
          amount_paid     : paid,
          credited_amount : credited,
          outstanding     : outstanding,
          issue_date      : inv.issue_date,
          due_date        : inv.due_date,
          paid_date       : inv.paid_date,
        };
      });
      // Round open_total naar 2 decimalen voor nette weergave.
      result.financial.open_total = Math.round(result.financial.open_total * 100) / 100;
      result.financial.items = items;
    }
  } catch (e) {
    console.warn('[student-detail] financial faalde:', e?.message || e);
    result.financial = { open_count: 0, overdue_count: 0, open_total: 0, items: [], error: String(e?.message || e) };
  }

  // ── 3) Calls — LMS hlms_sessie van deze student ──────────────────────────
  try {
    const lms = getDfoLmsClient();
    if (!lms) throw new Error('LMS-koppeling niet geconfigureerd');
    let lmsId = lmsStudentIdRaw || null;
    if (!lmsId) {
      // Studentsleutel → hlms_student.id (oud id of al een LMS-id).
      let q = lms.from('hlms_student').select('id').limit(2);
      q = UUID_RE.test(studentSleutel)
        ? q.or(`id.eq.${studentSleutel},bubble_user_id.eq.${studentSleutel}`)
        : q.eq('bubble_user_id', studentSleutel);
      const { data: hits, error: hErr } = await q;
      if (hErr) throw new Error('hlms_student: ' + hErr.message);
      if ((hits || []).length === 1) lmsId = hits[0].id;
    }
    if (lmsId) {
      const { data: rows, error: sErr } = await lms
        .from('hlms_sessie')
        .select('start_tijd, status')
        .eq('student_id', lmsId)
        .order('start_tijd', { ascending: false })
        .limit(100);
      if (sErr) throw new Error('hlms_sessie: ' + sErr.message);
      const tijd = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Brussels', hour: '2-digit', minute: '2-digit' });
      result.calls = (rows || []).filter((r) => r.start_tijd).map((r) => ({
        date:   r.start_tijd,
        done:   r.status === 'afgerond',
        noshow: r.status === 'no_show',
        status: r.status || null,
        time:   tijd.format(new Date(r.start_tijd)),
      }));
    }
  } catch (e) {
    console.warn('[student-detail] calls faalde:', e?.message || e);
    result.calls = [];
    result.calls_error = String(e?.message || e);
  }

  return res.status(200).json(result);
}
