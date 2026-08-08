// api/_lib/incasso-pre-brief-core.js
//
// Gedeelde WIK-brief-generator: rendert de WIK-14-dagenbrief (NL) of de eerste
// (kosteloze) herinnering (BE), uploadt de PDF naar de dunning-briefs-bucket,
// en maakt een dunning_briefs-bewijsrij + dunning_log-regel aan.
//
// Geëxtraheerd uit api/incasso-pre-brief.js zodat ZOWEL de handmatige
// "stuur pre-incassobrief"-knop ALS de dunning-engine (auto-generatie op de
// dag-21-WhatsApp, step_order 12) exact dezelfde brief produceren — één bron
// van waarheid, geen gedupliceerde briefslogica.
//
// Verschil t.o.v. de HTTP-handler: deze functie raakt GEEN res aan. Ze geeft
// een gestructureerd resultaat terug; de caller bepaalt de HTTP-respons of de
// engine-log. Bij een onvolledig adres of duplicaat FAALT ze niet hard —
// ze geeft een code terug zodat de engine fail-soft kan doorlopen.
//
// generatePreBriefForCustomer({ customerId, country?, generatedByUserId?, runId?, stepId?, db? })
//   → { ok:true,  brief_id, pdf_path, pdf_size_bytes, buffer, country, template_code }
//   | { ok:false, code:'ADDRESS_INCOMPLETE',   missing:[…] }
//   | { ok:false, code:'DUPLICATE_RUN_BRIEF',  error }         // partial-unique (run_id) backstop
//   | { ok:false, code:'CUSTOMER_NOT_FOUND'  | 'TEMPLATE_NOT_FOUND'
//              | 'STORAGE_UPLOAD_FAILED' | 'BRIEF_ROW_FAILED', error }
//
// Systeemcontext (engine): generatedByUserId = null → generated_by_user_id NULL
// (de kolom is nullable met ON DELETE SET NULL). db = supabaseAdmin bypasst RLS
// zoals de bestaande endpoints; er is geen ingelogde manager nodig.

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import { supabaseAdmin } from '../supabase.js';
import { customerDisplayName } from './customer-name.js';
import { resolveVariables } from './template-variables.js';
import { sanitizeForPdf } from './incasso-pdf.js';
import {
  validateCustomerAddress,
  buildAddressBlockPosition,
  buildAddressBlockLines,
  mmToPt,
} from './wik-brief-layout.js';
// Base64-embedded logo — WERKT op Vercel serverless. Zie kop-comment in
// wik-brief-logo.js waarom dit patroon nodig is (img/ wordt niet meegebundeld
// door Vercel; alleen JS-modules geïmporteerd vanuit een function komen mee).
import { WIK_LOGO_BUFFER } from './wik-brief-logo.js';

const OPEN_STATUSES = ['open', 'partially_paid', 'overdue'];
const BUCKET = 'dunning-briefs';

function fmtDateNl(d) {
  const dt = d instanceof Date ? d : new Date(d || Date.now());
  const mm = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  return `${dt.getDate()} ${mm[dt.getMonth()]} ${dt.getFullYear()}`;
}

/**
 * Kies het logo-buffer voor pdfkit doc.image(). Prio: env WIK_LOGO_PATH
 * (filesystem) → WIK_LOGO_BUFFER (base64-embedded default). Returns Buffer of
 * null (null → generator slaat logo over, fail-soft).
 */
function _resolveLogoBuffer() {
  const override = process.env.WIK_LOGO_PATH;
  if (override) {
    try {
      const abs = path.isAbsolute(override) ? override : path.join(process.cwd(), override);
      if (fs.existsSync(abs)) return fs.readFileSync(abs);
      console.warn('[incasso-pre-brief-core] WIK_LOGO_PATH bestaat niet, fallback naar embedded:', abs);
    } catch (e) {
      console.warn('[incasso-pre-brief-core] WIK_LOGO_PATH read-fout, fallback naar embedded:', e?.message || e);
    }
  }
  return WIK_LOGO_BUFFER || null;
}

/**
 * Render de brief-PDF (identieke C5-envelop-layout als de handmatige knop).
 * Puur in-memory; geen storage/DB. Returnt een Buffer.
 */
