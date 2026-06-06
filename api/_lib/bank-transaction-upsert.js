// api/_lib/bank-transaction-upsert.js
// Mapper + upsert van één e-Boekhouden mutatie in onze `bank_transactions`-tabel.
// V1 — geen match-engine, geen TL-cascade. Pure spiegel met defensieve
// veldextractie omdat counterparty-velden niet 100% bevestigd zijn in de
// REST-spec (Mantix Client.php documenteert ze niet expliciet).
//
// Idempotent: 2-staps SELECT op eb_mutation_id → UPDATE/INSERT. Bestaande
// rijen worden bijgewerkt zodat e-Boekhouden-side wijzigingen (bv. handmatige
// factuur-koppeling die type 5 → 4 promoveert) doorkomen bij re-sync.

import { supabaseAdmin } from '../supabase.js';

const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function isoDate(v) {
  if (!v) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

/**
 * Probeer counterparty-naam te extraheren. Volgorde:
 *   1. expliciete top-level velden (counterpartyName, debtorName, etc.)
 *   2. relatie-naam als relationId aanwezig (out-of-scope voor v1 — alleen veld)
 *   3. eerste regel van description (bv. "JEFFREY BIEMOLD NL12RABO0123 ..." → naam)
 *
 * Defensief omdat de REST-spec niet bevestigt dat counterparty separate velden
 * geeft. Bij eerste echte cron-run zien we wat erin zit en kunnen we verfijnen.
 */
function extractCounterpartyName(m) {
  return trimOrNull(
    m.counterpartyName
    || m.debtorName
    || m.creditorName
    || m.relationName
    || null
  );
}
function extractCounterpartyIban(m) {
  return trimOrNull(
    m.counterpartyIban
    || m.debtorIban
    || m.creditorIban
    || m.iban
    || null
  );
}

/**
 * Totaal-bedrag van een mutatie. e-Boekhouden geeft een rows-array met
 * per-regel amounts; voor bank-transacties is dat meestal één regel maar
 * defensief sommeren we. Tekens: type 4/5 = positief (in), type 3/6 = negatief (uit).
 */
function signedAmountCents(m) {
  const rows = Array.isArray(m.rows) ? m.rows : [];
  let sum = 0;
  for (const row of rows) {
    const a = Number(row.amount);
    if (Number.isFinite(a)) sum += a;
  }
  if (!sum && Number.isFinite(Number(m.amount))) sum = Number(m.amount);
  const cents = Math.round(r2(sum) * 100);
  const t = Number(m.type);
  // Type 4 (verkoopfactuur-betaling ontvangen) + type 5 (geld ontvangen) = inkomend
  // Type 3 (inkoopfactuur-betaling) + type 6 (geld uitgegeven) = uitgaand
  // e-Boekhouden levert amounts vaak positief; teken zelf zetten op type-basis.
  if (t === 3 || t === 6) return -Math.abs(cents);
  if (t === 4 || t === 5) return Math.abs(cents);
  return cents;
}

/**
 * Mapt een raw e-Boekhouden mutation-object naar onze DB-kolommen.
 * @returns {object} row klaar voor INSERT/UPDATE
 */
export function mapEbMutationToRow(m) {
  return {
    eb_mutation_id:    Number(m.id),
    ledger_id:         Number(m.ledgerId),
    mutation_type:     Number(m.type),
    transaction_date:  isoDate(m.date) || new Date().toISOString().slice(0, 10),
    amount_cents:      signedAmountCents(m),
    currency:          trimOrNull(m.currency) || 'EUR',
    description:       trimOrNull(m.description),
    counterparty_name: extractCounterpartyName(m),
    counterparty_iban: extractCounterpartyIban(m),
    invoice_number:    trimOrNull(m.invoiceNumber),
    raw_payload:       m,
  };
}

/**
 * Idempotente upsert. Returnt actie + lokale uuid.
 *
 * @param {object} ebMutation  raw response uit GET /v1/mutation
 * @returns {Promise<{ id: string, action: 'inserted'|'updated' }>}
 */
export async function upsertBankTransactionFromEb(ebMutation) {
  if (!ebMutation?.id) throw new Error('e-Boekhouden mutation zonder id');
  const row = mapEbMutationToRow(ebMutation);

  const { data: existing } = await supabaseAdmin
    .from('bank_transactions').select('id').eq('eb_mutation_id', row.eb_mutation_id).maybeSingle();

  if (existing) {
    const { error } = await supabaseAdmin
      .from('bank_transactions').update(row).eq('id', existing.id);
    if (error) throw new Error('bank_transactions update: ' + error.message);
    return { id: existing.id, action: 'updated' };
  }

  const { data: ins, error } = await supabaseAdmin
    .from('bank_transactions').insert(row).select('id').single();
  if (error) throw new Error('bank_transactions insert: ' + error.message);
  return { id: ins.id, action: 'inserted' };
}
