// tests/iris-instellingen-keuring.test.js
//
// De keuring die elke instelling passeert vóór ze de databank in gaat.
//
// Waarom hier zoveel tests op staan: een instelling die niemand nakijkt, is een
// instelling die ooit 'ZELF ' met een spatie bevat en dan stil als 'uit'
// gelezen wordt — terwijl degene die hem zette denkt dat het aan staat. Dat is
// de ergste soort fout: niet luid, maar verkeerd om. Hier weigeren we liever
// met een leesbare reden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keurWaardeGoed, TOEGESTANE_SLEUTELS } from '../api/iris-instellingen.js';

const ok  = (s, w) => { const r = keurWaardeGoed(s, w); assert.equal(r.ok, true, r.fout); return r.waarde; };
const nee = (s, w) => { const r = keurWaardeGoed(s, w); assert.equal(r.ok, false, 'dit had geweigerd moeten worden'); return r.fout; };

// ── autonomie ───────────────────────────────────────────────────────────────

test('autonomie: geldige standen komen door, met kleine letters', () => {
  const w = ok('autonomie', { facturatie: 'zelf', lms_support: 'CONCEPT', overig: ' uit ' });
  assert.deepEqual(w, { facturatie: 'zelf', lms_support: 'concept', overig: 'uit' });
});

test('autonomie: een onbekende categorie wordt geweigerd, niet genegeerd', () => {
  const fout = nee('autonomie', { verzonnen: 'zelf' });
  assert.match(fout, /onbekende categorie/);
});

test('autonomie: een onbekende stand noemt de geldige keuzes', () => {
  const fout = nee('autonomie', { facturatie: 'automatisch' });
  assert.match(fout, /uit \/ concept \/ zelf/);
});

test('autonomie: opzeg_klacht_juridisch op zelf wordt geweigerd, met uitleg', () => {
  const fout = nee('autonomie', { opzeg_klacht_juridisch: 'zelf' });
  assert.match(fout, /kan niet op zelf/);
  assert.match(fout, /mens/);
});

test('autonomie: opzeg_klacht_juridisch op concept mag wel', () => {
  const w = ok('autonomie', { opzeg_klacht_juridisch: 'concept' });
  assert.equal(w.opzeg_klacht_juridisch, 'concept');
});

test('autonomie: iets anders dan een object wordt geweigerd', () => {
  for (const v of [null, undefined, 'zelf', 42, ['zelf'], true]) {
    assert.equal(keurWaardeGoed('autonomie', v).ok, false, `${JSON.stringify(v)} hoorde geweigerd te worden`);
  }
});

// ── escalatie ───────────────────────────────────────────────────────────────

test('escalatie: de standaard drie op drie is geldig', () => {
  assert.deepEqual(ok('escalatie', { pogingen: 3, dagen: 3 }), { pogingen: 3, dagen: 3 });
});

test('escalatie: meer dagen dan pogingen kan niet', () => {
  const fout = nee('escalatie', { pogingen: 2, dagen: 5 });
  assert.match(fout, /dagen kan niet groter zijn dan pogingen/);
});

test('escalatie: nul pogingen zou betekenen dat Iris meteen escaleert', () => {
  nee('escalatie', { pogingen: 0, dagen: 0 });
});

test('escalatie: absurd hoge waarden worden geweigerd', () => {
  nee('escalatie', { pogingen: 999, dagen: 1 });
  nee('escalatie', { pogingen: 3, dagen: 999 });
});

test('escalatie: kommagetallen zijn geen pogingen', () => {
  nee('escalatie', { pogingen: 2.5, dagen: 2 });
});

// ── stille uren ─────────────────────────────────────────────────────────────

test('stille_uren: uu:mm wordt aanvaard', () => {
  const w = ok('stille_uren', { van: '21:00', tot: '08:00' });
  assert.equal(w.van, '21:00');
  assert.equal(w.tot, '08:00');
});

test('stille_uren: zondag_stil staat aan tenzij uitdrukkelijk uitgezet', () => {
  assert.equal(ok('stille_uren', { van: '21:00', tot: '08:00' }).zondag_stil, true);
  assert.equal(ok('stille_uren', { van: '21:00', tot: '08:00', zondag_stil: false }).zondag_stil, false);
  // Een waarde die niet false is, telt als aan. Dat is met opzet de stille kant.
  assert.equal(ok('stille_uren', { van: '21:00', tot: '08:00', zondag_stil: 'nee' }).zondag_stil, true);
});

