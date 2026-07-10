// api/wanbetalers-brief-pdf.js
//
// POST → PDF-download met aanmaningsbrieven voor 1 of meer klanten.
// Ook ?preview=1 → JSON { items: [{customer_id, name, address, has_address}] }
// zodat de UI vooraf kan tonen wie wél en wie NIET per post kan (zonder adres).
//
// Body:
//   { customer_ids: [uuid], template_id: uuid }
//   max 100 customer_ids per keer.
//
// Permission: finance.dunning.execute.
//
// Skip-logica:
//   - Klant zonder postadres (address_street + address_city allebei leeg) →
//     NIET in de PDF, wél in preview met has_address:false.
//   - Klant zonder gekoppelde customer-row of geanonimiseerd/gearchiveerd →
//     idem: overgeslagen.
//
// Layout per brief:
//   - Rechtsboven: afzenderblok (bedrijf.naam / bedrijf.adres).
//   - Linksmidden: geadresseerde (klant.naam + adres).
//   - Datum + onderwerp.
//   - Ge-resolvede briefbody (met {{klant.*}}-variabelen ingevuld).
//   - Handtekening-ruimte + "De Forex Opleiding".
//   - Elke klant op een nieuwe pagina (bulk).

import PDFDocument from 'pdfkit';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { resolveVariables } from './_lib/template-variables.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const MAX_CUSTOMERS = 100;

function openAmount(inv) {
  const total = Number(inv?.amount_total)    || 0;
  const paid  = Number(inv?.amount_paid)     || 0;
  const cred  = Number(inv?.credited_amount) || 0;
  return Math.max(0, total - paid - cred);
}
function buildAddressLines(cust) {
  const s = (cust?.address_street || '').trim();
  const n = (cust?.address_number || '').trim();
  const p = (cust?.address_postal || '').trim();
  const c = (cust?.address_city   || '').trim();
  const line1 = [s, n].filter(Boolean).join(' ');
  const line2 = [p, c].filter(Boolean).join(' ');
  return { line1, line2, hasAddress: !!(line1 && line2) };
}
function formatDateNl(d) {
  const dt = d instanceof Date ? d : new Date();
  const mm = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  return `${dt.getDate()} ${mm[dt.getMonth()]} ${dt.getFullYear()}`;
}

async function fetchTemplate(templateId) {
  if (!templateId || !UUID_RE.test(templateId)) return null;
  const { data } = await supabaseAdmin
    .from('dunning_templates')
    .select('id, name, kind, subject, body, is_active')
    .eq('id', templateId).maybeSingle();
  if (!data) return null;
  if (data.kind !== 'brief' || !data.is_active) return null;
  return data;
}

async function loadCustomerBundles(customerIds) {
  const bundles = new Map(); // id → { customer, openInvoices }
  if (!customerIds.length) return bundles;
  const { data: custRows } = await supabaseAdmin
    .from('customers')
    .select('id, first_name, last_name, company_name, is_company, email, phone, address_street, address_number, address_postal, address_city, archived_at, anonymized_at')
    .in('id', customerIds);
  const validCust = new Map();
  for (const c of custRows || []) {
    if (!c.archived_at && !c.anonymized_at) validCust.set(c.id, c);
  }
  if (validCust.size === 0) return bundles;

  const { data: invRows } = await supabaseAdmin
    .from('invoices')
    .select('id, customer_id, invoice_number, amount_total, amount_paid, credited_amount, issue_date, due_date, status')
    .in('customer_id', Array.from(validCust.keys()))
    .in('status', OPEN_STATUSES);
  const invByCust = new Map();
  for (const inv of invRows || []) {
    if (openAmount(inv) <= 0) continue;
    const list = invByCust.get(inv.customer_id) || [];
    list.push(inv);
    invByCust.set(inv.customer_id, list);
  }
  for (const [cid, c] of validCust) {
    bundles.set(cid, { customer: c, openInvoices: invByCust.get(cid) || [] });
  }
  return bundles;
}

