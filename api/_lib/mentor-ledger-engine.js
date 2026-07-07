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
 * Proportionele vrijgave o.b.v. BETAALDE TERMIJN-FACTUREN (Optie 1).
 *
 * Model: per-termijn 1/N met 1-maand-buffer op released_at.
 *
 *   paid_term_count = aantal volledig-betaalde termijn-facturen op de
 *                     subscription van deze klant (amount_paid >=
 *                     amount_total).
 *   term_count      = subscriptions.term_count.
 *   target_released = original_amount × (paid_term_count / term_count)
 *   new_slice_totaal = target_released − current_released
 *
 * We splitsen die new_slice per termijn: elke betaalde termijn krijgt
 * zijn eigen child (per_term_slice = original / term_count, met
 * remainder-correctie op de laatste termijn). released_at van elk child
 * is de 1e van de maand NA de paid_date van die termijn — zo valt de
 * slice in de payout-run van de maand erna (payout selecteert op
 * released_at).
 *
 * Voorbeeld: John betaalt termijn 1 op 14 april → slice met
 * released_at = 2024-05-01 → valt in mei-payout. 3/36 betaald =
 * 3 slices, elk in de maand na hun eigen paid_date.
 *
 * Parent-scope: per parent zoeken we de subscription:
 *   - primair via source_quote_id (deal-id) → subscription van dat deal
 *   - fallback: nieuwste subscription op de klant.
 *
 * schema_unknown (geen sub of geen term_count > 0) → NIET vrijgeven,
 * parent blijft 'pending'. Consistent met de KPI-uitsluiting in
 * mentor-bonus-overview.
 *
 * Idempotency: `idempotency_key = "${parent.id}:paidrel-term:${termIdx}"`.
 * Herhaald draaien met zelfde paid_term_count → dezelfde termIdx-set →
 * 23505 skip. Meer betaalde termijnen → nieuwe termIdx → nieuwe slice(s).
 * Forward-only, geen clawback.
 *
 * `dryRun=true` berekent alles maar schrijft niets. Bestaande children
 * (matching idem-key) worden herkend zodat de preview NIET zegt dat een
 * al-vrijgegeven termijn opnieuw vrijkomt.
 *
 * Returnt: {
 *   dry_run, customer_id, paid_total, last_paid_date, parents_touched,
 *   released_children, total_released, simulations: [
 *     { parent_id, mentor_user_id, term_index, term_count,
 *       paid_term_count, paid_date, released_at, slice_amount,
 *       would_release, idempotency_key, skip_reason? }
 *   ]
 * }.
 */
