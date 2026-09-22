// tests/gesprekken-v2-venster-en-status.test.js
//
// De twee rekensommen uit modules/shared/gesprekken-v2.js, nagerekend.
//
// Ze horen bij gat G3 en G9 uit docs/iris/02-gesprekken-audit.md. Allebei gaan
// ze over hetzelfde soort fout: gegevens die er wél zijn maar niet getoond
// worden, waardoor het scherm iets anders beweert dan de databank weet.
//
// Wat hier vooral bewaakt wordt zijn de randen, want dáár zit het verschil
// tussen een geruststellende badge en een leugen:
//
//   · "niet bekend" is niet hetzelfde als "verlopen";
//   · een minuut vóór sluitingstijd staat er niet "0m" (dat leest als dicht);
//   · een mislukt bericht krijgt nooit hetzelfde teken als een afgeleverd;
//   · een status die we niet kennen wordt zichtbaar, niet weggeslikt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Draai het browser-script en pak zijn export. Eén bron, geen tweede kopie. */
function laad() {
  const bron = readFileSync(join(ROOT, 'modules/shared/gesprekken-v2.js'), 'utf8');
  const mod = { exports: {} };
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function('window', 'module', bron)(win, mod);
  assert.equal(win.GESPREKKEN_V2, mod.exports, 'window- en module-export lopen uit elkaar');
  return mod.exports;
}

const G = laad();
const NU = Date.parse('2026-09-22T12:00:00Z');
const geleden = (ms) => new Date(NU - ms).toISOString();
const UUR = 3600 * 1000;

/* ── G3 · het venster ─────────────────────────────────────────────────── */

test('zonder last_inbound_at is het venster niet bekend, niet verlopen', () => {
  for (const leeg of [null, undefined, '']) {
    const v = G.vensterStand(leeg, NU);
    assert.equal(v.bekend, false);
    assert.equal(v.tekst, '', 'een gesprek zonder inkomend bericht mag geen "verlopen" tonen');
  }
});

test('een onleesbare datum telt als onbekend, niet als verlopen', () => {
  const v = G.vensterStand('gisteren', NU);
  assert.equal(v.bekend, false);
  assert.equal(v.tekst, '');
});

test('zes uur geleden binnengekomen → nog 18u00 open', () => {
  const v = G.vensterStand(geleden(6 * UUR), NU);
  assert.equal(v.open, true);
  assert.equal(v.tekst, 'nog 18u00');
  assert.equal(v.bijnaDicht, false);
});

test('de minuten krijgen een voorloopnul — "6u02", niet "6u2"', () => {
  const v = G.vensterStand(geleden(17 * UUR + 58 * 60 * 1000), NU);
  assert.equal(v.tekst, 'nog 6u02');
});

test('onder het uur telt het in minuten', () => {
  const v = G.vensterStand(geleden(23 * UUR - 13 * 60 * 1000), NU);
  assert.equal(v.tekst, 'nog 1u13');
  const w = G.vensterStand(geleden(23 * UUR + 13 * 60 * 1000), NU);
  assert.equal(w.tekst, 'nog 47m');
});

test('de laatste minuut heet "<1m" en niet "0m"', () => {
  // "0m" leest als dicht terwijl het nog open is. Het verschil is precies het
  // gat: je denkt dat je een template nodig hebt en dat is niet zo.
  const v = G.vensterStand(geleden(24 * UUR - 30 * 1000), NU);
  assert.equal(v.open, true);
  assert.equal(v.tekst, 'nog <1m');
});

test('precies 24 uur is voorbij — de grens valt naar dicht', () => {
  const v = G.vensterStand(geleden(24 * UUR), NU);
  assert.equal(v.bekend, true);
  assert.equal(v.open, false);
  assert.equal(v.tekst, 'verlopen');
  // En dat komt overeen met wat de server zegt: inbox-thread-unified rekent
  // `(Date.now() - ms) < 24h`, dus exact 24 uur is daar óók niet meer open.
});

test('binnen twee uur van sluiten heet het bijna dicht', () => {
  assert.equal(G.vensterStand(geleden(22 * UUR + 1), NU).bijnaDicht, true);
  assert.equal(G.vensterStand(geleden(22 * UUR - 60 * 1000), NU).bijnaDicht, false);
  assert.equal(G.vensterStand(geleden(25 * UUR), NU).bijnaDicht, false, 'verlopen is niet "bijna dicht"');
});

test('een Date en een tekstdatum geven hetzelfde antwoord', () => {
  const d = new Date(NU - 5 * UUR);
  assert.deepEqual(G.vensterStand(d, NU), G.vensterStand(d.toISOString(), NU));
});

/* ── G9 · de verzendstatus ────────────────────────────────────────────── */

test('mislukt krijgt nooit hetzelfde teken als afgeleverd', () => {
  const mislukt = G.verzendStand('failed', 'Recipient not on WhatsApp');
  const goed = G.verzendStand('delivered');
  assert.notEqual(mislukt.teken, goed.teken);
  assert.equal(mislukt.kleur, 'rood');
  assert.match(mislukt.label, /Recipient not on WhatsApp/, 'de reden hoort erbij te staan');
});

test('mislukt zonder reden blijft leesbaar', () => {
  const v = G.verzendStand('failed', null);
  assert.equal(v.label, 'Niet verstuurd');
});

test('de vier gewone standen', () => {
  assert.equal(G.verzendStand('sent').teken, '✓');
  assert.equal(G.verzendStand('delivered').teken, '✓✓');
  assert.equal(G.verzendStand('read').teken, '✓✓');
  assert.equal(G.verzendStand('read').kleur, 'blue', 'gelezen moet van afgeleverd te onderscheiden zijn');
  assert.equal(G.verzendStand('pending').code, 'pending');
});

test('hoofdletters en spaties uit de databank storen niet', () => {
  assert.equal(G.verzendStand(' Delivered ').code, 'delivered');
});

test('geen status → geen teken (oude rijen liegen niet)', () => {
  assert.equal(G.verzendStand(null), null);
  assert.equal(G.verzendStand(''), null);
});

test('een onbekende status wordt zichtbaar, niet weggeslikt', () => {
  // Meta kan morgen een status bijverzinnen. Die mag er niet uitzien als
  // afgeleverd; hij moet opvallen zodat iemand 'em komt toevoegen.
  const v = G.verzendStand('teleported');
  assert.equal(v.code, 'onbekend');
  assert.match(v.label, /teleported/);
  assert.notEqual(v.teken, '✓✓');
});

/* ── Wie krijgt er een teken onder zich ───────────────────────────────── */

test('alleen uitgaande WhatsApp krijgt een verzendstatus', () => {
  assert.equal(G.toontVerzendStand({ channel: 'whatsapp', direction: 'outbound' }), true);
  assert.equal(G.toontVerzendStand({ channel: 'whatsapp', direction: 'out' }), true);
  assert.equal(G.toontVerzendStand({ channel: 'whatsapp', direction: 'inbound' }), false);
  assert.equal(G.toontVerzendStand({ channel: 'email', direction: 'outbound' }), false, 'mail heeft geen Meta-status');
  assert.equal(G.toontVerzendStand(null), false);
});