function renderBriefPdf({ customer, resolvedSubject, resolvedBody }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 60 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end',  () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // ── Logo linksboven — base64-embedded (Vercel-compat). Fail-soft.
      const logoBuf = _resolveLogoBuffer();
      if (logoBuf) {
        try {
          doc.image(logoBuf, mmToPt(15), mmToPt(15), {
            fit: [mmToPt(45), mmToPt(20)], // max 45mm × 20mm
            align: 'left',
            valign: 'top',
          });
        } catch (e) {
          console.warn('[incasso-pre-brief-core] logo-render faalde (skip):', e?.message || e);
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

      // ── Geadresseerde in C5-vensterenvelop-slot ──────────────────────────
      const adrPos = buildAddressBlockPosition();
      const geadresseerdeRaw = customer.is_company
        ? (customer.company_name || customerDisplayName(customer, ''))
        : customerDisplayName(customer, '');
      const addrLines = buildAddressBlockLines(customer, geadresseerdeRaw);
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
      let addrY = adrPos.y;
      const lineHeight = 12; // pt
      for (const line of addrLines) {
        doc.text(sanitizeForPdf(line), adrPos.x, addrY, {
          width: adrPos.width,
          lineBreak: false,
        });
        addrY += lineHeight;
      }

      // Body begint ruim onder het venster (20mm marge onder venster-bottom).
      const bodyStartY = mmToPt(50 + 40 + 20);

      doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
      doc.text('Datum: ' + fmtDateNl(new Date()), 60, bodyStartY);
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).text('Onderwerp: ' + (resolvedSubject || ''), 60);
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
      doc.moveDown(1);

      const paragraphs = String(resolvedBody || '').split(/\n{2,}/);
      for (const p of paragraphs) {
        doc.text(p.replace(/\n/g, ' '), 60, doc.y, { width: 475, align: 'left' });
        doc.moveDown(0.6);
      }

      // Bewuste keuze: GEEN "Gegenereerd door ..."-voetnoot — WIK is een
      // formeel juridisch document; interne systeem-info hoort er niet op.
      doc.end();
    } catch (e) { reject(e); }
  });
}

/**
 * Genereer + bewaar de WIK-/pre-incassobrief voor één klant.
 *
 * Volgorde: klant → land/template → adres-gate → open facturen → variabelen →
 * PDF → storage-upload → dunning_briefs-rij → dunning_log. Bij fout ná upload
 * wordt de storage-file opgeruimd (geen weeskopieën).
 *
 * @param {object}   opts
 * @param {string}   opts.customerId          UUID van de klant.
 * @param {'NL'|'BE'|null} [opts.country]     Expliciet land; null → afgeleid uit customer.address_country.
 * @param {string|null} [opts.generatedByUserId] auth.users.id, of null voor systeem (engine).
 * @param {string|null} [opts.runId]          dunning_workflow_runs.id (cyclus-sleutel) of null (handmatig).
 * @param {string|null} [opts.stepId]         dunning_workflow_steps.id of null.
 * @param {object}   [opts.db]                Supabase-client (default supabaseAdmin).
 */
