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
 * F5.2 PR-3: bij ELKE klantbetaling (partial of full) wordt het
 * evenredige stuk van de openstaande bonus-obligaties vrijgegeven
 * via een child-entry (status='vrijgegeven') die naar de parent wijst.
 * De parent.amount wordt verlaagd met dezelfde slice; sum(children) per
 * parent gaat nooit boven de oorspronkelijke obligatie.
 *
 * Slice-formule: slice = original_amount × (paymentAmount / invoiceTotal).
 * NIET remaining × ratio (zou geometrisch aflopen i.p.v. een vaste
 * percentage per betaling). original_amount wordt op de eerste aanraking
 * gepersist op de huidige parent.amount (zonder children = oorspronkelijke
 * obligatie). Cap blijft op remaining zodat we nooit méér vrijgeven
 * dan er nog open staat.
 *
 * Forward-only / no clawback: een vrijgegeven child wordt nooit teruggedraaid.
 *
 * Idempotent op 2 niveaus:
 *  1. idempotency_key = `${parent.id}:pay:${paymentId}` blokkeert dat
 *     dezelfde betaling 2x een slice spawnt voor dezelfde parent. Bij 23505
 *     (unique-violation) wordt de spawn voor die parent overgeslagen.
 *  2. Parent wordt geselecteerd op status IN ('pending','wachten_op_betaling')
 *     EN parent_entry_id IS NULL. Children zelf hebben parent_entry_id !=
 *     NULL en vallen daarmee buiten de query — re-runs krijgen alleen de
 *     nog-niet-vrijgegeven parents te zien.
 *
 * Bij fullyPaid=true wordt een SETTLE-child gespawnd voor elke parent met
 * resterende amount > 0 (backstop tegen afrondings-/race-restanten).
 *
 * Args:
 *   customerId       (verplicht) — klant-id waarvan de obligaties zijn
 *   sourceInvoiceId  (optioneel) — bij voorkeur scoping op invoice; valt
 *                                   anders terug op customer_id alleen
 *   paymentId        (verplicht) — payments.id, gebruikt voor idempotency_key
 *   paymentAmount    (verplicht) — bedrag dat zojuist binnen kwam (>0)
 *   invoiceTotal     (verplicht) — invoices.amount_total (>0)
 *   fullyPaid        (default false) — als invoice nu volledig betaald is,
 *                                       spawn ook restje-children
 *
 * Returnt: { released: <int children gespawnd>, ids: uuid[] }.
 */
