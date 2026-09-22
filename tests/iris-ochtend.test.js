// tests/iris-ochtend.test.js
//
// Het ochtendoverzicht en de gezondheid.
//
// Waar dit bestand echt over gaat: het verschil tussen "er is niets aan de
// hand" en "we konden niet kijken". Een gezondheidsrapport dat bij een
// leesfout groen kleurt, is erger dan geen rapport — dan denk je dat je kijkt
// terwijl je niets ziet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NIET_GEMETEN,
  GRENZEN,
  gemeten,
  nietGemeten,
  bouwOverzicht,
  alarmTekst,
} from '../api/_lib/iris/ochtend.js';

// ── gemeten en niet gemeten ─────────────────────────────────────────────────

test('een meting binnen de grens is ok', () => {
  const m = gemeten('concepten', 3, { grens: 10 });
  assert.equal(m.status, 'ok');
  assert.equal(m.waarde, 3);
});

test('een meting boven de grens vraagt aandacht', () => {
  const m = gemeten('concepten', 14, { grens: 10 });
  assert.equal(m.status, 'let_op');
});

test('een grens kan ook naar beneden werken', () => {
  // Nul nieuwe berichten in 24 uur is het eerste teken dat een webhook
  // stilgevallen is.
  const m = gemeten('nieuwe berichten', 0, { grens: 1, hoger_is_slechter: false });
  assert.equal(m.status, 'let_op');
  assert.equal(gemeten('nieuwe berichten', 5, { grens: 1, hoger_is_slechter: false }).status, 'ok');
});

test('zonder grens is elke waarde gewoon ok', () => {
  assert.equal(gemeten('verstuurd', 99).status, 'ok');
  assert.equal(gemeten('verstuurd', 0).status, 'ok');
});

test('een niet-gelukte meting is NIET nul en NIET ok', () => {
  // Dit is de kern van dit bestand.
  const m = nietGemeten('facturen', 'databank weg');
  assert.equal(m.status, NIET_GEMETEN);
  assert.notEqual(m.status, 'ok');
  assert.equal(m.waarde, null, 'null, niet nul — nul is een bewering');
  assert.match(m.reden, /databank weg/);
});

test('een niet-gelukte meting zonder reden krijgt er toch een', () => {
  assert.equal(nietGemeten('x').reden, 'onbekend');
});

// ── het overzicht ───────────────────────────────────────────────────────────

test('een gezond overzicht heeft geen problemen', () => {
  const o = bouwOverzicht({
    gedaan: { verstuurd: 4, ingedeeld: 12 },
    wacht: { concepten: 0 },
    metingen: [gemeten('a', 1), gemeten('b', 2)],
  });
  assert.equal(o.gezond, true);
  assert.deepEqual(o.problemen, []);
});

test('een niet-gemeten waarde maakt het overzicht ONGEZOND', () => {
  // Niet kunnen kijken hoort net zo hard op te vallen als iets zien dat
  // misgaat. Anders is "we konden niet kijken" de stilste fout die er is.
  const o = bouwOverzicht({ metingen: [gemeten('a', 1), nietGemeten('b', 'weg')] });
  assert.equal(o.gezond, false);
  assert.equal(o.problemen.length, 1);
  assert.equal(o.problemen[0].status, NIET_GEMETEN);
});

test('een waarde boven de grens maakt het overzicht ook ongezond', () => {
  const o = bouwOverzicht({ metingen: [gemeten('a', 50, { grens: 10 })] });
  assert.equal(o.gezond, false);
});

test('de samenvatting noemt wat er gebeurd is', () => {
  const o = bouwOverzicht({ gedaan: { verstuurd: 3, ingedeeld: 9 } });
  assert.match(o.samenvatting.join(' '), /9 bericht/);
  assert.match(o.samenvatting.join(' '), /verstuurde er 3/);
});

test('een stille nacht wordt met zoveel woorden gezegd', () => {
  const o = bouwOverzicht({ gedaan: { verstuurd: 0, ingedeeld: 0 } });
  assert.match(o.samenvatting[0], /niets verstuurd/);
});

