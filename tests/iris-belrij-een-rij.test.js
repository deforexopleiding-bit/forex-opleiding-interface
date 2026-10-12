// tests/iris-belrij-een-rij.test.js
//
// Taak 6, deel 2b — één OPEN rij per persoon, ook met de hand.
//
// ── WAT ER MIS WAS, EN WAAROM HET NIET OPVIEL ───────────────────────────────
// Twee plekken deden een gewone INSERT in iris_belrij: de actie
// belrij_toevoegen uit een plan (api/iris-actie.js) en de knop op het scherm
// (api/iris-belrij.js). Beide maakten een NIEUWE rij, ook als die persoon er al
// op stond. Twee rijen betekent twee keer gebeld worden — en omdat de belrij
// tot deel 1 leeg was, is dat nooit gebeurd. Nu hij zich vult uit drie bronnen
// zou het wel gebeuren.
//
// ── EN ÉÉN FOUT DIE DEEL 1 ERBIJ MAAKTE ─────────────────────────────────────
// vervallenRedenen() vinkte ALLES af wat de bronnen deze ronde niet
// aanleverden. Een reden die een mens met de hand toevoegde heeft geen
// bronsysteem dat hem kan aanleveren, dus die zou bij de eerste ronde meteen op
// verwerkt gaan — weg van de kaart, terwijl degene die hem zette denkt dat hij
// er staat. Alleen `pending_action:`, `signaal:` en `opvolging:` zijn van de
// vuller; `hand:` is van een mens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BEHEERDE_PREFIXEN, SLEUTEL_PREFIX, prefixVan, vervallenRedenen,
} from '../api/_lib/iris/belrij-bronnen.js';
import { voegHandmatigToe, schrijfPersoon } from '../api/_lib/iris/belrij-vullen.js';
import { uitBeltaak, voegSamen } from '../api/_lib/iris/belrij-bronnen.js';
import { nepDb } from './vast/nep-db.js';

const ACTIE = readFileSync(new URL('../api/iris-actie.js', import.meta.url), 'utf8');
const EP    = readFileSync(new URL('../api/iris-belrij.js', import.meta.url), 'utf8');
const MIGR  = readFileSync(new URL('../docs/sql-migrations/2026-10-12-iris-belrij-een-rij-per-persoon.sql', import.meta.url), 'utf8');

const CONTACT = '11111111-1111-1111-1111-111111111111';
const MAXIM   = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DAVE    = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const codeVan = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');

/* ── de prefix-regel ──────────────────────────────────────────────────────── */

test('de vuller beheert drie prefixen, en hand hoort er NIET bij', () => {
  assert.deepEqual([...BEHEERDE_PREFIXEN].sort(), ['opvolging', 'pending_action', 'signaal']);
  assert.ok(!BEHEERDE_PREFIXEN.includes(SLEUTEL_PREFIX.hand));
});

test('prefixVan knipt op de eerste dubbele punt, en geeft null zonder prefix', () => {
  assert.equal(prefixVan('signaal:abc'), 'signaal');
  assert.equal(prefixVan('hand:1-2-3'), 'hand');
  assert.equal(prefixVan('geen-prefix'), null);
  assert.equal(prefixVan(':leeg'), null);
  assert.equal(prefixVan(null), null);
  assert.equal(prefixVan(''), null);
});

test('een handmatige reden wordt NOOIT afgevinkt door een ronde', () => {
  const weg = vervallenRedenen(
    [
      { id: 'r1', bron_sleutel: 'signaal:s1' },
      { id: 'r2', bron_sleutel: 'hand:abc' },
      { id: 'r3', bron_sleutel: 'opvolging:o1' },
    ],
    [], // de bronnen leveren niets meer aan
  );
  assert.deepEqual(weg.sort(), ['r1', 'r3']);
});

test('een sleutel zonder bekende prefix blijft ook staan', () => {
  // Liever een reden te veel op de kaart dan er stil een af.
  assert.deepEqual(vervallenRedenen([{ id: 'r9', bron_sleutel: 'onbekend:1' }], []), []);
  assert.deepEqual(vervallenRedenen([{ id: 'r9', bron_sleutel: 'losse-tekst' }], []), []);
});

