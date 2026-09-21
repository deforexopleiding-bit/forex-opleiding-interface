// tests/iris-instellingen.test.js
//
// De schakelaars van Iris. Wat hier getest wordt is één ding, vanuit alle
// kanten: dat twijfel naar 'uit' valt. Een instellingenmodule die bij een
// databankfout per ongeluk 'zelf' teruggeeft, stuurt berichten die niemand
// heeft goedgekeurd — dus elke tak die mis kan gaan krijgt hier een test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORIEEN,
  STANDEN,
  NOOIT_ZELF,
  STANDAARD,
  irisAan,
  leesStand,
  normaliseerAutonomie,
  magZelfVersturen,
  magConceptSchrijven,
  leesOngedaanSeconden,
  haalInstellingen,
} from '../api/_lib/iris/instellingen.js';

// ── de hoofdschakelaar ──────────────────────────────────────────────────────

test('irisAan: alleen de letterlijke tekst true zet hem aan', () => {
  assert.equal(irisAan({ IRIS_AAN: 'true' }), true);
  assert.equal(irisAan({ IRIS_AAN: 'TRUE' }), true);
  assert.equal(irisAan({ IRIS_AAN: ' true ' }), true);
});

test('irisAan: alles wat er op lijkt maar het niet is, staat uit', () => {
  for (const v of ['1', 'ja', 'yes', 'aan', 'True!', '', 'false', 'undefined']) {
    assert.equal(irisAan({ IRIS_AAN: v }), false, `"${v}" hoorde uit te staan`);
  }
  assert.equal(irisAan({}), false);
  assert.equal(irisAan(undefined), false);
});

// ── standen lezen ───────────────────────────────────────────────────────────

test('leesStand: kent precies drie standen', () => {
  assert.deepEqual([...STANDEN], ['uit', 'concept', 'zelf']);
  assert.equal(leesStand('uit'), 'uit');
  assert.equal(leesStand('concept'), 'concept');
  assert.equal(leesStand('zelf'), 'zelf');
  assert.equal(leesStand('ZELF'), 'zelf');
  assert.equal(leesStand('  concept '), 'concept');
});

test('leesStand: alles wat we niet herkennen wordt uit', () => {
  for (const v of ['automatisch', 'aan', 'on', '', null, undefined, 0, 1, {}, []]) {
    assert.equal(leesStand(v), 'uit', `${JSON.stringify(v)} hoorde uit te worden`);
  }
});

// ── autonomie normaliseren ──────────────────────────────────────────────────

test('normaliseerAutonomie: hoofdschakelaar uit betekent alles uit', () => {
  const alles = Object.fromEntries(CATEGORIEEN.map((c) => [c, 'zelf']));
  const r = normaliseerAutonomie(alles, { aan: false });
  for (const c of CATEGORIEEN) assert.equal(r[c], 'uit', `${c} hoorde uit te staan`);
});

test('normaliseerAutonomie: zonder opgaaf van aan staat alles uit', () => {
  const alles = Object.fromEntries(CATEGORIEEN.map((c) => [c, 'zelf']));
  const r = normaliseerAutonomie(alles);
  for (const c of CATEGORIEEN) assert.equal(r[c], 'uit');
});

test('normaliseerAutonomie: met de schakelaar aan komt de ingestelde stand door', () => {
  const r = normaliseerAutonomie({ facturatie: 'zelf', lms_support: 'concept' }, { aan: true });
  assert.equal(r.facturatie, 'zelf');
  assert.equal(r.lms_support, 'concept');
});

test('normaliseerAutonomie: ontbrekende categorieën worden uit, niet undefined', () => {
  const r = normaliseerAutonomie({ facturatie: 'zelf' }, { aan: true });
  for (const c of CATEGORIEEN) {
    assert.equal(typeof r[c], 'string', `${c} hoorde een stand te hebben`);
  }
  assert.equal(r.overig, 'uit');
  assert.equal(r.spam, 'uit');
});

test('normaliseerAutonomie: onbekende sleutels in de databank halen het niet', () => {
  const r = normaliseerAutonomie({ verzonnen_categorie: 'zelf', facturatie: 'zelf' }, { aan: true });
  assert.equal(r.verzonnen_categorie, undefined);
  assert.equal(Object.keys(r).length, CATEGORIEEN.length);
});

test('normaliseerAutonomie: rommel in plaats van een object wordt alles uit', () => {
  for (const ruw of [null, undefined, 'zelf', 42, ['zelf'], true]) {
    const r = normaliseerAutonomie(ruw, { aan: true });
    for (const c of CATEGORIEEN) assert.equal(r[c], 'uit');
  }
});

// ── de categorie die nooit vanzelf mag ──────────────────────────────────────

test('opzeg_klacht_juridisch kan nooit op zelf, ook niet als het in de databank staat', () => {
  const r = normaliseerAutonomie({ opzeg_klacht_juridisch: 'zelf' }, { aan: true });
  assert.equal(r.opzeg_klacht_juridisch, 'concept',
    'zelf hoorde teruggezet te worden naar concept, niet stil overgenomen');
});

