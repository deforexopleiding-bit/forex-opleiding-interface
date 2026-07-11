// api/_lib/incasso-pdf.js
//
// buildDossierPdfBuffer(dossierId) → Promise<Buffer>
//
// Verzamelt de dossier-context (zelfde queries als incasso-dossier-detail.js,
// gedeeld hier om dubbele fetch te voorkomen) en bouwt met pdfkit één PDF
// met alle secties: kop, schuldeiser, debiteur, vordering (factuurtabel +
// totaal), onderbouwing (offerte/deal), aanmaan- & contact-historie,
// betalingsregelingen, notities.
//
// Geen incassokosten-/renteberekening (bewust: bureau doet dat).

import PDFDocument from 'pdfkit';
import { supabaseAdmin } from '../supabase.js';
import { customerDisplayName } from './customer-name.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

function openAmount(inv) {
  const t = Number(inv?.amount_total)    || 0;
  const p = Number(inv?.amount_paid)     || 0;
  const c = Number(inv?.credited_amount) || 0;
  return Math.max(0, t - p - c);
}
function eur(n) {
  const v = Number(n) || 0;
  return '€ ' + v.toFixed(2).replace('.', ',');
}
function fmtDateNl(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return '—';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${dt.getFullYear()}`;
}
function daysBetween(a, b) {
  const ta = new Date(a).getTime(); const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.floor((ta - tb) / (24 * 3600 * 1000));
}

async function fetchDossierContext(dossierId) {
  const { data: dossier, error: dErr } = await supabaseAdmin
    .from('dunning_incasso_dossiers')
    .select('id, customer_id, bureau_id, country, status, debt_snapshot, notes, opened_at, updated_at, ' +
      'bureau:bureau_id(id, name, email, country, address)')
    .eq('id', dossierId).maybeSingle();
  if (dErr) throw new Error('dossier lookup: ' + dErr.message);
  if (!dossier) throw new Error('Dossier niet gevonden');

  const cid = dossier.customer_id;
  const [
    { data: customer },
    { data: invoicesAll },
    { data: arrangements },
    { data: conversations },
    { data: dunningLog },
    { data: deals },
  ] = await Promise.all([
    supabaseAdmin.from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone, address_street, address_number, address_postal, address_city, tl_contact_id, tl_company_id')
      .eq('id', cid).maybeSingle(),
    supabaseAdmin.from('invoices')
      .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, issue_date, status, paid_date')
      .eq('customer_id', cid).order('issue_date', { ascending: false }).limit(200),
    supabaseAdmin.from('payment_arrangements')
      .select('id, type, status, details, created_at').eq('customer_id', cid)
      .order('created_at', { ascending: false }).limit(50),
    supabaseAdmin.from('whatsapp_conversations')
      .select('id, phone_number, status, last_message_at, last_inbound_at, unread_count')
      .eq('customer_id', cid).order('last_message_at', { ascending: false, nullsFirst: false }).limit(20),
    supabaseAdmin.from('dunning_log')
      .select('id, event_type, payload, created_at')
      .filter('payload->>customer_id', 'eq', cid)
      .order('created_at', { ascending: false }).limit(50),
    supabaseAdmin.from('deals')
      .select('id, quote_reference, tl_quotation_status, tl_quotation_accepted_at, total_amount, created_at')
      .eq('customer_id', cid).order('created_at', { ascending: false }).limit(5),
  ]);

  return {
    dossier,
    customer      : customer || null,
    invoices      : invoicesAll || [],
    arrangements  : arrangements || [],
    conversations : conversations || [],
    dunning_log   : dunningLog || [],
    deals         : deals || [],
  };
}

export async function buildDossierPdfBuffer(dossierId) {
  const ctx = await fetchDossierContext(dossierId);
  return renderPdf(ctx);
}

function renderPdf(ctx) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      _renderSections(doc, ctx);
      doc.end();
    } catch (e) { reject(e); }
  });
}

function _sectionHeader(doc, title) {
  doc.moveDown(0.5);
  doc.fontSize(11).fillColor('#1e293b').font('Helvetica-Bold').text(title.toUpperCase());
  doc.moveTo(doc.x, doc.y).lineTo(545, doc.y).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
  doc.moveDown(0.4);
  doc.font('Helvetica').fillColor('#0f172a').fontSize(10);
}

function _kvRow(doc, label, value) {
  const y = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569').text(label + ':', 50, y, { width: 130, continued: false });
  doc.font('Helvetica').fontSize(10).fillColor('#0f172a').text(value || '—', 185, y, { width: 360 });
}

function _renderSections(doc, ctx) {
  const { dossier, customer, invoices, arrangements, conversations, dunning_log, deals } = ctx;

  // ── KOP ────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#0f172a').text('INCASSODOSSIER', 50, 50);
  doc.font('Helvetica').fontSize(9).fillColor('#64748b')
    .text('Dossiernummer: ' + dossier.id, 50, 76)
    .text('Aangemeld op: '  + fmtDateNl(dossier.opened_at), 50, 88)
    .text('Land: '          + (dossier.country || 'NL'), 50, 100);
  if (dossier.bureau) {
    doc.text('Bureau: ' + dossier.bureau.name + ' (' + (dossier.bureau.country || 'NL') + ')', 300, 76, { width: 245 });
    if (dossier.bureau.email)   doc.text('E-mail: '  + dossier.bureau.email,   300, 88, { width: 245 });
    if (dossier.bureau.address) doc.text('Adres: '   + dossier.bureau.address, 300, 100, { width: 245 });
  }
  doc.moveDown(2);

  // ── SCHULDEISER ────────────────────────────────────────────────────
  _sectionHeader(doc, 'Schuldeiser');
  const companyName    = process.env.COMPANY_NAME    || 'De Forex Opleiding NL B.V.';
  const companyAddress = process.env.COMPANY_ADDRESS || '';
  const companyKvk     = process.env.COMPANY_KVK     || '';
  const companyBtw     = process.env.COMPANY_BTW     || '';
  const companyIban    = process.env.COMPANY_IBAN    || '';
  const companyEmail   = process.env.COMPANY_EMAIL   || 'info@deforexopleiding.nl';
  const companyPhone   = process.env.COMPANY_PHONE   || '';
  _kvRow(doc, 'Naam',    companyName); doc.moveDown(0.2);
  if (companyAddress) { _kvRow(doc, 'Adres',   companyAddress); doc.moveDown(0.2); }
  if (companyKvk)     { _kvRow(doc, 'KvK',     companyKvk);     doc.moveDown(0.2); }
  if (companyBtw)     { _kvRow(doc, 'BTW',     companyBtw);     doc.moveDown(0.2); }
  if (companyIban)    { _kvRow(doc, 'IBAN',    companyIban);    doc.moveDown(0.2); }
  _kvRow(doc, 'E-mail', companyEmail); doc.moveDown(0.2);
  if (companyPhone)   { _kvRow(doc, 'Telefoon', companyPhone);  doc.moveDown(0.2); }

  // ── DEBITEUR ───────────────────────────────────────────────────────
  _sectionHeader(doc, 'Debiteur');
  if (customer) {
    const naam = customer.is_company
      ? (customer.company_name || customerDisplayName(customer, '(zonder naam)'))
      : customerDisplayName(customer, '(zonder naam)');
    const addr1 = [customer.address_street, customer.address_number].filter(Boolean).join(' ');
    const addr2 = [customer.address_postal, customer.address_city].filter(Boolean).join(' ');
    _kvRow(doc, 'Naam',        naam); doc.moveDown(0.2);
    _kvRow(doc, 'Adres',       [addr1, addr2].filter(Boolean).join(', ') || '—'); doc.moveDown(0.2);
    _kvRow(doc, 'E-mail',      customer.email || '—'); doc.moveDown(0.2);
    _kvRow(doc, 'Telefoon',    customer.phone || '—'); doc.moveDown(0.2);
    _kvRow(doc, 'Land',        dossier.country || 'NL'); doc.moveDown(0.2);
    _kvRow(doc, 'Klantnummer', String(customer.id).slice(0, 8) + '…'); doc.moveDown(0.2);
    if (customer.is_company)   { _kvRow(doc, 'Type',      'Zakelijk'); doc.moveDown(0.2); }
  } else {
    doc.text('Klant-record niet gevonden.');
  }

  // ── VORDERING ─────────────────────────────────────────────────────
  _sectionHeader(doc, 'Vordering');
  const openInvs = (invoices || []).filter((iv) => OPEN_STATUSES.includes(String(iv.status || '').toLowerCase()) && openAmount(iv) > 0);
  const totalOpen = openInvs.reduce((s, iv) => s + openAmount(iv), 0);

  // Header-rij
  const headerY = doc.y;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569');
  doc.text('Nr.',          50,  headerY, { width: 70 });
  doc.text('Factuurdatum', 120, headerY, { width: 75 });
  doc.text('Vervaldatum',  195, headerY, { width: 75 });
  doc.text('Origineel',    270, headerY, { width: 70, align: 'right' });
  doc.text('Betaald',      340, headerY, { width: 70, align: 'right' });
  doc.text('Open',         410, headerY, { width: 70, align: 'right' });
  doc.text('Dagen te laat',480, headerY, { width: 65, align: 'right' });
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
  doc.moveDown(0.2);

  const nowIso = new Date();
  doc.font('Helvetica').fontSize(9).fillColor('#0f172a');
  if (openInvs.length === 0) {
    doc.text('Geen openstaande facturen.', 50, doc.y);
  } else {
    for (const iv of openInvs) {
      const rowY = doc.y;
      const dagen = daysBetween(nowIso, iv.due_date);
      doc.text(iv.invoice_number || String(iv.id).slice(0, 8), 50,  rowY, { width: 70 });
      doc.text(fmtDateNl(iv.issue_date),                       120, rowY, { width: 75 });
      doc.text(fmtDateNl(iv.due_date),                          195, rowY, { width: 75 });
      doc.text(eur(iv.amount_total),                            270, rowY, { width: 70, align: 'right' });
      doc.text(eur(iv.amount_paid),                             340, rowY, { width: 70, align: 'right' });
      doc.text(eur(openAmount(iv)),                             410, rowY, { width: 70, align: 'right' });
      doc.text(dagen != null && dagen > 0 ? String(dagen) : '—', 480, rowY, { width: 65, align: 'right' });
      doc.moveDown(0.3);
    }
  }
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#cbd5e1').lineWidth(0.5).stroke();
  doc.moveDown(0.2);
  const totalY = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0f172a')
    .text('Totaal openstaand', 340, totalY, { width: 70, align: 'right' })
    .text(eur(totalOpen),      410, totalY, { width: 70, align: 'right' });
  doc.moveDown(0.6);
  doc.font('Helvetica').fontSize(8).fillColor('#64748b')
    .text('(Snapshot bij aanmelding: ' + eur(dossier.debt_snapshot?.total_open_eur || 0) + ' — ' + (dossier.debt_snapshot?.open_invoice_count || 0) + ' facturen)');

  // ── ONDERBOUWING (deals) ──────────────────────────────────────────
  _sectionHeader(doc, 'Onderbouwing (offerte / deal)');
  const acceptedDeal = (deals || []).find((d) => d.tl_quotation_accepted_at) || (deals || [])[0];
  if (acceptedDeal) {
    _kvRow(doc, 'Referentie',      acceptedDeal.quote_reference || String(acceptedDeal.id).slice(0, 8)); doc.moveDown(0.2);
    _kvRow(doc, 'Aangemaakt',      fmtDateNl(acceptedDeal.created_at)); doc.moveDown(0.2);
    _kvRow(doc, 'Bedrag (totaal)', eur(acceptedDeal.total_amount)); doc.moveDown(0.2);
    _kvRow(doc, 'Status',          acceptedDeal.tl_quotation_status || '—'); doc.moveDown(0.2);
    if (acceptedDeal.tl_quotation_accepted_at) {
      _kvRow(doc, 'Geaccepteerd',  fmtDateNl(acceptedDeal.tl_quotation_accepted_at)); doc.moveDown(0.2);
    }
  } else {
    doc.text('Geen offerte-/deal-referentie gevonden.');
  }

  // ── AANMAAN- & CONTACTHISTORIE ────────────────────────────────────
  _sectionHeader(doc, 'Aanmaan- & contacthistorie');
  const wikSent = (dunning_log || []).some((r) => {
    const t = String(r.event_type || '');
    return t === 'wik_letter_sent' || t === 'be_letter_sent' || t === 'brief_verstuurd';
  });
  doc.text('WIK/BE-brief: ' + (wikSent ? 'verstuurd' : 'niet vastgelegd'));
  doc.moveDown(0.3);
  if ((dunning_log || []).length === 0) {
    doc.text('Geen aanmaan-logs geregistreerd.');
  } else {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#475569');
    const logHeaderY = doc.y;
    doc.text('Datum',        50,  logHeaderY, { width: 80 });
    doc.text('Type',         130, logHeaderY, { width: 180 });
    doc.text('Kanaal / info',310, logHeaderY, { width: 235 });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor('#0f172a');
    for (const l of (dunning_log || []).slice(0, 15)) {
      const rowY = doc.y;
      const channels = l.payload?.channels;
      const info = channels
        ? Object.entries(channels).filter(([, v]) => v).map(([k]) => k).join('+') || '—'
        : (l.payload?.info || '');
      doc.text(fmtDateNl(l.created_at), 50,  rowY, { width: 80 });
      doc.text(String(l.event_type || ''), 130, rowY, { width: 180 });
      doc.text(String(info).slice(0, 60), 310, rowY, { width: 235 });
      doc.moveDown(0.25);
    }
  }
  doc.moveDown(0.4);

  const convCount   = (conversations || []).length;
  const lastInbound = (conversations || []).map((c) => c.last_inbound_at).filter(Boolean).sort().pop();
  const lastMessage = (conversations || []).map((c) => c.last_message_at).filter(Boolean).sort().pop();
  doc.text('Gesprekken (WhatsApp): ' + convCount +
    (lastMessage ? ' · laatste bericht: ' + fmtDateNl(lastMessage) : '') +
    (lastInbound ? ' · laatste inbound: ' + fmtDateNl(lastInbound) : ''));

  // ── BETALINGSREGELINGEN ───────────────────────────────────────────
  _sectionHeader(doc, 'Betalingsregelingen');
  if (!(arrangements || []).length) {
    doc.text('Geen betalingsregelingen geregistreerd.');
  } else {
    for (const a of arrangements) {
      const type   = a.type || '—';
      const status = a.status || '—';
      doc.text('• ' + type + ' — ' + status + ' (aangemaakt ' + fmtDateNl(a.created_at) + ')');
    }
  }

  // ── NOTITIES ──────────────────────────────────────────────────────
  if (dossier.notes && dossier.notes.trim()) {
    _sectionHeader(doc, 'Notities');
    doc.fillColor('#0f172a').fontSize(10).text(dossier.notes, { width: 495 });
  }

  // ── VOETNOOT ──────────────────────────────────────────────────────
  doc.moveDown(1);
  doc.fontSize(8).fillColor('#94a3b8').text(
    'Gegenereerd op ' + fmtDateNl(new Date()) + ' door het Agency Command Center. ' +
    'Bedragen exclusief incassokosten en wettelijke rente — het bureau berekent die zelf.'
  );
}
