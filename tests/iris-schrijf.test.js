// tests/iris-schrijf.test.js
//
// Het schrijven van een concept.
//
// De meeste tests hier gaan over wat er in de prompt belandt, en dat is geen
// muggenzifterij: wat hier per ongeluk in komt, kan het model naar een klant
// schrijven. En wat er NIET in komt, kan het niet lekken.
//
// Het gevoeligste geval staat in 'facturen die niet gelezen konden worden':
// als de kaart niets weet over facturen, moet de prompt dat zeggen, niet
// zwijgen. Zwijgen leest voor een model als "er zijn er geen".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALTIJD_EEN_MENS,
  GEREEDSCHAP_SCHEMA,
  dossierAlsFeiten,
  bouwSysteem,
  bouwBerichten,
  schrijfConcept,
} from '../api/_lib/iris/schrijf.js';
import { ONTBREEKT } from '../api/_lib/iris/toon.js';

const DOSSIER = {
  contact: { naam: 'Jan Janssen', koppelstatus: 'gekoppeld' },
  facturen: {
    gelezen: true,
    items: [
      { id: 'f1', nummer: 'F-001', bedrag_open: 450, vervaldatum: '2026-09-01', te_laat: true, dagen_te_laat: 20 },
    ],
  },
  totalen: { open_bedrag: 450, aantal_open: 1, oudste_dagen_te_laat: 20 },
  mag_over_facturen_praten: { mag: true, reden: '1 factuur over de vervaldatum' },
  aanmaanmotor: { gelezen: true, fase: 'aangemaand' },
  lms: { gelezen: true, student: { toegang_tot: '2026-12-31', toegang_geldig: true, product: 'Jaartraject', no_shows: 0 } },
  beloftes: { gelezen: true, items: [], actief: null },
  signalen: { gelezen: true, items: [] },
};

// ── het dossier als feiten ──────────────────────────────────────────────────

test('dossierAlsFeiten: bedragen, nummers en dagen te laat staan erin', () => {
  const t = dossierAlsFeiten(DOSSIER);
  assert.match(t, /F-001/);
  assert.match(t, /450\.00/);
  assert.match(t, /20 dagen over de vervaldatum/);
});

test('dossierAlsFeiten: zonder dossier staat er dat er niets is', () => {
  const t = dossierAlsFeiten(null);
  assert.match(t, /geen dossier/i);
});

test('dossierAlsFeiten: facturen die niet gelezen konden worden, worden BENOEMD', () => {
  // Zwijgen leest voor een model als "er zijn er geen". Dat is een bewering,
  // en die mogen we op ongelezen gegevens niet doen.
  const t = dossierAlsFeiten({ ...DOSSIER, facturen: { gelezen: false, reden: 'weg', items: [] } });
  assert.match(t, /NIET GELEZEN/);
  assert.match(t, /Zeg niets over facturen/);
  assert.doesNotMatch(t, /F-001/);
});

test('dossierAlsFeiten: geen open facturen is iets anders dan niet gelezen', () => {
  const t = dossierAlsFeiten({ ...DOSSIER, facturen: { gelezen: true, items: [] }, totalen: {} });
  assert.match(t, /geen openstaande facturen/);
  assert.doesNotMatch(t, /NIET GELEZEN/);
});

test('dossierAlsFeiten: een factuur die nog niet vervallen is, levert een uitdrukkelijk verbod op', () => {
  const t = dossierAlsFeiten({
    ...DOSSIER,
    facturen: { gelezen: true, items: [{ id: 'f1', nummer: 'F-002', bedrag_open: 100, vervaldatum: '2026-10-01', te_laat: false, dagen_te_laat: 0 }] },
    mag_over_facturen_praten: { mag: false, reden: 'geen enkele factuur is over de vervaldatum heen' },
  });
  assert.match(t, /maan NIET aan/);
});

test('dossierAlsFeiten: een onbevestigde koppeling verbiedt factuurgegevens', () => {
  const t = dossierAlsFeiten({ ...DOSSIER, contact: { naam: 'Jan', koppelstatus: 'te_bevestigen' } });
  assert.match(t, /nog niet zeker aan een klant gekoppeld/);
  assert.match(t, /Noem geen factuurgegevens/);
});

test('dossierAlsFeiten: een lopende belofte wordt als afspraak gepresenteerd', () => {
  const t = dossierAlsFeiten({
    ...DOSSIER,
    beloftes: { gelezen: true, items: [], actief: { bedrag: 200, datum: '2026-10-01' } },
  });
  assert.match(t, /Lopende betaalafspraak/);
  assert.match(t, /vraag niet eerder om betaling/);
});

test('dossierAlsFeiten: een verlopen LMS-toegang wordt als zodanig benoemd', () => {
  const t = dossierAlsFeiten({
    ...DOSSIER,
    lms: { gelezen: true, student: { toegang_tot: '2026-01-01', toegang_geldig: false } },
  });
  assert.match(t, /VERLOPEN/);
});

test('dossierAlsFeiten: een niet-gelezen LMS zwijgt niet maar zegt het', () => {
  const t = dossierAlsFeiten({ ...DOSSIER, lms: { gelezen: false, reden: 'geen sleutel' } });
  assert.match(t, /Zeg niets over toegang/);
});

