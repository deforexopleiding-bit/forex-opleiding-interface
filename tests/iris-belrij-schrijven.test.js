// tests/iris-belrij-schrijven.test.js
//
// Taak 6, deel 1 — wat de vuller ECHT met de databank doet.
//
// De toetsen in iris-belrij-bronnen.test.js gaan over de regels (puur) en over
// wat er wel en niet in de code staat. Dat is niet genoeg: "er staat een
// try/catch in" is geen bewijs dat één fout contact de rest niet blokkeert, en
// "er staat geen .delete() in" is geen bewijs dat een bestaande rij heel blijft.
//
// Hier staat een kleine nep-databank die de filters die de vuller gebruikt
// echt toepast, zodat de uitkomst gemeten wordt in plaats van gegrepen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schrijfPersoon, vulBelrij, voegHandmatigToe } from '../api/_lib/iris/belrij-vullen.js';
import { uitBeltaak, uitSignaal, uitOpvolging, voegSamen, BRON_PRIORITEIT } from '../api/_lib/iris/belrij-bronnen.js';
import { nepDb } from './vast/nep-db.js';

const CONTACT = '11111111-1111-1111-1111-111111111111';
const CONTACT_B = '22222222-2222-2222-2222-222222222222';
const MAXIM     = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const beltaak = (id, klant) => ({ id, customer_id: klant, action_type: 'MANUAL_FOLLOWUP', status: 'PENDING', payload: { kind: 'call', title: 'Bel klant' } });

/* ── één persoon wegschrijven ─────────────────────────────────────────────── */

test('een nieuwe persoon krijgt één rij met zijn redenen eronder', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const rij = voegSamen([
    uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT }),
    uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' }),
  ])[0];

  const uit = await schrijfPersoon(db, rij);

  assert.equal(uit.nieuw, 1);
  assert.equal(db._data.iris_belrij.length, 1);
  assert.equal(db._data.iris_belrij[0].contact_id, CONTACT);
  assert.equal(db._data.iris_belrij[0].prioriteit, BRON_PRIORITEIT.wanbetaler);
  assert.equal(db._data.iris_belrij_redenen.length, 2);
  assert.deepEqual(
    db._data.iris_belrij_redenen.map((r) => r.bron_sleutel).sort(),
    ['pending_action:t1', 'signaal:s1']
  );
});

test('twee ronden met dezelfde bronnen geven GEEN tweede rij en GEEN tweede reden', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];

  await schrijfPersoon(db, rij);
  const tweede = await schrijfPersoon(db, rij);

  assert.equal(tweede.nieuw, 0);
  assert.equal(tweede.bijgewerkt, 1);
  assert.equal(db._data.iris_belrij.length, 1, 'er staat een tweede open rij voor dezelfde persoon');
  assert.equal(db._data.iris_belrij_redenen.length, 1);
});

/* ── de verloren race met de unieke index ─────────────────────────────────── */
//
// Sinds 13 okt staat idx_iris_belrij_een_open_per_contact in productie: één
// open rij per persoon, als PARTIËLE unieke index. Zo'n index kan geen
// ON CONFLICT-arbiter zijn, dus beide schrijvers doen SELECT-dan-INSERT — en
// tussen die twee zit ruimte waar de cron-ronde en een mens die op "op de
// lijst zetten" klikt elkaar tegenkomen. Wie verliest, kreeg een 23505 als
// harde fout: in de ronde een foutregel plus die persoon een ronde
// overgeslagen, op de knop een 500 terwijl de rij er gewoon staat. Een 23505
// op DEZE index betekent niet "er ging iets mis" maar "iemand was net
// sneller".
//
// We spelen de race echt: de nep-databank roept faalOp aan op het moment dat
// de INSERT wordt uitgevoerd, dus zetten we daar de rij van "de ander" neer en
// geven we de 23505 terug. Dat is precies de volgorde van de race.
function dbMetVerlorenRace(rijen, rijVanDeAnder) {
  let gedaan = false;
  const db = nepDb(rijen, {
    faalOp: (tabel, soort) => {
      if (tabel !== 'iris_belrij' || soort !== 'insert' || gedaan) return false;
      gedaan = true;
      if (rijVanDeAnder) db._data.iris_belrij.push({ ...rijVanDeAnder });
      return { code: '23505', message: 'duplicate key value violates unique constraint "idx_iris_belrij_een_open_per_contact"' };
    },
  });
  return db;
}

const RIJ_VAN_DE_ANDER = { id: 'b-ander', contact_id: CONTACT, status: 'open', prioriteit: 40, bron: 'mentorsignaal', eigenaar: null, reden: 'mentorsignaal' };

