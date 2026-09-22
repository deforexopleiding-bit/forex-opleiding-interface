// tests/iris-koppel.test.js
//
// Wie is dit, en weten we dat zeker genoeg?
//
// De regel die hier getest wordt: bij precies één kandidaat koppelen, bij nul
// of meer dan één niet. Dat is streng, en de verleiding om bij twee kandidaten
// de meest recente te kiezen is groot — dat is precies waar het misgaat. Een
// betalingsherinnering bij de verkeerde persoon is geen ongemak maar een
// privacylek. Dus: elke tak waar een gok zou kunnen binnensluipen krijgt hier
// een test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseerEmail,
  normaliseerTelefoon,
  telefoonMatch,
  kiesKandidaat,
  zoekKlant,
} from '../api/_lib/iris/koppel.js';

// ── mailadressen ────────────────────────────────────────────────────────────

test('normaliseerEmail: kleine letters en geen witruimte', () => {
  assert.equal(normaliseerEmail('  Jan.Janssen@Example.COM '), 'jan.janssen@example.com');
});

test('normaliseerEmail: wat geen adres is, wordt leeg', () => {
  for (const v of ['jan', 'jan@', '@example.com', 'jan@example', 'jan janssen@x.nl', '', null, undefined]) {
    assert.equal(normaliseerEmail(v), '', `${JSON.stringify(v)} hoorde leeg te worden`);
  }
});

test('normaliseerEmail: de plus-truc wordt NIET weggehaald', () => {
  // jan+factuur@ is in ons systeem een ander adres dan jan@. Het bij elkaar
  // vegen zou betekenen dat we aannemen hoe andermans mailserver werkt.
  assert.equal(normaliseerEmail('jan+factuur@example.com'), 'jan+factuur@example.com');
});

// ── telefoonnummers ─────────────────────────────────────────────────────────

test('normaliseerTelefoon: alles behalve cijfers verdwijnt', () => {
  assert.equal(normaliseerTelefoon('+31 (6) 12-34.56 78'), '31612345678');
  assert.equal(normaliseerTelefoon('06 12 34 56 78'), '0612345678');
  assert.equal(normaliseerTelefoon(null), '');
});

test('telefoonMatch: identieke cijferreeksen zijn een volledige match', () => {
  assert.equal(telefoonMatch('+31612345678', '0031612345678'.replace('00', '')), 'volledig');
  assert.equal(telefoonMatch('+31 6 1234 5678', '31612345678'), 'volledig');
});

test('telefoonMatch: met en zonder landcode is een staartmatch, geen volledige', () => {
  assert.equal(telefoonMatch('+31612345678', '0612345678'), 'staart');
  assert.equal(telefoonMatch('+32470123456', '0470123456'), 'staart');
});

test('telefoonMatch: verschillende nummers matchen niet', () => {
  assert.equal(telefoonMatch('+31612345678', '+31687654321'), null);
});

test('telefoonMatch: leeg matcht nooit, ook niet met leeg', () => {
  assert.equal(telefoonMatch('', ''), null);
  assert.equal(telefoonMatch(null, '+31612345678'), null);
  assert.equal(telefoonMatch('+31612345678', undefined), null);
});

test('telefoonMatch: een te kort nummer geeft geen staartmatch', () => {
  // Acht cijfers is te weinig om er iets op te durven bouwen.
  assert.equal(telefoonMatch('12345678', '9912345678'), null);
});

// ── de keuze ────────────────────────────────────────────────────────────────

test('kiesKandidaat: geen kandidaten betekent onbekend', () => {
  const r = kiesKandidaat([]);
  assert.equal(r.status, 'onbekend');
  assert.equal(r.id, null);
  assert.match(r.reden, /geen kandidaat/);
});

test('kiesKandidaat: precies één op e-mail koppelt, met een leesbare reden', () => {
  const r = kiesKandidaat([{ id: 'a', score: 'email' }]);
  assert.equal(r.status, 'gekoppeld');
  assert.equal(r.id, 'a');
  assert.equal(r.reden, 'uniek e-mailadres');
});

test('kiesKandidaat: precies één op een volledig nummer koppelt ook', () => {
  const r = kiesKandidaat([{ id: 'a', score: 'volledig' }]);
  assert.equal(r.status, 'gekoppeld');
  assert.equal(r.reden, 'volledig telefoonnummer');
});

test('kiesKandidaat: TWEE volledige matches koppelen niet — dit is de belangrijkste test', () => {
  const r = kiesKandidaat([{ id: 'a', score: 'email' }, { id: 'b', score: 'volledig' }]);
  assert.equal(r.status, 'te_bevestigen');
  assert.equal(r.id, null, 'er mag GEEN kandidaat gekozen worden bij dubbelzinnigheid');
  assert.match(r.reden, /2 kandidaten/);
});

test('kiesKandidaat: een volledige match verslaat een staartmatch', () => {
  const r = kiesKandidaat([
    { id: 'staart', score: 'staart' },
    { id: 'vol', score: 'volledig' },
  ]);
  assert.equal(r.status, 'gekoppeld');
  assert.equal(r.id, 'vol');
});

test('kiesKandidaat: één staartmatch geeft een voorstel, geen koppeling', () => {
  const r = kiesKandidaat([{ id: 'a', score: 'staart' }]);
  assert.equal(r.status, 'te_bevestigen');
  assert.equal(r.id, 'a', 'de kandidaat wordt wel getoond — een mens moet hem kunnen bevestigen');
  assert.match(r.reden, /laatste negen cijfers/);
});

test('kiesKandidaat: meerdere staartmatches geven geen voorstel', () => {
  const r = kiesKandidaat([{ id: 'a', score: 'staart' }, { id: 'b', score: 'staart' }]);
  assert.equal(r.status, 'te_bevestigen');
  assert.equal(r.id, null);
  assert.match(r.reden, /2 kandidaten/);
});

