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
  buildPaypalDescription,
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
    // 13-14 filler, 15 = Item Title, 16-23 filler, 24 = Reference Txn ID
    'F13','F14','Item Title','F16','F17','F18','F19','F20','F21','F22','F23','Reference Txn ID',
    // 25 = Factuurnummer, 26-28 filler, 29 = Saldo
    'Factuurnummer','F26','F27','F28','Saldo',
    // 30-36 filler, 37 = Onderwerp, 38 = Note, 39 = filler, 40 = Effect op saldo
    'F30','F31','F32','F33','F34','F35','F36','Onderwerp','Note','F39','Effect op saldo',
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

test('parsePaypalCsv: source=paypal + description fallback op Type + raw_xml is JSON', () => {
  // Zonder Onderwerp/Item Title/Factuurnummer/Note → cascade valt op Type.
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'Adobe', Type:'Sub', Valuta:'EUR', Net:'-19,99',
      Transactiereferentie:'T1', 'Reference Txn ID':'', Saldo:'0,00', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  const tx = p.transactions[0];
  assert.strictEqual(tx.source, 'paypal');
  assert.strictEqual(tx.description, 'Sub');
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

// ─── buildPaypalDescription: cascade — bevestigt volgorde per veld ─────────

test('buildPaypalDescription: Onderwerp wint boven al het andere', () => {
  assert.strictEqual(
    buildPaypalDescription({ Onderwerp:'Ads', ItemTitle:'Foo', Factuurnummer:'123', Note:'x', Type:'PPCard' }),
    'Ads'
  );
});

test('buildPaypalDescription: geen Onderwerp → Item Title', () => {
  assert.strictEqual(
    buildPaypalDescription({ Onderwerp:'', ItemTitle:'Nitro Monthly', Factuurnummer:'', Note:'', Type:'PPCard' }),
    'Nitro Monthly'
  );
});

test('buildPaypalDescription: geen Onderwerp+ItemTitle → Factuurnummer met "Factuur "-prefix', () => {
  assert.strictEqual(
    buildPaypalDescription({ Onderwerp:'', ItemTitle:'', Factuurnummer:'2025 / 844', Note:'', Type:'Express' }),
    'Factuur 2025 / 844'
  );
});

test('buildPaypalDescription: alleen Note → Note', () => {
  assert.strictEqual(
    buildPaypalDescription({ Onderwerp:'', ItemTitle:'', Factuurnummer:'', Note:'private notitie', Type:'PPCard' }),
    'private notitie'
  );
});

test('buildPaypalDescription: alles leeg behalve Type → Type als laatste fallback', () => {
  assert.strictEqual(
    buildPaypalDescription({ Onderwerp:'', ItemTitle:'', Factuurnummer:'', Note:'', Type:'Vastgehouden - algemeen' }),
    'Vastgehouden - algemeen'
  );
});

test('buildPaypalDescription: alles leeg → lege string (geen crash)', () => {
  assert.strictEqual(buildPaypalDescription({}), '');
  assert.strictEqual(buildPaypalDescription({ Onderwerp:'', ItemTitle:'', Factuurnummer:'', Note:'', Type:'' }), '');
});

test('buildPaypalDescription: whitespace-only telt als leeg', () => {
  assert.strictEqual(
    buildPaypalDescription({ Onderwerp:'   ', ItemTitle:'Real Title', Factuurnummer:'', Note:'', Type:'X' }),
    'Real Title'
  );
});

test('buildPaypalDescription: null/undefined-inputs zijn safe', () => {
  assert.strictEqual(
    buildPaypalDescription({ Onderwerp: null, ItemTitle: undefined, Factuurnummer: null, Note: undefined, Type: 'PP' }),
    'PP'
  );
});

// ─── parsePaypalCsv: description-cascade end-to-end op mini-CSV ────────────

test('parsePaypalCsv: description = Onderwerp als aanwezig (echte Meta-scenario)', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'Meta Platforms, Inc.', Type:'Vooraf goedgekeurde betaling',
      Valuta:'EUR', Net:'-100,00', Transactiereferentie:'TX1', 'Reference Txn ID':'',
      Saldo:'0,00', Onderwerp:'Ads', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions[0].description, 'Ads');
});

test('parsePaypalCsv: description = "Factuur X" als alleen Factuurnummer', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'Klant Bas', Type:'Express Checkout',
      Valuta:'EUR', Net:'250,00', Transactiereferentie:'TX2', 'Reference Txn ID':'',
      Saldo:'250,00', Factuurnummer:'2025 / 844', 'Effect op saldo':'Bij' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions[0].description, 'Factuur 2025 / 844');
});

test('parsePaypalCsv: description = Item Title als geen Onderwerp', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'Discord', Type:'Vooraf goedgekeurde betaling',
      Valuta:'EUR', Net:'-9,99', Transactiereferentie:'TX3', 'Reference Txn ID':'',
      Saldo:'0,00', 'Item Title':'Nitro Monthly', 'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions[0].description, 'Nitro Monthly');
});

test('parsePaypalCsv: prioriteit — Onderwerp overschrijft Item Title + Factuurnummer', () => {
  const csv = makeMiniCsv([
    { Datum:'28-07-2025', Naam:'X', Type:'Y', Valuta:'EUR', Net:'-1,00',
      Transactiereferentie:'TX4', 'Reference Txn ID':'', Saldo:'0,00',
      Onderwerp:'ONDERWERP', 'Item Title':'ITEM', Factuurnummer:'999',
      'Effect op saldo':'Af' },
  ]);
  const p = parsePaypalCsv(csv);
  assert.strictEqual(p.transactions[0].description, 'ONDERWERP');
});