export async function releaseProportionalForPaidInvoices({ customerId, dryRun = false } = {}) {
  if (!customerId) throw new Error('releaseProportionalForPaidInvoices: customerId vereist');
  const _r2 = (n) => Math.round(Number(n) * 100) / 100;

  // 1e van de maand NA een YYYY-MM-DD als volledige ISO-timestamp
  // (00:00:00.000Z). Zo valt de released_at netjes in de payout-run van
  // die maand — payout selecteert op released_at.
  function firstOfNextMonthTimestamp(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  }

  // ── 1) Subscriptions van deze klant (voor term_count + tl_sub_id) ──────
  const { data: dealsForCust } = await supabaseAdmin
    .from('deals').select('id').eq('customer_id', customerId);
  const dealIds = (dealsForCust || []).map((d) => d.id);

  let subsForCust = [];
  if (dealIds.length) {
    const { data: subs } = await supabaseAdmin
      .from('subscriptions')
      .select('id, deal_id, teamleader_subscription_id, term_count, start_date')
      .in('deal_id', dealIds)
      .order('start_date', { ascending: false, nullsFirst: false });
    subsForCust = subs || [];
  }

  // ── 2) Volledig-betaalde termijn-facturen per subscription ─────────────
  //    Alleen invoices op subscription-scope (via tl_subscription_id) tellen
  //    als termijn. Klant-brede invoices zonder sub-koppeling behoren typisch
  //    tot andere producten en gaan hier niet mee.
  const tlSubIds = [...new Set(subsForCust.map((s) => s.teamleader_subscription_id).filter(Boolean))];
  const paidTermsBySub = new Map(); // tl_sub_id → [{ paid_date }] gesorteerd asc

  // Extra: paid_total + lastPaidDate (voor backward-compat report-veld;
  // rekenkundig niet meer leidend voor de release-beslissing).
  let paidTotal = 0;
  let lastPaidDate = null;

  if (tlSubIds.length) {
    const { data: invs } = await supabaseAdmin
      .from('invoices')
      .select('tl_subscription_id, amount_paid, amount_total, paid_date, status')
      .in('tl_subscription_id', tlSubIds);
    for (const inv of (invs || [])) {
      const paid  = Number(inv.amount_paid)  || 0;
      const total = Number(inv.amount_total) || 0;
      paidTotal += paid;
      if (inv.paid_date && (!lastPaidDate || inv.paid_date > lastPaidDate)) {
        lastPaidDate = inv.paid_date;
      }
      if (total <= 0 || paid < total) continue; // niet volledig betaald → niet als termijn
      if (!paidTermsBySub.has(inv.tl_subscription_id)) {
        paidTermsBySub.set(inv.tl_subscription_id, []);
      }
      paidTermsBySub.get(inv.tl_subscription_id).push({
        paid_date: inv.paid_date || null,
      });
    }
    for (const arr of paidTermsBySub.values()) {
      arr.sort((a, b) => (a.paid_date || '').localeCompare(b.paid_date || ''));
    }
  }
  // Backup paid_total via customer als sub-route niks opleverde (voor
  // backward-compat report-veld; termijn-detectie blijft aan de sub-kant).
  if (paidTotal <= 0) {
    const { data: invs } = await supabaseAdmin
      .from('invoices')
      .select('amount_paid, paid_date')
      .eq('customer_id', customerId);
    for (const inv of (invs || [])) {
      paidTotal += Number(inv.amount_paid) || 0;
      if (inv.paid_date && (!lastPaidDate || inv.paid_date > lastPaidDate)) {
        lastPaidDate = inv.paid_date;
      }
    }
  }
  paidTotal = _r2(paidTotal);

  // ── 3) Parents ─────────────────────────────────────────────────────────
  const { data: parents, error: pErr } = await supabaseAdmin
    .from('mentor_ledger_entries')
    .select('id, mentor_user_id, team_member_id, event_id, attendee_id, customer_id, basis, amount, original_amount, source_invoice_id, source_quote_id, status, created_at')
    .eq('entry_type', 'bonus')
    .eq('customer_id', customerId)
    .in('status', ['pending', 'wachten_op_betaling'])
    .is('parent_entry_id', null)
    .order('created_at', { ascending: true });
  if (pErr) throw new Error('releaseProportionalForPaidInvoices parents: ' + pErr.message);

  // Bestaande children voor dedup in dry-run + idempotency-signaal.
  // (Live-schrijfpad vangt 23505 al af; dry-run heeft geen 23505 dus we
  // moeten hier expliciet checken.)
  const parentIds = (parents || []).map((p) => p.id);
  const existingIdemByParent = new Map(); // parent_id → Set<idem_key>
  if (parentIds.length) {
    const { data: kids } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .select('parent_entry_id, idempotency_key')
      .in('parent_entry_id', parentIds);
    for (const k of (kids || [])) {
      if (!k.parent_entry_id || !k.idempotency_key) continue;
      if (!existingIdemByParent.has(k.parent_entry_id)) {
        existingIdemByParent.set(k.parent_entry_id, new Set());
      }
      existingIdemByParent.get(k.parent_entry_id).add(k.idempotency_key);
    }
  }

  const simulations = [];
  const releasedIds = [];

  for (const parent of parents || []) {
    // Vind subscription voor deze parent.
    //   Route 1: source_quote_id (deal.id) → sub op dat deal.
    //   Route 2 (fallback): nieuwste sub op de klant.
    let sub = null;
    if (parent.source_quote_id) {
      sub = subsForCust.find((s) => s.deal_id === parent.source_quote_id) || null;
    }
    if (!sub) sub = subsForCust[0] || null;

    const termCount = sub && Number.isFinite(Number(sub.term_count)) && Number(sub.term_count) > 0
      ? Number(sub.term_count) : null;
    const tlSubId = sub?.teamleader_subscription_id || null;

    if (!termCount) {
      // schema_unknown → parent blijft pending (KPI-consistent).
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        term_index: null, term_count: null, paid_term_count: 0,
        paid_date: null, released_at: null, slice_amount: 0,
        would_release: false, skip_reason: 'schema_unknown',
      });
      continue;
    }

    const paidTermsForSub = (tlSubId && paidTermsBySub.get(tlSubId)) || [];
    const paidTermCount   = Math.min(termCount, paidTermsForSub.length);

    if (paidTermCount === 0) {
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        term_index: null, term_count: termCount, paid_term_count: 0,
        paid_date: null, released_at: null, slice_amount: 0,
        would_release: false, skip_reason: 'no_paid_terms',
      });
      continue;
    }

    // Snapshot original_amount bij eerste aanraking.
    let origAmount = parent.original_amount != null
      ? Number(parent.original_amount) : Number(parent.amount);
    if (!Number.isFinite(origAmount) || origAmount <= 0) {
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        term_index: null, term_count: termCount, paid_term_count: paidTermCount,
        paid_date: null, released_at: null, slice_amount: 0,
        would_release: false, skip_reason: 'origAmount<=0',
      });
      continue;
    }
    if (parent.original_amount == null && !dryRun) {
      const { error: snapErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .update({ original_amount: origAmount })
        .eq('id', parent.id)
        .is('original_amount', null);
      if (snapErr) throw new Error('paidrel-term snapshot: ' + snapErr.message);
    }

    const perTermSlice = _r2(origAmount / termCount);
    const existingIdemForParent = existingIdemByParent.get(parent.id) || new Set();

    // Itereer per termijn 1..paidTermCount. Bestaande termijn (idem in Set)
    // wordt zowel in dry-run als live overgeslagen.
    for (let termIdx = 1; termIdx <= paidTermCount; termIdx++) {
      const paidDateStr = paidTermsForSub[termIdx - 1]?.paid_date || null;
      const releasedAt  = firstOfNextMonthTimestamp(paidDateStr);
      const idem        = `${parent.id}:paidrel-term:${termIdx}`;

      if (existingIdemForParent.has(idem)) {
        // Al vrijgegeven in eerdere run — skip zonder simulatie-noise.
        continue;
      }

      // Slice-bedrag met remainder-correctie op de laatste termijn zodat
      // sum(slices) == origAmount ondanks rounding.
      let sliceAmount;
      if (termIdx === termCount) {
        sliceAmount = _r2(origAmount - perTermSlice * (termCount - 1));
      } else {
        sliceAmount = perTermSlice;
      }
      // Cap op parent.amount voor safety (mocht handmatige transitie
      // parent.amount al hebben verlaagd).
      const parentAmount = Number(parent.amount) || 0;
      if (sliceAmount > parentAmount) sliceAmount = _r2(parentAmount);
      if (sliceAmount <= 0) {
        simulations.push({
          parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
          term_index: termIdx, term_count: termCount, paid_term_count: paidTermCount,
          paid_date: paidDateStr, released_at: releasedAt,
          slice_amount: 0, would_release: false, idempotency_key: idem, skip_reason: 'slice<=0',
        });
        continue;
      }

      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        term_index: termIdx, term_count: termCount, paid_term_count: paidTermCount,
        paid_date: paidDateStr, released_at: releasedAt,
        slice_amount: sliceAmount, would_release: true, idempotency_key: idem,
      });

      if (dryRun) continue;

      // ── Schrijfpad: child insert + parent.amount verlagen ────────────
      const childRow = {
        mentor_user_id : parent.mentor_user_id,
        team_member_id : parent.team_member_id,
        event_id       : parent.event_id,
        entry_type     : 'bonus',
        attendee_id    : parent.attendee_id,
        customer_id    : parent.customer_id,
        amount         : sliceAmount,
        status         : 'vrijgegeven',
        source_invoice_id: parent.source_invoice_id || null,
        source_quote_id  : parent.source_quote_id  || null,
        parent_entry_id  : parent.id,
        released_at      : releasedAt,
        idempotency_key  : idem,
      };
      const { data: inserted, error: cErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .insert(childRow)
        .select('id')
        .maybeSingle();
      if (cErr) {
        if (cErr.code === '23505') continue; // race met parallel-run → skip
        throw new Error('paidrel-term child insert: ' + cErr.message);
      }
      if (inserted?.id) releasedIds.push(inserted.id);

      const newAmount = _r2(Math.max(0, parentAmount - sliceAmount));
      const { error: uErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .update({ amount: newAmount })
        .eq('id', parent.id);
      if (uErr) throw new Error('paidrel-term parent update: ' + uErr.message);
      parent.amount = newAmount;
    }
  }

  const total_released = _r2(
    simulations.filter((s) => s.would_release).reduce((sum, s) => sum + Number(s.slice_amount), 0)
  );

  return {
    dry_run          : !!dryRun,
    customer_id      : customerId,
    paid_total       : paidTotal,
    last_paid_date   : lastPaidDate,
    parents_touched  : (parents || []).length,
    released_children: releasedIds.length,
    total_released,
    simulations,
  };
}