test('kiesKandidaat: rommel in plaats van een lijst is onbekend, geen crash', () => {
  for (const v of [null, undefined, 'x', 42, {}]) {
    const r = kiesKandidaat(v);
    assert.equal(r.status, 'onbekend');
  }
});

test('kiesKandidaat: null-waarden in de lijst tellen niet mee', () => {
  const r = kiesKandidaat([null, { id: 'a', score: 'email' }, undefined]);
  assert.equal(r.status, 'gekoppeld');
  assert.equal(r.id, 'a');
});

test('elke uitkomst draagt een reden die een mens kan lezen', () => {
  const gevallen = [
    [],
    [{ id: 'a', score: 'email' }],
    [{ id: 'a', score: 'email' }, { id: 'b', score: 'email' }],
    [{ id: 'a', score: 'staart' }],
    [{ id: 'a', score: 'staart' }, { id: 'b', score: 'staart' }],
  ];
  for (const g of gevallen) {
    const r = kiesKandidaat(g);
    assert.equal(typeof r.reden, 'string');
    assert.ok(r.reden.length > 10, `de reden "${r.reden}" is te kort om iets aan te hebben`);
  }
});

// ── zoeken in de klantenlijst ───────────────────────────────────────────────

function nepKlanten(rijen) {
  return {
    from: () => ({
      select: () => ({
        is: () => ({
          is: async () => ({ data: rijen, error: null }),
        }),
      }),
    }),
  };
}

test('zoekKlant: zonder adres en zonder nummer valt er niets te zoeken', async () => {
  const r = await zoekKlant(nepKlanten([]), {});
  assert.equal(r.status, 'onbekend');
  assert.match(r.reden, /geen e-mailadres en geen telefoonnummer/);
});

test('zoekKlant: zonder client komt er geen gok terug', async () => {
  const r = await zoekKlant(null, { email: 'jan@example.com' });
  assert.equal(r.status, 'onbekend');
  assert.match(r.reden, /geen databank-client/);
});

test('zoekKlant: één klant met dit adres wordt gekoppeld', async () => {
  const db = nepKlanten([
    { id: 'k1', name: 'Jan', email: 'JAN@example.com', phone: null },
    { id: 'k2', name: 'Piet', email: 'piet@example.com', phone: null },
  ]);
  const r = await zoekKlant(db, { email: ' jan@EXAMPLE.com ' });
  assert.equal(r.status, 'gekoppeld');
  assert.equal(r.id, 'k1');
});

test('zoekKlant: twee klanten met hetzelfde adres worden NIET gekoppeld', async () => {
  const db = nepKlanten([
    { id: 'k1', name: 'Jan', email: 'jan@example.com', phone: null },
    { id: 'k2', name: 'Jan bis', email: 'jan@example.com', phone: null },
  ]);
  const r = await zoekKlant(db, { email: 'jan@example.com' });
  assert.equal(r.status, 'te_bevestigen');
  assert.equal(r.id, null);
  assert.equal(r.kandidaten.length, 2);
});

test('zoekKlant: het mailadres wint van het nummer als allebei meegegeven zijn', async () => {
  const db = nepKlanten([
    { id: 'viaMail', name: 'Jan', email: 'jan@example.com', phone: '+31687654321' },
    { id: 'viaTel',  name: 'Piet', email: 'piet@example.com', phone: '+31612345678' },
  ]);
  // Twee verschillende klanten: eentje matcht op mail, eentje op nummer.
  // Dat zijn twee volledige matches, dus geen koppeling.
  const r = await zoekKlant(db, { email: 'jan@example.com', telefoon: '+31612345678' });
  assert.equal(r.status, 'te_bevestigen');
  assert.equal(r.id, null);
});

test('zoekKlant: dezelfde klant op mail én nummer telt maar één keer', async () => {
  const db = nepKlanten([
    { id: 'k1', name: 'Jan', email: 'jan@example.com', phone: '+31612345678' },
  ]);
  const r = await zoekKlant(db, { email: 'jan@example.com', telefoon: '0612345678' });
  assert.equal(r.status, 'gekoppeld');
  assert.equal(r.id, 'k1');
  assert.equal(r.kandidaten.length, 1, 'één klant mag niet als twee kandidaten tellen');
});

test('zoekKlant: een leesfout geeft geen gok maar een onbekende', async () => {
  const stuk = {
    from: () => ({
      select: () => ({ is: () => ({ is: async () => ({ data: null, error: { message: 'weg' } }) }) }),
    }),
  };
  const r = await zoekKlant(stuk, { email: 'jan@example.com' });
  assert.equal(r.status, 'onbekend');
  assert.match(r.reden, /niet gelezen/);
});

test('zoekKlant: een uitzondering laat niets ontploffen', async () => {
  const stuk = {
    from: () => ({
      select: () => ({ is: () => ({ is: async () => { throw new Error('boem'); } }) }),
    }),
  };
  const r = await zoekKlant(stuk, { email: 'jan@example.com' });
  assert.equal(r.status, 'onbekend');
});

test('zoekKlant: klanten zonder nummer verstoren de nummermatch niet', async () => {
  const db = nepKlanten([
    { id: 'k1', name: 'Zonder', email: 'a@b.nl', phone: null },
    { id: 'k2', name: 'Leeg',   email: 'c@d.nl', phone: '' },
    { id: 'k3', name: 'Met',    email: 'e@f.nl', phone: '+31612345678' },
  ]);
  const r = await zoekKlant(db, { telefoon: '+31612345678' });
  assert.equal(r.status, 'gekoppeld');
  assert.equal(r.id, 'k3');
});
