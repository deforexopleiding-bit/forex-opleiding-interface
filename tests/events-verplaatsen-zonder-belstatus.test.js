// tests/events-verplaatsen-zonder-belstatus.test.js
//
// EEN VERPLAATSTE DEELNEMER KOMT ZONDER BELSTATUS BINNEN. MET OPZET.
//
// Sinds 15 sep 2026 neemt belstatus 'bevestigd' een plek in. Daarmee krijgt
// verplaatsen een zichtbaar gevolg: wie zijn plek enkel aan de bel ontleende,
// komt op het doel-event binnen ZONDER plek, en telt daar pas mee zodra hij de
// vragenlijst invult of opnieuw bevestigt.
//
// Dat leek eerst een vergeten kolom. Het is het bedoelde gedrag. Maxim,
// 15 sep 2026: "als hij verplaatst wordt komt hij zonder bevestigd terug in de
// flow terecht." Hij is bevestigd voor een dátum, niet voor het merk.
//
// Deze test staat er zodat niemand het later "repareert". Zou call_status wél
// meegekopieerd worden, dan zou de deelnemer op het doel-event meteen een plek
// innemen zonder dat iemand hem daarvoor gesproken heeft — én zou de
// belronde-automatisering (trigger on_call_status) op een oud call_status_at
// als nulpunt gaan lopen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { isPlekBezet } from '../api/_lib/plek-bezet.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KERN = readFileSync(join(ROOT, 'api/_lib/event-attendee-move-core.js'), 'utf8');

/** Het object dat de move op het doel-event inserteert. */
const insertBlok = (() => {
  const i = KERN.indexOf('const insertRow = {');
  assert.ok(i > 0, 'insertRow hoort te bestaan');
  return KERN.slice(i, KERN.indexOf('};', i) + 2);
})();

test('de nieuwe rij krijgt GEEN call_status en GEEN call_status_at mee', () => {
  // Niet als sleutel in het insert-object. Alleen in commentaar mag het woord
  // voorkomen — dat is de uitleg waarom het er níet staat.
  const code = insertBlok.split('\n').filter((r) => !r.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\bcall_status\s*:/);
  assert.doesNotMatch(code, /\bcall_status_at\s*:/);
  assert.doesNotMatch(code, /\bcalled\s*:/, 'ook de called-vlag hoort bij de belronde van het oude event');
});

test('de reden staat er in het bestand bij', () => {
  // Zonder uitleg is een ontbrekende kolom niet te onderscheiden van een bug,
  // en dan repareert de volgende lezer hem alsnog.
  assert.match(KERN, /DE BELSTATUS GAAT MET OPZET NIET MEE/);
  assert.match(KERN, /zonder bevestigd terug in de flow/);
});

test('wat WEL meegaat blijft meegaan', () => {
  // De vragenlijst is niet datum-gebonden: wie hem invulde houdt zijn plek op
  // het doel-event. Dat is precies het verschil met de belstatus.
  assert.match(insertBlok, /assessment_response_id:\s*source\.assessment_response_id/);
  assert.match(insertBlok, /is_test:\s*source\.is_test === true/);
  assert.match(insertBlok, /automation_enabled:\s*source\.automation_enabled !== false/);
});

test('het gevolg voor de telling, uitgeschreven', () => {
  const bron = {
    status: 'aangemeld', is_test: false,
    assessment_response_id: null, call_status: 'bevestigd',
  };
  assert.equal(isPlekBezet(bron), true, 'op het bron-event heeft hij een plek');

  // De nieuwe rij zoals de move hem maakt: status 'aangemeld', vragenlijst
  // overgenomen (hier: geen), belstatus leeg.
  const nieuw = {
    status: 'aangemeld', is_test: false,
    assessment_response_id: bron.assessment_response_id, call_status: null,
  };
  assert.equal(isPlekBezet(nieuw), false, 'op het doel-event nog niet — hij moet terug de flow in');

  // Vult hij daar de vragenlijst in, of bevestigt hij opnieuw, dan telt hij mee.
  assert.equal(isPlekBezet({ ...nieuw, assessment_response_id: 'resp-1' }), true);
  assert.equal(isPlekBezet({ ...nieuw, call_status: 'bevestigd' }), true);
});

test('wie de vragenlijst wél invulde, houdt zijn plek bij het verplaatsen', () => {
  const bron = { status: 'aangemeld', is_test: false, assessment_response_id: 'resp-1', call_status: 'bevestigd' };
  const nieuw = { status: 'aangemeld', is_test: false, assessment_response_id: bron.assessment_response_id, call_status: null };
  assert.equal(isPlekBezet(nieuw), true, 'de vragenlijst is niet datum-gebonden');
});
