// api/incasso-pre-brief.js
// POST { customer_id, country? } → download WIK-14-dagenbrief (NL) of
// eerste (kosteloze) herinnering (BE), gerenderd uit een bewerkbaar
// dunning_templates-record (code='incasso_pre_nl' / 'incasso_pre_be').
//
// - Vult variabelen via resolveVariables (klant.naam, klant.adres_volledig,
//   klant.totaal_open — bestaande keys).
// - Rendert een zelfstandige PDF (pdfkit) — NIET wanbetalers-brief-pdf.js
//   refactoren.
// - Logt naar dunning_log { event_type:'incasso_pre_brief_sent', payload:
//   {customer_id, country, template_code} } zodat de create-guard weet
//   dat de brief verstuurd is.
//
// Permission: finance.incasso.manage.

import PDFDocument from 'pdfkit';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { resolveVariables } from './_lib/template-variables.js';
import { sanitizeForPdf } from './_lib/incasso-pdf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

function fmtDateNl(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  const mm = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  return `${dt.getDate()} ${mm[dt.getMonth()]} ${dt.getFullYear()}`;
}
function buildAddressLines(cust) {
  const s = (cust?.address_street || '').trim();
  const n = (cust?.address_number || '').trim();
  const p = (cust?.address_postal || '').trim();
  const c = (cust?.address_city   || '').trim();
  return {
    line1: [s, n].filter(Boolean).join(' '),
    line2: [p, c].filter(Boolean).join(' '),
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) { res.setHeader('Content-Type', 'application/json'); return res.status(401).json({ error: 'Niet geauthenticeerd' }); }
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const customerId = typeof body.customer_id === 'string' && UUID_RE.test(body.customer_id) ? body.customer_id : null;
  const country    = (body.country === 'BE') ? 'BE' : 'NL';
  if (!customerId) { res.setHeader('Content-Type', 'application/json'); return res.status(400).json({ error: 'customer_id (uuid) verplicht' }); }

  const templateCode = country === 'BE' ? 'incasso_pre_be' : 'incasso_pre_nl';

  try {
    // 1) Template ophalen (bewerkbaar in Templates-tab).
    const { data: tpl } = await supabaseAdmin
      .from('dunning_templates')
      .select('id, code, name, kind, subject, body, is_active')
      .eq('code', templateCode).eq('kind', 'brief').eq('is_active', true)
      .maybeSingle();
    if (!tpl) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: `Template '${templateCode}' niet gevonden of niet actief. Draai migratie 038.` });
    }

    // 2) Klant + open invoices ophalen voor variabele-context.
    const { data: customer, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone, address_street, address_number, address_postal, address_city, archived_at, anonymized_at')
      .eq('id', customerId).maybeSingle();
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    if (!customer) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(404).json({ error: 'Klant niet gevonden' });
    }

    const { data: invs } = await supabaseAdmin
      .from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, issue_date, status')
      .eq('customer_id', customerId).in('status', OPEN_STATUSES);
    const openInvoices = (invs || []).filter((iv) => {
      const t = Number(iv.amount_total) || 0;
      const p = Number(iv.amount_paid) || 0;
      const c = Number(iv.credited_amount) || 0;
      return Math.max(0, t - p - c) > 0;
    });

    // 3) Variabelen resolven — klant.naam / klant.adres_volledig / klant.totaal_open.
    const { text: resolvedSubject } = resolveVariables(tpl.subject || '', null, { customer, openInvoices });
    const { text: resolvedBody }    = resolveVariables(tpl.body    || '', null, { customer, openInvoices });

    // 4) PDF renderen (zelfstandig, NIET wanbetalers-brief-pdf refactoren).
    const buffer = await new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 60 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // Afzender-blok rechtsboven.
        const companyName    = process.env.COMPANY_NAME    || 'De Forex Opleiding NL B.V.';
        const companyAddress = process.env.COMPANY_ADDRESS || '';
        const companyPhone   = process.env.COMPANY_PHONE   || '';
        const companyEmail   = process.env.COMPANY_EMAIL   || 'info@deforexopleiding.nl';
        doc.font('Helvetica').fontSize(9).fillColor('#0f172a')
          .text(companyName, 320, 60, { width: 220, align: 'right' });
        if (companyAddress) doc.text(companyAddress, 320, doc.y, { width: 220, align: 'right' });
        if (companyPhone)   doc.text(companyPhone,   320, doc.y, { width: 220, align: 'right' });
        doc.text(companyEmail, 320, doc.y, { width: 220, align: 'right' });

        // Geadresseerde linksboven.
        const geadresseerdeRaw = customer.is_company
          ? (customer.company_name || customerDisplayName(customer, ''))
          : customerDisplayName(customer, '');
        const geadresseerde = sanitizeForPdf(geadresseerdeRaw);
        const addr = buildAddressLines(customer);
        doc.font('Helvetica').fontSize(10).fillColor('#0f172a')
          .text(geadresseerde || '(zonder naam)', 60, 150);
        if (addr.line1) doc.text(sanitizeForPdf(addr.line1), 60, doc.y);
        if (addr.line2) doc.text(sanitizeForPdf(addr.line2), 60, doc.y);

        // Datum + onderwerp.
        doc.moveDown(2);
        doc.text('Datum: ' + fmtDateNl(new Date()), 60);
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(11).text('Onderwerp: ' + (resolvedSubject || ''), 60);
        doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
        doc.moveDown(1);

        // Body — nl2br via text() met individuele regels.
        const paragraphs = String(resolvedBody || '').split(/\n{2,}/);
        for (const p of paragraphs) {
          doc.text(p.replace(/\n/g, ' '), 60, doc.y, { width: 475, align: 'left' });
          doc.moveDown(0.6);
        }

        // Voetnoot.
        doc.moveDown(1);
        doc.fontSize(8).fillColor('#64748b').text(
          'Gegenereerd op ' + fmtDateNl(new Date()) + ' door het Agency Command Center.',
          60, doc.y, { width: 475 }
        );

        doc.end();
      } catch (e) { reject(e); }
    });

    // 5) Log — de create-guard checkt op dit event.
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id     : null,
        step_id    : null,
        event_type : 'incasso_pre_brief_sent',
        payload    : {
          customer_id  : customerId,
          country      : country,
          template_code: templateCode,
          template_id  : tpl.id,
        },
      });
    } catch (e) {
      console.warn('[incasso-pre-brief] dunning_log insert soft-fail', e?.message || e);
    }

    // 6) Stream als download.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pre-incassobrief_${country}_${customerId.slice(0, 8)}.pdf"`);
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[incasso-pre-brief]', e?.message || e);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
