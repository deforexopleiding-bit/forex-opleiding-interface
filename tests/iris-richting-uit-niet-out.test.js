// tests/iris-richting-uit-niet-out.test.js
//
// `iris_berichten.richting` is 'in' of 'uit'. Niet 'out'.
//
// ── DE BUG, EN WAAROM HIJ ONZICHTBAAR WAS ───────────────────────────────────
// H3 (#1780) voegde aan cron-iris-werk twee regels toe:
//
//     if (vorm.richting === 'out') await stempelOutbound(...)
//
// `vorm.richting` komt uit waRichting() / mailRichting(), en die geven 'uit'
// terug. De vergelijking is dus ALTIJD onwaar: `laatste_outbound` werd nooit
// gestempeld.
//
// En dat was precies de kolom waar de hele "wacht op ons"-regel op leunt.
// balBijOns() doet `if (!outbound) return true` -- geen stempel betekent "er is
// niets van ons bekend, dus het wacht op ons". Met een kolom die nooit gevuld
// werd, gaf die regel dus voor élk gesprek met een inkomend bericht `true`.
// H3 stond stil in productie, zonder één foutmelding.
//
// De backfill had dezelfde fout (`WHERE b.richting = 'out'`, 0 rijen), en de
// toets van H3 pinde de kapotte tekst vast:
//     CRON.match(/if \(vorm\.richting === 'out'\) await stempelOutbound\(/g)
// Die toets was groen. Hij certificeerde de bug.
//
// Gemeten in productie, 13 oktober: iris_berichten.richting heeft 906 rijen
// 'in' en 1610 rijen 'uit'. Nul rijen 'out' -- de CHECK op die kolom staat op
// `IN ('in','uit')`, dus 'out' kán er niet eens in.
//
// ── WAT DEZE TOETSEN BEWAKEN ────────────────────────────────────────────────
// Niet "staat er ergens 'out'" -- dat matcht ook op deze uitleg, en op de
// BRONtabellen waar 'out' juist wél de goede waarde is. Wel: dat de keten van
// de ruwe bronwaarde tot de stempel-beslissing klopt, en dat de SQL dezelfde
// waarde gebruikt als de code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RICHTING, BRON_UITGAAND, waRichting, mailRichting, isUitgaand, vormWa, vormMail,
} from '../api/_lib/iris/opname.js';
import { balBijOns } from '../api/_lib/iris/werkbak.js';

const CRON    = readFileSync(new URL('../api/cron-iris-werk.js', import.meta.url), 'utf8');
const BACKFILL = readFileSync(new URL('../docs/sql-migrations/2026-10-13-iris-laatste-outbound-backfill.sql', import.meta.url), 'utf8');
const OUD      = readFileSync(new URL('../docs/sql-migrations/archived/2026-10-12-iris-laatste-outbound-backfill.sql', import.meta.url), 'utf8');
const SCHEMA   = readFileSync(new URL('../docs/sql-migrations/2026-09-21-iris-fase1-datamodel.sql', import.meta.url), 'utf8');

/** Commentaar eruit. Anders matcht een toets op de uitleg waarin de fout geciteerd staat. */
const jsCode = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');
/** Uitvoerbare SQL: alles achter `--` weg. */
const sqlCode = (src) => src
  .split('\n').map((r) => r.replace(/--.*$/, '')).join('\n');

const C_CRON = jsCode(CRON);
const SQL_NIEUW = sqlCode(BACKFILL);

/* ── de constante ─────────────────────────────────────────────────────────── */

test('de kolom kent precies twee waarden, en "out" is er geen van', () => {
  assert.deepEqual(Object.values(RICHTING).sort(), ['in', 'uit']);
  assert.ok(!Object.values(RICHTING).includes('out'));
});

test('het schema staat geen derde waarde toe', () => {
  // Dit is waarom de oude backfill 0 rijen zou raken: 'out' kán er niet in.
  assert.match(SCHEMA, /richting\s+text NOT NULL CHECK \(richting IN \('in','uit'\)\)/);
});

/* ── de vertaling van bron naar onze woorden ──────────────────────────────── */

test("de BRON gebruikt 'out' — en dat is daar juist goed", () => {
  assert.deepEqual([...BRON_UITGAAND].sort(), ['out', 'outbound']);
});

test("'out' gaat erin, 'uit' komt eruit — dat is de asymmetrie waar het misging", () => {
  assert.equal(waRichting('out'), 'uit');
  assert.equal(waRichting('outbound'), 'uit');
  assert.equal(waRichting('OUT'), 'uit');
  assert.equal(waRichting('in'), 'in');
  assert.equal(waRichting('inbound'), 'in');
  assert.equal(waRichting(null), 'in');
  // En het punt: de uitkomst is NOOIT 'out'.
  for (const ruw of ['out', 'outbound', 'OUT', 'in', '', null, undefined, 'rommel']) {
    assert.notEqual(waRichting(ruw), 'out', `waRichting(${JSON.stringify(ruw)}) gaf 'out'`);
  }
});