/**
 * Proportionele inhaal-vrijgave o.b.v. BETAALD BEDRAG (Optie 2 / "amount").
 *
 * Model: 3% van wat binnen is. Voor elke parent-obligatie:
 *   totaalBetaald  = som van betaalde bedragen op de facturen die bij deze
 *                    sale horen. Primair: invoices met tl_subscription_id
 *                    matchend op de sub die uit de parent volgt
 *                    (source_quote_id -> deal -> sub.tl_subscription_id).
 *                    Fallback: alle klant-facturen (customer-breed).
 *   parentBasis    = parent.basis (het geboekte sale-bedrag, bv. €7200).
 *                    Fallback: origAmount / bonusPct als basis ontbreekt —
 *                    hier houden we het simpel: basis is verplicht (skip
 *                    als 0 of NULL).
 *   targetReleased = round2(origAmount × min(1, totaalBetaald / parentBasis))
 *   reedsReleased  = som(amount) van bestaande children van deze parent.
 *   teReleasen     = round2(targetReleased - reedsReleased),
 *                    gecapt op (origAmount - reedsReleased).
 *
 * Als teReleasen <= 0 -> skip. Anders 1 child gespawnd met status
 * 'vrijgegeven', parent_entry_id = parent.id, amount = teReleasen.
 * parent.amount verlaagd met teReleasen. original_amount snapshotted bij
 * eerste aanraking (zoals de bestaande functies).
 *
 * Idempotency: idempotency_key = `${parent.id}:paidamount:${paidCents}`.
 *   paidCents = Math.round(totaalBetaald * 100). Stabiel per betaald-totaal.
 *   Re-run met exact hetzelfde bedrag -> 23505 skip (of geen delta).
 *   Later meer betaald -> nieuwe key -> extra child voor het verschil.
 *   Forward-only, geen clawback.
 *
 * released_at = 1e vd maand NA de laatste paid_date, zodat de child in de
 * juiste payout-maand valt (payout selecteert op released_at).
 *
 * `dryRun=true`: berekent + returned simulaties, schrijft niets. Bestaande
 * children (matching idem-key) worden opgehaald zodat de sim niet zegt dat
 * een al-vrijgegeven slice opnieuw komt.
 *
 * Returnt: {
 *   dry_run, customer_id, paid_total, last_paid_date, parents_touched,
 *   released_children, total_released, simulations: [
 *     { parent_id, mentor_user_id, customer_id, parent_basis,
 *       totaal_betaald, target_released, reeds_released, te_releasen,
 *       released_at, idempotency_key, would_release, skip_reason? }
 *   ]
 * }.
 */
