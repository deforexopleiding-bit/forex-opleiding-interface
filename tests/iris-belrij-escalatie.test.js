// tests/iris-belrij-escalatie.test.js
//
// Taak 6, deel 3 (kern) — het mandaat rond de escalatie.
//
// Deze toetsen gaan niet over of de drempel klopt (dat doet
// iris-belrij.test.js via moetEscaleren) maar over wat er MAG gebeuren als hij
// gehaald is. Dat is de plek waar een fout een klant bereikt, dus staat elk
// geval hier apart: niet één toets op het goede pad, maar één per poort.
//
// Het punt dat elke toets hier bewaakt: 'zelf sturen' is gebouwd en staat UIT,
// en een poort die dicht staat valt terug op CONCEPT — niet op niets. Werk dat
// stil verdwijnt is erger dan werk dat wacht.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BELRIJ_STANDEN, STANDAARD_STAND, UREN, AFKOELING_UREN, BRONNEN,
  leesStand, standVoorBron, binnenKantooruren, beslisEscalatie,
} from '../api/_lib/iris/belrij-escalatie.js';
import { moetEscaleren } from '../api/_lib/iris/belrij.js';

const GEHAALD = { escaleren: true, reden: '3 pogingen op 3 verschillende dagen zonder contact' };
// 12:00 Brussel in de winter = 11:00 UTC; in de zomer 10:00 UTC.
const MIDDAG_WINTER = new Date('2026-01-15T11:00:00Z');
const MIDDAG_ZOMER  = new Date('2026-07-15T10:00:00Z');
const NACHT         = new Date('2026-01-15T23:15:00Z');

// ── standen lezen ───────────────────────────────────────────────────────────

test('rommel leest als concept, nooit als zelf', () => {
  for (const ruw of [null, undefined, '', 'ja', 'true', 'ZELF STUREN', 42, {}, 'autonomous']) {
    assert.equal(leesStand(ruw), STANDAARD_STAND, `${JSON.stringify(ruw)} werd niet concept`);
  }
  assert.equal(STANDAARD_STAND, 'concept');
  assert.deepEqual(BELRIJ_STANDEN, ['uit', 'concept', 'zelf']);
});

test('een bron zonder instelling staat op concept', () => {
  for (const bron of BRONNEN) assert.equal(standVoorBron({}, bron), 'concept');
  assert.equal(standVoorBron(null, 'wanbetaler'), 'concept');
  assert.equal(standVoorBron({ wanbetaler: 'zelf' }, 'mentorsignaal'), 'concept');
});

test('een bron die niet bestaat krijgt geen stand uit de instelling', () => {
  // Anders zou een typefout in de instellingen ('wanbetalers') stilletjes een
  // andere bron op zelf zetten.
  assert.equal(standVoorBron({ wanbetalers: 'zelf' }, 'wanbetalers'), 'concept');
});

test('alleen de letterlijke waarde zelf zet de stand op zelf', () => {
  assert.equal(standVoorBron({ wanbetaler: 'zelf' }, 'wanbetaler'), 'zelf');
  assert.equal(standVoorBron({ wanbetaler: 'ZELF' }, 'wanbetaler'), 'zelf');
  assert.equal(standVoorBron({ wanbetaler: 'zelf sturen' }, 'wanbetaler'), 'concept');
});

// ── kantooruren ─────────────────────────────────────────────────────────────

test('kantooruren gaan over de klok van de klant, niet over UTC', () => {
  // De server staat op UTC. In de zomer scheelt dat twee uur, en dan zou een
  // venster van 08:00 om 06:00 opengaan.
  assert.equal(binnenKantooruren(new Date('2026-07-15T05:30:00Z')), false, '07:30 Brussel viel binnen het venster');
  assert.equal(binnenKantooruren(new Date('2026-07-15T06:30:00Z')), true, '08:30 Brussel viel buiten het venster');
  assert.equal(binnenKantooruren(new Date('2026-01-15T07:30:00Z')), true, '08:30 Brussel in de winter');
  assert.equal(binnenKantooruren(new Date('2026-01-15T06:30:00Z')), false, '07:30 Brussel in de winter');
});

