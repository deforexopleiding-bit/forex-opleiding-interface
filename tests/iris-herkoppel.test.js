// tests/iris-herkoppel.test.js
//
// De regels van de herkoppel-ronde.
//
// Deze ronde bestaat omdat een contact zijn koppelstatus ooit één keer kreeg
// en daarna nooit meer. Ging het zoeken toen mis — op productie noemde de
// opvraging een kolom die niet bestaat — dan bleef dat contact voor altijd
// "onbekend", ook nadat de oorzaak allang verholpen was.
//
// Een reparatieronde is gevaarlijker dan hij lijkt: hij raakt veel rijen tegelijk
// en hij draait op een moment dat er iets stuk was. Daarom liggen de regels vast
// in een zuivere functie, apart van de databank:
//
//   · een bestaande koppeling wordt nooit teruggedraaid;
//   · een bron die niet gelezen kon worden levert geen verdict op;
//   · er wordt alleen geschreven als er echt iets verandert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bepaalWijziging, STANDAARD_MAX } from '../api/iris-herkoppel.js';

const contact = (o = {}) => ({
  id: 'c1', customer_id: null, koppelstatus: 'onbekend', weergavenaam: null, ...o,
});

test('een gevonden klant wordt gekoppeld', () => {
  const w = bepaalWijziging(contact(), {
    gelezen: true, status: 'gekoppeld', id: 'k1', reden: 'uniek e-mailadres',
    kandidaten: [{ id: 'k1', naam: 'Jan Janssen' }],
  });
  assert.equal(w.customer_id, 'k1');
  assert.equal(w.koppelstatus, 'gekoppeld');
  assert.equal(w.koppel_reden, 'uniek e-mailadres');
  assert.equal(w.weergavenaam, 'Jan Janssen');
});

test('een bestaande koppeling wordt nooit teruggedraaid', () => {
  // Deze ronde maakt koppelingen; verbreken hoort bij een mens.
  const w = bepaalWijziging(contact({ customer_id: 'k9', koppelstatus: 'gekoppeld' }), {
    gelezen: true, status: 'onbekend', id: null, reden: 'niets gevonden',
  });
  assert.equal(w, null);
});

test('een onleesbare bron levert geen verdict', () => {
  // Dit is de fout waar deze hele ronde uit voortkomt: een mislukte opvraging
  // die als antwoord werd opgeslagen. Eén slechte minuut werd zo een
  // blijvende toestand.
  const w = bepaalWijziging(contact(), {
    gelezen: false, status: 'onbekend', id: null, reden: 'klanten niet gelezen: …',
  });
  assert.equal(w, null);
});

test('een ontbrekende gelezen-vlag telt als niet gelezen', () => {
  // Strikt, niet soepel: een oudere versie van zoekKlant die het veld niet
  // kent, hoort niets te mogen schrijven in plaats van per ongeluk alles.
  assert.equal(bepaalWijziging(contact(), { status: 'gekoppeld', id: 'k1' }), null);
  assert.equal(bepaalWijziging(contact(), { gelezen: 'ja', status: 'gekoppeld', id: 'k1' }), null);
});

test('dezelfde uitkomst schrijft niets', () => {
  // Idempotent: twee keer draaien geeft hetzelfde resultaat als één keer, en
  // de tweede ronde raakt geen enkele rij aan.
  const w = bepaalWijziging(contact({ koppelstatus: 'onbekend' }), {
    gelezen: true, status: 'onbekend', id: null, reden: 'geen e-mailadres en geen telefoonnummer',
  });
  assert.equal(w, null);
});

test('van onbekend naar te bevestigen is wél een wijziging', () => {
  const w = bepaalWijziging(contact({ koppelstatus: 'onbekend' }), {
    gelezen: true, status: 'te_bevestigen', id: null, reden: '3 kandidaten op de laatste negen cijfers',
  });
  assert.ok(w);
  assert.equal(w.koppelstatus, 'te_bevestigen');
  assert.equal(w.customer_id, null, 'te bevestigen is geen koppeling');
});

test('een naam die er al staat blijft staan', () => {
  // Die kan met de hand gezet zijn, en dan weet een mens het beter.
  const w = bepaalWijziging(contact({ weergavenaam: 'De baas van Acme' }), {
    gelezen: true, status: 'gekoppeld', id: 'k1', reden: 'uniek e-mailadres',
    kandidaten: [{ id: 'k1', naam: 'Acme BV' }],
  });
  assert.equal(w.weergavenaam, undefined, 'de naam hoort niet in de wijziging te zitten');
});

test('rommel geeft null, geen uitzondering', () => {
  assert.equal(bepaalWijziging(null, { gelezen: true, status: 'gekoppeld', id: 'k1' }), null);
  assert.equal(bepaalWijziging(contact(), null), null);
  assert.equal(bepaalWijziging(undefined, undefined), null);
});

test('de ronde heeft een bovengrens', () => {
  // Vercel kapt af op 30 seconden; een ronde zonder grens komt nooit tot het
  // punt waarop hij zijn telling teruggeeft, en dan weet niemand wat er wél
  // gelukt is.
  assert.ok(Number.isInteger(STANDAARD_MAX) && STANDAARD_MAX > 0 && STANDAARD_MAX <= 1000);
});
