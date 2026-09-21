// tests/iris-verzend.test.js
//
// De laatste deur vóór een klant iets leest.
//
// Vier poorten in vaste volgorde: de tekst, het venster, de stille uren, de
// dosering. De goedkoopste controle vooraan, en de meest concrete reden eerst
// — "er staat nog [invullen] in" is bruikbaarder dan "het venster is dicht"
// als allebei waar zijn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keurVerzending, alGestuurdVandaag, VerzendFout } from '../api/_lib/iris/verzend.js';
import { ONTBREEKT } from '../api/_lib/iris/toon.js';

const NU = new Date('2026-09-21T12:00:00Z');           // maandag 14:00 Brussel
const NACHT = new Date('2026-09-22T00:30:00Z');        // dinsdag 02:30 Brussel
const uurGeleden = (n, vanaf = NU) => new Date(vanaf.getTime() - n * 3600 * 1000).toISOString();
const STIL = { van: '21:00', tot: '08:00', zondag_stil: true, tijdzone: 'Europe/Brussels' };

const BASIS = {
  tekst: 'Dank je wel voor je bericht, ik kijk het na.',
  kanaal: 'whatsapp',
  laatsteInbound: uurGeleden(2),
  stilleUrenInstelling: STIL,
  nu: NU,
};

// ── het gewone geval ────────────────────────────────────────────────────────

test('binnen het venster, overdag, met nette tekst: weg ermee', () => {
  const r = keurVerzending(BASIS);
  assert.equal(r.mag, true);
  assert.equal(r.vorm, 'tekst');
  assert.deepEqual(r.blokkades, []);
});

// ── poort 1: de tekst ───────────────────────────────────────────────────────

test('[invullen] blokkeert, ook bij een mens en ook met een open venster', () => {
  const r = keurVerzending({ ...BASIS, tekst: `Er staat nog ${ONTBREEKT} open.`, doorMens: true });
  assert.equal(r.mag, false);
  assert.ok(r.blokkades.some((b) => /invullen/.test(b)));
});

test('de eerste blokkade is de meest concrete, ook als er meer zijn', () => {
  // Tekst én venster gaan mis. De tekst staat vooraan omdat die actiegerichter
  // is: er staat iets in wat je kunt aanvullen.
  const r = keurVerzending({
    ...BASIS,
    tekst: `Bedrag: ${ONTBREEKT}`,
    laatsteInbound: uurGeleden(30),
  });
  assert.equal(r.mag, false);
  assert.match(r.blokkades[0], /invullen/);
});

// ── poort 2: het venster ────────────────────────────────────────────────────

test('buiten het venster is de vorm een template, geen blokkade', () => {
  const r = keurVerzending({ ...BASIS, laatsteInbound: uurGeleden(30) });
  assert.equal(r.mag, true, 'een gesloten venster verbiedt niets — het bepaalt de vorm');
  assert.equal(r.vorm, 'template');
});

test('mail kent het venster niet — dat is een regel van Meta over WhatsApp', () => {
  const r = keurVerzending({ ...BASIS, kanaal: 'email', laatsteInbound: uurGeleden(72) });
  assert.equal(r.mag, true);
  assert.equal(r.vorm, 'tekst', 'een mail van drie dagen later is gewoon een mail');
});

test('nog nooit contact gehad betekent ook: een template', () => {
  const r = keurVerzending({ ...BASIS, laatsteInbound: null });
  assert.equal(r.vorm, 'template');
});

// ── poort 3: de stille uren ─────────────────────────────────────────────────

test('s nachts stuurt Iris niets uit zichzelf', () => {
  const r = keurVerzending({
    ...BASIS,
    laatsteInbound: uurGeleden(1, NACHT),
    nu: NACHT,
    doorMens: false,
  });
  assert.equal(r.mag, false);
  assert.ok(r.blokkades.some((b) => /stille uren/.test(b)));
});

test('s nachts mag een mens wél op Verstuur drukken', () => {
  const r = keurVerzending({
    ...BASIS,
    laatsteInbound: uurGeleden(1, NACHT),
    nu: NACHT,
    doorMens: true,
  });
  assert.equal(r.mag, true);
});

