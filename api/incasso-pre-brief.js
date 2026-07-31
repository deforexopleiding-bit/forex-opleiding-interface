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

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { customerDisplayName } from './_lib/customer-name.js';
import { resolveVariables } from './_lib/template-variables.js';
import { sanitizeForPdf } from './_lib/incasso-pdf.js';
import {
  validateCustomerAddress,
  buildAddressBlockPosition,
  buildAddressBlockLines,
  mmToPt,
} from './_lib/wik-brief-layout.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];

// WIK_LOGO_PATH override in env → anders default naar het bestaande brand-logo
// dat ook op login.html / sidebar wordt gebruikt. Als het bestand niet bestaat
// slaat _tryLogoBuffer() fail-soft de logo-render over (brief zonder logo, geen
// crash). Zo blijft de brief werken ook als het assetpad ooit wijzigt.
const WIK_LOGO_DEFAULT = 'img/logo-dark.png';

function fmtDateNl(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  const mm = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  return `${dt.getDate()} ${mm[dt.getMonth()]} ${dt.getFullYear()}`;
}

/**
 * Probeer het logo-bestand in te laden voor doc.image(). Fail-soft:
 * ontbrekend/onleesbaar bestand → null → generator slaat het logo over.
 * Env-override WIK_LOGO_PATH (relatief aan process.cwd()) wint van default.
 */
