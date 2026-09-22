// tests/gesprekken-werkstand.test.js
//
// Waar een gesprek op wacht, en of er vandaag een belofte loopt.
//
// Het gat: de lijst kon filteren op status en op zoeken. Wat ontbrak is
// precies waar je op wilt filteren als je 's ochtends begint — wacht dit op
// ONS of op de KLANT. Die gegevens bestonden al in iris_gesprekken en
// iris_beloftes; ze werden alleen niet gelezen door het scherm dat ze nodig
// heeft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOK,
  werkSleutel,
  inBlokken,
  isVandaag,
  metWerkstand,
} from '../api/_lib/gesprekken-werkstand.js';

// ── de brug tussen de twee tabellen ─────────────────────────────────────────

test('de sleutel is precies wat de migratie belooft', () => {
  // Dit is de enige brug tussen whatsapp_conversations en iris_gesprekken.
  // Typ je 'm ergens anders nog eens over, dan loopt hij een keer uit de pas.
  assert.equal(werkSleutel('abc-123'), 'whatsapp:abc-123');
});

test('zonder gesprek geen sleutel — en dus geen opvraging', () => {
  // Een lege sleutel in een .in() is een filter dat niets betekent.
  assert.equal(werkSleutel(''), null);
  assert.equal(werkSleutel(null), null);
  assert.equal(werkSleutel(undefined), null);
  assert.equal(werkSleutel('   '), null);
});

// ── in blokken ──────────────────────────────────────────────────────────────

test('de lijst wordt gehakt op een grootte die de URL aankan', () => {
  // Een .in() met 1000 sleutels van ruim veertig tekens wordt een URL van
  // tientallen kilobytes, en die knapt ergens tussen PostgREST en de proxy —
  // niet met een nette fout, maar met een lege lijst of een 414.
  const blokken = inBlokken(Array.from({ length: 1000 }, (_, i) => `k${i}`));
  assert.equal(blokken.length, Math.ceil(1000 / BLOK));
  for (const b of blokken) assert.ok(b.length <= BLOK);
  assert.equal(blokken.flat().length, 1000, 'er mag er geen één wegvallen');
});

test('bij de 115 gesprekken van vandaag is het gewoon één blok', () => {
  assert.equal(inBlokken(Array.from({ length: 115 }, (_, i) => `k${i}`)).length, 1);
});

test('leeg erin geeft geen enkel blok, dus ook geen opvraging', () => {
  assert.deepEqual(inBlokken([]), []);
  assert.deepEqual(inBlokken(null), []);
  // Lege sleutels horen er niet in te belanden.
  assert.deepEqual(inBlokken([null, '', undefined]), []);
});

// ── vandaag is de LOKALE dag ────────────────────────────────────────────────

test('een belofte van vandaag telt, die van morgen en gisteren niet', () => {
  const nu = new Date(2026, 8, 22, 12, 0, 0); // 22 september 2026, lokaal
  assert.equal(isVandaag('2026-09-22', nu), true);
  assert.equal(isVandaag('2026-09-23', nu), false);
  assert.equal(isVandaag('2026-09-21', nu), false);
});

test('laat op de avond is morgen nog steeds morgen', () => {
  // Met toISOString() zou een belofte voor morgen er om half elf 's avonds al
  // als "vandaag" uitzien. Dat is de off-by-one waar dit project eerder op
  // stukliep, en hier zou hij een toezegging een dag te vroeg laten oplichten.
  const laat = new Date(2026, 8, 22, 23, 30, 0);
  assert.equal(isVandaag('2026-09-22', laat), true);
  assert.equal(isVandaag('2026-09-23', laat), false);
});

test('vroeg in de nacht is vandaag nog steeds vandaag', () => {
  const vroeg = new Date(2026, 8, 22, 0, 30, 0);
  assert.equal(isVandaag('2026-09-22', vroeg), true);
  assert.equal(isVandaag('2026-09-21', vroeg), false);
});

test('een onleesbare datum telt niet mee', () => {
  const nu = new Date(2026, 8, 22, 12, 0, 0);
  for (const d of [null, undefined, '', 'morgen', '22-09-2026', {}]) {
    assert.equal(isVandaag(d, nu), false);
  }
});

// ── de regel aankleden ──────────────────────────────────────────────────────

const STANDEN = new Map([
  ['whatsapp:c1', { status: 'wacht_op_ons', toegewezen_aan: 'p1', contact_id: 'k1' }],
  ['whatsapp:c2', { status: 'wacht_op_klant', toegewezen_aan: null, contact_id: 'k2' }],
]);
const NAMEN = new Map([['p1', 'Dave']]);

test('de stand, de naam en de belofte komen op de regel', () => {
  const r = metWerkstand({ id: 'c1' }, STANDEN, NAMEN, new Set(['k1']));
  assert.equal(r.iris_status, 'wacht_op_ons');
  assert.equal(r.toegewezen_aan, 'p1');
  assert.equal(r.toegewezen_naam, 'Dave');
  assert.equal(r.belofte_vandaag, true);
});

test('een gesprek dat Iris nog niet gezien heeft krijgt GEEN stand', () => {
  // Uitdrukkelijk null en niet 'nieuw': anders beweren we iets wat we niet
  // weten, en dan filtert iemand op "wacht op ons" en mist hij precies de
  // gesprekken waar nog niets over bekend is.
  const r = metWerkstand({ id: 'onbekend' }, STANDEN, NAMEN, new Set());
  assert.equal(r.iris_status, null);
  assert.equal(r.toegewezen_aan, null);
  assert.equal(r.toegewezen_naam, null);
  assert.equal(r.belofte_vandaag, false);
});

test('toegewezen zonder bekende naam geeft geen uuid in beeld', () => {
  // Een uuid op het scherm is geen antwoord op "van wie is dit" maar een
  // nieuwe vraag.
  const standen = new Map([['whatsapp:c9', { status: 'nieuw', toegewezen_aan: 'pX', contact_id: null }]]);
  const r = metWerkstand({ id: 'c9' }, standen, NAMEN, new Set());
  assert.equal(r.toegewezen_aan, 'pX');
  assert.equal(r.toegewezen_naam, null);
});

test('de bestaande velden van de regel blijven staan', () => {
  const r = metWerkstand({ id: 'c2', customer_name: 'Jan', unread_count: 3 }, STANDEN, NAMEN, new Set());
  assert.equal(r.customer_name, 'Jan');
  assert.equal(r.unread_count, 3);
  assert.equal(r.iris_status, 'wacht_op_klant');
});

test('aankleden raakt de oorspronkelijke regel niet aan', () => {
  const origineel = { id: 'c1' };
  metWerkstand(origineel, STANDEN, NAMEN, new Set(['k1']));
  assert.deepEqual(origineel, { id: 'c1' });
});

test('onzin erin gooit niets om', () => {
  for (const arg of [null, undefined, {}]) {
    const r = metWerkstand(arg, null, null, null);
    assert.equal(r.iris_status, null);
    assert.equal(r.belofte_vandaag, false);
  }
});