test('dossierAlsFeiten: er lekken geen andere klanten in', () => {
  // Wat er niet in gaat, kan het model niet naar buiten schrijven.
  const t = dossierAlsFeiten(DOSSIER);
  assert.doesNotMatch(t, /customer_id/);
  assert.doesNotMatch(t, /[0-9a-f]{8}-[0-9a-f]{4}-/, 'geen interne id-reeksen in de prompt');
});

// ── de instructie ───────────────────────────────────────────────────────────

test('bouwSysteem: het merkteken voor een ontbrekend gegeven staat in de instructie', () => {
  const s = bouwSysteem({ kanaal: 'whatsapp', dossier: DOSSIER });
  assert.ok(s.includes(ONTBREEKT), 'zonder die uitweg vult een model de gaten zelf');
});

test('bouwSysteem: het kanaal staat erin', () => {
  assert.match(bouwSysteem({ kanaal: 'email', dossier: DOSSIER }), /e-mail/);
  assert.match(bouwSysteem({ kanaal: 'whatsapp', dossier: DOSSIER }), /WhatsApp/);
});

test('bouwSysteem: de categorie gaat mee als die er is', () => {
  const s = bouwSysteem({ kanaal: 'whatsapp', categorie: 'betaalafspraak', dossier: DOSSIER });
  assert.match(s, /ingedeeld als: betaalafspraak/);
});

test('bouwSysteem: bedrijfsgegevens gaan mee, maar alleen als ze er zijn', () => {
  assert.match(bouwSysteem({ kanaal: 'whatsapp', dossier: DOSSIER, kennis: { iban: 'BE00' } }), /iban/);
  assert.doesNotMatch(bouwSysteem({ kanaal: 'whatsapp', dossier: DOSSIER, kennis: {} }), /Vaste bedrijfsgegevens/);
});

// ── de beurt ────────────────────────────────────────────────────────────────

test('bouwBerichten: één beurt, met de geschiedenis als context', () => {
  const m = bouwBerichten({
    voorgeschiedenis: [{ richting: 'in', tekst_kort: 'hallo' }, { richting: 'uit', tekst_kort: 'dag' }],
    instructie: 'zeg dat hij tot vrijdag heeft',
  });
  assert.equal(m.length, 1);
  assert.match(m[0].content, /\[klant\] hallo/);
  assert.match(m[0].content, /\[wij\] dag/);
  assert.match(m[0].content, /tot vrijdag/);
});

test('bouwBerichten: zonder instructie schrijft het model gewoon een antwoord', () => {
  const m = bouwBerichten({ voorgeschiedenis: [], laatsteBericht: 'ik heb al betaald' });
  assert.match(m[0].content, /passend antwoord/);
  assert.match(m[0].content, /ik heb al betaald/);
});

test('bouwBerichten: alleen de laatste acht beurten gaan mee', () => {
  const veel = Array.from({ length: 30 }, (_, i) => ({ richting: 'in', tekst_kort: `b${i}` }));
  const m = bouwBerichten({ voorgeschiedenis: veel, instructie: 'x' });
  assert.doesNotMatch(m[0].content, /\bb21\b/);
  assert.match(m[0].content, /b29/);
});

test('bouwBerichten: rommel als geschiedenis breekt niets', () => {
  for (const v of [null, undefined, 'x', 42]) {
    assert.equal(bouwBerichten({ voorgeschiedenis: v, instructie: 'x' }).length, 1);
  }
});

// ── het schema ──────────────────────────────────────────────────────────────

test('het model moet zelf melden welke gegevens het miste', () => {
  assert.ok(GEREEDSCHAP_SCHEMA.required.includes('ontbrekende_gegevens'));
});

test('de toelichting is voor de medewerker, niet voor de klant', () => {
  assert.match(GEREEDSCHAP_SCHEMA.properties.toelichting.description, /medewerker/);
  assert.match(GEREEDSCHAP_SCHEMA.properties.toelichting.description, /Niet voor de klant/);
});

// ── de categorie die nooit vanzelf gaat ─────────────────────────────────────

test('bij een opzegging of klacht schrijft Iris niets', async () => {
  const r = await schrijfConcept({ categorie: 'opzeg_klacht_juridisch', dossier: DOSSIER });
  assert.equal(r.ok, true);
  assert.equal(r.mensNodig, true);
  assert.equal(r.concept.tekst, '');
  assert.equal(r.concept.mag_verstuurd_worden, false);
});

test('die categorie kost geen enkele aanroep van het model', async () => {
  // De controle staat vóór de aanroep. Zonder sleutel zou een aanroep falen;
  // dit geeft gewoon het mens-nodig-antwoord terug.
  const bewaard = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await schrijfConcept({ categorie: 'opzeg_klacht_juridisch' });
    assert.equal(r.ok, true);
    assert.equal(r.mensNodig, true);
  } finally {
    if (bewaard !== undefined) process.env.ANTHROPIC_API_KEY = bewaard;
  }
});

test('ALTIJD_EEN_MENS bevat op dit moment precies één categorie', () => {
  assert.deepEqual([...ALTIJD_EEN_MENS], ['opzeg_klacht_juridisch']);
});

test('schrijfConcept: zonder sleutel mislukt het netjes in plaats van te ontploffen', async () => {
  const bewaard = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const r = await schrijfConcept({ categorie: 'facturatie', dossier: DOSSIER, instructie: 'x' });
    assert.equal(r.ok, false);
    assert.equal(typeof r.fout, 'string');
  } finally {
    if (bewaard !== undefined) process.env.ANTHROPIC_API_KEY = bewaard;
  }
});
