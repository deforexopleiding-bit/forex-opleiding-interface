// api/_lib/dunning-briefs-selectie.js
//
// Eén bron voor "welke brieven, in welke volgorde" bij een selectie uit
// Wanbetalers → Brieven. Gedeeld door:
//   - api/dunning-briefs-bulk-print.js  (PDF-bundel)
//   - api/dunning-briefs-labels.js      (adreslabels)
// zodat de labels altijd in exact dezelfde volgorde liggen als de bundel.
//
// Volgorde = de volgorde van brief_ids in het verzoek (dubbels weg, eerste telt),
// onbekende ids vallen weg.

export const BRIEF_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BRIEFS_PER_SELECTIE = 100;

/**
 * Lees + valideer brief_ids uit de request-body.
 * @returns {{ ok: true, ids: string[] } | { ok: false, status: number, code: string, error: string }}
 */
export function leesBriefIds(body, { max = MAX_BRIEFS_PER_SELECTIE, maxLabel = 'print-batch' } = {}) {
  let b = body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
  b = b || {};
  const rawIds = Array.isArray(b.brief_ids) ? b.brief_ids : [];
  const ids = Array.from(new Set(rawIds.map((s) => String(s || '').trim()).filter(Boolean)));
  if (ids.length === 0) return { ok: false, status: 400, code: 'MISSING_BRIEF_IDS', error: 'brief_ids (array) verplicht' };
  if (ids.length > max) return { ok: false, status: 400, code: 'TOO_MANY', error: `Max ${max} brieven per ${maxLabel}` };
  for (const id of ids) {
    if (!BRIEF_UUID_RE.test(id)) return { ok: false, status: 400, code: 'INVALID_UUID', error: `Ongeldige uuid: ${id}` };
  }
  return { ok: true, ids };
}

/** Puur: zet rijen in de volgorde van briefIds; onbekende ids vallen weg. */
export function ordenBriefRijen(briefIds, rows) {
  const rowById = new Map((rows || []).map((r) => [r.id, r]));
  return (briefIds || []).map((id) => rowById.get(id)).filter(Boolean);
}

/**
 * Haal de dunning_briefs-rijen op en orden ze zoals de selectie.
 * @returns {Promise<object[]>} geordende rijen (kan leeg zijn)
 */
export async function laadGeordendeBrieven(db, briefIds, select) {
  const { data: rows, error } = await db
    .from('dunning_briefs')
    .select(select)
    .in('id', briefIds);
  if (error) throw new Error('select failed: ' + error.message);
  return ordenBriefRijen(briefIds, rows || []);
}
