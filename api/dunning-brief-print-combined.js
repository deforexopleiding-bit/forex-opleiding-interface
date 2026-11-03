// api/dunning-brief-print-combined.js
//
// POST { brief_id } -> EEN gecombineerde PDF = de bewaarde brief-PDF met
// daarachter alle openstaande factuur-PDF's van die klant. Bedoeld voor het
// download/post-pad: de gebruiker downloadt alles in 1 keer, print het en
// stuurt het per post.
//
// Dit is PUUR een lees-/stream-pad. De bewaarde bucket-PDF (juridisch bewijs)
// blijft ONAANGERAAKT; we concateneren alleen in de response-stream. De kale
// "Bewijs"-download (directe signed URL) en het e-mailpad (losse bijlagen)
// veranderen niet.
//
// KRITIEK (zelfde rationale als dunning-briefs-bulk-print.js): we mergen de
// BEWAARDE brief-PDF uit Supabase Storage, niet een hergegenereerde versie.
//
// FAIL-SOFT per factuur (exact het e-mailpad-patroon): mislukt een factuur-PDF,
// dan komt de brief + de overige facturen alsnog in de PDF, en loggen we de
// miss in dunning_log (event 'incasso_brief_factuur_pdf_gemist', reden
// geen_open_facturen / geen_tl_invoice_id / download_mislukt /
// attachment_exception). Een ontbrekende factuur breekt NOOIT de download.
// Alleen de brief-PDF zelf is hard vereist: mislukt die, dan 500.
//
// Request:  POST { brief_id: uuid }
// Response: 200 application/pdf (inline), header X-Facturen-Bijgevoegd: <N>
// Errors:   400 MISSING_BRIEF_ID, 404 NOT_FOUND,
//           500 STORAGE_DOWNLOAD_FAILED / MERGE_FAILED / interne fout
//
// Permission: finance.incasso.manage.

import { PDFDocument } from 'pdf-lib';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { fetchOpenInvoicesForCustomer } from './_lib/incasso-pre-brief-core.js';
import { fetchInvoicePdfBuffer } from './_lib/teamleader-invoice-pdf.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'dunning-briefs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.setHeader('Content-Type', 'application/json');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(401).json({ error: 'Niet geauthenticeerd' });
  }
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const briefId = body.brief_id ? String(body.brief_id).trim() : '';
  if (!briefId || !UUID_RE.test(briefId)) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: 'brief_id (uuid) vereist', code: 'MISSING_BRIEF_ID' });
  }

  // Log-helpertje: dunning_log mag de download NOOIT breken (fail-soft).
  const logBijlageGemist = async (customerId, payloadExtra) => {
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id: null, step_id: null,
        event_type: 'incasso_brief_factuur_pdf_gemist',
        payload: { customer_id: customerId, brief_id: briefId, bron: 'print_combined', ...payloadExtra },
      });
    } catch (_) {}
  };

  try {
    // 1) Brief-rij ophalen.
    const { data: brief, error: brErr } = await supabaseAdmin
      .from('dunning_briefs')
      .select('id, customer_id, pdf_path')
      .eq('id', briefId)
      .maybeSingle();
    if (brErr) throw new Error('brief lookup: ' + brErr.message);
    if (!brief) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(404).json({ error: 'Brief niet gevonden', code: 'NOT_FOUND' });
    }

    // 2) Bewaarde brief-PDF downloaden uit storage (hard vereist).
    const { data: fileBlob, error: dlErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(brief.pdf_path);
    if (dlErr || !fileBlob) {
      console.error('[dunning-brief-print-combined] storage download failed:', dlErr?.message);
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({
        error: 'PDF-download uit storage mislukt: ' + (dlErr?.message || 'geen blob'),
        code: 'STORAGE_DOWNLOAD_FAILED',
      });
    }
    const briefBytes = await fileBlob.arrayBuffer();

    // 3) Merge: eerst de brief-pagina's, dan de factuur-pagina's.
    const merged = await PDFDocument.create();
    let briefPaginas = 0;
    try {
      const briefPdf = await PDFDocument.load(briefBytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(briefPdf, briefPdf.getPageIndices());
      for (const p of pages) merged.addPage(p);
      briefPaginas = pages.length;
    } catch (e) {
      console.error('[dunning-brief-print-combined] brief-PDF merge faalde:', e?.message || e);
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: 'Brief-PDF kon niet worden geladen', code: 'MERGE_FAILED' });
    }

    // 4) Openstaande facturen ophalen + per factuur de TL-PDF mergen.
    //    Fail-soft per factuur; de brief staat al in de merged doc.
    let facturenBijgevoegd = 0;
    try {
      const { openInvoices } = await fetchOpenInvoicesForCustomer(brief.customer_id);
      if (!openInvoices || openInvoices.length === 0) {
        await logBijlageGemist(brief.customer_id, { reden: 'geen_open_facturen' });
      } else {
        const gemist = [];
        for (const iv of openInvoices) {
          const buf = iv.tl_invoice_id ? await fetchInvoicePdfBuffer(iv.tl_invoice_id) : null;
          if (!buf) {
            gemist.push({ invoice_id: iv.id, invoice_number: iv.invoice_number || null, reden: iv.tl_invoice_id ? 'download_mislukt' : 'geen_tl_invoice_id' });
            continue;
          }
          try {
            const invPdf = await PDFDocument.load(buf, { ignoreEncryption: true });
            const pages = await merged.copyPages(invPdf, invPdf.getPageIndices());
            for (const p of pages) merged.addPage(p);
            facturenBijgevoegd++;
          } catch (e) {
            // PDF opgehaald maar niet te laden/mergen -> zelfde categorie als download_mislukt.
            gemist.push({ invoice_id: iv.id, invoice_number: iv.invoice_number || null, reden: 'download_mislukt' });
          }
        }
        if (gemist.length) await logBijlageGemist(brief.customer_id, { gemist });
      }
    } catch (e) {
      console.warn('[dunning-brief-print-combined] factuur-bijlagen overgeslagen (fail-soft):', e?.message || e);
      await logBijlageGemist(brief.customer_id, { reden: 'attachment_exception', message: String(e?.message || e).slice(0, 500) });
    }

    // 5) Serialize + stream (inline, zodat de browser direct toont + printen kan).
    const mergedBytes = await merged.save();
    const buffer = Buffer.from(mergedBytes);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `brief-met-facturen_${brief.customer_id.slice(0, 8)}_${dateStr}.pdf`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('X-Facturen-Bijgevoegd', String(facturenBijgevoegd));
    res.setHeader('X-Brief-Paginas', String(briefPaginas));
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[dunning-brief-print-combined]', e?.message || e);
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({ error: e?.message || 'Interne fout' });
    }
  }
}