function drawLetter(doc, ctx, tpl, isFirst) {
  if (!isFirst) doc.addPage();
  const { customer, addressLines, resolvedBody, subject, companyName, companyAddress } = ctx;

  const MARGIN_L = 60, MARGIN_R = 60, MARGIN_T = 60;
  const pageWidth = doc.page.width - MARGIN_L - MARGIN_R;

  // ─── Afzenderblok rechtsboven ─────────────────────────────────────────
  const rightX = doc.page.width - MARGIN_R;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a')
     .text(companyName, MARGIN_L, MARGIN_T, { width: pageWidth, align: 'right' });
  if (companyAddress) {
    doc.font('Helvetica').fontSize(9).fillColor('#475569')
       .text(companyAddress, MARGIN_L, doc.y, { width: pageWidth, align: 'right' });
  }

  // ─── Geadresseerde links ──────────────────────────────────────────────
  doc.moveDown(3);
  const custName = customerDisplayName(customer, '(zonder naam)');
  doc.font('Helvetica').fontSize(11).fillColor('#0f172a')
     .text(custName, MARGIN_L, doc.y);
  if (addressLines.line1) doc.text(addressLines.line1);
  if (addressLines.line2) doc.text(addressLines.line2);

  // ─── Datum + onderwerp ────────────────────────────────────────────────
  doc.moveDown(2);
  doc.font('Helvetica').fontSize(10).fillColor('#475569')
     .text(formatDateNl(new Date()), MARGIN_L, doc.y);
  doc.moveDown(1);
  const subj = (subject && subject.trim()) || 'Betalingsherinnering';
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#0f172a').text(`Onderwerp: ${subj}`);

  // ─── Body (ge-resolvede tekst) ────────────────────────────────────────
  doc.moveDown(1.2);
  doc.font('Helvetica').fontSize(11).fillColor('#0f172a')
     .text(resolvedBody, MARGIN_L, doc.y, { width: pageWidth, align: 'left', lineGap: 3 });

  // ─── Handtekening-ruimte ──────────────────────────────────────────────
  doc.moveDown(4);
  doc.font('Helvetica').fontSize(10).fillColor('#475569')
     .text(`— ${companyName}`, MARGIN_L, doc.y);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.dunning.execute'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.dunning.execute)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : null;
  if (!body) return res.status(400).json({ error: 'Body ontbreekt' });

  const rawIds = Array.isArray(body.customer_ids)
    ? body.customer_ids.filter((v) => typeof v === 'string' && UUID_RE.test(v))
    : [];
  const uniqueIds = Array.from(new Set(rawIds));
  if (uniqueIds.length === 0) return res.status(400).json({ error: 'customer_ids vereist' });
  if (uniqueIds.length > MAX_CUSTOMERS) return res.status(400).json({ error: `Max ${MAX_CUSTOMERS} klanten per keer` });

  const templateId = typeof body.template_id === 'string' ? body.template_id.trim() : null;
  const tpl = await fetchTemplate(templateId);
  if (!tpl) return res.status(404).json({ error: 'Brief-template niet gevonden of niet actief' });

  const isPreview = String(req.query?.preview || '') === '1';

  try {
    const bundles = await loadCustomerBundles(uniqueIds);

    // Preview-mode: alleen JSON met per klant of adres OK is.
    if (isPreview) {
      const items = uniqueIds.map((cid) => {
        const b = bundles.get(cid);
        if (!b) return { customer_id: cid, name: null, has_address: false, skip_reason: 'not_found_or_anonymized' };
        const addr = buildAddressLines(b.customer);
        return {
          customer_id: cid,
          name       : customerDisplayName(b.customer, '(zonder naam)'),
          address    : addr.hasAddress ? { line1: addr.line1, line2: addr.line2 } : null,
          has_address: addr.hasAddress,
          skip_reason: addr.hasAddress ? null : 'no_address',
        };
      });
      const ok      = items.filter((i) => i.has_address).length;
      const skipped = items.filter((i) => !i.has_address).length;
      return res.status(200).json({ items, summary: { total: items.length, will_print: ok, skipped } });
    }

    // PDF-mode: alleen klanten met adres.
    const printable = uniqueIds
      .map((cid) => bundles.get(cid))
      .filter(Boolean)
      .map((b) => ({ bundle: b, addr: buildAddressLines(b.customer) }))
      .filter((x) => x.addr.hasAddress);

    if (printable.length === 0) {
      return res.status(400).json({ error: 'Geen klanten met adres — niets om te printen' });
    }

    const companyName    = process.env.COMPANY_NAME    || 'De Forex Opleiding NL B.V.';
    const companyAddress = process.env.COMPANY_ADDRESS || '';

    // Stream PDF direct in de response.
    res.setHeader('Content-Type', 'application/pdf');
    const today = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="aanmaningsbrieven_${today}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');

    const doc = new PDFDocument({ size: 'A4', margin: 60, info: { Title: 'Aanmaningsbrieven', Author: companyName } });
    doc.pipe(res);

    let isFirst = true;
    for (const item of printable) {
      const { bundle, addr } = item;
      const ctx = { customer: bundle.customer, openInvoices: bundle.openInvoices };
      let resolvedBody = '';
      try {
        resolvedBody = resolveVariables(tpl.body, null, ctx)?.text ?? String(tpl.body || '');
      } catch (e) {
        resolvedBody = String(tpl.body || '');
        console.error('[wanbetalers-brief-pdf] resolve fail', bundle.customer.id, e?.message || e);
      }
      drawLetter(doc, {
        customer      : bundle.customer,
        addressLines  : addr,
        resolvedBody,
        subject       : tpl.subject,
        companyName,
        companyAddress,
      }, tpl, isFirst);
      isFirst = false;
    }
    doc.end();
  } catch (e) {
    console.error('[wanbetalers-brief-pdf]', e?.message || e);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }
}
