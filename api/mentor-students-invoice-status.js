// api/mentor-students-invoice-status.js
//
// GET → per eigen student het aantal TE LATE facturen (alleen aantallen,
// geen bedragen / factuurdetails).
//
// SCOPE-ALIGNMENT (fix t.o.v. PR #445):
//   Eerder gebruikte dit endpoint getMentorCustomerIds (onboardings.
//   mentor_user_id). Dat gaf een ANDERE studentenset dan
//   mentor-my-students (team_members.bubble_user_id → Bubble user.mentor_user)
//   — studenten zonder onboarding-rij verschenen wél in de lijst maar
//   kregen geen badge. Deze versie gebruikt EXACT dezelfde dual-gate en
//   Bubble-resolutie als mentor-my-students via _lib/mentorStudents.js.
//
// AUTH + GATE (gespiegeld van mentor-my-students):
//   Default self (auth.uid()) → requirePermission('mentor.module.access').
//   ?mentor_user_id (uuid) → requirePermission('mentor.admin.view').
//   Ongeldige uuid → 400; geen permissie → 403; geen sessie → 401.
//
// OVERDUE-DEFINITIE (identiek aan finance-invoices deriveDisplayStatus):
//   status='open' AND due_date < vandaag AND credited_amount < amount_total.
//   Volledig gecrediteerde facturen (credited >= total) worden uitgesloten.
//
// SHAPE: { byEmail: { "<lowercased-email>": <count>, ... } }.
//   Alleen entries met count > 0. Lege set → { byEmail: {} }.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getMentorStudentEmails } from './_lib/mentorStudents.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PostgREST .or() URL-budget: chunk de ilike-filters in batches van 100.
// Mentor heeft typisch 5-50 studenten — meestal 1 chunk. Bij admin-scope
// kan het meer worden; per chunk ~6KB (100 × 60 chars), comfortabel onder
// 8KB-URL-limit.
const ILIKE_CHUNK = 100;

// PostgREST .or() interpreteert ',' en ')' als delimiters — emails die deze
// chars bevatten zijn per RFC ongeldig, dus filteren we ze defensief weg
// i.p.v. ze te escapen.
function isSafeForIlikeOr(email) {
  return typeof email === 'string' && email.length > 0
    && !email.includes(',') && !email.includes('(') && !email.includes(')');
}