test('magZelfVersturen weigert opzeg_klacht_juridisch zelfs bij een handmatig gezette stand', () => {
  // Iemand omzeilt normaliseerAutonomie en geeft rechtstreeks 'zelf' door.
  const handmatig = { opzeg_klacht_juridisch: 'zelf' };
  assert.equal(magZelfVersturen(handmatig, 'opzeg_klacht_juridisch'), false);
});

test('NOOIT_ZELF bevat op dit moment precies één categorie', () => {
  assert.deepEqual([...NOOIT_ZELF], ['opzeg_klacht_juridisch']);
  for (const c of NOOIT_ZELF) {
    assert.ok(CATEGORIEEN.includes(c), `${c} hoort een bekende categorie te zijn`);
  }
});

// ── de twee vragen die de verzendweg stelt ──────────────────────────────────

test('magZelfVersturen: alleen bij zelf', () => {
  assert.equal(magZelfVersturen({ facturatie: 'zelf' }, 'facturatie'), true);
  assert.equal(magZelfVersturen({ facturatie: 'concept' }, 'facturatie'), false);
  assert.equal(magZelfVersturen({ facturatie: 'uit' }, 'facturatie'), false);
});

test('magZelfVersturen: een onbekende of ontbrekende categorie is nee', () => {
  assert.equal(magZelfVersturen({}, 'facturatie'), false);
  assert.equal(magZelfVersturen(null, 'facturatie'), false);
  assert.equal(magZelfVersturen(undefined, undefined), false);
  assert.equal(magZelfVersturen({ verzonnen: 'zelf' }, 'verzonnen'), true,
    'let op: deze functie kent de categorielijst niet — normaliseerAutonomie filtert die');
});

test('magConceptSchrijven: concept en zelf mogen allebei schrijven', () => {
  assert.equal(magConceptSchrijven({ facturatie: 'concept' }, 'facturatie'), true);
  assert.equal(magConceptSchrijven({ facturatie: 'zelf' }, 'facturatie'), true);
  assert.equal(magConceptSchrijven({ facturatie: 'uit' }, 'facturatie'), false);
  assert.equal(magConceptSchrijven({}, 'facturatie'), false);
});

test('opzeg_klacht_juridisch mag wel een concept krijgen — alleen niet zelf versturen', () => {
  const r = normaliseerAutonomie({ opzeg_klacht_juridisch: 'concept' }, { aan: true });
  assert.equal(magConceptSchrijven(r, 'opzeg_klacht_juridisch'), true);
  assert.equal(magZelfVersturen(r, 'opzeg_klacht_juridisch'), false);
});

// ── het ongedaan-venster ────────────────────────────────────────────────────

test('leesOngedaanSeconden: standaard is dertig', () => {
  assert.equal(leesOngedaanSeconden(undefined), 30);
  assert.equal(leesOngedaanSeconden(null), 30);
  assert.equal(leesOngedaanSeconden('geen getal'), 30);
});

test('leesOngedaanSeconden: te kort is een leugen, te lang is een blokkade', () => {
  assert.equal(leesOngedaanSeconden(0), 5);
  assert.equal(leesOngedaanSeconden(-99), 5);
  assert.equal(leesOngedaanSeconden(1), 5);
  assert.equal(leesOngedaanSeconden(10000), 300);
});

test('leesOngedaanSeconden: een gewone waarde komt ongeschonden door', () => {
  assert.equal(leesOngedaanSeconden(30), 30);
  assert.equal(leesOngedaanSeconden(60), 60);
  assert.equal(leesOngedaanSeconden('45'), 45);
  assert.equal(leesOngedaanSeconden(45.9), 45);
});

// ── uit de databank halen ───────────────────────────────────────────────────

function nepClient(antwoord) {
  return { from: () => ({ select: async () => antwoord }) };
}

test('haalInstellingen: zonder client komt alles uit terug, met een reden', async () => {
  const r = await haalInstellingen(null, { IRIS_AAN: 'true' });
  assert.equal(r.gelezen, false);
  assert.equal(r.fout, 'geen databank-client');
  for (const c of CATEGORIEEN) assert.equal(r.autonomie[c], 'uit');
});

test('haalInstellingen: een databankfout zet alles uit — niet wat er toevallig in de cache stond', async () => {
  const r = await haalInstellingen(nepClient({ data: null, error: { message: 'connectie weg' } }), { IRIS_AAN: 'true' });
  assert.equal(r.gelezen, false);
  assert.equal(r.fout, 'connectie weg');
  for (const c of CATEGORIEEN) assert.equal(r.autonomie[c], 'uit');
});

test('haalInstellingen: een uitzondering zet ook alles uit', async () => {
  const stuk = { from: () => ({ select: async () => { throw new Error('boem'); } }) };
  const r = await haalInstellingen(stuk, { IRIS_AAN: 'true' });
  assert.equal(r.gelezen, false);
  assert.equal(r.fout, 'boem');
  for (const c of CATEGORIEEN) assert.equal(r.autonomie[c], 'uit');
});