test('ronde verliest de race: de redenen komen op de BESTAANDE rij, geen tweede rij, geen fout', async () => {
  const db = dbMetVerlorenRace({ iris_belrij: [], iris_belrij_redenen: [] }, RIJ_VAN_DE_ANDER);
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];

  const uit = await schrijfPersoon(db, rij);

  assert.equal(uit.nieuw, 0, 'wij maakten de rij niet');
  assert.equal(uit.bijgewerkt, 1, 'we werkten de rij van de ander bij');
  assert.equal(db._data.iris_belrij.length, 1, 'er staat een tweede open rij voor dezelfde persoon');
  assert.equal(db._data.iris_belrij_redenen.length, 1);
  assert.equal(db._data.iris_belrij_redenen[0].belrij_id, 'b-ander', 'de reden hangt aan de rij die er al stond');
  // De wanbetalerbron weegt zwaarder dan de 40 van de ander; omlaag gaat 'ie nooit.
  assert.equal(db._data.iris_belrij[0].prioriteit, BRON_PRIORITEIT.wanbetaler);
});

test('ronde verliest de race en er valt niets te hervinden: gooien, geen id verzinnen', async () => {
  // De ander rondde z'n rij meteen af, dus de hervonden lees vindt niets open.
  const db = dbMetVerlorenRace({ iris_belrij: [], iris_belrij_redenen: [] }, null);
  const rij = voegSamen([uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' })])[0];

  await assert.rejects(() => schrijfPersoon(db, rij), /belrij aanmaken/,
    'stil doen alsof het goed ging zou een rij verzinnen die niet bestaat');
  assert.equal(db._data.iris_belrij.length, 0);
  assert.equal(db._data.iris_belrij_redenen.length, 0);
});

test('hand verliest de race: de klik hangt aan de bestaande rij, met prioriteit en eigenaar', async () => {
  const db = dbMetVerlorenRace({ iris_belrij: [], iris_belrij_redenen: [] }, RIJ_VAN_DE_ANDER);

  const uit = await voegHandmatigToe(db, {
    contactId: CONTACT, reden: 'met de hand', prioriteit: 90, eigenaar: MAXIM, bron: 'hand',
  });

  assert.equal(uit.belrij_id, 'b-ander', 'de klik hangt aan de rij die er al stond');
  assert.equal(uit.nieuw, false, 'het scherm hoort te zeggen dat de persoon er al op stond');
  assert.equal(db._data.iris_belrij.length, 1, 'geen tweede rij');
  assert.equal(db._data.iris_belrij[0].prioriteit, 90, 'de prioriteit van het mens komt er alsnog op');
  assert.equal(db._data.iris_belrij[0].eigenaar, MAXIM, 'en de eigenaar die het mens aanwijst ook');
  assert.equal(db._data.iris_belrij_redenen.length, 1, 'de reden komt onder de bestaande rij');
  assert.equal(db._data.iris_belrij_redenen[0].belrij_id, 'b-ander');
});

test('een prioriteit die een mens hoger zette blijft staan', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 95, bron: 'hand', reden: 'hand' }],
    iris_belrij_redenen: [],
  });
  const rij = voegSamen([uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' })])[0];

  await schrijfPersoon(db, rij);

  assert.equal(db._data.iris_belrij[0].prioriteit, 95);
  assert.equal(db._data.iris_belrij[0].bron, 'hand', 'de bron van een handmatige rij is overschreven');
  assert.equal(db._data.iris_belrij[0].reden, 'hand', 'de reden van een handmatige rij is overschreven');
});

test('een reden die niet meer wordt aangeleverd krijgt verwerkt_op en blijft staan', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 50, bron: 'mentorsignaal' }],
    iris_belrij_redenen: [
      { id: 'r1', belrij_id: 'b1', bron: 'mentorsignaal', bron_sleutel: 'signaal:oud', reden: 'mentorsignaal', verwerkt_op: null },
    ],
  });
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];

  const uit = await schrijfPersoon(db, rij);

  assert.equal(uit.redenen_verwerkt, 1);
  const oud = db._data.iris_belrij_redenen.find((r) => r.id === 'r1');
  assert.ok(oud, 'de oude reden is verwijderd in plaats van afgevinkt');
  assert.ok(oud.verwerkt_op, 'verwerkt_op is niet gezet');
});

test('een rij met status bezig wordt hergebruikt, niet gedupliceerd', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'bezig', prioriteit: 50, bron: 'wanbetaler' }],
    iris_belrij_redenen: [],
  });
  await schrijfPersoon(db, voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0]);
  assert.equal(db._data.iris_belrij.length, 1);
});

test('een afgehandelde rij blokkeert geen nieuwe: gedaan is gedaan', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'gedaan', prioriteit: 50, bron: 'wanbetaler' }],
    iris_belrij_redenen: [],
  });
  const uit = await schrijfPersoon(db, voegSamen([uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' })])[0]);
  assert.equal(uit.nieuw, 1);
  assert.equal(db._data.iris_belrij.length, 2);
});

test('zonder redenen gebeurt er niets', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const uit = await schrijfPersoon(db, { contact_id: CONTACT, redenen: [] });
  assert.deepEqual(uit, { nieuw: 0, bijgewerkt: 0, redenen_nieuw: 0, redenen_verwerkt: 0, redenen_fout: null });
  assert.equal(db._data.iris_belrij.length, 0);
});