test('de samenvatting noemt alleen wat er IS', () => {
  // Een lijst met veertien getallen leest niemand na de derde ochtend, en dan
  // mist hij ook de twee die er wél toe deden.
  const leeg = bouwOverzicht({ gedaan: { verstuurd: 0 }, wacht: {}, bellen: {}, beloftes: {} });
  const vol = bouwOverzicht({
    gedaan: { verstuurd: 2 },
    wacht: { concepten: 3, opdrachten: 1, niet_gekoppeld: 2 },
    bellen: { open: 5 },
    beloftes: { vandaag: 1 },
  });
  assert.equal(leeg.samenvatting.length, 1);
  assert.ok(vol.samenvatting.length > leeg.samenvatting.length);
});

test('elke regel in de samenvatting is een hele zin', () => {
  const o = bouwOverzicht({
    gedaan: { verstuurd: 2, ingedeeld: 5 },
    wacht: { concepten: 3 },
    bellen: { open: 2, escalatie: 1 },
    beloftes: { vandaag: 1 },
  });
  for (const r of o.samenvatting) {
    assert.ok(r.endsWith('.'), `"${r}" is geen hele zin`);
    assert.ok(r.length > 15);
  }
});

test('de escalatieteller wordt alleen genoemd als er een is', () => {
  const met = bouwOverzicht({ bellen: { open: 3, escalatie: 2 } });
  const zonder = bouwOverzicht({ bellen: { open: 3 } });
  assert.match(met.samenvatting.join(' '), /klaar voor escalatie/);
  assert.doesNotMatch(zonder.samenvatting.join(' '), /escalatie/);
});

// ── de alarmmail ────────────────────────────────────────────────────────────

test('zonder problemen gaat er GEEN mail', () => {
  // Een dagelijkse mail die meestal "alles goed" zegt, wordt na twee weken
  // niet meer gelezen — en dan mist hij de ene keer dat het wél mis was.
  const o = bouwOverzicht({ metingen: [gemeten('a', 1)] });
  assert.equal(alarmTekst(o), null);
});

test('met problemen staat er precies in wat er is', () => {
  const o = bouwOverzicht({ metingen: [gemeten('vastgelopen berichten', 4, { grens: 0 })] });
  const t = alarmTekst(o);
  assert.match(t, /vastgelopen berichten/);
  assert.match(t, /4/);
  assert.match(t, /grens: 0/);
});

test('de mail legt uit wat NIET GEMETEN betekent', () => {
  // Zonder die uitleg leest iemand het als "nul" en denkt hij dat het goed zit.
  const o = bouwOverzicht({ metingen: [nietGemeten('belrij', 'tabel weg')] });
  const t = alarmTekst(o);
  assert.match(t, /NIET GEMETEN/);
  assert.match(t, /tabel weg/);
  assert.match(t, /Dat is iets\s+anders dan "er is niets aan de hand"/);
});

test('een leeg overzicht geeft geen mail en geen crash', () => {
  assert.equal(alarmTekst(null), null);
  assert.equal(alarmTekst({}), null);
  assert.equal(alarmTekst({ problemen: [] }), null);
});

// ── de grenzen ──────────────────────────────────────────────────────────────

test('de grens voor een goedgekeurd bericht ligt ruim boven het ongedaan-venster', () => {
  // Het venster is 30 seconden. Een grens van een kwartier betekent dat er
  // echt iets mis is, niet dat de klok een seconde verschilt.
  assert.ok(GRENZEN.goedgekeurd_minuten >= 5);
});

test('de grenzen zijn allemaal een positief getal', () => {
  for (const [naam, waarde] of Object.entries(GRENZEN)) {
    assert.ok(Number.isFinite(waarde) && waarde > 0, `${naam} is geen bruikbare grens`);
  }
});

test('een concept mag een werkdag blijven staan, niet langer', () => {
  assert.ok(GRENZEN.concept_uren >= 8 && GRENZEN.concept_uren <= 24);
});
