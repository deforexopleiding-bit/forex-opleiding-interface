// tests/paypal-csv-parser.test.js
//
// Unit-tests voor api/_lib/paypal-csv-parser.js.
//
// De belangrijkste test is de SALDO-VALIDATIE tegen het echte sample-CSV
// (~2381 rijen). Die is de MERGE-GATE: als de som van non-Memo Net niet
// exact gelijk is aan (eind-saldo − begin-saldo), dan is de parser fout en
// mag de PR niet mergen. Financiële data laat geen drift toe.
//
// Sample-bestand wordt gezocht op vaste padnaam. Ontbreekt 'ie? → skip de
// saldo-gate met een duidelijke waarschuwing (in CI zonder sample-bestand
// draait de rest gewoon door).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseCsv,
  parseAmount,
  parseDate,
  parsePaypalCsv,
  validateSaldo,
} from '../api/_lib/paypal-csv-parser.js';

// ─── parseCsv: CSV-basisgedrag ──────────────────────────────────────────────

test('parseCsv: eenvoudige 2-koloms CSV', () => {
  const out = parseCsv('a,b\n1,2\n3,4');
  assert.deepEqual(out, [['a','b'], ['1','2'], ['3','4']]);
});

test('parseCsv: quoted fields met komma binnen quotes', () => {
  const out = parseCsv('a,b\n"1,5","x"');
  assert.deepEqual(out, [['a','b'], ['1,5','x']]);
});

test('parseCsv: escaped quotes ("") binnen quoted field', () => {
  const out = parseCsv('a\n"He zei ""ja"""');
  assert.deepEqual(out, [['a'], ['He zei "ja"']]);
});

test('parseCsv: BOM aan begin gestript', () => {
  const out = parseCsv('﻿a,b\n1,2');
  assert.deepEqual(out, [['a','b'], ['1','2']]);
});

test('parseCsv: \\r\\n line-endings correct verwerkt', () => {
  const out = parseCsv('a,b\r\n1,2\r\n3,4');
  assert.deepEqual(out, [['a','b'], ['1','2'], ['3','4']]);
});

// ─── parseAmount: NL-formaat conversie ─────────────────────────────────────

test('parseAmount: standaard decimaal', () => {
  assert.strictEqual(parseAmount('12,34'), 12.34);
  assert.strictEqual(parseAmount('-12,34'), -12.34);
  assert.strictEqual(parseAmount('0,00'), 0);
});

test('parseAmount: duizendtal punt (kritiek — regressie -1.800,00 → -180)', () => {
  assert.strictEqual(parseAmount('-1.800,00'), -1800);
  assert.strictEqual(parseAmount('1.234.567,89'), 1234567.89);
  assert.strictEqual(parseAmount('-100.000,50'), -100000.5);
});

test('parseAmount: lege/null/undefined → 0', () => {
  assert.strictEqual(parseAmount(''), 0);
  assert.strictEqual(parseAmount(null), 0);
  assert.strictEqual(parseAmount(undefined), 0);
});

// ─── parseDate: DD-MM-YYYY → YYYY-MM-DD ────────────────────────────────────

test('parseDate: correct formaat', () => {
  assert.strictEqual(parseDate('28-07-2025'), '2025-07-28');
  assert.strictEqual(parseDate('01-01-2026'), '2026-01-01');
});

test('parseDate: ongeldig → null', () => {
  assert.strictEqual(parseDate(''), null);
  assert.strictEqual(parseDate('2025-07-28'), null);   // wrong format
  assert.strictEqual(parseDate('28/07/2025'), null);
});

// ─── parsePaypalCsv: header-validatie ──────────────────────────────────────

test('parsePaypalCsv: ontbrekende verplichte kolom → error', () => {
  const csv = 'Datum,Naam,Type\n"28-07-2025","X","Y"';  // Net/Saldo/Effect ontbreken
  assert.throws(() => parsePaypalCsv(csv), /ontbrekende kolommen/);
});

test('parsePaypalCsv: null/lege input → error', () => {
  assert.throws(() => parsePaypalCsv(null), /csvText ontbreekt/);
  assert.throws(() => parsePaypalCsv(''), /csvText ontbreekt/);
});

// ─── parsePaypalCsv: mini-CSV end-to-end ───────────────────────────────────

// Minimal fake PayPal-CSV met exact de verplichte kolommen (+ enkele extra).
function makeMiniCsv(rows) {
  const headers = [
    'Datum','Tijd','Tijdzone','Naam','Type','Status','Valuta','Bruto','Kosten','Net',
    'Van e-mailadres','Naar e-mailadres','Transactiereferentie',
    // fillers tot Reference Txn ID (index 24)
    'F13','F14','F15','F16','F17','F18','F19','F20','F21','F22','F23','Reference Txn ID',
    // fillers tot Saldo (index 29)
    'F25','F26','F27','F28','Saldo',
    // fillers tot Effect op saldo (index 40)
    'F30','F31','F32','F33','F34','F35','F36','F37','F38','F39','Effect op saldo',
  ];
  const csvHeader = headers.map(h => '"'+h+'"').join(',');
  const csvRows = rows.map(r => headers.map(h => '"'+(r[h] || '')+'"').join(','));
  return csvHeader + '\n' + csvRows.join('\n');
}