test('het venster blijft afzonderlijk afleesbaar, ook als de stille uren blokkeren', () => {
  const r = keurVerzending({ ...BASIS, laatsteInbound: uurGeleden(1, NACHT), nu: NACHT });
  assert.equal(r.mag, false);
  assert.equal(r.venster.open, true, 'twee verschillende vragen, twee verschillende antwoorden');
});

// ── poort 4: de dosering ────────────────────────────────────────────────────

test('na twee berichten op een dag houdt Iris op', () => {
  const r = keurVerzending({ ...BASIS, alGestuurdVandaag: 2, maxPerDag: 2 });
  assert.equal(r.mag, false);
  assert.ok(r.blokkades.some((b) => /aandringen/.test(b)));
});

test('één bericht op een dag is geen probleem', () => {
  assert.equal(keurVerzending({ ...BASIS, alGestuurdVandaag: 1, maxPerDag: 2 }).mag, true);
});

test('de dosering geldt niet voor een mens', () => {
  // Een collega die drie keer moet reageren, heeft daar een reden voor.
  const r = keurVerzending({ ...BASIS, alGestuurdVandaag: 9, maxPerDag: 2, doorMens: true });
  assert.equal(r.mag, true);
});

// ── de neutrale herinnering ─────────────────────────────────────────────────

test('een neutrale herinnering met een bedrag erin geeft een waarschuwing, geen blokkade', () => {
  const r = keurVerzending({ ...BASIS, tekst: 'Je hebt nog € 450,00 open.', neutraleHerinnering: true });
  assert.equal(r.mag, true);
  assert.ok(r.waarschuwingen.length > 0);
});

// ── de dagteller ────────────────────────────────────────────────────────────

function nepTeller(antwoord) {
  return {
    from: () => {
      const b = { select: () => b, eq: () => b, is: () => b, gte: async () => antwoord };
      return b;
    },
  };
}

test('alGestuurdVandaag: telt wat er geteld wordt', async () => {
  assert.equal(await alGestuurdVandaag(nepTeller({ count: 3, error: null }), 'g1', NU), 3);
});

test('alGestuurdVandaag: zonder gesprek of client is het nul', async () => {
  assert.equal(await alGestuurdVandaag(null, 'g1'), 0);
  assert.equal(await alGestuurdVandaag(nepTeller({ count: 5, error: null }), null), 0);
});

test('alGestuurdVandaag: een leesfout betekent NIET nul maar het maximum', async () => {
  // Niet kunnen tellen is geen reden om ongelimiteerd te mogen sturen. Nul
  // teruggeven zou van een leesfout een vrijbrief maken.
  const r = await alGestuurdVandaag(nepTeller({ count: null, error: { message: 'weg' } }), 'g1', NU);
  assert.equal(r, Number.MAX_SAFE_INTEGER);
  assert.equal(keurVerzending({ ...BASIS, alGestuurdVandaag: r, maxPerDag: 2 }).mag, false);
});

test('alGestuurdVandaag: een uitzondering leidt ook tot dichtdraaien', async () => {
  const stuk = { from: () => { throw new Error('boem'); } };
  assert.equal(await alGestuurdVandaag(stuk, 'g1', NU), Number.MAX_SAFE_INTEGER);
});

// ── de fout ─────────────────────────────────────────────────────────────────

test('VerzendFout draagt een code zodat de aanroeper kan beslissen', () => {
  const f = new VerzendFout('het ging mis', 'META_FOUT', { status: 502 });
  assert.equal(f.code, 'META_FOUT');
  assert.equal(f.status, 502);
  assert.ok(f instanceof Error);
});

// ── alles tegelijk ──────────────────────────────────────────────────────────

test('elke blokkade is een zin die een mens kan lezen, geen foutcode', () => {
  const gevallen = [
    { ...BASIS, tekst: ONTBREEKT },
    { ...BASIS, tekst: '' },
    { ...BASIS, laatsteInbound: uurGeleden(1, NACHT), nu: NACHT },
    { ...BASIS, alGestuurdVandaag: 5, maxPerDag: 2 },
    { ...BASIS, tekst: 'Wij sturen een deurwaarder.' },
  ];
  for (const g of gevallen) {
    const r = keurVerzending(g);
    assert.equal(r.mag, false);
    for (const b of r.blokkades) {
      assert.ok(b.length > 15, `"${b}" is te kort om iets aan te hebben`);
      assert.doesNotMatch(b, /^[A-Z_]+$/, 'een foutcode is geen uitleg');
    }
  }
});
