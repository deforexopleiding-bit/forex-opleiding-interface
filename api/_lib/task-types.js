// api/_lib/task-types.js
// Centrale registry voor pending_actions.action_type -> categorie-mapping.
//
// Gebruikt door:
//   * api/tasks-list.js                  (filter + group-by categorie)
//   * api/tasks-create-verify-payment.js (insert nieuwe verify-payment task)
//   * modules/open-acties.html           (frontend filter-tabs + labels)
//
// Achtergrond:
//   * pending_actions.action_type is vrije tekst in de DB (geen CHECK), zie
//     docs/sql-migrations/2026-06-09-payment-arrangements-d1.sql regel 106-107.
//   * Arrangement-acties (TL_*) hangen aan een payment_arrangements-row en
//     worden via api/arrangements-propose.js geinsert.
//   * MANUAL_VERIFY_PAYMENT staat los van een arrangement (arrangement_id NULL)
//     en koppelt direct aan een factuur via de nieuwe invoice_id FK-kolom
//     (zie docs/sql-migrations/2026-06-09-tasks-f1-invoice-link.sql).

export const TASK_CATEGORY = {
  arrangement:    'Regelingen',
  verify_payment: 'Betalingsclaims',
  escalation:     'Escalaties',
  unknown:        'Overig',
};

// action_type -> categorie-key. Houd in sync met TASK_CATEGORY.
export const TASK_ACTION_TYPES = {
  // --- Arrangement-acties (D1/D2 — TL-executor) ---
  TL_INVOICE_UPDATE_DUE:              'arrangement', // legacy UITSTEL pre-D1.5
  TL_INVOICE_CONSOLIDATE_AND_RESTART: 'arrangement', // UITSTEL (D1.5+)
  TL_INVOICE_SPLIT:                   'arrangement', // SPLITSING
  TL_SUBSCRIPTION_PAUSE:              'arrangement', // ABONNEMENT_PAUZE
  TL_SUBSCRIPTION_STOP:               'arrangement', // ABONNEMENT_STOP
  TL_INVOICE_WRITEOFF:                'arrangement', // KWIJTSCHELDING

  // --- F1: handmatige verify-payment task (inbox -> finance) ---
  MANUAL_VERIFY_PAYMENT: 'verify_payment',

  // --- F3: handmatige escalatie-task (inbox/Joost -> finance) ---
  MANUAL_ESCALATION: 'escalation',

  // --- E2/F-uitbreiding: Joost / inbox -> finance ---
  // Joost stelt een betalingsregeling voor (uitstel/splitsing/etc) buiten zijn
  // mandaat en parkeert het als taak voor menselijke goedkeuring. Valt onder
  // de bestaande 'arrangement'-categorie zodat de UI/queue-filter ongewijzigd
  // blijft.
  MANUAL_PROPOSE_ARRANGEMENT: 'arrangement',
  // Follow-up bericht / reminder die door een mens moet worden opgesteld of
  // verstuurd (bv. na no-reply-streak waar autonomy gepauzeerd is). Hangt
  // semantisch aan een arrangement / regeling-flow en blijft daarom binnen
  // de 'arrangement'-categorie.
  MANUAL_FOLLOWUP: 'arrangement',
};

/**
 * Geef de categorie-key voor een gegeven action_type.
 * Onbekende / nieuwe action_types vallen terug op 'unknown' zodat de UI ze
 * nog steeds rendert (in plaats van te verbergen).
 *
 * @param {string} actionType
 * @returns {'arrangement'|'verify_payment'|'escalation'|'unknown'}
 */
export function getTaskCategoryFor(actionType) {
  if (typeof actionType !== 'string' || !actionType) return 'unknown';
  return TASK_ACTION_TYPES[actionType] || 'unknown';
}

/**
 * Geef het NL-label voor een categorie. Handig voor UI-tabs / KPI-strip.
 *
 * @param {string} categoryKey
 * @returns {string}
 */
export function getTaskCategoryLabel(categoryKey) {
  return TASK_CATEGORY[categoryKey] || TASK_CATEGORY.unknown;
}

// Optionele NL-labels per action_type voor UI-rendering (badge / row-title).
// Niet exhaustive: alleen MANUAL_* / nieuwe types waar de TL_*-namen al
// elders een eigen label-hook hebben (arrangement-types via type-mapper).
export const TASK_ACTION_LABEL = {
  MANUAL_VERIFY_PAYMENT:       'Betaling verifiëren',
  MANUAL_ESCALATION:           'Escalatie',
  MANUAL_PROPOSE_ARRANGEMENT:  'Voorstel afspraak',
  MANUAL_FOLLOWUP:             'Follow-up bericht',
};

/**
 * Geef het NL-label voor een action_type. Onbekende waardes vallen terug op
 * de action_type-string zelf zodat de UI nooit een lege cell laat.
 *
 * @param {string} actionType
 * @returns {string}
 */
export function getTaskActionLabel(actionType) {
  if (typeof actionType !== 'string' || !actionType) return '';
  return TASK_ACTION_LABEL[actionType] || actionType;
}
