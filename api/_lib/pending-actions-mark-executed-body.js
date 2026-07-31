// api/_lib/pending-actions-mark-executed-body.js
//
// Pure helper voor de UI-body-serialisatie richting
// /api/pending-actions-mark-executed. Endpoint eist strict:
//
//   {
//     id: uuid,
//     execution_result: {
//       outcome:      <enum uit MANUAL_*_OUTCOMES set>,
//       manual_notes: string (min 10 chars, verplicht),
//       ...andere action-type-specifieke velden (call_log_id, matched_transaction_id, ...)
//     }
//   }
//
// Callers in finance.html (Acties-werkcentrum knoppen) hadden een tijd de body
// als { id, outcome, reason } op top-level gestuurd → 400
// "execution_result (object) vereist". Deze helper is de single-source-of-truth
// voor de body-shape zodat regressies direct in tests zichtbaar zijn. Het feit
// dat de client-code deze helper (nog) niet importeert is een gevolg van de
// inline-JS architectuur van finance.html; de tests bewaken de shape en de
// inline-code houdt zich hieraan tot een refactor dit trekt.

/**
 * Bouwt de body voor pending-actions-mark-executed.
 *
 * @param {object} args
 * @param {string} args.id            pending_action.id (uuid, caller valideert)
 * @param {string} args.outcome       outcome-enum (bv. 'closed_manually', 'resolved')
 * @param {string} [args.reason]      optionele reden uit wbxOpenConfirm requireReason
 * @param {string} args.fallbackNotes wat er in manual_notes komt als reason leeg/<10 chars
 * @param {object} [args.extra]       optionele extra velden voor execution_result
 *                                    (call_log_id, matched_transaction_id, handed_over_to)
 * @returns {object} body die exact matcht met wat het endpoint verwacht
 */
export function buildMarkExecutedBody({ id, outcome, reason, fallbackNotes, extra }) {
  const trimmed = (typeof reason === 'string') ? reason.trim() : '';
  const notes   = (trimmed.length >= 10) ? trimmed : String(fallbackNotes || '');
  const execution_result = { outcome, manual_notes: notes };
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== null && v !== '') execution_result[k] = v;
    }
  }
  return { id, execution_result };
}
