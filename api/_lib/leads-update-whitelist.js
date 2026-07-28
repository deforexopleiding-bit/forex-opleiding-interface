// api/_lib/leads-update-whitelist.js
// Pure helper: bouw een veilige UPDATE-payload voor leads. HARDE whitelist —
// alleen status/notitie/eigenaar_id komen door, ongeacht wat er in de body
// zit. Vastleg-velden (kwalificatie/score/drempel/afwijzer/antwoorden) worden
// STIL genegeerd. Geen Supabase, geen HTTP.

const ALLOWED_STATUS = new Set(['nieuw', 'opgevolgd', 'gewonnen', 'verloren']);

/**
 * Bouwt de UPDATE-payload op basis van een request-body. Retourneert:
 *   { patch: {status?, notitie?, eigenaar_id?}, error?: string, rejected: string[] }
 *
 * - Onbekende/vastleg-velden komen NIET in patch (worden in `rejected` gelogd
 *   voor audit-doel maar niet als error — dat matcht "hard weigeren zonder
 *   crashen"; de audit-log kan gebruikt worden om misbruik te detecteren).
 * - `status` moet in ALLOWED_STATUS zitten of er komt een error.
 * - `notitie` mag NULL/'' zijn (leegmaken toegestaan) of string.
 * - `eigenaar_id` mag NULL zijn (toewijzing weghalen) of een niet-lege string.
 * - Patch mag leeg zijn (dan is er niks te wijzigen — caller kan besluiten
 *   200 OK terug te geven of een "no-op"-melding).
 *
 * @param {object|null|undefined} body
 * @returns {{ patch: object, error?: string, rejected: string[] }}
 */
export function buildLeadUpdatePatch(body) {
  const patch = {};
  const rejected = [];
  const src = body && typeof body === 'object' ? body : {};

  // ── Whitelist keys ──
  const ALLOWED_KEYS = new Set(['status', 'notitie', 'eigenaar_id', 'id']);
  for (const k of Object.keys(src)) {
    if (!ALLOWED_KEYS.has(k)) rejected.push(k);
  }

  // ── status ──
  if (Object.prototype.hasOwnProperty.call(src, 'status')) {
    const s = src.status;
    if (s === null || s === undefined || s === '') {
      // niet meegeven i.p.v. NULL — status is NOT NULL in de DB waarschijnlijk
    } else if (typeof s !== 'string' || !ALLOWED_STATUS.has(s)) {
      return { patch: {}, error: `Ongeldige status: ${JSON.stringify(s)}. Toegestaan: ${[...ALLOWED_STATUS].join(', ')}`, rejected };
    } else {
      patch.status = s;
    }
  }

  // ── notitie ──
  if (Object.prototype.hasOwnProperty.call(src, 'notitie')) {
    const n = src.notitie;
    if (n === null || n === '') {
      patch.notitie = null;
    } else if (typeof n === 'string') {
      patch.notitie = n.slice(0, 10000);  // max 10k chars, defensief
    } else {
      return { patch: {}, error: 'notitie moet string of NULL zijn', rejected };
    }
  }

  // ── eigenaar_id ──
  if (Object.prototype.hasOwnProperty.call(src, 'eigenaar_id')) {
    const e = src.eigenaar_id;
    if (e === null || e === '') {
      patch.eigenaar_id = null;
    } else if (typeof e === 'string' && e.trim().length > 0) {
      patch.eigenaar_id = e.trim();
    } else {
      return { patch: {}, error: 'eigenaar_id moet UUID-string of NULL zijn', rejected };
    }
  }

  return { patch, rejected };
}

export { ALLOWED_STATUS };