test('een mail van onszelf is ook "uit", nooit "out"', () => {
  assert.equal(mailRichting('administratie@deforexopleiding.nl'), 'uit');
  assert.equal(mailRichting('klant@gmail.com'), 'in');
  assert.notEqual(mailRichting('administratie@deforexopleiding.nl'), 'out');
});

/* ── de keten tot de stempel-beslissing ───────────────────────────────────── */

test('DE BUG: een uitgaand WhatsApp-bericht hoort gestempeld te worden', () => {
  // Dit is de toets die op de oude code faalt. vormWa geeft richting 'uit';
  // `=== 'out'` was onwaar, dus stempelOutbound werd niet aangeroepen.
  const vorm = vormWa({ id: 'm1', direction: 'out', body: 'hoi', created_at: '2026-10-13T10:00:00Z' });
  assert.equal(vorm.richting, 'uit');
  assert.equal(isUitgaand(vorm), true, 'een uitgaand bericht wordt niet als uitgaand herkend');
  assert.equal(vorm.richting === 'out', false, "de oude vergelijking was altijd onwaar — dát was de bug");
});

test('een uitgaande mail net zo', () => {
  const vorm = vormMail({ id: 'e1', from_address: 'administratie@deforexopleiding.nl', snippet: 'hoi', date_received: '2026-10-13T10:00:00Z' });
  assert.equal(isUitgaand(vorm), true);
});

test('een inkomend bericht wordt NIET gestempeld', () => {
  assert.equal(isUitgaand(vormWa({ id: 'm2', direction: 'in', body: 'hoi' })), false);
  assert.equal(isUitgaand(vormMail({ id: 'e2', from_address: 'klant@gmail.com' })), false);
  assert.equal(isUitgaand(null), false);
  assert.equal(isUitgaand({}), false);
});

test('de cron beslist via isUitgaand, niet via een losse tekst', () => {
  assert.equal((C_CRON.match(/if \(isUitgaand\(vorm\)\) await stempelOutbound\(/g) || []).length, 2,
    'beide opnamepaden (WhatsApp en mail) horen te stempelen');
  assert.ok(!/vorm\.richting === '/.test(C_CRON),
    'de cron vergelijkt richting nog met een letterlijke tekst');
});

/* ── waarom het zo stil kapot was ─────────────────────────────────────────── */

test('zonder stempel telt ELK gesprek met een inkomend bericht als "wacht op ons"', () => {
  // Dit is wat de werkbak op 569 hield in plaats van 225: geen stempel, dus
  // balBijOns geeft true. Geen foutmelding, alleen een te lange lijst.
  assert.equal(balBijOns({ laatste_inbound: '2026-10-01T10:00:00Z', laatste_outbound: null }), true);
  // Mét stempel doet hij wat H3 bedoelde.
  assert.equal(balBijOns({ laatste_inbound: '2026-10-01T10:00:00Z', laatste_outbound: '2026-10-02T10:00:00Z' }), false);
});

/* ── de SQL ───────────────────────────────────────────────────────────────── */

test('de nieuwe backfill filtert op de waarde die bestaat', () => {
  assert.ok(SQL_NIEUW.includes("richting = 'uit'"), "de backfill filtert niet op 'uit'");
  assert.ok(!SQL_NIEUW.includes("richting = 'out'"), "er staat nog 'out' in de UITVOERBARE SQL");
});

test('de code en de SQL gebruiken dezelfde waarde', () => {
  // Dit is de koppeling die ontbrak: SQL kan niets importeren, dus moet een
  // toets de twee tegen elkaar houden.
  assert.ok(SQL_NIEUW.includes(`richting = '${RICHTING.UIT}'`),
    `de SQL hoort te filteren op '${RICHTING.UIT}', de waarde die de code schrijft`);
});

test('de nieuwe backfill controleert de aanname VOORDAT hij iets doet', () => {
  // De stap die de vorige versie niet had, en die hem gered zou hebben.
  const voorDeEersteUpdate = SQL_NIEUW.slice(0, SQL_NIEUW.indexOf('UPDATE'));
  assert.match(voorDeEersteUpdate, /GROUP BY richting/, 'er wordt niet eerst gekeken welke waarden er zijn');
});

test('de oude backfill is afgevoerd en draagt een waarschuwing', () => {
  assert.match(OUD, /⛔ NIET DRAAIEN/);
  assert.match(OUD, /2026-10-13-iris-laatste-outbound-backfill\.sql/);
});

test('het oude bestand staat niet meer op de plek waar je migraties pakt', () => {
  let bestaatNog = true;
  try {
    readFileSync(new URL('../docs/sql-migrations/2026-10-12-iris-laatste-outbound-backfill.sql', import.meta.url));
  } catch {
    bestaatNog = false;
  }
  assert.equal(bestaatNog, false, 'de kapotte backfill staat nog tussen de te draaien migraties');
});

test('de twee sporen botsen niet', () => {
  // Elk een eigen tabelnaam, zodat een leeg spoor van de afgevoerde versie niet
  // suggereert dat er al een backfill gelopen heeft.
  assert.ok(SQL_NIEUW.includes('iris_outbound_backfill_20261013'));
  assert.ok(!SQL_NIEUW.includes('INSERT INTO public.iris_outbound_backfill_20261012'));
});