test('parsePaypalCsv: Memo-rij wordt geskipt (bewezen beslisregel)', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'ACME', Type:'Bankpas', Valuta:'EUR', Net:'-10,00',
      Transactiereferentie:'T1', 'Reference Txn ID':'', Saldo:'-10,00', 'Effect op saldo':'Af' },
    { Datum:'28-07-2025', Naam:'ACME', Type:'Autorisatie', Valuta:'EUR', Net:'-10,00',
      Transactiereferentie:'T2', 'Reference Txn ID':'', Saldo:'-10,00', 'Effect op saldo':'Memo' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions.length, 1);
  assert.strictEqual(p.stats.skipped_memo, 1);
  assert.strictEqual(p.transactions[0].entry_reference, 'T1');
});

test('parsePaypalCsv: bedrag → amount_cents (signed, met duizendtal)', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'Meta', Type:'Sub', Valuta:'EUR', Net:'-1.800,00',
      Transactiereferentie:'T1', 'Reference Txn ID':'', Saldo:'-1.800,00', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions[0].amount_cents, -180000);
});

test('parsePaypalCsv: counterparty-3-staps — lege Naam met Ref Txn ID vindt parent', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'Upwork', Type:'Betaling', Valuta:'USD', Net:'-98,70',
      Transactiereferentie:'PARENT_TX', 'Reference Txn ID':'', Saldo:'-98,70', 'Effect op saldo':'Af' },
    { Datum:'28-07-2025', Naam:'', Type:'Valutaomrekening', Valuta:'EUR', Net:'-87,86',
      Transactiereferentie:'CHILD_TX_1', 'Reference Txn ID':'PARENT_TX', Saldo:'-186,56', 'Effect op saldo':'Af' },
    { Datum:'28-07-2025', Naam:'', Type:'Valutaomrekening', Valuta:'USD', Net:'98,70',
      Transactiereferentie:'CHILD_TX_2', 'Reference Txn ID':'PARENT_TX', Saldo:'-87,86', 'Effect op saldo':'Bij' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions.length, 3);
  // Alle 3 zouden onder 'Upwork' moeten vallen via ref-lookup:
  assert.strictEqual(p.transactions[0].counterparty_name, 'Upwork');
  assert.strictEqual(p.transactions[1].counterparty_name, 'Upwork');
  assert.strictEqual(p.transactions[2].counterparty_name, 'Upwork');
});

test('parsePaypalCsv: counterparty-3-staps — geen naam + geen linkbare ref → (intern PayPal)', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'', Type:'Vastgehouden', Valuta:'EUR', Net:'-7,92',
      Transactiereferentie:'HOLD1', 'Reference Txn ID':'', Saldo:'-7,92', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions[0].counterparty_name, '(intern PayPal)');
});

test('parsePaypalCsv: trailing/leading spaces getrimd', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'BOTLOBBIES.COM        ', Type:'Bankpas', Valuta:'EUR', Net:'-6,16',
      Transactiereferentie:'T1', 'Reference Txn ID':'', Saldo:'-6,16', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions[0].counterparty_name, 'BOTLOBBIES.COM');
});

test('parsePaypalCsv: source=paypal + description = [Type] counterparty + raw_xml is JSON', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'Adobe', Type:'Sub', Valuta:'EUR', Net:'-19,99',
      Transactiereferentie:'T1', 'Reference Txn ID':'', Saldo:'0,00', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  const tx = p.transactions[0];
  assert.strictEqual(tx.source, 'paypal');
  assert.strictEqual(tx.description, '[Sub] Adobe');
  assert.ok(tx.raw_xml && tx.raw_xml.startsWith('{'));
  const raw = JSON.parse(tx.raw_xml);
  assert.strictEqual(raw.Naam, 'Adobe');
  assert.strictEqual(raw.Net, '-19,99');
});

test('parsePaypalCsv: statement metadata (from/to/opening/closing)', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'A', Type:'X', Valuta:'EUR', Net:'-10,00',
      Transactiereferentie:'T1', 'Reference Txn ID':'', Saldo:'40,00', 'Effect op saldo':'Af' },
    { Datum:'30-07-2025', Naam:'B', Type:'X', Valuta:'EUR', Net:'-5,00',
      Transactiereferentie:'T2', 'Reference Txn ID':'', Saldo:'35,00', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.statement.account_iban, 'PAYPAL');
  assert.strictEqual(p.statement.statement_from, '2025-07-28');
  assert.strictEqual(p.statement.statement_to, '2025-07-30');
  // Opening = eerste-saldo − eerste-net = 40 − (-10) = 50
  assert.strictEqual(p.statement.opening_balance_cents, 5000);
  assert.strictEqual(p.statement.closing_balance_cents, 3500);
});

