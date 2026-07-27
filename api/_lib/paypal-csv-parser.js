// api/_lib/paypal-csv-parser.js
//
// PayPal Business NL CSV-parser. Returnt een gestructureerd object met
// statement-metadata + transactie-lijst klaar voor insert in dezelfde
// camt_transactions-tabel als de CAMT.053-import (via source='paypal').
//
// ── BEWEZEN BESLISREGELS (uit analyse-ronde tegen echte sample-CSV) ─────────
//
// RIJ-FILTER:
//   'Effect op saldo' ∈ ('Af','Bij') → import.
//   'Effect op saldo' = 'Memo'       → skip (boekhoudkundige tegenboeking,
//                                             geen saldo-effect).
//   Andere waarden: skip + warn (defensief).
//
// BEDRAG:
//   parseAmount('-1.800,00') → -1800.00 (NL-formaat: '.' = duizendtal,
//                                        ',' = decimaal).
//   amount_cents = Math.round(parseAmount(Net) * 100). Signed: Af=negatief,
//   Bij=positief (al correct in Net-kolom).
//
// COUNTERPARTY-RESOLUTIE (3-staps):
//   1) Naam.trim() als niet leeg
//   2) Anders: lookup via deze rij's "Reference Txn ID" → een rij wiens
//      "Transactiereferentie" daaraan gelijk is → diens Naam.trim()
//      (vangt fx-cascades: EUR-omrekening-rijen krijgen zo de merchant-naam)
//   3) Anders: '(intern PayPal)'
//
// DEDUPE:
//   Transactiereferentie (17-char alfanumeriek) → entry_reference-kolom.
//   Botsingsvrij met ING AcctSvcrRef op de bestaande partial unique index.
//
// MULTI-CURRENCY:
//   USD/GBP-rijen worden ook geïmporteerd; hun currency-veld staat op de
//   originele valuta. Netto in EUR volgt vanzelf (USD-Af + USD-Bij = 0 per
//   fx-cascade; EUR-Af is de echte kost).
//
// SALDO-VALIDATIE:
//   Deze parser levert een validatie-hulp (validateSaldo) die op de test-
//   set moet sluiten op €0,00 (som non-Memo Net = eind−begin saldo).
//
// ── Verwachte header ─────────────────────────────────────────────────────────
// PayPal Business NL-export, kolommen (indexen 0..40):
//   0  Datum          (DD-MM-YYYY)
//   1  Tijd           (HH:MM:SS)
//   2  Tijdzone       ('CEST' / 'CET')
//   3  Naam           (counterparty; kan leeg zijn + trailing spaces)
//   4  Type           (14 unieke waarden, zie analyse)
//   5  Status         ('Voltooid' / 'Teruggeboekt' / 'Geweigerd')
//   6  Valuta         ('EUR' / 'USD' / 'GBP')
//   7  Bruto          (bedrag NL-formaat)
//   8  Kosten
//   9  Net            (netto, signed; PRIMARY amount voor onze parser)
//   10 Van e-mailadres
//   11 Naar e-mailadres
//   12 Transactiereferentie  (unique per rij → dedupe-anchor)
//   ...
//   24 Reference Txn ID     (parent-link)
//   29 Saldo                (running EUR-saldo)
//   40 Effect op saldo      ('Af' / 'Bij' / 'Memo')