test('de grenzen van het venster: 20:00 valt erbuiten', () => {
  assert.equal(binnenKantooruren(new Date('2026-01-15T18:59:00Z')), true);  // 19:59
  assert.equal(binnenKantooruren(new Date('2026-01-15T19:00:00Z')), false); // 20:00
  assert.equal(UREN.van, 8);
  assert.equal(UREN.tot, 20);
});

test('een onleesbaar tijdstip of een onbekende tijdzone is BUITEN het venster', () => {
  assert.equal(binnenKantooruren(new Date('niet-een-datum')), false);
  assert.equal(binnenKantooruren(MIDDAG_WINTER, { tz: 'Mars/Olympus' }), false);
});

// ── de drempel gaat voor ────────────────────────────────────────────────────

test('zonder gehaalde drempel gebeurt er niets, ook op zelf', () => {
  const uit = beslisEscalatie({ escalatie: { escaleren: false, reden: '2 van de 3 pogingen' }, stand: 'zelf' });
  assert.equal(uit.doen, 'niets');
  assert.equal(uit.poort, 'drempel');
  assert.match(uit.reden, /2 van de 3/, 'de reden van de drempel hoort doorgegeven te worden');
});

test('een ontbrekende escalatie is geen escalatie', () => {
  assert.equal(beslisEscalatie({ stand: 'zelf' }).doen, 'niets');
  assert.equal(beslisEscalatie({}).doen, 'niets');
  assert.equal(beslisEscalatie().doen, 'niets');
});

test('escaleren: true met een andere waarde dan precies true telt niet', () => {
  // Een waarheidsachtige waarde uit jsonb mag geen bericht losmaken.
  for (const ruw of ['true', 1, 'ja', {}]) {
    assert.equal(beslisEscalatie({ escalatie: { escaleren: ruw }, stand: 'zelf' }).doen, 'niets');
  }
});

// ── de standen in de praktijk ───────────────────────────────────────────────

test('uit is uit: geen bericht en ook geen concept', () => {
  const uit = beslisEscalatie({ escalatie: GEHAALD, stand: 'uit' });
  assert.equal(uit.doen, 'niets');
  assert.equal(uit.poort, 'stand');
});

test('concept is de standaard, en heeft geen poorten nodig', () => {
  // Er gaat niets de deur uit zonder klik, dus nacht, afkoeling en afspraak
  // mogen een concept niet tegenhouden — anders mist een mens het juist dan.
  const uit = beslisEscalatie({
    escalatie: GEHAALD, stand: 'concept',
    nu: NACHT, laatsteUitgaandOp: NACHT.toISOString(), actieveAfspraak: true,
  });
  assert.equal(uit.doen, 'concept');
  assert.equal(uit.poort, null);
});

test('zelf mag alleen als alle vier de poorten open staan', () => {
  const uit = beslisEscalatie({ escalatie: GEHAALD, stand: 'zelf', nu: MIDDAG_WINTER });
  assert.equal(uit.doen, 'zelf');
  assert.equal(uit.poort, null);
});

// ── de vier poorten, elk apart ──────────────────────────────────────────────

test('poort 1 — buiten kantooruren wordt het een concept', () => {
  const uit = beslisEscalatie({ escalatie: GEHAALD, stand: 'zelf', nu: NACHT });
  assert.equal(uit.doen, 'concept');
  assert.equal(uit.poort, 'kantooruren');
  assert.match(uit.reden, /buiten 8-20 uur/);
});

test('poort 2 — binnen de afkoeling wordt het een concept', () => {
  const kort = new Date(MIDDAG_ZOMER.getTime() - 10 * 3600000).toISOString();
  const uit = beslisEscalatie({ escalatie: GEHAALD, stand: 'zelf', nu: MIDDAG_ZOMER, laatsteUitgaandOp: kort });
  assert.equal(uit.doen, 'concept');
  assert.equal(uit.poort, 'afkoeling');
  assert.match(uit.reden, /10 uur geleden/);
});

test('poort 2 — net buiten de afkoeling mag wel', () => {
  const lang = new Date(MIDDAG_ZOMER.getTime() - (AFKOELING_UREN + 1) * 3600000).toISOString();
  assert.equal(beslisEscalatie({ escalatie: GEHAALD, stand: 'zelf', nu: MIDDAG_ZOMER, laatsteUitgaandOp: lang }).doen, 'zelf');
});