export async function generatePreBriefForCustomer({
  customerId,
  country = null,
  generatedByUserId = null,
  runId = null,
  stepId = null,
  db = supabaseAdmin,
} = {}) {
  // 1) Klant ophalen (altijd nodig: adres + naam + land-afleiding).
  const { data: customer, error: cErr } = await db
    .from('customers')
    .select('id, first_name, last_name, company_name, is_company, email, phone, address_street, address_number, address_postal, address_city, address_country, archived_at, anonymized_at')
    .eq('id', customerId).maybeSingle();
  if (cErr)      return { ok: false, code: 'CUSTOMER_NOT_FOUND', error: 'customers lookup: ' + cErr.message };
  if (!customer) return { ok: false, code: 'CUSTOMER_NOT_FOUND', error: 'Klant niet gevonden' };

  // 2) Land + template-code. Expliciet meegegeven land wint (handmatige knop);
  //    anders afleiden uit het klant-adresland (engine: NL default, BE indien 'BE').
  const resolvedCountry = country === 'BE' ? 'BE'
    : country === 'NL' ? 'NL'
    : (customer.address_country === 'BE' ? 'BE' : 'NL');
  const templateCode = resolvedCountry === 'BE' ? 'incasso_pre_be' : 'incasso_pre_nl';

  // 3) Template ophalen (bewerkbaar in de Templates-tab).
  const { data: tpl } = await db
    .from('dunning_templates')
    .select('id, code, name, kind, subject, body, is_active')
    .eq('code', templateCode).eq('kind', 'brief').eq('is_active', true)
    .maybeSingle();
  if (!tpl) {
    return { ok: false, code: 'TEMPLATE_NOT_FOUND', error: `Template '${templateCode}' niet gevonden of niet actief. Draai migratie 038.` };
  }

  // 4) ADRES-GATE (juridische veiligheid). Onvolledig adres → geen rechtsgeldig
  //    afleverbare brief. Fail vóór render/upload → geen rij én geen weeskopie.
  const addrCheck = validateCustomerAddress(customer);
  if (!addrCheck.ok) {
    return { ok: false, code: 'ADDRESS_INCOMPLETE', missing: addrCheck.missing };
  }

  // 5) Open facturen voor de variabele-context (klant.totaal_open).
  const { data: invs } = await db
    .from('invoices')
    .select('id, invoice_number, amount_total, amount_paid, credited_amount, due_date, issue_date, status')
    .eq('customer_id', customerId).in('status', OPEN_STATUSES);
  const openInvoices = (invs || []).filter((iv) => {
    const t = Number(iv.amount_total) || 0;
    const p = Number(iv.amount_paid) || 0;
    const c = Number(iv.credited_amount) || 0;
    return Math.max(0, t - p - c) > 0;
  });

  // 5b) Contract-context voor klant.totaal_resterend (+ indicaties): actieve
  //     subscriptions van de klant (via deals) + het reeds betaalde. Fail-soft —
  //     lukt dit niet, dan valt totaal_resterend terug op het reeds-vervallen
  //     totaal (zie berekenTotaalResterend). De brief mag hier nooit op falen.
  let subscriptions = [];
  let betaaldTotaal = 0;
  try {
    const { data: deals } = await db
      .from('deals')
      .select('id')
      .eq('customer_id', customerId)
      .is('archived_at', null)
      .in('status', ['active', 'paused', 'delinquent', 'disputed']); // niet 'completed'/'deceased'
    const dealIds = (deals || []).map((d) => d.id);
    if (dealIds.length) {
      const { data: subs } = await db
        .from('subscriptions')
        .select('amount, term_count, vat_percentage, status')
        .in('deal_id', dealIds)
        .neq('status', 'completed');
      subscriptions = subs || [];
    }
    const { data: paidRows } = await db
      .from('invoices')
      .select('amount_paid')
      .eq('customer_id', customerId);
    betaaldTotaal = (paidRows || []).reduce((s, r) => s + (Number(r.amount_paid) || 0), 0);
  } catch (e) {
    console.warn('[incasso-pre-brief-core] resterend-context fail-soft:', e?.message || e);
  }

  // 6) Variabelen resolven — klant.naam / klant.adres_volledig / klant.totaal_open
  //    / klant.incassokosten / klant.totaal_na_termijn / klant.totaal_resterend / indicaties.
  const briefContext = { customer, openInvoices, subscriptions, betaaldTotaal };
  const { text: resolvedSubject } = resolveVariables(tpl.subject || '', null, briefContext);
  const { text: resolvedBody }    = resolveVariables(tpl.body    || '', null, briefContext);

  // 7) PDF renderen (identieke C5-layout).
  const buffer = await renderBriefPdf({ customer, resolvedSubject, resolvedBody });

  // 8) PERSISTENT BEWAREN (juridisch bewijs) — upload + rij. Fail-loud (codes).
  const generatedAtIso = new Date().toISOString();
  const shortId = Math.random().toString(36).slice(2, 8);
  const storagePath = `${customerId}/${generatedAtIso.replace(/[:.]/g, '-')}-${shortId}.pdf`;

  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: 'application/pdf', cacheControl: '3600', upsert: false });
  if (upErr) {
    console.error('[incasso-pre-brief-core] storage upload failed:', upErr.message);
    return { ok: false, code: 'STORAGE_UPLOAD_FAILED', error: upErr.message };
  }

  // dunning_briefs-rij. run_id = cyclus-sleutel (dedup via partial-unique index).
  const { data: brief, error: brErr } = await db
    .from('dunning_briefs')
    .insert({
      customer_id          : customerId,
      invoice_id           : null,
      run_id               : runId,
      template_code        : templateCode,
      country              : resolvedCountry,
      pdf_path             : storagePath,
      pdf_size_bytes       : buffer.length,
      generated_at         : generatedAtIso,
      generated_by_user_id : generatedByUserId,
    })
    .select('id, pdf_path')
    .maybeSingle();
  if (brErr || !brief) {
    // PDF is geüpload maar de rij mislukte → storage-file opruimen (geen weeskopie).
    try { await db.storage.from(BUCKET).remove([storagePath]); } catch {}
    // 23505 = unique-violation op de partial-unique index (run_id) → er bestaat
    // al een auto-brief voor deze run (race tussen twee cron-ticks). Benigne
    // duplicaat, geen echte fout.
    if (brErr?.code === '23505') {
      return { ok: false, code: 'DUPLICATE_RUN_BRIEF', error: brErr.message };
    }
    console.error('[incasso-pre-brief-core] dunning_briefs insert failed:', brErr?.message);
    return { ok: false, code: 'BRIEF_ROW_FAILED', error: brErr?.message || 'geen rij' };
  }

  // 9) Log — de create-guard checkt op dit event. auto_generated + run_id/step_id
  //    zodat de pipeline-timeline de auto-brief kan onderscheiden en linken.
  try {
    await db.from('dunning_log').insert({
      run_id     : runId,
      step_id    : stepId,
      event_type : 'incasso_pre_brief_sent',
      payload    : {
        customer_id   : customerId,
        country       : resolvedCountry,
        template_code : templateCode,
        template_id   : tpl.id,
        brief_id      : brief.id,
        pdf_path      : brief.pdf_path,
        auto_generated: !!runId,
      },
    });
  } catch (e) {
    console.warn('[incasso-pre-brief-core] dunning_log insert soft-fail', e?.message || e);
  }

  return {
    ok: true,
    brief_id: brief.id,
    pdf_path: brief.pdf_path,
    pdf_size_bytes: buffer.length,
    buffer,
    country: resolvedCountry,
    template_code: templateCode,
  };
}
