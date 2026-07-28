// api/finance-bank-paypal-upload.js
// POST → upload + parse + insert van een PayPal Business CSV-bestand.
// Permission: finance.expenses.category.edit (= manager+).
//
// Body (JSON):
//   { file_name: string, csv_content_base64: string }
//
// Response 200:
//   { statement_id, num_parsed, num_inserted, num_skipped_dedupe,
//     num_skipped_memo, num_skipped_other, account_iban, statement_from,
//     statement_to, opening_balance_cents, closing_balance_cents,
//     saldo_validation: { ok, sum_cents, expected_cents, diff_cents } }
//
// Dedupe: entry_reference (PayPal Transactiereferentie) via PRE-SELECT +
// in-batch guard, identiek patroon aan finance-bank-camt-upload.js.
// camt_statements-record wordt altijd nieuw aangemaakt per upload (audit-
// trail: wat-wanneer-geüpload). account_iban = 'PAYPAL' marker.
//
// Belangrijk: gebruikt DEZELFDE camt_transactions-tabel als CAMT-upload, met
// source='paypal'. Bestaande CAMT-flow (factuur-matching, tab-lijst) blijft
// ongewijzigd; UI kan later per source filteren.

import { createUserClient, supabaseAdmin } from './supabase.js';
import { requirePermission } from './_lib/requirePermission.js';
import { parsePaypalCsv, validateSaldo } from './_lib/paypal-csv-parser.js';