test('poort 2 — precies op de grens van drie dagen mag nog niet', () => {
  const grens = new Date(MIDDAG_ZOMER.getTime() - (AFKOELING_UREN - 0.5) * 3600000).toISOString();
  assert.equal(beslisEscalatie({ escalatie: GEHAALD, stand: 'zelf', nu: MIDDAG_ZOMER, laatsteUitgaandOp: grens }).doen, 'concept');
  assert.equal(AFKOELING_UREN, 72);
});

test('poort 2 — een onleesbaar tijdstip blokkeert in plaats van door te laten', () => {
  const uit = beslisEscalatie({ escalatie: GEHAALD, stand: 'zelf', nu: MIDDAG_WINTER, laatsteUitgaandOp: 'gisteren' });
  assert.equal(uit.doen, 'concept');
  assert.equal(uit.poort, 'afkoeling');
});

test('poort 3 — tijdens een betaalafspraak wordt het een concept', () => {
  const uit = beslisEscalatie({ escalatie: GEHAALD, stand: 'zelf', nu: MIDDAG_WINTER, actieveAfspraak: true });
  assert.equal(uit.doen, 'concept');
  assert.equal(uit.poort, 'afspraak');
});

test('poort 4 — een open concept levert geen tweede op', () => {
  const uit = beslisEscalatie({ escalatie: GEHAALD, stand: 'zelf', nu: MIDDAG_WINTER, openConcept: true });
  assert.equal(uit.doen, 'niets');
  assert.equal(uit.poort, 'idempotentie');
});

test('de poorten hebben een vaste volgorde, zodat de reden de EERSTE blokkade is', () => {
  // Alles dicht tegelijk: idempotentie hoort eruit te komen, want een tweede
  // concept maken is het enige dat ook geen nut heeft om te wachten.
  const uit = beslisEscalatie({
    escalatie: GEHAALD, stand: 'zelf', nu: NACHT,
    laatsteUitgaandOp: NACHT.toISOString(), actieveAfspraak: true, openConcept: true,
  });
  assert.equal(uit.poort, 'idempotentie');

  // Zonder open concept is de afspraak de eerstvolgende.
  const zonder = beslisEscalatie({
    escalatie: GEHAALD, stand: 'zelf', nu: NACHT,
    laatsteUitgaandOp: NACHT.toISOString(), actieveAfspraak: true,
  });
  assert.equal(zonder.poort, 'afspraak');
});

// ── het samenspel met de drempel uit belrij.js ──────────────────────────────

test('iemand die gisteren nog appte komt niet aan de poorten toe', () => {
  const telling = { niet_opgenomen: 5, dagen_niet_opgenomen: 4, laatste_contact: null };
  const nu = MIDDAG_WINTER;
  const escalatie = moetEscaleren(telling, {}, { laatsteInbound: new Date(nu.getTime() - 12 * 3600000).toISOString(), nu });
  const uit = beslisEscalatie({ escalatie, stand: 'zelf', nu });
  assert.equal(uit.doen, 'niets');
  assert.equal(uit.poort, 'drempel');
});

test('drie keer bellen op één ochtend is geen escalatie, en dus ook geen concept', () => {
  const telling = { niet_opgenomen: 3, dagen_niet_opgenomen: 1, laatste_contact: null };
  const escalatie = moetEscaleren(telling, {}, { nu: MIDDAG_WINTER });
  assert.equal(beslisEscalatie({ escalatie, stand: 'concept', nu: MIDDAG_WINTER }).doen, 'niets');
});

test('de volle keten: drempel gehaald, stand niet ingesteld → concept', () => {
  const telling = { niet_opgenomen: 3, dagen_niet_opgenomen: 3, laatste_contact: null };
  const escalatie = moetEscaleren(telling, {}, { nu: MIDDAG_WINTER });
  assert.equal(escalatie.escaleren, true);
  const uit = beslisEscalatie({ escalatie, stand: standVoorBron({}, 'wanbetaler'), nu: MIDDAG_WINTER });
  assert.equal(uit.doen, 'concept', 'een bron zonder instelling stuurde zelf');
});
