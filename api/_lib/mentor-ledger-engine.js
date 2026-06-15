// api/_lib/mentor-ledger-engine.js
//
// F5.1 — Status-engine voor mentor_ledger_entries. Pure, idempotente functies
// die de ledger-status laten flowen van 'pending' → 'wachten_op_betaling' →
// 'vrijgegeven' → 'uitbetaald' (of zijbalk: 'geannuleerd').
//
// Bedoeld als bibliotheek-laag. Endpoints (mentor-ledger-set-status,
// mentor-payout-run) gebruiken deze functies. Latere auto-hooks (op
// finance-payment-match-confirm + teamleader-quotation webhook) zullen
// dezelfde functies aanroepen — zie INTEGRATIE-TODO onderaan dit bestand.
//
// Geen RBAC hier; callers (endpoints / cron) doen de auth-check. Geen
// network calls; alleen Supabase Admin client.

import { supabaseAdmin } from '../supabase.js';

/**
 * 1e betaalde factuur van een klant → alle openstaande bonus-entries voor
 * die klant (op 'pending' of 'wachten_op_betaling') naar 'vrijgegeven'.
 * Idempotent: entries die al vrijgegeven/uitbetaald/geannuleerd zijn
 * blijven ongemoeid. Returnt { released: <int>, ids: uuid[] }.
 */
export async function releaseForPaidInvoice({ customerId, sourceInvoiceId = null } = {}) {
  if (!customerId) throw new Error('releaseForPaidInvoice: customerId vereist');
  const nowIso = new Date().toISOString();
  const update = { status: 'vrijgegeven', released_at: nowIso };
  if (sourceInvoiceId) update.source_invoice_id = sourceInvoiceId;

  const { data, error } = await supabaseAdmin
    .from('mentor_ledger_entries')
    .update(update)
    .eq('entry_type', 'bonus')
    .eq('customer_id', customerId)
    .in('status', ['pending', 'wachten_op_betaling'])
    .select('id');
  if (error) throw new Error('releaseForPaidInvoice: ' + error.message);
  const rows = data || [];
  return { released: rows.length, ids: rows.map((r) => r.id) };
}

/**
 * Geannuleerde offerte → bonus-entries gekoppeld aan die deal (via
 * source_quote_id) op 'pending'/'wachten_op_betaling' → 'geannuleerd'.
 * Idempotent op rows die al geannuleerd zijn.
 * Returnt { cancelled: <int>, ids: uuid[] }.
 */
export async function cancelForCancelledQuote({ quoteId } = {}) {
  if (!quoteId) throw new Error('cancelForCancelledQuote: quoteId vereist');
  const { data, error } = await supabaseAdmin
    .from('mentor_ledger_entries')
    .update({ status: 'geannuleerd' })
    .eq('entry_type', 'bonus')
    .eq('source_quote_id', quoteId)
    .in('status', ['pending', 'wachten_op_betaling'])
    .select('id');
  if (error) throw new Error('cancelForCancelledQuote: ' + error.message);
  const rows = data || [];
  return { cancelled: rows.length, ids: rows.map((r) => r.id) };
}

/**
 * Factuur te laat → bonus-entries van die klant op 'pending' → 'wachten_op_betaling'.
 * Zo blijft transparant dat de bonus nog niet vrijgegeven kan worden tot er
 * daadwerkelijk betaling binnenkomt. Idempotent.
 * Returnt { marked: <int>, ids: uuid[] }.
 */
export async function markOverdue({ customerId } = {}) {
  if (!customerId) throw new Error('markOverdue: customerId vereist');
  const { data, error } = await supabaseAdmin
    .from('mentor_ledger_entries')
    .update({ status: 'wachten_op_betaling' })
    .eq('entry_type', 'bonus')
    .eq('customer_id', customerId)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error('markOverdue: ' + error.message);
  const rows = data || [];
  return { marked: rows.length, ids: rows.map((r) => r.id) };
}

/**
 * Toegestane handmatige status-transities. Centraal hier zodat
 * mentor-ledger-set-status (en eventuele admin-UI later) één bron van
 * waarheid heeft. Engine zelf (releaseForPaidInvoice/etc.) doet beperkter
 * dan dit; deze map is voor manager+ handmatige acties.
 */
export const ALLOWED_TRANSITIONS = {
  pending             : ['wachten_op_betaling', 'vrijgegeven', 'geannuleerd'],
  wachten_op_betaling : ['vrijgegeven', 'geannuleerd', 'pending'],
  vrijgegeven         : ['uitbetaald', 'geannuleerd'],
  geannuleerd         : ['pending'], // herstel-pad
  uitbetaald          : [],          // terminal
};

export function canTransition(fromStatus, toStatus) {
  const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
  return allowed.includes(toStatus);
}

// ── INTEGRATIE-TODO ──────────────────────────────────────────────────────────
//
// Auto-hooks zijn NOG NIET gewired. Ze zijn bewust uitgesteld omdat de recon
// niet helder maakte op welk exact punt in de bestaande code-base ze het
// veiligst kunnen aanhaken zonder bestaande finance/sales-flows te raken.
// Aanbevolen vervolg (los van deze PR):
//
//   * Hook 1 — releaseForPaidInvoice
//     Plek: api/finance-payment-match-confirm.js, direct NA de geslaagde
//     invoice.update({ amount_paid, status }) call. Pseudo:
//       if (newStatus === 'paid' && previousStatus !== 'paid') {
//         const customerId = invoice.customer_id;
//         await releaseForPaidInvoice({ customerId, sourceInvoiceId: invoice.id })
//           .catch((e) => console.error('[hook] releaseForPaidInvoice:', e.message));
//       }
//
//   * Hook 2 — cancelForCancelledQuote
//     Plek: api/_lib/teamleader-quotation.js (of waar webhook 'deal.cancelled'/
//     'quotation.cancelled' wordt verwerkt). Vereist mapping deal_id → ledger
//     source_quote_id (zelfde id wordt gebruikt).
//
//   * Hook 3 — markOverdue
//     Plek: api/cron-dunning-engine.js, in de loop waar facturen op
//     'overdue' worden gezet. Per customer_id 1 keer aanroepen.
//
// Voor nu (PR E): handmatige status-toggle via mentor-ledger-set-status en
// uitbetalings-run via mentor-payout-run dekken de manager-flow.
