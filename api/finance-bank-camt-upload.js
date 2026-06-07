// api/finance-bank-camt-upload.js
// POST → upload + parse + insert van een CAMT.053-bestand.
// Permission: finance.bank.transactions_view (= manager+, super_admin auto).
//
// Body (JSON):
//   { file_name: string, xml_content_base64: string }
//
// Response 200:
//   { statement_id, num_inserted, num_skipped, num_parsed,
//     account_iban, statement_from, statement_to,
//     opening_balance_cents, closing_balance_cents }
//
// Dedupe: bij re-upload van overlappende periodes worden bestaande transacties
// (met dezelfde entry_reference) gedetecteerd via PRE-SELECT en geskipt.
// camt_statements record wordt altijd nieuw aangemaakt (per upload) zodat
// audit-trail van wat-wanneer-geüpload behouden blijft.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { parseCamt053 } from './_lib/camt-parser.js';

// Vercel function body size-cap is 4.5MB. CAMT-bestanden van een week
// ING Zakelijk zijn typisch 20-200KB — ruim binnen budget.
const MAX_BASE64_LENGTH = 5_000_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.bank.transactions_view'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.bank.transactions_view)' });
  }

  const { file_name, xml_content_base64 } = req.body || {};
  if (!file_name || typeof file_name !== 'string') {
    return res.status(400).json({ error: 'file_name vereist' });
  }
  if (!xml_content_base64 || typeof xml_content_base64 !== 'string') {
    return res.status(400).json({ error: 'xml_content_base64 vereist' });
  }
  if (xml_content_base64.length > MAX_BASE64_LENGTH) {
    return res.status(413).json({ error: `Bestand te groot (>${MAX_BASE64_LENGTH} base64-chars)` });
  }

  // Decode base64 → XML-string. Defensief: trim eventuele newlines + spaties.
  let xmlString;
  try {
    xmlString = Buffer.from(String(xml_content_base64).trim(), 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).json({ error: 'Base64-decode mislukt: ' + e.message });
  }
  if (!xmlString.includes('<') || xmlString.length < 100) {
    return res.status(400).json({ error: 'Decoded content lijkt geen geldige XML' });
  }

  // Parse.
  let parsed;
  try { parsed = parseCamt053(xmlString); }
  catch (e) {
    console.error('[camt-upload] parse fout:', e.message);
    return res.status(422).json({ error: 'CAMT-parser fout: ' + e.message });
  }

  const stmt = parsed.statement;
  const txs  = parsed.transactions;

  try {
    // Insert statement-rij eerst (krijg uuid terug voor FK).
    const { data: stmtRow, error: stmtErr } = await supabaseAdmin
      .from('camt_statements')
      .insert({
        file_name:               file_name.trim(),
        account_iban:            stmt.account_iban,
        opening_balance_cents:   stmt.opening_balance_cents,
        closing_balance_cents:   stmt.closing_balance_cents,
        statement_from:          stmt.statement_from,
        statement_to:            stmt.statement_to,
        num_entries:             txs.length,
        uploaded_by_user_id:     user.id,
      })
      .select('id')
      .single();
    if (stmtErr) throw new Error('camt_statements insert: ' + stmtErr.message);
    const statementId = stmtRow.id;

    // Dedupe: pre-fetch alle entry_references die al in DB staan voor deze
    // verzameling. Eén query met IN-list i.p.v. per-record SELECT.
    const refs = txs.map(t => t.entry_reference).filter(Boolean);
    const existingRefs = new Set();
    if (refs.length) {
      const { data: existing } = await supabaseAdmin
        .from('camt_transactions')
        .select('entry_reference')
        .in('entry_reference', refs);
      for (const r of (existing || [])) {
        if (r.entry_reference) existingRefs.add(r.entry_reference);
      }
    }

    // Filter + map naar insert-rows.
    // Twee dedupe-passages:
    //   1. Cross-batch: tx.entry_reference matched een existing row in DB
    //      (pre-fetched via existingRefs).
    //   2. In-batch: hetzelfde entry_reference komt 2× voor binnen dít CAMT-
    //      bestand. Komt voor bij ING op summary-rows of multi-leg
    //      transacties. Zonder deze filter botst de 2e INSERT op de UNIQUE
    //      partial index uniq_camt_tx_entry_ref.
    // NULL entry_reference passeert beide filters (NULL ≠ NULL in UNIQUE),
    // dus wordt altijd geïnsert.
    const rowsToInsert = [];
    const seenInBatch = new Set();
    let skipped = 0;
    for (const tx of txs) {
      if (tx.entry_reference) {
        if (existingRefs.has(tx.entry_reference)) {       // cross-batch hit
          skipped++;
          continue;
        }
        if (seenInBatch.has(tx.entry_reference)) {        // in-batch hit
          skipped++;
          continue;
        }
        seenInBatch.add(tx.entry_reference);
      }
      rowsToInsert.push({
        statement_id:      statementId,
        account_iban:      stmt.account_iban,
        booking_date:      tx.booking_date,
        value_date:        tx.value_date,
        amount_cents:      tx.amount_cents,
        currency:          tx.currency || 'EUR',
        description:       tx.description,
        counterparty_name: tx.counterparty_name,
        counterparty_iban: tx.counterparty_iban,
        end_to_end_id:     tx.end_to_end_id,
        transaction_code:  tx.transaction_code,
        entry_reference:   tx.entry_reference,
        raw_xml:           null,  // v1: optimaliseer DB-grootte; raw kan later
      });
    }

    let inserted = 0;
    if (rowsToInsert.length) {
      const { error: insErr, count } = await supabaseAdmin
        .from('camt_transactions')
        .insert(rowsToInsert, { count: 'exact' });
      if (insErr) {
        // Defensief: zou alleen kunnen falen bij race-condition op partial unique.
        // Statement-rij is al gemaakt — laat staan voor debug-trail.
        console.error('[camt-upload] tx insert error:', insErr.message);
        return res.status(500).json({
          error: 'Insert mislukt: ' + insErr.message,
          statement_id: statementId,
        });
      }
      inserted = count ?? rowsToInsert.length;
    }

    // Statement num_entries bijwerken naar werkelijk-ingeschreven aantal.
    if (inserted !== txs.length) {
      await supabaseAdmin
        .from('camt_statements')
        .update({ num_entries: inserted })
        .eq('id', statementId);
    }

    console.log(`[camt-upload] ${file_name} | ${stmt.account_iban} | parsed=${txs.length} inserted=${inserted} skipped=${skipped}`);

    return res.status(200).json({
      statement_id:           statementId,
      num_parsed:             txs.length,
      num_inserted:           inserted,
      num_skipped:            skipped,
      account_iban:           stmt.account_iban,
      statement_from:         stmt.statement_from,
      statement_to:           stmt.statement_to,
      opening_balance_cents:  stmt.opening_balance_cents,
      closing_balance_cents:  stmt.closing_balance_cents,
    });
  } catch (e) {
    console.error('[camt-upload]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
