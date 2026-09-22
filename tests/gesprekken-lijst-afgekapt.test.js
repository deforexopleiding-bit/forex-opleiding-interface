// tests/gesprekken-lijst-afgekapt.test.js
//
// Zeggen dat je niet alles ziet (G8, lijst-kant).
//
// ── WAT HIER NIET GEBEURT, EN WAAROM ─────────────────────────────────────────
// De draad kreeg echte paginering. De LIJST krijgt die niet, en dat is geen
// halfheid maar een grens die in de gegevens zit.
//
// De lijst sorteert op `last_activity_at`, en dat is MAX(laatste WhatsApp,
// laatste mail) — een waarde die het endpoint zelf uitrekent, geen kolom. Juist
// daarom haalt hij alles op: je kunt niet door de database laten sorteren op
// iets dat er niet in staat, en dus ook geen cursor op zetten.
//
// Sorteren op `last_message_at` alleen zou dat wel kunnen, maar dat is precies
// de bug die eerder is opgelost: een klant met verse MAIL en oude WhatsApp
// zakt dan weg in de lijst. Een cursor die een opgeloste bug terugbrengt is
// geen vooruitgang.
//
// Wat wél kan zonder de gegevens te veranderen: zeggen dat de lijst afgekapt
// is. Het endpoint rekende dat al uit en stuurde het mee (`cap_overflow_warning`);
// er keek alleen nooit iemand naar. Een onvolledige lijst die er volledig
// uitziet is het soort fout waar je pas maanden later achter komt: je zoekt
// een klant, vindt hem niet, en concludeert dat hij niet geschreven heeft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const LIJST = readFileSync(new URL('../api/inbox-conversations-list.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');

test('het endpoint rekent nog steeds uit of de lijst afgekapt is', () => {
  assert.match(LIJST, /cap_overflow_warning/);
  assert.match(LIJST, /totalCount > limit/);
});

test('het scherm bewaart dat antwoord in plaats van het weg te gooien', () => {
  // Dit was het hele gat: de waarschuwing reisde al mee, er keek alleen
  // niemand naar.
  assert.match(SCHERM, /st\.afgekapt = j\?\.cap_overflow_warning/);
  assert.match(SCHERM, /st\.totaal =/);
});

test('de banner staat er alleen als de lijst echt afgekapt is', () => {
  // Een waarschuwing die er altijd staat, lees je na een dag niet meer.
  assert.match(SCHERM, /const afgekaptBanner = \(_gv2\(\) && st\.afgekapt\)/);
});

test('de banner verschijnt ook boven een LEGE lijst', () => {
  // Juist dan is hij het hardst nodig: "geen gesprekken in dit filter" terwijl
  // je de helft niet hebt opgehaald, is ronduit misleidend.
  assert.match(SCHERM, /return afgekaptBanner \+ `<div style="padding:44px/);
  assert.match(SCHERM, /return afgekaptBanner \+ items\.map/);
});

test('de banner belooft niets over zoeken', () => {
  // Het zoekveld filtert eerst wat er al geladen is; de server ziet de
  // zoekterm pas bij de volgende poll. "Zoeken vindt het wel" zou dus pas na
  // een halve minuut kloppen, en een halve waarheid op een waarschuwing is
  // erger dan geen waarheid.
  const i = SCHERM.indexOf('const afgekaptBanner');
  const body = SCHERM.slice(i, i + 700);
  assert.doesNotMatch(body, /Zoeken kijkt/);
  assert.doesNotMatch(body, /zoeken vindt/i);
});

test('de lijst sorteert nog steeds op de samengestelde waarde', () => {
  // Als dit ooit verandert naar last_message_at alleen, is de eerder
  // opgeloste bug terug: verse mail met oude WhatsApp zakt weg. Deze test
  // staat er zodat die stap een bewuste wordt en geen sluipende.
  assert.match(LIJST, /last_activity_at/);
  assert.match(LIJST, /a\.last_activity_at \? Date\.parse\(a\.last_activity_at\)/);
});
