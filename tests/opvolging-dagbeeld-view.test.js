// tests/opvolging-dagbeeld-view.test.js
//
// HET SCHERM ZELF, UITGEVOERD.
//
// Op 9 september gaf een sabotage die de afrondknop achter een voorwaarde
// verstopte nul rood, omdat geen enkele test naar de view keek. Deze tests
// knippen de ECHTE uitdrukking uit opvolging-v2.js en voeren hem uit in een
// node:vm. Ze lezen de brontekst niet — ze draaien hem.
//
// Wat hier bewezen wordt is de grens: het grijs en het label horen bij het
// AGENDAFEIT (verzet), niet bij een status die van buiten komt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { agendaFeit, knoppenVoor } from '../api/_lib/opvolging-dagbeeld.js';

const VIEW = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');

/** De uitdrukking die de regel-CSS bepaalt, uitgevoerd op een echte rij. */
function klasseVoor(c) {
  // Inclusief de regel die `dood` afleidt: dat IS de code onder test. Die
  // waarde in de context zetten zou de vraag beantwoorden in plaats van hem
  // te stellen.
  const start = VIEW.indexOf('const dood = ');
  assert.ok(start > 0, 'de doorgehaald-regel is niet gevonden in de view');
  const klasse = VIEW.indexOf("'<div class=\"call'", start);
  assert.ok(klasse > start, 'de regel-uitdrukking is niet gevonden in de view');
  const eind = VIEW.indexOf("+\n", klasse);
  assert.ok(eind > klasse, 'het einde van de uitdrukking is niet gevonden');
  const bron = VIEW.slice(start, VIEW.indexOf('\n', start) + 1)
    + 'const uit = ' + VIEW.slice(klasse, eind).trim() + ';\nuit;';
  return runInContext(bron, createContext({ c, geweest: false }), { filename: 'opvolging-v2.js#klasse' });
}

/** De uitdrukking die het label naast de naam zet, uitgevoerd. */
function labelVoor(c) {
  const anker = "const label = c.label ?";
  const start = VIEW.indexOf(anker);
  assert.ok(start > 0, 'de label-uitdrukking is niet gevonden in de view');
  const eind = VIEW.indexOf("';", start + anker.length);
  assert.ok(eind > start, 'het einde van de label-uitdrukking is niet gevonden');
  const bron = VIEW.slice(start, eind + 2) + '\nlabel;';
  return runInContext(bron, createContext({ c, esc: (s) => String(s == null ? '' : s) }),
    { filename: 'opvolging-v2.js#label' });
}

const SANDER = {
  id: 'a', lead_name: 'sander De groot', status: 'scheduled',
  scheduled_at: '2026-09-15T13:00:00Z', eerst_gepland_op: '2026-09-07T13:00:00Z',
};
// Zoals de server hem uitlevert: het oordeel is server-side gemaakt.
const rij = (a, opNieuweDag = false) => ({
  label      : agendaFeit(a, { negeerVerplaatsing: opNieuweDag }).label,
  doorgehaald: agendaFeit(a, { negeerVerplaatsing: opNieuweDag }).doorgehaald,
  knoppen    : knoppenVoor(a, Date.parse('2026-09-08T12:00:00Z'), { opNieuweDag }),
});

test('een verzette call staat grijs op zijn oude dag, met de bestemming erbij', () => {
  const c = rij(SANDER);
  assert.match(klasseVoor(c), /vervallen/);
  assert.match(labelVoor(c), /verzet naar 15 september om 15:00/);
});

test('op zijn nieuwe dag staat hij gewoon, zonder label en zonder grijs', () => {
  const c = rij(SANDER, true);
  assert.doesNotMatch(klasseVoor(c), /vervallen/);
  assert.equal(labelVoor(c), '');
});

test('een no-show krijgt GEEN label en GEEN grijs — dat is Maxims grens', () => {
  // De status komt van buiten en zegt niets over wat Dave heeft vastgelegd.
  // Wat daarvan waar is staat in de afrondchip, en die leest alleen `uitkomst`.
  for (const status of ['no_show', 'completed', 'cancelled', 'in_progress']) {
    const c = rij({ ...SANDER, status, eerst_gepland_op: SANDER.scheduled_at });
    assert.equal(labelVoor(c), '', status + ' krijgt een label op het scherm');
    assert.doesNotMatch(klasseVoor(c), /vervallen/, status + ' wordt grijs getoond');
  }
});

test('een oudere server zonder deze velden levert een gewone regel op', () => {
  assert.doesNotMatch(klasseVoor({}), /vervallen/);
  assert.equal(labelVoor({}), '');
});