// Escape LIKE/ILIKE wildcards zodat ilike een exacte (case-insensitive)
// equality wordt i.p.v. patroon-matching. Volgorde is belangrijk: eerst de
// backslash zelf (zodat we onze eigen escapes daarna niet nog eens escapen),
// dan % en _. Een mailadres als 'foo_bar@x.nl' zou anders elk adres met een
// willekeurig char op die positie matchen (false positives + leak-risico).
function escapeIlikePattern(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }

  // 1. Auth-check.
  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.id) {
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }

  // 2. Dual-gate (identiek aan mentor-my-students).
  const requestedMentorId = typeof req.query?.mentor_user_id === 'string'
    ? req.query.mentor_user_id.trim() : '';
  let effectiveUserId;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) {
      return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    }
    if (!(await requirePermission(req, 'mentor.admin.view'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    }
    effectiveUserId = requestedMentorId;
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) {
      return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    }
    effectiveUserId = user.id;
  }

  try {
    // 3. Studenten-e-mails via DEZELFDE Bubble-resolutie als
    //    mentor-my-students (getMentorStudentEmails wraps de gedeelde
    //    helpers). Lowercased + getrimd + gededupliceerd.
    const { linked, emails } = await getMentorStudentEmails(effectiveUserId);
    if (!linked || emails.length === 0) {
      return res.status(200).json({ byEmail: {} });
    }

    // 4. Match e-mails → klanten CASE-INSENSITIEF via per-email ilike
    //    in een .or()-clause. Eén e-mail kan op meerdere customer-rijen
    //    matchen (case-variants of duplicates) — alle ids tellen mee.
    const safeEmails = emails.filter(isSafeForIlikeOr);
    if (safeEmails.length === 0) return res.status(200).json({ byEmail: {} });

    const emailToCustomerIds = new Map(); // lowercased-email → Set<customer_id>
    for (let i = 0; i < safeEmails.length; i += ILIKE_CHUNK) {
      const slice = safeEmails.slice(i, i + ILIKE_CHUNK);
      const filter = slice.map((e) => `email.ilike.${escapeIlikePattern(e)}`).join(',');
      const { data: rows, error: cErr } = await supabaseAdmin
        .from('customers')
        .select('id, email')
        .or(filter);
      if (cErr) throw new Error('customers fetch: ' + cErr.message);
      for (const r of (rows || [])) {
        if (!r || !r.id || !r.email) continue;
        const eLc = String(r.email).trim().toLowerCase();
        if (!eLc) continue;
        let s = emailToCustomerIds.get(eLc);
        if (!s) { s = new Set(); emailToCustomerIds.set(eLc, s); }
        s.add(r.id);
      }
    }
    if (emailToCustomerIds.size === 0) {
      return res.status(200).json({ byEmail: {} });
    }

    // 5. Verzamel alle customer_ids over de gematchte e-mails + reverse-map
    //    customer_id → lowercased-email zodat we de invoice-counts later
    //    weer kunnen terugkoppelen naar de juiste e-mail-key.
    const customerIdToEmail = new Map();
    for (const [eLc, ids] of emailToCustomerIds.entries()) {
      for (const cid of ids) customerIdToEmail.set(cid, eLc);
    }

    // 6. Vandaag in YYYY-MM-DD (matcht deriveDisplayStatus).
    const today = new Date().toISOString().slice(0, 10);

    // 7. Batch-fetch invoices: server-side filter status='open' +
    //    due_date < vandaag + customer_id IN alle ids.
    const allCustomerIds = Array.from(customerIdToEmail.keys());
    const { data: invoices, error: iErr } = await supabaseAdmin
      .from('invoices')
      .select('customer_id, status, due_date, amount_total, credited_amount')
      .in('customer_id', allCustomerIds)
      .eq('status', 'open')
      .lt('due_date', today);
    if (iErr) throw new Error('invoices fetch: ' + iErr.message);

    // 8. Tel per e-mail (somma over alle matchende customer_ids).
    const byEmail = {};
    for (const inv of (invoices || [])) {
      const credited = Number(inv.credited_amount) || 0;
      const total    = Number(inv.amount_total)    || 0;
      if (total <= 0) continue;
      if (credited >= total) continue; // volledig gecrediteerd
      const cid = inv.customer_id;
      if (!cid) continue;
      const eLc = customerIdToEmail.get(cid);
      if (!eLc) continue;
      byEmail[eLc] = (byEmail[eLc] || 0) + 1;
    }

    // 9. Defense-in-depth: alleen keys overhouden die in de oorspronkelijke
    //    student-e-mailset zitten. Mocht een toekomstige regex-fout of een
    //    DB-side e-mail met case-variant per ongeluk een niet-student
    //    matchen, dan filtert deze stap die weg vóór de response. De data
    //    zou er sowieso al niet in moeten zitten — dit is de gordel-en-
    //    bretels-laag, niet de eerste lijn.
    const studentEmailSet = new Set(emails); // 'emails' is al lowercased + getrimd
    for (const k of Object.keys(byEmail)) {
      if (!(byEmail[k] > 0) || !studentEmailSet.has(k)) delete byEmail[k];
    }

    return res.status(200).json({ byEmail });
  } catch (e) {
    console.error('[mentor-students-invoice-status]', e?.message || e);
    // Bubble-fouten apart melden voor diagnose (zoals mentor-my-students).
    if (e?.code === 'BUBBLE_CONFIG_MISSING') {
      return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    }
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
