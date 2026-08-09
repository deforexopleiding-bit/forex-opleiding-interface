// api/dunning-brief-delete.js
// POST → verwijder één of meer dunning_briefs-rijen + hun bewaarde PDF in storage.
//
// HARD DELETE (geen soft-delete): de rij wordt verwijderd én het PDF-bestand in
// de 'dunning-briefs'-bucket opgeruimd (geen weesbestanden). Achter een
// bevestigingsdialoog in de UI + deze permissie-gate.
// LET OP: dunning_briefs is juridisch bewijs van verstuurde WIK-brieven —
// verwijderen is definitief en niet herstelbaar.
//
// Request: POST { brief_ids: [uuid, ...] }   (single = array van 1; brief_id ook toegestaan)
// Response 200: { ok: true, deleted: N, storage_removed: M, storage_failed: K }
// Errors: 400 MISSING_BRIEF_IDS / TOO_MANY · 404 NOT_FOUND · 500 DB_DELETE_FAILED
//
// Permission: finance.incasso.manage (zelfde als de overige brief-acties).

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'dunning-briefs';
const MAX_IDS = 500;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.incasso.manage'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.incasso.manage)' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // brief_ids (array) óf één brief_id → unieke, gevalideerde lijst.
  const raw = Array.isArray(body.brief_ids) ? body.brief_ids
            : (body.brief_id ? [body.brief_id] : []);
  const ids = Array.from(new Set(
    raw.map((x) => String(x || '').trim()).filter((x) => UUID_RE.test(x))
  ));
  if (ids.length === 0) {
    return res.status(400).json({ error: 'brief_ids (uuid-array) vereist', code: 'MISSING_BRIEF_IDS' });
  }
  if (ids.length > MAX_IDS) {
    return res.status(400).json({ error: `Maximaal ${MAX_IDS} brieven per keer`, code: 'TOO_MANY' });
  }

  try {
    // 1) Paden ophalen VÓÓR de delete, zodat we exact die PDF's kunnen opruimen.
    const { data: rows, error: selErr } = await supabaseAdmin
      .from('dunning_briefs')
      .select('id, pdf_path')
      .in('id', ids);
    if (selErr) throw new Error('lookup: ' + selErr.message);
    const found = rows || [];
    if (found.length === 0) {
      return res.status(404).json({ error: 'Geen brieven gevonden', code: 'NOT_FOUND' });
    }
    const foundIds = found.map((r) => r.id);

    // 2) Rijen verwijderen.
    const { error: delErr } = await supabaseAdmin
      .from('dunning_briefs')
      .delete()
      .in('id', foundIds);
    if (delErr) {
      console.error('[dunning-brief-delete] delete failed:', delErr.message);
      return res.status(500).json({ error: 'Verwijderen mislukt: ' + delErr.message, code: 'DB_DELETE_FAILED' });
    }

    // 3) Bijbehorende PDF's opruimen (best-effort). De rij is al weg; een
    //    storage-fout mag de delete niet laten falen (levert hooguit een klein
    //    weesbestand op, geen data-verlies). Voorkomt normaliter weesbestanden.
    const paths = found.map((r) => r.pdf_path).filter(Boolean);
    let storageRemoved = 0;
    let storageFailed = 0;
    if (paths.length > 0) {
      try {
        const { data: rm, error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove(paths);
        if (rmErr) {
          storageFailed = paths.length;
          console.warn('[dunning-brief-delete] storage remove fail:', rmErr.message);
        } else {
          storageRemoved = Array.isArray(rm) ? rm.length : paths.length;
        }
      } catch (e) {
        storageFailed = paths.length;
        console.warn('[dunning-brief-delete] storage remove exception:', e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      deleted: foundIds.length,
      storage_removed: storageRemoved,
      storage_failed: storageFailed,
    });
  } catch (e) {
    console.error('[dunning-brief-delete]', e?.message || e);
    return res.status(500).json({ error: e?.message || 'Interne fout' });
  }
}
