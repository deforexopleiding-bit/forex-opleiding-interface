// tests/iris-belrij-zonder-migratie.test.js
//
// Wat er gebeurt als de migratie van deel 1 nog niet gedraaid is.
//
// ── WAT IK HIEROVER VERKEERD HAD ────────────────────────────────────────────
// Ik heb gemeld dat de belrij leeg blijft zolang
// docs/sql-migrations/2026-10-12-iris-belrij-redenen.sql niet gedraaid is. Dat
// was niet waar, en de code las ik verkeerd terug.
//
// Wat er echt gebeurde: schrijfPersoon zette eerst de rij in `iris_belrij` en
// gooide daarna op de redenen-tabel. De rij stond er dus wél. De volgende ronde
// vond die rij, probeerde de redenen opnieuw, en gooide opnieuw. Resultaat: een
// belrij die zich gewoon vult (met de ene reden uit iris_belrij.reden, zoals
// vóór taak 6) plus een foutmelding per persoon per ronde. Honderd mensen op de
// lijst is honderd regels in het logboek, elke vijf minuten.
//
// Dat is de slechtste van de drie mogelijke uitkomsten: niet leeg (dus mijn
// melding was fout), niet werkend (geen redenen), en luid genoeg om elke ándere
// fout eronder te verbergen.
//
// Nu: fail-soft per persoon, één regel per RONDE, en de belrij vult zich. Niet
// omdat een fout wegslikken goed is -- de reden staat in het rapport en in
// console.error -- maar omdat de rest van de ronde er niets mee te maken heeft.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { schrijfPersoon, vulBelrij } from '../api/_lib/iris/belrij-vullen.js';
import { uitBeltaak, uitSignaal, voegSamen } from '../api/_lib/iris/belrij-bronnen.js';
import { nepDb } from './vast/nep-db.js';

const CRON = readFileSync(new URL('../api/cron-iris-werk.js', import.meta.url), 'utf8');

const CONTACT = '11111111-1111-1111-1111-111111111111';
const CONTACT_B = '22222222-2222-2222-2222-222222222222';
// Volledig zoals pending_actions hem heeft: zonder action_type en status
// filtert leesBeltaken hem er terecht uit, en dan toetst dit bestand niets.
const beltaak = (id, klant) => ({
  id, customer_id: klant,
  action_type: 'MANUAL_FOLLOWUP', status: 'PENDING',
  payload: { kind: 'call', title: 'Bel klant' },
});

/** De tabel bestaat niet — zoals PostgREST het meldt als de migratie niet gedraaid is. */
const geenTabel = (tabel) => ({ faalOp: (t) => t === tabel });

test('de belrij-rij komt er, ook als de redenen-tabel ontbreekt', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] }, geenTabel('iris_belrij_redenen'));
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];

  const uit = await schrijfPersoon(db, rij);

  assert.equal(uit.nieuw, 1);
  assert.equal(db._data.iris_belrij.length, 1);
  assert.ok(uit.redenen_fout, 'de fout wordt niet gemeld');
  assert.equal(uit.redenen_nieuw, 0);
});

test('de rij heeft dan nog steeds een leesbare reden uit iris_belrij zelf', async () => {
  // Dat is de terugval waar het scherm op rekent: één reden in plaats van de
  // hele lijst, zoals vóór taak 6.
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] }, geenTabel('iris_belrij_redenen'));
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];
  await schrijfPersoon(db, rij);
  assert.equal(db._data.iris_belrij[0].reden, 'wanbetaler');
  assert.equal(db._data.iris_belrij[0].bron, 'wanbetaler');
});

test('er komt GEEN tweede rij bij de volgende ronde', async () => {
  // Dit is wat er misging zou zijn als de fout bleef gooien: de rij stond er,
  // maar de ronde kon niet verder, en elke ronde probeerde het opnieuw.
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] }, geenTabel('iris_belrij_redenen'));
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];
  await schrijfPersoon(db, rij);
  await schrijfPersoon(db, rij);
  assert.equal(db._data.iris_belrij.length, 1);
});

test('de ronde meldt het ÉÉN keer, niet één keer per persoon', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1'), beltaak('t2', 'k2')],
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }, { id: CONTACT_B, customer_id: 'k2' }],
    iris_signalen: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  }, geenTabel('iris_belrij_redenen'));

  const rap = await vulBelrij(db);

  assert.equal(rap.nieuw, 2, 'de belrij vulde zich niet');
  assert.equal(rap.redenen_fout_aantal, 2, 'het aantal getroffen personen wordt niet geteld');
  assert.ok(rap.redenen_fout, 'de reden staat niet in het rapport');
  assert.deepEqual(rap.fouten, [], 'de redenen-fout vult de algemene foutenlijst');
});

test('zonder de migratie blokkeert de ronde de andere bronnen niet', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1')],
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }],
    iris_signalen: [{ id: 's1', contact_id: CONTACT_B, type: 'reageert_niet', verwerkt_op: null }],
    iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  }, geenTabel('iris_belrij_redenen'));

  const rap = await vulBelrij(db);

  assert.equal(rap.personen, 2);
  assert.equal(rap.nieuw, 2);
});

test('mét de tabel werkt alles gewoon — de fail-soft verandert het goede pad niet', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1')],
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }],
    iris_signalen: [{ id: 's1', contact_id: CONTACT, type: 'reageert_niet', verwerkt_op: null }],
    iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.redenen_fout, null);
  assert.equal(rap.redenen_fout_aantal, 0);
  assert.equal(db._data.iris_belrij_redenen.length, 2);
});

test('een leesfout op de redenen laat de rij ook staan', async () => {
  // Niet alleen de upsert: ook het terugelezen van de open redenen en het
  // afvinken mogen de ronde niet omgooien.
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 50, bron: 'wanbetaler' }],
    iris_belrij_redenen: [],
  }, { faalOp: (t, soort) => t === 'iris_belrij_redenen' && soort === 'select' });
  const rij = voegSamen([uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' })])[0];

  const uit = await schrijfPersoon(db, rij);

  assert.equal(uit.bijgewerkt, 1);
  assert.ok(uit.redenen_fout);
});

test('de cron zet er één logregel voor, met het aantal personen erbij', () => {
  assert.match(CRON, /belrij-redenen \(\$\{rapport\.belrij\.redenen_fout_aantal\} personen\)/);
  assert.match(CRON, /if \(rapport\.belrij\?\.redenen_fout\)/);
});
