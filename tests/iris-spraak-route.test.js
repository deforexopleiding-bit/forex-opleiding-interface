// tests/iris-spraak-route.test.js
//
// De keuze tussen de twee wegen naar tekst.
//
// Maxim heeft gekozen voor alleen Anthropic. De Anthropic-API doet geen spraak
// naar tekst, dus luistert de browser mee (Web Speech). De OpenAI-weg blijft
// staan als optie voor als er ooit tóch een sleutel is — nauwkeuriger bij
// eigennamen, en hij werkt in élke browser.
//
// Wat deze test bewaakt is niet welke weg "beter" is, maar dat het ontbreken
// van de sleutel als KEUZE gelezen wordt en niet als storing. Dat verschil
// bepaalt of er een foutmelding op het scherm komt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiBeschikbaar, spraakRoute } from '../api/_lib/iris/spraak.js';

test('een sleutel betekent de OpenAI-weg', () => {
  assert.equal(openaiBeschikbaar({ OPENAI_API_KEY: 'sk-test' }), true);
  assert.equal(spraakRoute({ OPENAI_API_KEY: 'sk-test' }), 'openai');
});

test('geen sleutel betekent de browser, niet een fout', () => {
  for (const env of [{}, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: '   ' }, { OPENAI_API_KEY: null }, null, undefined]) {
    assert.equal(openaiBeschikbaar(env), false);
    assert.equal(spraakRoute(env), 'browser');
  }
});

test('spaties eromheen tellen niet als een sleutel', () => {
  // Een variabele die per ongeluk op een spatie staat is leeg, geen sleutel.
  // Zonder trim zou het scherm naar een weg gestuurd worden die 401 geeft.
  assert.equal(openaiBeschikbaar({ OPENAI_API_KEY: '\n\t ' }), false);
  assert.equal(openaiBeschikbaar({ OPENAI_API_KEY: ' sk-x ' }), true);
});