/* ── de hele ronde ────────────────────────────────────────────────────────── */

test('de ronde leest drie bronnen en maakt één rij per persoon', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1'), beltaak('t2', 'k2')],
    iris_contacten: [
      { id: CONTACT, customer_id: 'k1' },
      { id: CONTACT_B, customer_id: 'k2' },
    ],
    iris_signalen: [{ id: 's1', contact_id: CONTACT, type: 'reageert_niet', verwerkt_op: null, signaal_op: '2026-10-01T00:00:00Z' }],
    iris_opvolgingen: [{ id: 'o1', contact_id: CONTACT_B, gesprek_id: 'g1', status: 'verlopen', omschrijving: 'Wacht', tot: '2026-10-01T00:00:00Z' }],
    iris_gesprekken: [{ id: 'g1', contact_id: CONTACT_B }],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.kandidaten, 4);
  assert.equal(rap.personen, 2);
  assert.equal(rap.nieuw, 2);
  assert.equal(db._data.iris_belrij.length, 2);
  assert.equal(db._data.iris_belrij_redenen.length, 4);
  assert.deepEqual(rap.fouten, []);
});

test('een mentorsignaal met een type dat NIET naar de belrij hoort, komt er niet in', async () => {
  const db = nepDb({
    pending_actions: [], iris_contacten: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_signalen: [
      { id: 's-halt', contact_id: CONTACT, type: 'halt', verwerkt_op: null },
      { id: 's-uitstel', contact_id: CONTACT, type: 'uitstel', verwerkt_op: null },
      { id: 's-start', contact_id: CONTACT, type: 'start_niet_op', verwerkt_op: null },
    ],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.kandidaten, 1, 'halt of uitstel is op de belrij beland');
  assert.equal(db._data.iris_belrij_redenen[0].bron_sleutel, 'signaal:s-start');
});

test('een klant met twee contacten valt eruit in plaats van gokken', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1')],
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }, { id: CONTACT_B, customer_id: 'k1' }],
    iris_signalen: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.meerdere_contacten, 1);
  assert.equal(rap.zonder_contact, 1);
  assert.equal(db._data.iris_belrij.length, 0, 'er is gegokt welk contact het was');
});

test('één contact dat omvalt blokkeert de rest van de ronde niet', async () => {
  // De tweede persoon laat de insert in iris_belrij falen; de eerste en de derde
  // horen er gewoon te staan.
  let gezien = 0;
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1'), beltaak('t2', 'k2'), beltaak('t3', 'k3')],
    iris_contacten: [
      { id: CONTACT, customer_id: 'k1' },
      { id: CONTACT_B, customer_id: 'k2' },
      { id: '33333333-3333-3333-3333-333333333333', customer_id: 'k3' },
    ],
    iris_signalen: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  }, {
    faalOp: (tabel, soort) => (tabel === 'iris_belrij' && soort === 'insert' && ++gezien === 2),
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.nieuw, 2, 'de ronde stopte bij de eerste fout');
  assert.equal(rap.fouten.length, 1);
  assert.match(rap.fouten[0], /belrij aanmaken/);
});

test('een ronde die buiten de tijd valt, kapt af en zegt dat', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1'), beltaak('t2', 'k2')],
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }, { id: CONTACT_B, customer_id: 'k2' }],
    iris_signalen: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  let over = 1;
  const rap = await vulBelrij(db, { opTijd: () => over-- > 0 });

  assert.equal(rap.afgekapt, true);
  assert.equal(rap.nieuw, 1);
});

test('een lege ronde schrijft niets en meldt niets', async () => {
  const db = nepDb({
    pending_actions: [], iris_contacten: [], iris_signalen: [], iris_opvolgingen: [],
    iris_gesprekken: [], iris_belrij: [], iris_belrij_redenen: [],
  });
  const rap = await vulBelrij(db);
  assert.equal(rap.personen, 0);
  assert.equal(rap.nieuw, 0);
  assert.equal(db._data.iris_belrij.length, 0);
});

test('de ronde raakt pending_actions, iris_signalen en iris_opvolgingen niet aan', async () => {
  const taken = [beltaak('t1', 'k1')];
  const signalen = [{ id: 's1', contact_id: CONTACT, type: 'reageert_niet', verwerkt_op: null }];
  const opvolg = [{ id: 'o1', contact_id: CONTACT, status: 'verlopen', omschrijving: 'x', tot: '2026-10-01T00:00:00Z' }];
  const db = nepDb({
    pending_actions: taken, iris_signalen: signalen, iris_opvolgingen: opvolg,
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }],
    iris_gesprekken: [], iris_belrij: [], iris_belrij_redenen: [],
  });

  await vulBelrij(db);

  assert.deepEqual(db._data.pending_actions, taken.map((t) => ({ ...t })));
  assert.deepEqual(db._data.iris_signalen, signalen.map((s) => ({ ...s })));
  assert.deepEqual(db._data.iris_opvolgingen, opvolg.map((o) => ({ ...o })));
});