export async function releaseProportionalForPayment({
  customerId,
  sourceInvoiceId = null,
  paymentId,
  paymentAmount,
  invoiceTotal,
  fullyPaid = false,
} = {}) {
  if (!customerId) throw new Error('releaseProportionalForPayment: customerId vereist');
  if (!paymentId)  throw new Error('releaseProportionalForPayment: paymentId vereist');
  const payAmt = Number(paymentAmount) || 0;
  const invTot = Number(invoiceTotal)  || 0;
  if (payAmt <= 0 || invTot <= 0) {
    // Niets om vrij te geven; behandel als no-op zodat caller geen 500 krijgt.
    return { released: 0, ids: [] };
  }
  const ratio = payAmt / invTot; // proportionele factor van deze betaling

  // 1) Parents ophalen — alleen ECHTE obligaties (parent_entry_id IS NULL)
  //    die nog niet (volledig) zijn vrijgegeven.
  let q = supabaseAdmin
    .from('mentor_ledger_entries')
    .select('id, mentor_user_id, team_member_id, event_id, customer_id, attendee_id, source_invoice_id, source_quote_id, amount, original_amount')
    .eq('entry_type', 'bonus')
    .eq('customer_id', customerId)
    .in('status', ['pending', 'wachten_op_betaling'])
    .is('parent_entry_id', null);
  if (sourceInvoiceId) q = q.eq('source_invoice_id', sourceInvoiceId);
  const { data: parents, error: pErr } = await q;
  if (pErr) throw new Error('releaseProportionalForPayment select: ' + pErr.message);
  if (!parents || parents.length === 0) return { released: 0, ids: [] };

  const nowIso = new Date().toISOString();
  const releasedIds = [];

  for (const parent of parents) {
    const remaining = Number(parent.amount) || 0;
    if (remaining <= 0) continue;

    // F5.2 fix: slice moet evenredig zijn met de ORIGINELE obligatie, niet
    // met het resterende bedrag (anders krimpt 'ie geometrisch i.p.v. een
    // vaste 3% per betaling). Snapshot persisten op de eerste aanraking —
    // op dat moment heeft de parent nog GEEN children, dus parent.amount
    // is per definitie gelijk aan de oorspronkelijke obligatie.
    let origAmount = (parent.original_amount != null) ? Number(parent.original_amount) : remaining;
    if (parent.original_amount == null) {
      const { error: snapErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .update({ original_amount: origAmount })
        .eq('id', parent.id)
        .is('original_amount', null);
      if (snapErr) throw new Error('releaseProportionalForPayment snapshot: ' + snapErr.message);
      parent.original_amount = origAmount;
    }

    // Proportionele slice op basis van originele obligatie, gecapt op resterend.
    let slice = Math.round(origAmount * ratio * 100) / 100;
    if (slice > remaining) slice = remaining;
    if (slice <= 0) continue;

    // Insert child — bij 23505 (idempotency_key bestaat al) overslaan.
    const childRow = {
      mentor_user_id   : parent.mentor_user_id,
      team_member_id   : parent.team_member_id,
      event_id         : parent.event_id,
      entry_type       : 'bonus',
      attendee_id      : parent.attendee_id,
      customer_id      : parent.customer_id,
      amount           : slice,
      status           : 'vrijgegeven',
      source_invoice_id: parent.source_invoice_id || sourceInvoiceId || null,
      source_quote_id  : parent.source_quote_id || null,
      parent_entry_id  : parent.id,
      released_at      : nowIso,
      idempotency_key  : `${parent.id}:pay:${paymentId}`,
    };
    const { data: insertedChild, error: cErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .insert(childRow)
      .select('id')
      .maybeSingle();
    if (cErr) {
      if (cErr.code === '23505') {
        // Reeds verwerkt voor deze (parent, payment) — sla over.
        continue;
      }
      throw new Error('releaseProportionalForPayment child insert: ' + cErr.message);
    }
    if (insertedChild?.id) releasedIds.push(insertedChild.id);

    // Verlaag parent.amount.
    const newAmount = Math.round((remaining - slice) * 100) / 100;
    const { error: uErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .update({ amount: newAmount })
      .eq('id', parent.id);
    if (uErr) throw new Error('releaseProportionalForPayment parent update: ' + uErr.message);
    parent.amount = newAmount; // lokaal voor evt. settle hieronder
  }

  // 2) Backstop bij fullyPaid: spawn settle-children voor restjes
  //    (afronding, gedeeltelijke-betalingen die door rounding nooit tot 0
  //    convergeren). Aparte idempotency_key zodat hij naast de :pay:-child
  //    kan bestaan op dezelfde parent+payment.
  if (fullyPaid) {
    for (const parent of parents) {
      const rest = Number(parent.amount) || 0;
      if (rest <= 0) continue;

      const settleRow = {
        mentor_user_id   : parent.mentor_user_id,
        team_member_id   : parent.team_member_id,
        event_id         : parent.event_id,
        entry_type       : 'bonus',
        attendee_id      : parent.attendee_id,
        customer_id      : parent.customer_id,
        amount           : rest,
        status           : 'vrijgegeven',
        source_invoice_id: parent.source_invoice_id || sourceInvoiceId || null,
        source_quote_id  : parent.source_quote_id || null,
        parent_entry_id  : parent.id,
        released_at      : nowIso,
        idempotency_key  : `${parent.id}:settle:${paymentId}`,
      };
      const { data: settled, error: sErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .insert(settleRow)
        .select('id')
        .maybeSingle();
      if (sErr) {
        if (sErr.code === '23505') continue;
        throw new Error('releaseProportionalForPayment settle insert: ' + sErr.message);
      }
      if (settled?.id) releasedIds.push(settled.id);

      const { error: u2Err } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .update({ amount: 0 })
        .eq('id', parent.id);
      if (u2Err) throw new Error('releaseProportionalForPayment parent settle update: ' + u2Err.message);
    }
  }

  return { released: releasedIds.length, ids: releasedIds };
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
