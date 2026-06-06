// api/_lib/bank-transaction-upsert.js
// Mapper + upsert van één e-Boekhouden mutatie in onze `bank_transactions`-tabel.
// V1.2 — drie aanvullingen op v1:
//   1. List-response van /v1/mutation bevat geen counterparty/iban/description.
//      Daarom doen we per record een aparte detail-call /v1/mutation/{id}.
//   2. Detail-call is duur, dus we skippen 'm bij bestaande rijen met al-gevulde
//      counterparty/iban/description (idempotent re-sync wordt veel sneller).
//   3. Defensieve mapping met extra veldnamen die in detail-response kunnen
//      zitten (relationName, accountNumber, paymentReference, mededeling, etc.).
//
// Idempotent: 2-staps SELECT op eb_mutation_id → UPDATE/INSERT. Bestaande rijen
// worden bijgewerkt zodat e-Boekhouden-side wijzigingen (bv. handmatige
// factuur-koppeling die type 5 → 4 promoveert) doorkomen bij re-sync.

import { supabaseAdmin } from '../supabase.js';
import { ebFetch } from './eboekhouden-token.js';

// Module-level debug-flag — logt één sample detail-object per cold-start zodat
// we de echte response-shape kunnen lezen in Vercel logs. Te verwijderen in
// volgende fix-PR zodra alle velden bevestigd zijn.
let _debugLoggedDetail = false;

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

// Counterparty-naam — uitgebreid met `relationName`, `name` velden die in
// detail-response kunnen zitten.
function extractCounterpartyName(m) {
  return trimOrNull(
    m.counterpartyName
    || m.relationName
    || m.debtorName
    || m.creditorName
    || m.name
    || null
  );
}
// IBAN — extra `accountNumber` (e-Boekhouden gebruikt soms generieke benaming).
function extractCounterpartyIban(m) {
  return trimOrNull(
    m.counterpartyIban
    || m.iban
    || m.relationIban
    || m.accountNumber
    || m.debtorIban
    || m.creditorIban
    || null
  );
}
// Description — extra `paymentReference` + `mededeling` (NL bank-term).
function extractDescription(m) {
  return trimOrNull(
    m.description
    || m.paymentReference
    || m.mededeling
    || null
  );
}

/**
 * Totaal-bedrag van een mutatie. List-response heeft top-level `amount`;
 * detail-response heeft typisch een rows[]-array. Defensief beide ondersteunen.
 * Tekens: type 4/5 = positief (in), type 3/6 = negatief (uit).
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
  if (t === 3 || t === 6) return -Math.abs(cents);
  if (t === 4 || t === 5) return Math.abs(cents);
  return cents;
}

/**
 * Detail-call /v1/mutation/{id}. Returnt parsed object of null bij fail
 * (failure mag de hele cron-run niet kapotmaken).
 */
async function fetchMutationDetail(id) {
  try {
    const r = await ebFetch('GET', `/mutation/${id}`);
    if (!r.ok) {
      console.warn(`[bank-tx-upsert] detail fetch /mutation/${id} HTTP ${r.status}`);
      return null;
    }
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { return null; }
    // Defensieve unwrap — sommige TL-style endpoints geven { data: {...} }.
    return parsed?.data || parsed || null;
  } catch (e) {
    console.warn(`[bank-tx-upsert] detail fetch /mutation/${id} netwerk`, e.message);
    return null;
  }
}

/**
 * Mapt list-record + (optioneel) detail naar DB-kolommen. Detail-velden hebben
 * voorrang voor counterparty/iban/description omdat list-response die niet heeft.
 *
 * @param {object} m       list-record uit /v1/mutation
 * @param {object|null} d  detail-record uit /v1/mutation/{id}, optioneel
 * @returns {object} row klaar voor INSERT/UPDATE
 */
export function mapEbMutationToRow(m, d = null) {
  const source = d || m;       // detail-velden voorrang
  return {
    eb_mutation_id:    Number(m.id),
    ledger_id:         Number(m.ledgerId ?? d?.ledgerId),
    mutation_type:     Number(m.type),
    transaction_date:  isoDate(m.date) || new Date().toISOString().slice(0, 10),
    amount_cents:      signedAmountCents(d || m),
    currency:          trimOrNull(source.currency) || 'EUR',
    description:       extractDescription(source),
    counterparty_name: extractCounterpartyName(source),
    counterparty_iban: extractCounterpartyIban(source),
    invoice_number:    trimOrNull(source.invoiceNumber ?? m.invoiceNumber),
    // raw_payload: detail als beschikbaar (rijker), anders list-record.
    raw_payload:       d || m,
  };
}

/**
 * Idempotente upsert met optionele detail-call back-fill.
 *
 * Strategie:
 *   - INSERT pad: altijd detail-call (nieuw record, alle data nodig)
 *   - UPDATE pad: detail-call alleen als bestaande counterparty/iban/description
 *                 NULL is (back-fill van eerder-inserted rijen die geen detail
 *                 hadden in v1.1). Bij al-verrijkte rij: skip detail (snelheid).
 *
 * @param {object} ebMutation  list-record uit GET /v1/mutation
 * @returns {Promise<{ id: string, action: 'inserted'|'updated' }>}
 */
export async function upsertBankTransactionFromEb(ebMutation) {
  if (!ebMutation?.id) throw new Error('e-Boekhouden mutation zonder id');

  // Bekijk of we al een rij hebben + of die counterparty data heeft.
  const { data: existing } = await supabaseAdmin
    .from('bank_transactions')
    .select('id, counterparty_name, counterparty_iban, description')
    .eq('eb_mutation_id', Number(ebMutation.id))
    .maybeSingle();

  const needsDetail = !existing
    || (!existing.counterparty_name && !existing.counterparty_iban && !existing.description);

  let detail = null;
  if (needsDetail) {
    detail = await fetchMutationDetail(ebMutation.id);
    // DEBUG (Fase 3 v1.2 — tijdelijk): log eerste niet-lege detail-response
    // zodat we de échte veldnamen kunnen bevestigen. Module-level flag,
    // dus max één log per Vercel function-instance (cold-start).
    if (detail && !_debugLoggedDetail) {
      _debugLoggedDetail = true;
      console.log('[debug] sample detail keys:', JSON.stringify(Object.keys(detail)));
      console.log('[debug] sample detail:', JSON.stringify(detail, null, 2).substring(0, 2000));
    }
  }

  const row = mapEbMutationToRow(ebMutation, detail);

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