test('haalInstellingen: gelezen onderscheidt "niets aangezet" van "kon niet kijken"', async () => {
  const leeg = await haalInstellingen(nepClient({ data: [], error: null }), { IRIS_AAN: 'true' });
  const stuk = await haalInstellingen(nepClient({ data: null, error: { message: 'x' } }), { IRIS_AAN: 'true' });
  // Allebei alles uit …
  assert.equal(leeg.autonomie.facturatie, 'uit');
  assert.equal(stuk.autonomie.facturatie, 'uit');
  // … maar wel te onderscheiden.
  assert.equal(leeg.gelezen, true);
  assert.equal(stuk.gelezen, false);
});

test('haalInstellingen: met de hoofdschakelaar uit blijft een ingestelde zelf-stand uit', async () => {
  const rijen = [{ sleutel: 'autonomie', waarde: { facturatie: 'zelf', lms_support: 'zelf' } }];
  const r = await haalInstellingen(nepClient({ data: rijen, error: null }), { IRIS_AAN: 'false' });
  assert.equal(r.gelezen, true);
  assert.equal(r.aan, false);
  assert.equal(r.autonomie.facturatie, 'uit');
  assert.equal(r.autonomie.lms_support, 'uit');
});

test('haalInstellingen: met de schakelaar aan komen de standen door', async () => {
  const rijen = [{ sleutel: 'autonomie', waarde: { facturatie: 'zelf', lms_support: 'concept' } }];
  const r = await haalInstellingen(nepClient({ data: rijen, error: null }), { IRIS_AAN: 'true' });
  assert.equal(r.aan, true);
  assert.equal(r.autonomie.facturatie, 'zelf');
  assert.equal(r.autonomie.lms_support, 'concept');
  assert.equal(r.autonomie.overig, 'uit');
});

test('haalInstellingen: deelinstellingen vullen de standaard aan, ze vervangen hem niet', async () => {
  const rijen = [{ sleutel: 'escalatie', waarde: { pogingen: 5 } }];
  const r = await haalInstellingen(nepClient({ data: rijen, error: null }), {});
  assert.equal(r.escalatie.pogingen, 5);
  assert.equal(r.escalatie.dagen, STANDAARD.escalatie.dagen, 'dagen hoorde uit de standaard te komen');
});

test('haalInstellingen: stille uren en dosering hebben altijd een waarde', async () => {
  const r = await haalInstellingen(nepClient({ data: [], error: null }), {});
  assert.equal(r.stille_uren.van, '21:00');
  assert.equal(r.stille_uren.tot, '08:00');
  assert.equal(r.stille_uren.zondag_stil, true);
  assert.equal(r.dosering.max_per_dag_per_persoon, 2);
});

test('haalInstellingen: een rij zonder sleutel breekt niets', async () => {
  const rijen = [null, { waarde: { facturatie: 'zelf' } }, { sleutel: 'autonomie', waarde: { facturatie: 'zelf' } }];
  const r = await haalInstellingen(nepClient({ data: rijen, error: null }), { IRIS_AAN: 'true' });
  assert.equal(r.autonomie.facturatie, 'zelf');
});

// ── samenhang met de migratie ───────────────────────────────────────────────

test('de categorielijst is dezelfde als in de CHECK op iris_berichten', () => {
  // Als deze lijst verandert moet de migratie mee. De test is er om die twee
  // uit elkaar te laten lopen op te merken, niet om de lijst te bevriezen.
  assert.deepEqual([...CATEGORIEEN], [
    'facturatie', 'betaalafspraak', 'wanbetaling_reactie',
    'lms_toegang', 'lms_support', 'planning_mentor',
    'opzeg_klacht_juridisch', 'bounce_systeem', 'overig', 'spam',
  ]);
});

test('STANDAARD heeft voor elke categorie de stand uit', () => {
  for (const c of CATEGORIEEN) {
    assert.equal(STANDAARD.autonomie[c], 'uit', `${c} hoorde standaard uit te staan`);
  }
});

test('leesOngedaanSeconden: een ontbrekende instelling is niet hetzelfde als nul', () => {
  // Number(null) en Number('') zijn allebei 0 en allebei eindig. Zonder een
  // aparte controle wordt een ontbrekende instelling daardoor 5 seconden in
  // plaats van de standaard 30 — stil, en precies de verkeerde kant op.
  assert.equal(leesOngedaanSeconden(null), 30);
  assert.equal(leesOngedaanSeconden(''), 30);
  assert.equal(leesOngedaanSeconden(undefined), 30);
  // Een uitdrukkelijke nul is wél een keuze, en klemt naar het minimum.
  assert.equal(leesOngedaanSeconden(0), 5);
  assert.equal(leesOngedaanSeconden('0'), 5);
});
