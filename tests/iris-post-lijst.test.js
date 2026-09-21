// tests/iris-post-lijst.test.js
//
// De vorm van een lijstrij in de Post.
//
// Deze test bestaat vooral om gat G3 uit de audit vast te pinnen: het venster
// moet AFTELLEN, niet pas iets zeggen als het te laat is. Het bestaande scherm
// toont alleen "24u-venster is verlopen", en dat zie je pas als je er al
// tegenaan loopt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bouwLijstRij, FILTERS } from '../api/iris-post.js';

const NU = new Date('2026-09-21T12:00:00Z');
const uurGeleden = (n) => new Date(NU.getTime() - n * 3600 * 1000).toISOString();

const GESPREK = {
  id: 'g1',
  kanaal: 'whatsapp',
  categorie: 'facturatie',
  status: 'wacht_op_ons',
  toegewezen_aan: null,
  ongelezen: 2,
  laatste_inbound: uurGeleden(1),
  laatste_outbound: null,
};

test('bouwLijstRij: het venster telt af in plaats van alleen te melden dat het dicht is', () => {
  const r = bouwLijstRij(GESPREK, { nu: NU });
  assert.equal(r.venster.open, true);
  assert.match(r.venster.tekst, /nog 23u00/);
});

test('bouwLijstRij: bijna dicht is een eigen vlag, geen kleurtruc in de opmaak', () => {
  const r = bouwLijstRij({ ...GESPREK, laatste_inbound: uurGeleden(23) }, { nu: NU });
  assert.equal(r.venster.bijna_dicht, true);
  assert.match(r.venster.tekst, /nog 1u00/);
});

test('bouwLijstRij: een verlopen venster zegt dat ook', () => {
  const r = bouwLijstRij({ ...GESPREK, laatste_inbound: uurGeleden(30) }, { nu: NU });
  assert.equal(r.venster.open, false);
  assert.match(r.venster.tekst, /dicht/);
});

test('bouwLijstRij: de naam komt uit het contact, met een terugval op adres en nummer', () => {
  assert.equal(bouwLijstRij(GESPREK, { contact: { id: 'c', weergavenaam: 'Jan' }, nu: NU }).naam, 'Jan');
  assert.equal(bouwLijstRij(GESPREK, { contact: { id: 'c', emails: ['jan@x.nl'] }, nu: NU }).naam, 'jan@x.nl');
  assert.equal(bouwLijstRij(GESPREK, { contact: { id: 'c', telefoons: ['+31612345678'] }, nu: NU }).naam, '+31612345678');
});

test('bouwLijstRij: zonder contact staat er Onbekend, niet leeg of null', () => {
  const r = bouwLijstRij(GESPREK, { nu: NU });
  assert.equal(r.naam, 'Onbekend');
  assert.equal(r.koppelstatus, 'onbekend');
  assert.equal(r.contact_id, null);
});

test('bouwLijstRij: de koppelreden komt mee zodat een mens weet wat er te bevestigen valt', () => {
  const r = bouwLijstRij(GESPREK, {
    contact: { id: 'c', koppelstatus: 'te_bevestigen', koppel_reden: '3 kandidaten op de laatste negen cijfers' },
    nu: NU,
  });
  assert.equal(r.koppelstatus, 'te_bevestigen');
  assert.match(r.koppel_reden, /3 kandidaten/);
});

test('bouwLijstRij: de samenvatting van het laatste bericht komt in de rij', () => {
  const r = bouwLijstRij(GESPREK, {
    laatsteBericht: { tekst_kort: 'ik heb al betaald hoor', samenvatting: 'Zegt dat hij al betaald heeft.', zekerheid: 0.9 },
    nu: NU,
  });
  assert.equal(r.samenvatting, 'Zegt dat hij al betaald heeft.');
  assert.equal(r.voorbeeld, 'ik heb al betaald hoor');
  assert.equal(r.zekerheid, 0.9);
});

test('bouwLijstRij: een lage zekerheid blijft als getal staan zodat de opmaak hem kan tonen', () => {
  const r = bouwLijstRij(GESPREK, { laatsteBericht: { zekerheid: 0.3 }, nu: NU });
  assert.equal(r.zekerheid, 0.3, 'niet stil weggooien — juist een lage zekerheid moet zichtbaar zijn');
});

test('bouwLijstRij: zonder bericht is de zekerheid null en niet nul', () => {
  // Nul zou lezen als "Iris weet het zeker dat ze het niet weet". Null is
  // "er is niets ingedeeld".
  assert.equal(bouwLijstRij(GESPREK, { nu: NU }).zekerheid, null);
});

test('de filters zijn de vragen die iemand s ochtends stelt', () => {
  assert.deepEqual([...FILTERS], [
    'wacht_op_ons', 'wacht_op_klant', 'venster_bijna_dicht',
    'niet_gekoppeld', 'belofte_vandaag', 'alles',
  ]);
  assert.ok(!FILTERS.includes('open'), '"alle open gesprekken" is geen vraag die iemand stelt');
});
