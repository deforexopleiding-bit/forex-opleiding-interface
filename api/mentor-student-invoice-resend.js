// api/mentor-student-invoice-resend.js
//
// POST { invoice_id }[, mentor_user_id?] → herverzendt een factuur naar de
// klant via TL invoices.send, na een strikte scope-check dat de factuur
// aan een EIGEN student van de mentor toebehoort.
//
// AUTH + GATE:
//   Default self → requirePermission('mentor.module.access').
//   Body/query mentor_user_id (uuid) → requirePermission('mentor.admin.view').
//
// SCOPE-GUARD:
//   Haal de factuur op → invoice.customer.email. Verifieer dat die email
//   voorkomt in getMentorStudentEmails(effectiveUserId). Zo niet → 403.
//   Geen client-parameters vertrouwd; alle scope is server-side afgeleid.
//
// Mail template:
//   Deze endpoint kiest GEEN template — de mentor mag geen finance-templates
//   selecteren. We gebruiken de VASTE TL mail-template 'Factuur verzenden'
//   (id in MENTOR_INVOICE_TEMPLATE_ID hieronder). Als TL de template niet
//   meer heeft (verwijderd/gehernoemd) → 502/503 met duidelijke tekst.
//
// Rate-limit (soft):
//   Anti-dubbelklik binnen dezelfde request-cycle; UI zet de knop kort
//   uit. Geen persistent throttle in de DB — een mentor die 2x verstuurt
//   moet 'm ook 2x kunnen sturen. Als spam-abuse ooit een issue wordt,
//   dan later een audit_log-gebaseerde cooldown erop plakken.
//
// Audit → audit_log:
//   action = 'mentor.invoice.resend', entity_type='invoice', entity_id=inv.id,
//   after_json = { mail_template_id, template_name, tl_endpoint, shape_used,
//                  student_email, mentor_user_id_effective }.
//
// Response 200: { ok:true, invoice_id, tl_endpoint, template_name,
//                 shape_used, recipient_email }
// Response 400/401/403/404/422/500 → { error, code?, details? }

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { getMentorStudentEmails } from './_lib/mentorStudents.js';
import { getClientIp } from './_lib/audit-customer.js';
import { sendInvoiceViaTl } from './_lib/tl-invoice-send.js';
import { upsertInvoiceFromTl } from './_lib/invoice-upsert.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Vaste TL mail-template die de mentor-resend gebruikt: 'Factuur verzenden'
// (standaard factuur-mail). Als deze id ooit wijzigt (template verwijderd
// of hernoemd in TL), geeft sendInvoiceViaTl een TEMPLATE_NOT_FOUND terug
// en returnt de endpoint een nette 502/503.
const MENTOR_INVOICE_TEMPLATE_ID = '600a810a-9a18-0e93-986a-c16e0727b07e';

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

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const invoiceId = typeof body.invoice_id === 'string' ? body.invoice_id.trim() : null;
  if (!invoiceId || !UUID_RE.test(invoiceId)) return res.status(400).json({ error: 'invoice_id (uuid) vereist' });

  const requestedMentorId = typeof body.mentor_user_id === 'string' ? body.mentor_user_id.trim() : '';
  let effectiveUserId;
  if (requestedMentorId) {
    if (!UUID_RE.test(requestedMentorId)) return res.status(400).json({ error: 'mentor_user_id (uuid) ongeldig' });
    if (!(await requirePermission(req, 'mentor.admin.view'))) return res.status(403).json({ error: 'Geen rechten (mentor.admin.view)' });
    effectiveUserId = requestedMentorId;
  } else {
    if (!(await requirePermission(req, 'mentor.module.access'))) return res.status(403).json({ error: 'Geen rechten (mentor.module.access)' });
    effectiveUserId = user.id;
  }

  const mailTemplateId = MENTOR_INVOICE_TEMPLATE_ID;

  try {
    // 1) Factuur ophalen incl. klant-email.
    const { data: inv, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, tl_invoice_id, status, customer_id, customer:customers(email)')
      .eq('id', invoiceId)
      .maybeSingle();
    if (invErr) throw new Error('invoice fetch: ' + invErr.message);
    if (!inv)   return res.status(404).json({ error: 'Factuur niet gevonden' });
    if (!inv.tl_invoice_id) return res.status(400).json({ error: 'Factuur heeft geen Teamleader-id' });
    const custEmail = String(inv.customer?.email || '').trim();
    if (!custEmail) return res.status(400).json({ error: 'Klant heeft geen e-mailadres' });

    // 2) SCOPE-GUARD: e-mail van de factuur-klant moet in eigen-studenten-set zitten.
    const { linked, emails } = await getMentorStudentEmails(effectiveUserId);
    if (!linked) return res.status(403).json({ error: 'Mentor-koppeling ontbreekt' });
    const studentEmails = new Set((emails || []).map((e) => String(e).trim().toLowerCase()));
    const custEmailLc   = custEmail.toLowerCase();
    if (!studentEmails.has(custEmailLc)) {
      return res.status(403).json({ error: 'Geen toegang tot deze factuur' });
    }

    // 3) TL-send via gedeelde helper (template-fetch + cascade A/B).
    let sendRes;
    try {
      sendRes = await sendInvoiceViaTl({
        invoice: inv,
        mailTemplateId,
        // Geen overrides — mentor bepaalt niet de tekst.
      });
    } catch (e) {
      const code = e?.code || 'TL_UNKNOWN';
      let status, errText;
      if (code === 'TL_NETWORK') {
        status  = 502;
        errText = e?.message || 'Kon Teamleader niet bereiken';
      } else if (code === 'TEMPLATE_NOT_FOUND') {
        status  = 503;
        errText = 'Factuur-template niet gevonden in Teamleader — vraag een beheerder de TL-template te controleren.';
      } else {
        status  = 422;
        errText = e?.message || 'Kon factuur niet versturen via Teamleader';
      }
      return res.status(status).json({ error: errText, code, details: e?.details || null });
    }

    // 4) Post-write sync-back (best-effort).
    let syncErr = null;
    try { await upsertInvoiceFromTl(inv.tl_invoice_id); }
    catch (e) { syncErr = e.message; console.error('[mentor-student-invoice-resend] post-sync', e.message); }

    // 5) Audit-log. Best-effort; faalt ≠ 500 want de send is al gebeurd.
    try {
      await supabaseAdmin.from('audit_log').insert({
        user_id    : user.id,
        action     : 'mentor.invoice.resend',
        entity_type: 'invoice',
        entity_id  : inv.id,
        after_json : {
          mail_template_id       : mailTemplateId,
          template_name          : sendRes.template_name,
          tl_endpoint            : sendRes.tl_endpoint,
          shape_used             : sendRes.shape,
          student_email          : custEmailLc,
          mentor_user_id_effective: effectiveUserId,
        },
        reason_text: `Factuur ${inv.invoice_number} opnieuw verstuurd door mentor (template ${sendRes.template_name || mailTemplateId})`,
        ip_address : getClientIp(req),
      });
    } catch (e) {
      console.error('[mentor-student-invoice-resend] audit', e.message);
    }

    return res.status(200).json({
      ok             : true,
      invoice_id     : inv.id,
      tl_endpoint    : sendRes.tl_endpoint,
      template_name  : sendRes.template_name,
      shape_used     : sendRes.shape,
      recipient_email: sendRes.recipient_email,
      sync_err       : syncErr,
    });
  } catch (e) {
    console.error('[mentor-student-invoice-resend]', e?.message || e);
    if (e?.code === 'BUBBLE_CONFIG_MISSING') return res.status(503).json({ error: 'Bubble-koppeling niet geconfigureerd (env)' });
    if (e?.code === 'BUBBLE_NETWORK' || (typeof e?.code === 'string' && e.code.startsWith('BUBBLE_HTTP_'))) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