// ─── validateSaldo: gate-primitive ─────────────────────────────────────────

test('validateSaldo: sluitende mini-set → ok:true, diff=0', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'A', Type:'X', Valuta:'EUR', Net:'-10,00',
      Transactiereferentie:'T1', 'Reference Txn ID':'', Saldo:'-10,00', 'Effect op saldo':'Af' },
    { Datum:'29-07-2025', Naam:'A', Type:'X', Valuta:'EUR', Net:'-5,00',
      Transactiereferentie:'T2', 'Reference Txn ID':'', Saldo:'-15,00', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  const v = validateSaldo(p);
  assert.strictEqual(v.ok, true, `diff=${v.diff_cents}`);
  assert.strictEqual(v.diff_cents, 0);
});

// ─── SALDO-VALIDATIE OP ECHTE SAMPLE-CSV (merge-gate) ──────────────────────
//
// Zoekt sample op vaste padnaam. Als niet gevonden: gooi ⚠️-message zodat
// de gate-status expliciet is (skip niet stilletjes).
const SAMPLE_PATHS = [
  'C:/Users/jeffr/Downloads/Download (2).CSV',
  'tests/fixtures/paypal-sample.csv',
];
function findSample() {
  for (const p of SAMPLE_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

test('SALDO-VALIDATIE op echte PayPal-sample (merge-gate; diff MOET €0,00 zijn)', () => {
  const samplePath = findSample();
  if (!samplePath) {
    console.warn('⚠️  Sample-CSV niet gevonden op:', SAMPLE_PATHS.join(' / '));
    console.warn('    → saldo-validatie gate NIET gedraaid. Voeg sample toe onder tests/fixtures/paypal-sample.csv om deze test volledig af te dwingen.');
    return; // test slaagt (skip); PR-body moet expliciet melden dat gate wel op sample gedraaid is
  }
  console.log('   Sample:', samplePath);
  const csv = fs.readFileSync(samplePath, 'utf8');
  const p = parsePaypalCsv(csv);
  const v = validateSaldo(p);

  console.log(`   Parsed: ${p.stats.total_rows} rows, imported ${p.stats.imported}, skipped_memo ${p.stats.skipped_memo}`);
  console.log(`   Sum non-Memo cents:      ${v.sum_cents}`);
  console.log(`   Expected (close−open):   ${v.expected_cents}`);
  console.log(`   Diff (moet 0):           ${v.diff_cents}`);
  console.log(`   Opening: ${v.opening} · Closing: ${v.closing}`);

  assert.strictEqual(
    v.diff_cents, 0,
    `❌ SALDO-VALIDATIE FAALT — diff=${v.diff_cents} cents. Parser is fout; PR mag NIET mergen tot dit sluit.`
  );

  // Extra assertions op verwachte counts uit de analyse-ronde:
  assert.ok(p.stats.total_rows >= 2380 && p.stats.total_rows <= 2385,
    `Sample-CSV heeft ~2381 rijen, gevonden ${p.stats.total_rows}`);
  assert.ok(p.stats.skipped_memo >= 440 && p.stats.skipped_memo <= 450,
    `Verwacht ~445 Memo-rijen, gevonden ${p.stats.skipped_memo}`);
  assert.ok(p.stats.imported >= 1930 && p.stats.imported <= 1940,
    `Verwacht ~1936 imports (2381 − 445), gevonden ${p.stats.imported}`);
});

// ─── Dedupe-simulatie (echte upload gebruikt DB-side unique index) ────────

test('parsePaypalCsv: geen in-parser dedupe — upload-endpoint doet dat DB-side', () => {
  // De parser levert alle rijen door; dedupe zit in de endpoint (pre-fetch
  // existingRefs + in-batch seenInBatch). Dit test bevestigt dat 2× dezelfde
  // Transactiereferentie in de CSV WEL bij de parser doorkomt (endpoint
  // filtert 'em er dan uit — dat is out-of-scope voor deze unit-test, maar
  // documenteert het contract).
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'A', Type:'X', Valuta:'EUR', Net:'-1,00',
      Transactiereferentie:'DUP1', 'Reference Txn ID':'', Saldo:'-1,00', 'Effect op saldo':'Af' },
    { Datum:'28-07-2025', Naam:'A', Type:'X', Valuta:'EUR', Net:'-1,00',
      Transactiereferentie:'DUP1', 'Reference Txn ID':'', Saldo:'-2,00', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions.length, 2);
  assert.strictEqual(p.transactions[0].entry_reference, 'DUP1');
  assert.strictEqual(p.transactions[1].entry_reference, 'DUP1');
});
