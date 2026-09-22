// tests/iris-actie.test.js
//
// De idempotentiesleutel, en de rechten per staptype.
//
// De sleutel is het enige waterdichte antwoord op dubbelklikken. Een
// uitgeschakelde knop is dat niet: het eerste verzoek kan al onderweg zijn
// wanneer de tweede klik komt. Maar dan moet de sleutel wél uit de INHOUD van
// de stap komen en niet uit een toevalsgetal — anders is elke klik uniek en
// beschermt de constraint nergens tegen. Daar gaat het grootste deel van dit
// bestand over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RECHT_PER_TYPE, bouwSleutel } from '../api/iris-actie.js';
import { STAPTYPES } from '../api/_lib/iris/opdracht.js';

const OP = new Date('2026-09-21T12:00:00Z');
const BASIS = { type: 'belofte_vastleggen', contactId: 'c1', opdrachtId: 'o1', parameters: { datum: '2026-09-25', bedrag: 450 }, op: OP };

// ── de sleutel ──────────────────────────────────────────────────────────────

test('dezelfde stap geeft dezelfde sleutel', () => {
  assert.equal(bouwSleutel(BASIS), bouwSleutel({ ...BASIS }));
});

test('twee keer klikken op dezelfde knop geeft dezelfde sleutel — dat is de hele bedoeling', () => {
  const eerste = bouwSleutel(BASIS);
  const tweede = bouwSleutel({ ...BASIS, op: new Date('2026-09-21T12:00:05Z') });
  assert.equal(eerste, tweede, 'vijf seconden later mag geen nieuwe sleutel geven');
});

test('de volgorde van de parameters maakt niet uit', () => {
  // JSON.stringify geeft bij een andere invoegvolgorde een andere tekst. Dat
  // zou betekenen dat dezelfde stap soms wél en soms niet herkend wordt.
  const a = bouwSleutel({ ...BASIS, parameters: { datum: '2026-09-25', bedrag: 450 } });
  const b = bouwSleutel({ ...BASIS, parameters: { bedrag: 450, datum: '2026-09-25' } });
  assert.equal(a, b);
});

test('een andere waarde geeft een andere sleutel', () => {
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, parameters: { datum: '2026-09-26', bedrag: 450 } }));
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, parameters: { datum: '2026-09-25', bedrag: 500 } }));
});

test('een andere persoon geeft een andere sleutel', () => {
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, contactId: 'c2' }));
});

test('een ander staptype geeft een andere sleutel', () => {
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, type: 'belrij_toevoegen' }));
});

test('dezelfde stap MORGEN mag wel, en krijgt dus een andere sleutel', () => {
  // Iemand morgen opnieuw op de belrij zetten is een geldige handeling. De
  // dag zit daarom in de sleutel; het tijdstip niet.
  const morgen = new Date('2026-09-22T09:00:00Z');
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, op: morgen }));
});

test('een losse stap zonder opdracht botst niet met eentje mét opdracht', () => {
  assert.notEqual(bouwSleutel(BASIS), bouwSleutel({ ...BASIS, opdrachtId: null }));
});

test('zonder contact is er nog steeds een bruikbare sleutel', () => {
  const s = bouwSleutel({ ...BASIS, contactId: null });
  assert.ok(s.includes('geen-contact'));
  assert.ok(s.length > 10);
});

test('geneste parameters worden ook stabiel verwerkt', () => {
  const a = bouwSleutel({ ...BASIS, parameters: { a: { x: 1, y: 2 }, b: [1, 2] } });
  const b = bouwSleutel({ ...BASIS, parameters: { b: [1, 2], a: { y: 2, x: 1 } } });
  assert.equal(a, b);
});

test('de sleutel blijft binnen de kolombreedte', () => {
  const groot = {};
  for (let i = 0; i < 200; i++) groot[`veld_met_een_lange_naam_${i}`] = 'waarde'.repeat(20);
  const s = bouwSleutel({ ...BASIS, parameters: groot });
  assert.ok(s.length <= 400, `sleutel van ${s.length} tekens past niet`);
});

test('lege parameters geven een geldige sleutel', () => {
  assert.ok(bouwSleutel({ ...BASIS, parameters: {} }).length > 10);
  assert.ok(bouwSleutel({ ...BASIS, parameters: null }).length > 10);
});

// ── de rechten ──────────────────────────────────────────────────────────────

test('elk staptype heeft een recht — er valt er geen door de mazen', () => {
  for (const t of STAPTYPES) {
    assert.ok(RECHT_PER_TYPE[t], `${t} heeft geen recht en zou dus een 403 geven bij iedereen`);
  }
});

test('elk recht begint met iris.', () => {
  for (const [type, recht] of Object.entries(RECHT_PER_TYPE)) {
    assert.match(recht, /^iris\./, `${type} verwijst naar een recht buiten Iris: ${recht}`);
  }
});

test('versturen vereist het zwaardere recht', () => {
  assert.equal(RECHT_PER_TYPE.wa_versturen, 'iris.versturen');
  assert.equal(RECHT_PER_TYPE.mail_versturen, 'iris.versturen');
});

test('LMS-stappen vereisen het LMS-recht — die raken wat een klant kan', () => {
  assert.equal(RECHT_PER_TYPE.lms_toegang_verlengen, 'iris.lms.acties');
  assert.equal(RECHT_PER_TYPE.lms_uitnodiging, 'iris.lms.acties');
  assert.equal(RECHT_PER_TYPE.lms_on_hold, 'iris.lms.acties');
});

test('de belrij heeft zijn eigen recht', () => {
  assert.equal(RECHT_PER_TYPE.belrij_toevoegen, 'iris.belrij');
});

test('een notitie-achtige stap vereist geen verzendrecht', () => {
  // Iemand op de belrij zetten of een taak maken is geen bericht naar buiten.
  assert.notEqual(RECHT_PER_TYPE.taak_aanmaken, 'iris.versturen');
  assert.notEqual(RECHT_PER_TYPE.factuur_nakijken, 'iris.versturen');
});

test('er staan geen rechten voor stappen die niet bestaan', () => {
  for (const type of Object.keys(RECHT_PER_TYPE)) {
    assert.ok(STAPTYPES.includes(type), `${type} staat bij de rechten maar is geen staptype`);
  }
});