test('stille_uren: een tijd die geen tijd is wordt geweigerd', () => {
  for (const t of ['9:00', '25:00', '21:60', '2100', 'avond', '']) {
    assert.equal(keurWaardeGoed('stille_uren', { van: t, tot: '08:00' }).ok, false, `"${t}" hoorde geweigerd te worden`);
  }
});

test('stille_uren: de tijdzone valt terug op Brussel', () => {
  assert.equal(ok('stille_uren', { van: '21:00', tot: '08:00' }).tijdzone, 'Europe/Brussels');
});

// ── dosering ────────────────────────────────────────────────────────────────

test('dosering: de standaard is geldig', () => {
  const w = ok('dosering', { max_per_minuut: 6, max_per_uur: 60, max_per_dag_per_persoon: 2 });
  assert.deepEqual(w, { max_per_minuut: 6, max_per_uur: 60, max_per_dag_per_persoon: 2 });
});

test('dosering: een uurgrens onder de minuutgrens is tegenstrijdig', () => {
  const fout = nee('dosering', { max_per_minuut: 30, max_per_uur: 10, max_per_dag_per_persoon: 2 });
  assert.match(fout, /kan niet kleiner zijn/);
});

test('dosering: een ontbrekend veld wordt geweigerd, niet aangevuld', () => {
  nee('dosering', { max_per_minuut: 6 });
});

// ── mailboxen ───────────────────────────────────────────────────────────────

test('mailboxen: een lege leeslijst betekent dat Iris niets ziet', () => {
  nee('mailboxen', { lezen: [] });
  nee('mailboxen', {});
});

test('mailboxen: namen worden getrimd en lege namen vallen weg', () => {
  const w = ok('mailboxen', { lezen: [' administratie ', '', 'onboarding'] });
  assert.deepEqual(w.lezen, ['administratie', 'onboarding']);
});

test('mailboxen: een onbekende categorie in afzender_per_categorie wordt geweigerd', () => {
  const fout = nee('mailboxen', { lezen: ['info'], afzender_per_categorie: { verzonnen: 'x@y.nl' } });
  assert.match(fout, /onbekende categorie/);
});

// ── model ───────────────────────────────────────────────────────────────────

test('model: lege modelnamen worden geweigerd', () => {
  nee('model', { redeneren: '', transcriptie: 'whisper-1' });
  nee('model', { redeneren: 'claude-sonnet-4-5', transcriptie: '  ' });
});

test('model: temperatuur buiten nul tot een wordt geweigerd', () => {
  nee('model', { redeneren: 'a', transcriptie: 'b', temperatuur: 1.5 });
  nee('model', { redeneren: 'a', transcriptie: 'b', temperatuur: -0.1 });
});

test('model: zonder temperatuur geldt 0.3', () => {
  assert.equal(ok('model', { redeneren: 'a', transcriptie: 'b' }).temperatuur, 0.3);
});

// ── ongedaan-venster ────────────────────────────────────────────────────────

test('ongedaan_seconden: onder vijf seconden is de knop een leugen', () => {
  const fout = nee('ongedaan_seconden', 2);
  assert.match(fout, /niet waarmaakt/);
});

test('ongedaan_seconden: dertig is goed, vijfhonderd niet', () => {
  assert.equal(ok('ongedaan_seconden', 30), 30);
  nee('ongedaan_seconden', 500);
});

// ── onbekende sleutels ──────────────────────────────────────────────────────

test('een onbekende sleutel wordt geweigerd', () => {
  const fout = nee('verzonnen_sleutel', 'x');
  assert.match(fout, /onbekende sleutel/);
});

test('de toegestane sleutels zijn precies de zeven uit de migratie', () => {
  assert.deepEqual([...TOEGESTANE_SLEUTELS].sort(), [
    'autonomie', 'dosering', 'escalatie', 'mailboxen',
    'model', 'ongedaan_seconden', 'stille_uren',
  ]);
});

test('elke toegestane sleutel wordt ook echt gekeurd — geen enkele valt in de default-tak', () => {
  for (const s of TOEGESTANE_SLEUTELS) {
    const r = keurWaardeGoed(s, null);
    // Of hij wordt goedgekeurd, of hij wordt geweigerd om een INHOUDELIJKE
    // reden — maar nooit met "onbekende sleutel". Dat zou betekenen dat er een
    // sleutel op de toegestane lijst staat die de keuring niet kent.
    if (!r.ok) assert.doesNotMatch(r.fout, /onbekende sleutel/, `${s} valt in de default-tak`);
  }
});