export async function releaseProportionalForPaidAmount({ customerId, dryRun = false } = {}) {
  if (!customerId) throw new Error('releaseProportionalForPaidAmount: customerId vereist');
  const _r2 = (n) => Math.round(Number(n) * 100) / 100;

  function firstOfNextMonthTimestamp(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
  }

  // ── 1) Subs van deze klant (voor tl_sub_id per deal) ────────────────────
  const { data: dealsForCust } = await supabaseAdmin
    .from('deals').select('id').eq('customer_id', customerId);
  const dealIds = (dealsForCust || []).map((d) => d.id);
  let subsForCust = [];
  if (dealIds.length) {
    const { data: subs } = await supabaseAdmin
      .from('subscriptions')
      .select('id, deal_id, teamleader_subscription_id, start_date')
      .in('deal_id', dealIds)
      .order('start_date', { ascending: false, nullsFirst: false });
    subsForCust = subs || [];
  }

  // ── 2) Facturen van de klant — paid_total per tl_sub_id + customer-breed ─
  const { data: allInvs } = await supabaseAdmin
    .from('invoices')
    .select('tl_subscription_id, amount_paid, amount_total, paid_date, status')
    .eq('customer_id', customerId);
  const custPaidTotal   = _r2((allInvs || []).reduce((s, i) => s + (Number(i.amount_paid) || 0), 0));
  let custLastPaidDate  = null;
  for (const inv of (allInvs || [])) {
    if (inv.paid_date && (!custLastPaidDate || inv.paid_date > custLastPaidDate)) {
      custLastPaidDate = inv.paid_date;
    }
  }
  const paidBySub = new Map(); // tl_sub_id -> { paid, lastPaidDate }
  for (const inv of (allInvs || [])) {
    if (!inv.tl_subscription_id) continue;
    if (!paidBySub.has(inv.tl_subscription_id)) {
      paidBySub.set(inv.tl_subscription_id, { paid: 0, lastPaidDate: null });
    }
    const acc = paidBySub.get(inv.tl_subscription_id);
    acc.paid += Number(inv.amount_paid) || 0;
    if (inv.paid_date && (!acc.lastPaidDate || inv.paid_date > acc.lastPaidDate)) {
      acc.lastPaidDate = inv.paid_date;
    }
  }

  // ── 3) Parents ───────────────────────────────────────────────────────────
  const { data: parents, error: pErr } = await supabaseAdmin
    .from('mentor_ledger_entries')
    .select('id, mentor_user_id, team_member_id, event_id, attendee_id, customer_id, basis, amount, original_amount, source_invoice_id, source_quote_id, status, created_at')
    .eq('entry_type', 'bonus')
    .eq('customer_id', customerId)
    .in('status', ['pending', 'wachten_op_betaling'])
    .is('parent_entry_id', null)
    .order('created_at', { ascending: true });
  if (pErr) throw new Error('releaseProportionalForPaidAmount parents: ' + pErr.message);

  // Bestaande children per parent — voor reedsReleased-som én dry-run dedup.
  const parentIds = (parents || []).map((p) => p.id);
  const kidsByParent = new Map(); // parent_id -> [{ amount, idempotency_key }]
  if (parentIds.length) {
    const { data: kids } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .select('parent_entry_id, amount, idempotency_key')
      .in('parent_entry_id', parentIds);
    for (const k of (kids || [])) {
      if (!k.parent_entry_id) continue;
      if (!kidsByParent.has(k.parent_entry_id)) kidsByParent.set(k.parent_entry_id, []);
      kidsByParent.get(k.parent_entry_id).push(k);
    }
  }

  const simulations = [];
  const releasedIds = [];

  for (const parent of parents || []) {
    // Bepaal sub voor deze parent → tl_sub_id → totaalBetaald voor deze sale.
    let sub = null;
    if (parent.source_quote_id) {
      sub = subsForCust.find((s) => s.deal_id === parent.source_quote_id) || null;
    }
    if (!sub) sub = subsForCust[0] || null;
    const tlSubId = sub?.teamleader_subscription_id || null;

    // Sale-scope totaalBetaald: MAX van sub-route en customer-route.
    // Waarom max en niet else-if: bij klanten met deels ongekoppelde
    // facturen (tl_subscription_id=NULL op sommige betalingen) is de
    // sub-route incompleet. Customer-route bevat álle klant-facturen (incl.
    // de gekoppelde) en is dus altijd >= sub-route.
    // Randgeval multi-sale klant: bij >1 sale per customer kan custPaidTotal
    // facturen van andere sales bevatten — bekende beperking (idem in
    // mentor-bonus-overview). De cap op (origAmount - reedsReleased) verderop
    // voorkomt dat er ooit meer dan de volledige bonus vrijkomt. Exactheid
    // verbetert zodra facturen consequent aan de sub gekoppeld zijn.
    const subAcc  = (tlSubId && paidBySub.has(tlSubId)) ? paidBySub.get(tlSubId) : null;
    const subPaid  = subAcc ? _r2(subAcc.paid) : 0;
    const custPaid = _r2(custPaidTotal);
    const saleTotaalBetaald = Math.max(subPaid, custPaid);
    // last paid_date volgt de route met het hoogste bedrag (typisch = recentste
    // betaling); fallback op de andere route zodat we nooit null returnen als
    // er wél betaald is.
    const saleLastPaidDate =
      (custPaid >= subPaid ? custLastPaidDate : (subAcc?.lastPaidDate || null))
      || custLastPaidDate || subAcc?.lastPaidDate || null;

    const parentBasis = Number(parent.basis) || 0;
    const kids        = kidsByParent.get(parent.id) || [];
    const reedsReleased = _r2(kids.reduce((s, k) => s + (Number(k.amount) || 0), 0));
    const paidCents     = Math.round(saleTotaalBetaald * 100);
    const idem          = `${parent.id}:paidamount:${paidCents}`;
    const releasedAt    = firstOfNextMonthTimestamp(saleLastPaidDate);

    if (parentBasis <= 0) {
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        parent_basis: 0, totaal_betaald: saleTotaalBetaald,
        target_released: 0, reeds_released: reedsReleased, te_releasen: 0,
        released_at: releasedAt, idempotency_key: idem,
        would_release: false, skip_reason: 'parent_basis<=0',
      });
      continue;
    }
    if (saleTotaalBetaald <= 0) {
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        parent_basis: parentBasis, totaal_betaald: 0,
        target_released: 0, reeds_released: reedsReleased, te_releasen: 0,
        released_at: null, idempotency_key: idem,
        would_release: false, skip_reason: 'no_payment',
      });
      continue;
    }

    // Snapshot original_amount bij eerste aanraking.
    let origAmount = parent.original_amount != null
      ? Number(parent.original_amount) : Number(parent.amount);
    if (!Number.isFinite(origAmount) || origAmount <= 0) {
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        parent_basis: parentBasis, totaal_betaald: saleTotaalBetaald,
        target_released: 0, reeds_released: reedsReleased, te_releasen: 0,
        released_at: releasedAt, idempotency_key: idem,
        would_release: false, skip_reason: 'origAmount<=0',
      });
      continue;
    }

    const ratio          = Math.min(1, saleTotaalBetaald / parentBasis);
    const targetReleased = _r2(origAmount * ratio);
    let   teReleasen     = _r2(targetReleased - reedsReleased);
    // Cap: nooit boven origAmount uit.
    const maxRest = _r2(origAmount - reedsReleased);
    if (teReleasen > maxRest) teReleasen = maxRest;
    if (teReleasen <= 0) {
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        parent_basis: parentBasis, totaal_betaald: saleTotaalBetaald,
        target_released: targetReleased, reeds_released: reedsReleased, te_releasen: 0,
        released_at: releasedAt, idempotency_key: idem,
        would_release: false, skip_reason: 'no_delta',
      });
      continue;
    }

    // Idempotency dry-run: bestaat er al een child met deze paidamount-key?
    const idemExists = kids.some((k) => k.idempotency_key === idem);
    if (idemExists) {
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        parent_basis: parentBasis, totaal_betaald: saleTotaalBetaald,
        target_released: targetReleased, reeds_released: reedsReleased, te_releasen: 0,
        released_at: releasedAt, idempotency_key: idem,
        would_release: false, skip_reason: 'idem_exists',
      });
      continue;
    }

    // Cap ook op de huidige parent.amount voor safety.
    const parentAmount = Number(parent.amount) || 0;
    if (teReleasen > parentAmount) teReleasen = _r2(parentAmount);
    if (teReleasen <= 0) {
      simulations.push({
        parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
        parent_basis: parentBasis, totaal_betaald: saleTotaalBetaald,
        target_released: targetReleased, reeds_released: reedsReleased, te_releasen: 0,
        released_at: releasedAt, idempotency_key: idem,
        would_release: false, skip_reason: 'parent_amount<=0',
      });
      continue;
    }

    simulations.push({
      parent_id: parent.id, mentor_user_id: parent.mentor_user_id, customer_id: parent.customer_id,
      parent_basis: parentBasis, totaal_betaald: saleTotaalBetaald,
      target_released: targetReleased, reeds_released: reedsReleased, te_releasen: teReleasen,
      released_at: releasedAt, idempotency_key: idem, would_release: true,
    });

    if (dryRun) continue;

    // ── Schrijfpad ─────────────────────────────────────────────────────
    // Snapshot original_amount als NULL.
    if (parent.original_amount == null) {
      const { error: snapErr } = await supabaseAdmin
        .from('mentor_ledger_entries')
        .update({ original_amount: origAmount })
        .eq('id', parent.id)
        .is('original_amount', null);
      if (snapErr) throw new Error('paidamount snapshot: ' + snapErr.message);
    }

    const childRow = {
      mentor_user_id : parent.mentor_user_id,
      team_member_id : parent.team_member_id,
      event_id       : parent.event_id,
      entry_type     : 'bonus',
      attendee_id    : parent.attendee_id,
      customer_id    : parent.customer_id,
      amount         : teReleasen,
      status         : 'vrijgegeven',
      source_invoice_id: parent.source_invoice_id || null,
      source_quote_id  : parent.source_quote_id  || null,
      parent_entry_id  : parent.id,
      released_at      : releasedAt,
      idempotency_key  : idem,
    };
    const { data: inserted, error: cErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .insert(childRow)
      .select('id')
      .maybeSingle();
    if (cErr) {
      if (cErr.code === '23505') continue; // race → skip
      throw new Error('paidamount child insert: ' + cErr.message);
    }
    if (inserted?.id) releasedIds.push(inserted.id);

    const newAmount = _r2(Math.max(0, parentAmount - teReleasen));
    const { error: uErr } = await supabaseAdmin
      .from('mentor_ledger_entries')
      .update({ amount: newAmount })
      .eq('id', parent.id);
    if (uErr) throw new Error('paidamount parent update: ' + uErr.message);
    parent.amount = newAmount;
  }

  const total_released = _r2(
    simulations.filter((s) => s.would_release).reduce((sum, s) => sum + Number(s.te_releasen), 0)
  );

  return {
    dry_run          : !!dryRun,
    customer_id      : customerId,
    paid_total       : custPaidTotal,
    last_paid_date   : custLastPaidDate,
    parents_touched  : (parents || []).length,
    released_children: releasedIds.length,
    total_released,
    simulations,
  };
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