// PayPal-CSV kan groter zijn dan een CAMT (jaar-export ~800KB base64). Ruimte
// binnen Vercel body-size (4.5MB).
const MAX_BASE64_LENGTH = 5_000_000;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const supabase = createUserClient(req);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return res.status(401).json({ error: 'Niet geauthenticeerd' });
  if (!(await requirePermission(req, 'finance.expenses.category.edit'))) {
    return res.status(403).json({ error: 'Geen rechten (finance.expenses.category.edit)' });
  }

  const { file_name, csv_content_base64 } = req.body || {};
  if (!file_name || typeof file_name !== 'string') {
    return res.status(400).json({ error: 'file_name vereist' });
  }
  if (!csv_content_base64 || typeof csv_content_base64 !== 'string') {
    return res.status(400).json({ error: 'csv_content_base64 vereist' });
  }
  if (csv_content_base64.length > MAX_BASE64_LENGTH) {
    return res.status(413).json({ error: `Bestand te groot (>${MAX_BASE64_LENGTH} base64-chars)` });
  }

  // Decode base64 → CSV-tekst. PayPal-export is UTF-8 (met BOM) — de parser
  // strip de BOM. Trim eventuele newlines rond base64.
  let csvText;
  try {
    csvText = Buffer.from(String(csv_content_base64).trim(), 'base64').toString('utf-8');
  } catch (e) {
    return res.status(400).json({ error: 'Base64-decode mislukt: ' + e.message });
  }
  if (csvText.length < 50 || !csvText.includes(',')) {
    return res.status(400).json({ error: 'Decoded content lijkt geen geldige CSV' });
  }

  // Parse.
  let parsed;
  try { parsed = parsePaypalCsv(csvText); }
  catch (e) {
    console.error('[paypal-upload] parse fout:', e.message);
    return res.status(422).json({ error: 'PayPal-parser fout: ' + e.message });
  }

  const stmt = parsed.statement;
  const txs  = parsed.transactions;
  const stats = parsed.stats;

  // Saldo-validatie (merge-gate in tests). Hier alleen loggen; we blokkeren
  // de upload NIET op mismatch — dat is een defensieve keuze zodat de user
  // in edge-cases (bv. corrupte CSV) alsnog kan importeren + zelf de UI-
  // KPIs kan raadplegen. De test-suite dwingt de gate af op de sample.
  const saldoCheck = validateSaldo(parsed);
  if (!saldoCheck.ok) {
    console.warn('[paypal-upload] SALDO-VALIDATIE FAALT: diff_cents=' + saldoCheck.diff_cents,
      'sum=' + saldoCheck.sum_cents, 'expected=' + saldoCheck.expected_cents);
  }

  try {
    // Statement-rij.
    const { data: stmtRow, error: stmtErr } = await supabaseAdmin
      .from('camt_statements')
      .insert({
        file_name:               file_name.trim(),
        account_iban:            stmt.account_iban,        // 'PAYPAL'
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

    // Dedupe: pre-fetch bestaande entry_references (chunked, patroon uit CAMT-upload).
    const refs = txs.map(t => t.entry_reference).filter(Boolean);
    const existingRefs = new Set();
    if (refs.length) {
      const CHUNK = 1000;
      for (let i = 0; i < refs.length; i += CHUNK) {
        const slice = refs.slice(i, i + CHUNK);
        const { data: existing, error: selErr } = await supabaseAdmin
          .from('camt_transactions')
          .select('entry_reference')
          .in('entry_reference', slice)
          .range(0, CHUNK - 1);
        if (selErr) {
          console.error('[paypal-upload] dedupe pre-SELECT chunk fout:', selErr.message);
          // best-effort; UNIQUE constraint vangt de rest.
        }
        for (const r of (existing || [])) {
          if (r.entry_reference) existingRefs.add(r.entry_reference);
        }
      }
    }

    // Filter + map naar insert-rows (in-batch dedupe extra).
    const rowsToInsert = [];
    const seenInBatch = new Set();
    let skippedDedupe = 0;
    for (const tx of txs) {
      if (tx.entry_reference) {
        if (existingRefs.has(tx.entry_reference)) { skippedDedupe++; continue; }
        if (seenInBatch.has(tx.entry_reference))  { skippedDedupe++; continue; }
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
        raw_xml:           tx.raw_xml,           // JSON van CSV-rij
        source:            tx.source,            // 'paypal'
      });
    }

    let inserted = 0;
    if (rowsToInsert.length) {
      // Chunked insert — Supabase heeft geen harde limiet maar bulk >~500 kan
      // in payload-size lopen. Insert per 500 rijen.
      const CHUNK = 500;
      for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
        const slice = rowsToInsert.slice(i, i + CHUNK);
        const { data, error: insErr } = await supabaseAdmin
          .from('camt_transactions')
          .insert(slice)
          .select('id');
        if (insErr) {
          console.error('[paypal-upload] insert chunk fout:', insErr.message);
          return res.status(500).json({
            error: 'Insert mislukt: ' + insErr.message,
            statement_id: statementId,
            partial_inserted: inserted,
          });
        }
        inserted += (data || []).length;
      }
    }

    // ── Rule-based auto-categorisatie: pas bestaande counterparty-regels toe ──
    // Zoek alle counterparties uit deze batch, kijk welke een rule hebben,
    // en insert transaction_categorizations voor die (nieuwe) rijen.
    let autoCategorized = 0;
    if (inserted > 0) {
      try {
        const cpNames = Array.from(new Set(
          rowsToInsert.map(r => r.counterparty_name).filter(Boolean)
        ));
        if (cpNames.length) {
          const { data: rules } = await supabaseAdmin
            .from('expense_counterparty_rules')
            .select('id, match_counterparty, category_id')
            .in('match_counterparty', cpNames);
          if (rules && rules.length) {
            // Map: counterparty → { rule_id, category_id }
            const cpToRule = new Map(rules.map(r => [r.match_counterparty, r]));
            // Fetch de net-inserted tx-IDs per counterparty. We hebben ze in
            // rowsToInsert maar zonder ID; hopelijk kunnen we via
            // (entry_reference, source='paypal') resolven.
            const insertedRefs = rowsToInsert
              .filter(r => cpToRule.has(r.counterparty_name) && r.entry_reference)
              .map(r => r.entry_reference);
            if (insertedRefs.length) {
              const { data: txRows } = await supabaseAdmin
                .from('camt_transactions')
                .select('id, entry_reference, counterparty_name')
                .in('entry_reference', insertedRefs);
              const catRows = [];
              for (const t of (txRows || [])) {
                const rule = cpToRule.get(t.counterparty_name);
                if (!rule) continue;
                catRows.push({
                  camt_transaction_id: t.id,
                  category_id:         rule.category_id,
                  source:              'rule',
                  rule_id:             rule.id,
                  set_by_user_id:      user.id,
                });
              }
              if (catRows.length) {
                // Upsert op UNIQUE(camt_transaction_id) — als de tx al een
                // 'manual' override heeft, NIET overschrijven.
                const { data: existingCats } = await supabaseAdmin
                  .from('transaction_categorizations')
                  .select('camt_transaction_id, source')
                  .in('camt_transaction_id', catRows.map(c => c.camt_transaction_id));
                const manualSet = new Set(
                  (existingCats || [])
                    .filter(c => c.source === 'manual')
                    .map(c => c.camt_transaction_id)
                );
                const finalCatRows = catRows.filter(c => !manualSet.has(c.camt_transaction_id));
                if (finalCatRows.length) {
                  const { error: catErr } = await supabaseAdmin
                    .from('transaction_categorizations')
                    .upsert(finalCatRows, { onConflict: 'camt_transaction_id' });
                  if (catErr) console.warn('[paypal-upload] auto-cat upsert:', catErr.message);
                  else autoCategorized = finalCatRows.length;
                }
              }
            }
          }
        }
      } catch (e) {
        // Auto-categorisatie mag de upload NIET kapotmaken.
        console.error('[paypal-upload] auto-categorize fout:', e.message);
      }
    }

    // ── Credit-detection: tag "Overige"-Bij rijen als terugbetalingen ──
    // Signaal: source='paypal' AND amount>0 AND transaction_code='Overige' AND
    // end_to_end_id koppelt aan entry_reference van een Af-parent (uit alle
    // paypal-tx, incl. eerdere uploads). Zelfde logica als de backfill-SQL.
    // Respecteert manual/rule overrides (skip als tx al gecategoriseerd is).
    let creditsTagged = 0;
    if (inserted > 0) {
      try {
        // 1. Vind de credit-cat id.
        const { data: creditCatRow } = await supabaseAdmin
          .from('expense_categories')
          .select('id')
          .eq('slug', 'terugbetalingen-credits')
          .maybeSingle();
        if (creditCatRow?.id) {
          // 2. Kandidaten uit rowsToInsert: "Overige"-Bij met end_to_end_id.
          const candidates = rowsToInsert.filter(r =>
            Number(r.amount_cents) > 0 &&
            r.transaction_code === 'Overige' &&
            r.end_to_end_id &&
            r.entry_reference
          );
          if (candidates.length) {
            // 3. Check welke end_to_end_ids matchen een paypal-Af.
            const parentRefs = Array.from(new Set(candidates.map(c => c.end_to_end_id)));
            const { data: parents } = await supabaseAdmin
              .from('camt_transactions')
              .select('entry_reference')
              .in('entry_reference', parentRefs)
              .eq('source', 'paypal')
              .lt('amount_cents', 0);
            const parentRefSet = new Set((parents || []).map(p => p.entry_reference));
            const matched = candidates.filter(c => parentRefSet.has(c.end_to_end_id));
            // 4. Re-fetch DB-IDs voor deze credits via entry_reference.
            if (matched.length) {
              const { data: txRows } = await supabaseAdmin
                .from('camt_transactions')
                .select('id, entry_reference')
                .in('entry_reference', matched.map(c => c.entry_reference))
                .eq('source', 'paypal');
              const catRows = (txRows || []).map(t => ({
                camt_transaction_id: t.id,
                category_id:         creditCatRow.id,
                source:              'rule',
                rule_id:             null,
                set_by_user_id:      user.id,
              }));
              if (catRows.length) {
                // Skip tx die al 'manual' overrides hebben.
                const { data: existingCats } = await supabaseAdmin
                  .from('transaction_categorizations')
                  .select('camt_transaction_id, source')
                  .in('camt_transaction_id', catRows.map(c => c.camt_transaction_id));
                const manualSet = new Set(
                  (existingCats || [])
                    .filter(c => c.source === 'manual')
                    .map(c => c.camt_transaction_id)
                );
                const finalRows = catRows.filter(c => !manualSet.has(c.camt_transaction_id));
                if (finalRows.length) {
                  const { error: crErr } = await supabaseAdmin
                    .from('transaction_categorizations')
                    .upsert(finalRows, { onConflict: 'camt_transaction_id' });
                  if (crErr) console.warn('[paypal-upload] credit-tag upsert:', crErr.message);
                  else creditsTagged = finalRows.length;
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('[paypal-upload] credit-detection fout:', e.message);
      }
    }

    // Statement num_entries corrigeren.
    if (inserted !== txs.length) {
      await supabaseAdmin
        .from('camt_statements')
        .update({ num_entries: inserted })
        .eq('id', statementId);
    }

    console.log(`[paypal-upload] ${file_name} | parsed=${txs.length} inserted=${inserted} skipped_dedupe=${skippedDedupe} skipped_memo=${stats.skipped_memo} auto_cat=${autoCategorized} credits=${creditsTagged} saldo_ok=${saldoCheck.ok} diff=${saldoCheck.diff_cents}`);

    return res.status(200).json({
      statement_id:           statementId,
      num_parsed:             txs.length,
      num_inserted:           inserted,
      num_skipped_dedupe:     skippedDedupe,
      num_skipped_memo:       stats.skipped_memo,
      num_skipped_other:      stats.skipped_other,
      num_skipped_bad_date:   stats.skipped_bad_date,
      total_rows:             stats.total_rows,
      account_iban:           stmt.account_iban,
      statement_from:         stmt.statement_from,
      statement_to:           stmt.statement_to,
      opening_balance_cents:  stmt.opening_balance_cents,
      closing_balance_cents:  stmt.closing_balance_cents,
      auto_categorized:       autoCategorized,
      saldo_validation:       saldoCheck,
    });
  } catch (e) {
    console.error('[paypal-upload]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