// ── CSV-parser (RFC-4180-ish; handelt quoted fields + escaped "") ──────────
export function parseCsv(text) {
  if (text == null) return [];
  // Strip BOM (﻿) — PayPal-export heeft dit altijd op regel 1.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip CR; \n eindigt regel */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  // Trailing field zonder eindigende newline
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ── Bedrag-parser: NL-formaat naar Number (in EUR) ─────────────────────────
// "-1.800,00" → -1800.00
// "12,34"     → 12.34
// "0,00"      → 0
// ""          → 0
// null/undef  → 0
export function parseAmount(s) {
  if (s == null || s === '') return 0;
  const cleaned = String(s).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

// ── Datum-parser: DD-MM-YYYY → YYYY-MM-DD ──────────────────────────────────
export function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// ── Header-index-builder ───────────────────────────────────────────────────
// Header-strings worden getrimd (PayPal geeft soms trailing whitespace).
// Returnt map van kolomnaam → index. Ontbrekende verplichte kolommen → throw.
const REQUIRED_HEADERS = [
  'Datum',
  'Naam',
  'Type',
  'Valuta',
  'Net',
  'Transactiereferentie',
  'Reference Txn ID',
  'Saldo',
  'Effect op saldo',
];

function buildHeaderIndex(header) {
  const idx = {};
  header.forEach((h, i) => { idx[String(h).trim()] = i; });
  const missing = REQUIRED_HEADERS.filter(k => !(k in idx));
  if (missing.length) {
    throw new Error('PayPal-parser: ontbrekende kolommen in CSV-header: ' + missing.join(', '));
  }
  return idx;
}

// ── Description-cascade (bewezen tegen 1936-rijen sample) ─────────────────
// Doel: geef per PayPal-tx de meest bruikbare menselijke omschrijving.
// De 'Naam' zit al in counterparty_name (aparte kolom + zichtbaar in UI);
// description is de "wat/waarom"-info, niet de "van wie".
//
// Volgorde + dekking uit analyse (%vulling op non-Memo rijen):
//   1) Onderwerp     — 37.6%  (bv Meta→"Ads", Upwork→"Upwork Services",
//                              klant→"Factuur 2025 / 844")
//   2) Item Title    — 15.8%  (product/dienst-titel)
//   3) Factuurnummer — 16.9%  ("Factuur <nr>" — prefix voor context)
//   4) Note          — 0.1%   (zeldzaam maar nuttig als het er is)
//   5) Type          — fallback ("Vastgehouden - algemeen" e.d.)
//
// Werkt op óf een raw-row array + header-index (parser-tijd), óf op een
// JSON-object (backfill-tijd, waarbij raw_xml als JSON is bewaard).
export function buildPaypalDescription({ Onderwerp, ItemTitle, Factuurnummer, Note, Type }) {
  const onderwerp = String(Onderwerp || '').trim();
  if (onderwerp) return onderwerp;
  const itemTitle = String(ItemTitle || '').trim();
  if (itemTitle) return itemTitle;
  const factuur = String(Factuurnummer || '').trim();
  if (factuur) return 'Factuur ' + factuur;
  const note = String(Note || '').trim();
  if (note) return note;
  const type = String(Type || '').trim();
  if (type) return type;
  return '';
}

// ── Counterparty-resolutie (3-staps) ───────────────────────────────────────
// Bouwt eerst een lookup Transactiereferentie → Naam.trim() (alleen voor
// rijen met niet-lege Naam, want die zijn parent-kandidaten). Daarna
// resolvet elke rij:
//   1) eigen Naam.trim() indien niet leeg
//   2) Reference Txn ID → parent Naam via lookup
//   3) fallback '(intern PayPal)'
function buildCounterpartyResolver(dataRows, H) {
  const txRefToName = new Map();
  for (const r of dataRows) {
    const tx = r[H['Transactiereferentie']];
    const nm = String(r[H['Naam']] || '').trim();
    if (tx && nm && !txRefToName.has(tx)) {
      txRefToName.set(tx, nm);
    }
  }
  return function resolveCounterparty(row) {
    const nm = String(row[H['Naam']] || '').trim();
    if (nm) return nm;
    const ref = row[H['Reference Txn ID']];
    if (ref && txRefToName.has(ref)) return txRefToName.get(ref);
    return '(intern PayPal)';
  };
}

// ── Hoofd-entry: parse PayPal-CSV → { statement, transactions } ───────────
export function parsePaypalCsv(csvText, opts = {}) {
  if (!csvText || typeof csvText !== 'string') {
    throw new Error('PayPal-parser: csvText ontbreekt of niet-string');
  }

  const rows = parseCsv(csvText);
  if (rows.length < 2) {
    throw new Error('PayPal-parser: CSV heeft geen data-rijen');
  }

  const header = rows[0];
  const H = buildHeaderIndex(header);
  const dataRows = rows.slice(1).filter(r => r.length >= 2);

  const resolveCounterparty = buildCounterpartyResolver(dataRows, H);

  const transactions = [];
  let skippedMemo = 0;
  let skippedOther = 0;
  let skippedBadDate = 0;

  // Voor statement-meta:
  let minDate = null, maxDate = null;
  // Opening/closing saldo uit Saldo-kolom (chronologisch oplopend):
  // Eerste-rij saldo minus haar Net (als niet-Memo) = openings-saldo. Laatste
  // rij saldo = closing-saldo. Memo-rijen laten saldo ongewijzigd → gebruik
  // laatste non-Memo als anker als eerste rij Memo is (defensief).
  let openingSaldoCents = null;
  let closingSaldoCents = null;

  // Zoek eerste non-Memo rij voor opening-berekening
  const firstNonMemoIdx = dataRows.findIndex(r =>
    ['Af', 'Bij'].includes(String(r[H['Effect op saldo']] || ''))
  );
  if (firstNonMemoIdx >= 0) {
    const first = dataRows[firstNonMemoIdx];
    const firstSaldo = Math.round(parseAmount(first[H['Saldo']]) * 100);
    const firstNet = Math.round(parseAmount(first[H['Net']]) * 100);
    openingSaldoCents = firstSaldo - firstNet;
  }
  // Laatste rij (memo of niet) heeft laatste saldo
  if (dataRows.length) {
    closingSaldoCents = Math.round(parseAmount(dataRows[dataRows.length - 1][H['Saldo']]) * 100);
  }

  for (const r of dataRows) {
    try {
      const effect = String(r[H['Effect op saldo']] || '').trim();

      // ── Filter Memo-rijen (bewezen: geen saldo-effect) ──
      if (effect === 'Memo') { skippedMemo++; continue; }
      if (effect !== 'Af' && effect !== 'Bij') {
        // Onbekende effect-waarde — defensief skippen + noteren
        skippedOther++;
        continue;
      }

      const bookingDate = parseDate(r[H['Datum']]);
      if (!bookingDate) { skippedBadDate++; continue; }
      if (minDate === null || bookingDate < minDate) minDate = bookingDate;
      if (maxDate === null || bookingDate > maxDate) maxDate = bookingDate;

      const netEur = parseAmount(r[H['Net']]);
      const amountCents = Math.round(netEur * 100);

      const counterparty = resolveCounterparty(r);
      const type = String(r[H['Type']] || '').trim();
      const currency = String(r[H['Valuta']] || 'EUR').trim() || 'EUR';
      const txRef = String(r[H['Transactiereferentie']] || '').trim() || null;
      const parentRef = String(r[H['Reference Txn ID']] || '').trim() || null;

      // Description: cascade uit de meest-vulde velden (zie
      // buildPaypalDescription). counterparty_name staat al in eigen kolom.
      const description = buildPaypalDescription({
        Onderwerp:     r[H['Onderwerp']],
        ItemTitle:     r[H['Item Title']],
        Factuurnummer: r[H['Factuurnummer']],
        Note:          r[H['Note']],
        Type:          type,
      });

      // Raw JSON van de hele CSV-rij (kolom-naam → waarde), voor audit +
      // future-proofing (kolommen die we nu niet mappen zoals Factuurnummer,
      // Van/Naar e-mailadres, Verzendadres blijven bewaard).
      const rawJson = {};
      for (const [colName, colIdx] of Object.entries(H)) {
        rawJson[colName] = String(r[colIdx] || '');
      }

      transactions.push({
        booking_date:       bookingDate,
        value_date:         bookingDate,  // PayPal heeft geen aparte value-date
        amount_cents:       amountCents,
        currency,
        description,
        counterparty_name:  counterparty,
        counterparty_iban:  null,          // PayPal geeft geen IBAN
        end_to_end_id:      parentRef,     // parent-child traceerbaar via Reference Txn ID
        transaction_code:   type,          // PayPal-Type in dit veld (analoog aan CAMT BkTxCd)
        entry_reference:    txRef,         // dedupe-anchor
        raw_xml:            JSON.stringify(rawJson),  // CSV-rij als JSON (kolom voor CAMT-XML hergebruikt)
        source:             'paypal',
      });
    } catch (e) {
      console.warn('[paypal-parser] rij overgeslagen:', e.message);
      skippedOther++;
    }
  }

  return {
    statement: {
      account_iban:           'PAYPAL',                 // marker (NOT NULL kolom)
      opening_balance_cents:  openingSaldoCents,
      closing_balance_cents:  closingSaldoCents,
      statement_from:         minDate,
      statement_to:           maxDate,
      num_entries:            transactions.length,
    },
    transactions,
    stats: {
      total_rows:      dataRows.length,
      imported:        transactions.length,
      skipped_memo:    skippedMemo,
      skipped_other:   skippedOther,
      skipped_bad_date: skippedBadDate,
    },
  };
}

// ── Saldo-validatie (merge-gate voor tests) ────────────────────────────────
// Toont of onze filter-logica correct is: som van amount_cents van alle
// geïmporteerde transacties moet gelijk zijn aan (closing − opening).
// Verwachte return: { ok: true, diff_cents: 0 } bij correcte parse.
export function validateSaldo(parseResult) {
  const { statement, transactions } = parseResult;
  const sumCents = transactions.reduce((s, t) => s + t.amount_cents, 0);
  const expected = (statement.closing_balance_cents ?? 0) - (statement.opening_balance_cents ?? 0);
  const diff = sumCents - expected;
  return {
    ok: Math.abs(diff) < 1,   // exact-cent match; drift <1 cent = float-artefact
    sum_cents: sumCents,
    expected_cents: expected,
    diff_cents: diff,
    opening: statement.opening_balance_cents,
    closing: statement.closing_balance_cents,
  };
}
