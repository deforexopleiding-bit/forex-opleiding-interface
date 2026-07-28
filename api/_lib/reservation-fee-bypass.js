// api/_lib/reservation-fee-bypass.js
// Pure helper: valideer een reserveringsfee-bypass-verzoek.
// Geen Supabase, geen HTTP-side-effects — deterministisch testbaar.

/**
 * Chirurgisch: bepaalt ALLEEN of Guard A (late-start) en Guard B (fee-factuur)
 * in api/sales-subscription-create.js mogen worden overgeslagen. Alle andere
 * validaties bij abbo-aanmaak blijven onaangeroerd.
 *
 * Fail-secure: bypass wordt alleen goedgekeurd als
 *   (a) body.bypass_reservation_fee === true (strict boolean),
 *   (b) hasPermission === true (server-side te bepalen door caller via
 *       requirePermission('sales.reservation_fee.bypass')),
 *   (c) een geldige reden (min. 10 chars na trim) is meegegeven.
 *
 * (b) faalt is een hard 403 (permission-issue) — géén silent no-op zodat een
 * frontend-vinkje-bypass zonder rechten duidelijk gerapporteerd wordt.
 * (c) faalt is een 422 (validation-issue) zodat de UI een concrete reden kan
 * tonen aan de gebruiker.
 *
 * @param {object|null|undefined} body  request body (mag null/undefined zijn)
 * @param {boolean} hasPermission       resultaat van server-side permission-check
 * @returns {object} verdict:
 *   { bypassApproved: false }                              — bypass niet gevraagd
 *   { error: 'no-permission',   status: 403, message: … } — bypass gevraagd, geen perm
 *   { error: 'reason-required', status: 422, message: … } — bypass gevraagd, geen (geldige) reden
 *   { bypassApproved: true, reason: string }              — approved, reden getrimd
 */
export function validateBypassRequest(body, hasPermission) {
  const requested = body?.bypass_reservation_fee === true;
  if (!requested) return { bypassApproved: false };
  if (!hasPermission) {
    return {
      error:   'no-permission',
      status:  403,
      message: 'Geen rechten om reserveringsfee te omzeilen (sales.reservation_fee.bypass)',
    };
  }
  const reason = String(body?.bypass_reason || '').trim();
  if (reason.length < 10) {
    return {
      error:   'reason-required',
      status:  422,
      message: 'Reden voor omzeiling is verplicht (min. 10 tekens).',
    };
  }
  return { bypassApproved: true, reason };
}