test('een ronde laat de handmatige reden staan en vinkt zijn eigen oude wel af', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 50, bron: 'hand', eigenaar: null }],
    iris_belrij_redenen: [
      { id: 'r-hand', belrij_id: 'b1', bron: 'hand', bron_sleutel: 'hand:abc', reden: 'hand', verwerkt_op: null },
      { id: 'r-oud',  belrij_id: 'b1', bron: 'mentorsignaal', bron_sleutel: 'signaal:oud', reden: 'mentorsignaal', verwerkt_op: null },
    ],
  });
  const rij = voegSamen([uitBeltaak({ id: 't1', customer_id: 'k1', payload: {} }, { contactId: CONTACT })])[0];

  const uit = await schrijfPersoon(db, rij);

  assert.equal(uit.redenen_verwerkt, 1, 'er is niet precies één reden afgevinkt');
  const hand = db._data.iris_belrij_redenen.find((r) => r.id === 'r-hand');
  assert.equal(hand.verwerkt_op, null, 'de handmatige reden is afgevinkt door een ronde');
  const oud = db._data.iris_belrij_redenen.find((r) => r.id === 'r-oud');
  assert.ok(oud.verwerkt_op, 'de oude signaal-reden is niet afgevinkt');
});

/* ── met de hand toevoegen ────────────────────────────────────────────────── */

test('een nieuwe persoon krijgt een rij én een reden-regel', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const uit = await voegHandmatigToe(db, { contactId: CONTACT, reden: 'belt zelf niet terug' });

  assert.equal(uit.nieuw, true);
  assert.equal(db._data.iris_belrij.length, 1);
  assert.equal(db._data.iris_belrij[0].status, 'open');
  assert.equal(db._data.iris_belrij_redenen.length, 1);
  assert.match(db._data.iris_belrij_redenen[0].bron_sleutel, /^hand:[0-9a-f-]{36}$/);
});

test('iemand die er al op staat krijgt GEEN tweede rij, maar een reden erbij', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 50, bron: 'wanbetaler', eigenaar: null }],
    iris_belrij_redenen: [],
  });
  const uit = await voegHandmatigToe(db, { contactId: CONTACT, reden: 'ook even over zijn mentor' });

  assert.equal(uit.nieuw, false);
  assert.equal(uit.belrij_id, 'b1');
  assert.equal(db._data.iris_belrij.length, 1, 'er staat een tweede rij voor dezelfde persoon');
  assert.equal(db._data.iris_belrij_redenen.length, 1);
});

test('twee keer met de hand toevoegen geeft twee redenen, niet één overschreven', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  await voegHandmatigToe(db, { contactId: CONTACT, reden: 'eerste reden' });
  await voegHandmatigToe(db, { contactId: CONTACT, reden: 'tweede reden' });

  assert.equal(db._data.iris_belrij.length, 1);
  assert.equal(db._data.iris_belrij_redenen.length, 2);
  const sleutels = new Set(db._data.iris_belrij_redenen.map((r) => r.bron_sleutel));
  assert.equal(sleutels.size, 2, 'de tweede toevoeging overschreef de eerste');
});

test('een bezige rij wordt hergebruikt; een afgehandelde niet', async () => {
  const bezig = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'bezig', prioriteit: 50, bron: 'hand' }],
    iris_belrij_redenen: [],
  });
  assert.equal((await voegHandmatigToe(bezig, { contactId: CONTACT })).nieuw, false);

  const gedaan = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'gedaan', prioriteit: 50, bron: 'hand' }],
    iris_belrij_redenen: [],
  });
  assert.equal((await voegHandmatigToe(gedaan, { contactId: CONTACT })).nieuw, true);
  assert.equal(gedaan._data.iris_belrij.length, 2, 'iemand die vorig jaar gebeld is mag er weer op');
});