function _tryLogoBuffer() {
  const rel = process.env.WIK_LOGO_PATH || WIK_LOGO_DEFAULT;
  try {
    const abs = path.isAbsolute(rel) ? rel : path.join(process.cwd(), rel);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs);
  } catch (e) {
    console.warn('[incasso-pre-brief] logo-load faalde (skip):', e?.message || e);
    return null;
  }
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
    // address_country toegevoegd voor de landregel in het C5-adresblok (NL/BE).
    const { data: customer, error: cErr } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, company_name, is_company, email, phone, address_street, address_number, address_postal, address_city, address_country, archived_at, anonymized_at')
      .eq('id', customerId).maybeSingle();
    if (cErr) throw new Error('customers lookup: ' + cErr.message);
    if (!customer) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(404).json({ error: 'Klant niet gevonden' });
    }

    // 2b) ADRES-SLOT (juridische veiligheids-gate — nieuw sinds fase C5).
    // WIK-brief zonder compleet adres is niet aantoonbaar afleverbaar → geen
    // rechtsgeldige start van de 14-dagen-termijn. Fail-loud vóór PDF-render
    // en vóór storage-upload zodat we GEEN dunning_briefs-rij OF weeskopie in
    // de bucket achterlaten bij onvolledig adres.
    const addrCheck = validateCustomerAddress(customer);
    if (!addrCheck.ok) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(422).json({
        code: 'ADDRESS_INCOMPLETE',
        error: `Adres onvolledig — ontbreekt: ${addrCheck.missing.join(', ')}. Vul aan in TeamLeader (sync haalt 'm binnen een uur op) of via het klantdossier.`,
        missing_fields: addrCheck.missing,
      });
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
    // Layout — fase C5 (envelop-standaard):
    //   - Logo linksboven (op briefpapier-positie).
    //   - Afzender-blok rechtsboven (bedrijfsdata).
    //   - Geadresseerde in C5-vensterenvelop-slot (~50mm × ~55mm van
    //     linksboven, binnen 90mm × 40mm venster) → past bij 1x dubbelvouwen
    //     A4 in het venster van een standaard NL C5-envelop.
    //   - Landregel toegevoegd (Nederland/België) — verplicht voor BE-adressen.
    //   - Body-tekst begint onder het adresblok met veilige margin.
    const buffer = await new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({ size: 'A4', margin: 60 });
        const chunks = [];
        doc.on('data', (c) => chunks.push(c));
        doc.on('end',  () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        // ── Logo linksboven — fail-soft: bestaand branding-asset (img/logo-dark.png)
        //    of WIK_LOGO_PATH override. Als het bestand ontbreekt: skip
        //    (brief gaat door zonder logo, geen crash).
        const logoBuf = _tryLogoBuffer();
        if (logoBuf) {
          try {
            doc.image(logoBuf, mmToPt(15), mmToPt(15), {
              fit: [mmToPt(45), mmToPt(20)], // max 45mm × 20mm — houdt het logo klein/professioneel
              align: 'left',
              valign: 'top',
            });
          } catch (e) {
            console.warn('[incasso-pre-brief] logo-render faalde (skip):', e?.message || e);
          }
        }

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

        // ── Geadresseerde in C5-vensterenvelop-slot ────────────────────────
        // Positie exact berekend uit C5_ENVELOPE (safe-margin 5mm binnen 90×40mm venster).
        const adrPos = buildAddressBlockPosition();
        const geadresseerdeRaw = customer.is_company
          ? (customer.company_name || customerDisplayName(customer, ''))
          : customerDisplayName(customer, '');
        const addrLines = buildAddressBlockLines(customer, geadresseerdeRaw);
        doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
        let addrY = adrPos.y;
        const lineHeight = 12; // pt; past ~4-5 regels in 30mm safe-area
        for (const line of addrLines) {
          doc.text(sanitizeForPdf(line), adrPos.x, addrY, {
            width: adrPos.width,
            lineBreak: false,
          });
          addrY += lineHeight;
        }

        // Body-tekst begint ruim onder het venster (voorkom overlap bij lange
        // adresregels). Bewuste marge van 20mm onder venster-bottom.
        const bodyStartY = mmToPt(50 + 40 + 20); // window_top + window_height + margin

        // Datum + onderwerp — start onder het adresblok.
        doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
        doc.text('Datum: ' + fmtDateNl(new Date()), 60, bodyStartY);
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

    // 5) PERSISTENT BEWAREN (fase 6 kern-eis — juridisch bewijs).
    // Upload de exact-verstuurde PDF naar Supabase Storage EN maak een
    // dunning_briefs-rij zodat we altijd kunnen bewijzen wat er destijds
    // is gestuurd. Fail-loud bij fout: bewijs-opslag mag NIET stilletjes
    // falen — zonder bewaarde PDF is er geen bewijs.
    const BUCKET = 'dunning-briefs';
    const generatedAtIso = new Date().toISOString();
    const shortId = Math.random().toString(36).slice(2, 8);
    const storagePath = `${customerId}/${generatedAtIso.replace(/[:.]/g, '-')}-${shortId}.pdf`;

    const { error: upErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, buffer, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: false,
      });
    if (upErr) {
      console.error('[incasso-pre-brief] storage upload failed:', upErr.message);
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({
        error: 'PDF-opslag mislukt (bewijs kon niet bewaard worden): ' + upErr.message,
        code: 'STORAGE_UPLOAD_FAILED',
      });
    }

    // dunning_briefs-rij: koppelt bewaarde PDF aan klant + template + user.
    const { data: brief, error: brErr } = await supabaseAdmin
      .from('dunning_briefs')
      .insert({
        customer_id          : customerId,
        invoice_id           : null,
        template_code        : templateCode,
        country              : country,
        pdf_path             : storagePath,
        pdf_size_bytes       : buffer.length,
        generated_at         : generatedAtIso,
        generated_by_user_id : user.id,
      })
      .select('id, pdf_path')
      .maybeSingle();
    if (brErr || !brief) {
      // PDF is in storage, maar rij mislukt → verwijder de storage-file
      // (voorkomt weeskopieën in de bucket zonder rij).
      try { await supabaseAdmin.storage.from(BUCKET).remove([storagePath]); } catch {}
      console.error('[incasso-pre-brief] dunning_briefs insert failed:', brErr?.message);
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({
        error: 'Bewijs-rij aanmaken mislukt: ' + (brErr?.message || 'geen rij'),
        code: 'BRIEF_ROW_FAILED',
      });
    }

    // 6) Log — de create-guard checkt op dit event. brief_id + pdf_path
    // toegevoegd zodat timeline/pipeline direct naar het bewijs kan linken.
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
          brief_id     : brief.id,
          pdf_path     : brief.pdf_path,
        },
      });
    } catch (e) {
      console.warn('[incasso-pre-brief] dunning_log insert soft-fail', e?.message || e);
    }

    // 7) Stream als download. brief_id in response-header zodat de UI 'em
    // kan tonen (bv. "Bewijs opgeslagen, id: xxx") + latere email-verzending
    // dezelfde brief kan hergebruiken.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="pre-incassobrief_${country}_${customerId.slice(0, 8)}.pdf"`);
    res.setHeader('X-Brief-Id', brief.id);
    res.setHeader('X-Brief-Path', brief.pdf_path);
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[incasso-pre-brief]', e?.message || e);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
