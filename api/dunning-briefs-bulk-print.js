// api/dunning-briefs-bulk-print.js
//
// POST { brief_ids: [uuid, ...] } → 1 samengevoegde PDF met alle geselecteerde
// brieven achter elkaar (elke brief = eigen pagina('s), automatische page-break
// tussen brieven). Bedoeld voor de Wanbetalers → Brieven overzichtspagina:
// gebruiker vinkt N brieven aan, klikt "Print/Download selectie", krijgt 1 PDF
// die 'ie in 1 printjob kan printen (Cmd+P → 1x klik → alle brieven).
//
// KRITIEK: we mergen de BEWAARDE PDFs uit Supabase Storage (niet hergenereren).
// Reden: bewaarde PDF = juridisch bewijs. Wat je print MOET exact zijn wat er
// in dunning_briefs staat + later verstuurd wordt. Hergenereren zou het bewijs
// kunnen doen afwijken (template intussen aangepast, klant-adres bijgewerkt,
// enz.). Zie migratie 2026-07-30-dunning-briefs.sql voor volledige rationale.
//
// Auto-mark-downloaded: alle brieven in de request krijgen downloaded_at=now()
// en downloaded_by=user.id. Alleen als de merge slaagt EN de response start.
// Status "aangemaakt" → "gedownload" in de overzichtspagina.
//
// Request:   POST { brief_ids: [uuid, ...] }
//            Max 100 brieven per request (Vercel timeout 60s + geheugen).
// Response:  200 application/pdf (samengevoegde PDF, inline disposition zodat
//            de browser 'em direct kan tonen + printen).
//            Content-Disposition: inline; filename="wik-brieven-<N>-<datum>.pdf"
//            X-Briefs-Merged: <N>
//            X-Briefs-Skipped: <N>
// Errors:
//   400 MISSING_BRIEF_IDS / TOO_MANY / INVALID_UUID
//   404 NO_BRIEFS_FOUND
//   500 STORAGE_FETCH_FAILED / MERGE_FAILED / DB_UPDATE_FAILED
//
// Permission: finance.incasso.manage (mag brieven downloaden voor verzending).

import { PDFDocument } from 'pdf-lib';
import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'dunning-briefs';
const MAX_BRIEFS = 100;

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

  const rawIds = Array.isArray(body.brief_ids) ? body.brief_ids : [];
  const briefIds = Array.from(new Set(rawIds.map((s) => String(s || '').trim()).filter(Boolean)));
  if (briefIds.length === 0) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: 'brief_ids (array) verplicht', code: 'MISSING_BRIEF_IDS' });
  }
  if (briefIds.length > MAX_BRIEFS) {
    res.setHeader('Content-Type', 'application/json');
    return res.status(400).json({ error: `Max ${MAX_BRIEFS} brieven per print-batch`, code: 'TOO_MANY' });
  }
  for (const id of briefIds) {
    if (!UUID_RE.test(id)) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(400).json({ error: `Ongeldige uuid: ${id}`, code: 'INVALID_UUID' });
    }
  }

  try {
    // 1) Rijen ophalen — behoud volgorde van request (nieuwste eerst zoals UI vraagt).
    const { data: rows, error: selErr } = await supabaseAdmin
      .from('dunning_briefs')
      .select('id, customer_id, pdf_path, generated_at')
      .in('id', briefIds);
    if (selErr) throw new Error('select failed: ' + selErr.message);
    if (!rows || rows.length === 0) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(404).json({ error: 'Geen brieven gevonden voor de opgegeven IDs', code: 'NO_BRIEFS_FOUND' });
    }
    // Sorteer op volgorde van briefIds-array (UI-consistent).
    const rowById = new Map(rows.map((r) => [r.id, r]));
    const ordered = briefIds.map((id) => rowById.get(id)).filter(Boolean);

    // 2) Voor elke brief: fetch PDF bytes uit Storage → merge in nieuw doc.
    // Fail-soft per brief: als één PDF niet ophaalbaar is, tellen we 'em als
    // skipped en gaan door. Bij 0 gemerged → 500.
    const merged = await PDFDocument.create();
    let mergedCount = 0;
    let skippedCount = 0;
    const skippedIds = [];

    for (const row of ordered) {
      try {
        const { data: pdfBlob, error: dlErr } = await supabaseAdmin.storage
          .from(BUCKET)
          .download(row.pdf_path);
        if (dlErr || !pdfBlob) {
          console.warn('[dunning-briefs-bulk-print] storage download failed for', row.pdf_path, dlErr?.message);
          skippedCount++; skippedIds.push(row.id);
          continue;
        }
        // Blob → Uint8Array voor pdf-lib.
        const arrayBuffer = await pdfBlob.arrayBuffer();
        const srcPdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
        // Kopieer ALLE pagina's van deze brief naar het merged doc.
        // Elke brief eindigt automatisch bij de laatste pagina; de volgende
        // brief begint op een verse pagina — dus impliciete page-break tussen
        // brieven zonder handmatige addPage() nodig.
        const pages = await merged.copyPages(srcPdf, srcPdf.getPageIndices());
        for (const p of pages) merged.addPage(p);
        mergedCount++;
      } catch (e) {
        console.warn('[dunning-briefs-bulk-print] merge failed for brief', row.id, e?.message || e);
        skippedCount++; skippedIds.push(row.id);
      }
    }

    if (mergedCount === 0) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(500).json({
        error: 'Geen enkele brief kon worden samengevoegd — controleer storage-toegang.',
        code: 'MERGE_FAILED',
        skipped_ids: skippedIds,
      });
    }

    // 3) Serialize merged PDF → Buffer.
    const mergedBytes = await merged.save();
    const buffer = Buffer.from(mergedBytes);

    // 4) Auto-mark-downloaded voor alle brieven die gemergd zijn (skipped
    // krijgen géén downloaded_at want de gebruiker heeft ze niet gedownload).
    // Fail-soft: als de update faalt, retourneren we alsnog de PDF (gebruiker
    // moet kunnen printen; status corrigeer je later handmatig).
    const mergedIds = ordered.filter((r) => !skippedIds.includes(r.id)).map((r) => r.id);
    if (mergedIds.length > 0) {
      try {
        const { error: updErr } = await supabaseAdmin
          .from('dunning_briefs')
          .update({
            downloaded_at: new Date().toISOString(),
            downloaded_by: user.id,
          })
          .in('id', mergedIds);
        if (updErr) console.warn('[dunning-briefs-bulk-print] mark-downloaded soft-fail:', updErr.message);
      } catch (e) {
        console.warn('[dunning-briefs-bulk-print] mark-downloaded exception:', e?.message);
      }
    }

    // 5) Log-event (fail-soft).
    try {
      await supabaseAdmin.from('dunning_log').insert({
        run_id: null, step_id: null,
        event_type: 'incasso_pre_brief_bulk_printed',
        payload: {
          user_id: user.id,
          brief_ids: mergedIds,
          skipped_ids: skippedIds,
          merged_count: mergedCount,
          skipped_count: skippedCount,
        },
      });
    } catch (_) {}

    // 6) Stream als PDF — inline zodat browser 'em direct rendert +
    // gebruiker Cmd+P kan doen voor één printjob.
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `wik-brieven-${mergedCount}-${dateStr}.pdf`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('X-Briefs-Merged', String(mergedCount));
    res.setHeader('X-Briefs-Skipped', String(skippedCount));
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[dunning-briefs-bulk-print]', e?.message || e);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