test('de prioriteit schuift omhoog, nooit omlaag', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 90, bron: 'wanbetaler' }],
    iris_belrij_redenen: [],
  });
  await voegHandmatigToe(db, { contactId: CONTACT, prioriteit: 20 });
  assert.equal(db._data.iris_belrij[0].prioriteit, 90);

  await voegHandmatigToe(db, { contactId: CONTACT, prioriteit: 95 });
  assert.equal(db._data.iris_belrij[0].prioriteit, 95);
});

test('een mens die een eigenaar meegeeft, wijst toe — ook als er al iemand staat', async () => {
  // Anders dan bij de vuller: daar is het een regel die iets afleidt, hier is
  // het iemand die het zegt.
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 50, bron: 'hand', eigenaar: DAVE }],
    iris_belrij_redenen: [],
  });
  await voegHandmatigToe(db, { contactId: CONTACT, eigenaar: MAXIM });
  assert.equal(db._data.iris_belrij[0].eigenaar, MAXIM);

  // zonder eigenaar laat hij staan wie er staat
  await voegHandmatigToe(db, { contactId: CONTACT });
  assert.equal(db._data.iris_belrij[0].eigenaar, MAXIM);
});

test('zonder contact gebeurt er niets, met een leesbare fout', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  await assert.rejects(() => voegHandmatigToe(db, {}), /belrij zonder contact/);
  assert.equal(db._data.iris_belrij.length, 0);
});

/* ── de twee aanroepers ───────────────────────────────────────────────────── */

test('geen van de twee handmatige paden doet nog een rechtstreekse insert', () => {
  for (const [naam, src] of [['iris-actie.js', ACTIE], ['iris-belrij.js', EP]]) {
    const code = codeVan(src);
    const direct = code.match(/from\('iris_belrij'\)\s*\n?\s*\.insert\(/);
    assert.equal(direct, null, `${naam} schrijft nog rechtstreeks in iris_belrij`);
    assert.match(code, /voegHandmatigToe\(supabaseAdmin, \{/, `${naam} gebruikt de helper niet`);
  }
});

test('het scherm krijgt te weten of er een rij bij kwam of een reden', () => {
  // Stil doen alsof er een rij bij kwam, geeft de indruk dat er twee staan.
  assert.match(EP, /nieuw: uit\.nieuw/);
  assert.match(ACTIE, /nieuw: uit\.nieuw/);
});

/* ── de migratie ──────────────────────────────────────────────────────────── */

test('de index is partieel: alleen op rijen die nog werk zijn', () => {
  assert.match(MIGR, /create unique index if not exists idx_iris_belrij_een_open_per_contact/i);
  assert.match(MIGR, /\(contact_id\)\s*where status in \('open','bezig'\)/i);
});

test('de migratie zegt dat hij NA de code moet, en waarom', () => {
  assert.match(MIGR, /PAS NÁ DE MERGE/);
  assert.match(MIGR, /23505/);
});

test('de migratie laat eerst zien of er al dubbele staan, en besluit niet zelf', () => {
  assert.match(MIGR, /personen_dubbel/);
  assert.match(MIGR, /Die\s*\n?--\s*maak ik niet voor je|maak ik niet voor je/);
  // en hij laat ze zien zonder namen of nummers
  const sql = MIGR.toLowerCase();
  assert.ok(!/weergavenaam|telefoons|emails/.test(sql), 'de controle-query haalt persoonsgegevens op');
});

test('de migratie is additief en omkeerbaar', () => {
  const sql = MIGR.split('\n').filter((r) => !/^\s*--/.test(r)).join('\n').toLowerCase();
  assert.ok(!/\bdrop (table|column|constraint|index)\b/.test(sql), 'er staat een drop in de uitvoerbare SQL');
  assert.ok(!/^\s*(update|delete)\s+/m.test(sql), 'er staat een UPDATE of DELETE in');
  assert.match(MIGR, /drop index if exists public\.idx_iris_belrij_een_open_per_contact/);
});

test('de migratie zegt dat deze index geen ON CONFLICT-arbiter kan zijn', () => {
  // Dat is precies de val waar de code omheen is gebouwd; wie de index ziet
  // zou anders denken dat de SELECT-dan-INSERT nu weg kan.
  assert.match(MIGR, /ON CONFLICT-arbiter/);
});
