// tests/iris-opname.test.js
//
// Welke berichten heeft Iris nog niet gezien?
//
// De kern van deze module is dat ze GEEN cursor gebruikt maar een verzamel-
// verschil. Lesson learned 4 in CLAUDE.md gaat daarover, en de reden is
// concreet: berichten komen niet op volgorde binnen. Een mailsync die vastliep
// en een uur later inhaalt, schrijft rijen weg met een ontvangsttijdstip dat
// vóór de cursor ligt — en die zou Iris met een cursor nooit meer zien.
// De test 'een bericht van gisteren dat vandaag pas binnenkomt' is er precies
// voor dat geval.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPNAME_PER_RONDE,
  TERUGBLIK_DAGEN,
  ONZE_MAILBOXEN,
  bronSleutel,
  leesBron,
  waRichting,
  mailRichting,
  filterNieuw,
  vormWa,
  vormMail,
  terugblikVanaf,
} from '../api/_lib/iris/opname.js';

// ── de bron-sleutel ─────────────────────────────────────────────────────────

test('bronSleutel: whatsapp en mail krijgen een eigen voorvoegsel', () => {
  assert.equal(bronSleutel('whatsapp', 'abc'), 'wa:abc');
  assert.equal(bronSleutel('email', 'abc'), 'mail:abc');
});

test('bronSleutel: dezelfde uuid in twee bronnen botst niet', () => {
  const id = '11111111-1111-1111-1111-111111111111';
  assert.notEqual(bronSleutel('whatsapp', id), bronSleutel('email', id));
});

test('leesBron: de sleutel is terug te lezen naar zijn bron', () => {
  assert.equal(leesBron('wa:abc'), 'whatsapp');
  assert.equal(leesBron('mail:abc'), 'email');
  assert.equal(leesBron('iets:abc'), null);
  assert.equal(leesBron(''), null);
  assert.equal(leesBron(null), null);
});

test('leesBron en bronSleutel zijn elkaars spiegelbeeld', () => {
  for (const bron of ['whatsapp', 'email']) {
    assert.equal(leesBron(bronSleutel(bron, 'x')), bron);
  }
});

// ── de richting van een WhatsApp-bericht ────────────────────────────────────

test('waRichting: de databank zegt in en out, niet inbound en outbound', () => {
  // whatsapp_messages heeft een CHECK op ('in','out'). inbox-thread-unified.js
  // heeft hier al een bug-fix voor moeten inbouwen; wij lopen er niet opnieuw in.
  assert.equal(waRichting('in'), 'in');
  assert.equal(waRichting('out'), 'uit');
});

test('waRichting: de lange vorm wordt ook begrepen', () => {
  assert.equal(waRichting('outbound'), 'uit');
  assert.equal(waRichting('inbound'), 'in');
  assert.equal(waRichting('OUT'), 'uit');
});

test('waRichting: bij twijfel is het inkomend', () => {
  // Inkomend is de voorzichtige kant: een inkomend bericht krijgt aandacht,
  // een uitgaand bericht wordt genegeerd. Verkeerd om zou betekenen dat een
  // klantvraag stil blijft liggen.
  for (const v of ['', null, undefined, 'onzin', 42]) {
    assert.equal(waRichting(v), 'in');
  }
});

// ── de richting van een mail ────────────────────────────────────────────────

test('mailRichting: van onze eigen mailbox is uitgaand', () => {
  for (const m of ONZE_MAILBOXEN) {
    assert.equal(mailRichting(m), 'uit', `${m} hoorde uitgaand te zijn`);
  }
});

test('mailRichting: hoofdletters en witruimte veranderen niets', () => {
  assert.equal(mailRichting('  Administratie@DeForexOpleiding.NL '), 'uit');
});

test('mailRichting: alles van buiten is inkomend', () => {
  assert.equal(mailRichting('jan@example.com'), 'in');
  assert.equal(mailRichting(''), 'in');
  assert.equal(mailRichting(null), 'in');
});

test('onboarding@ staat in de lijst — dat is de mailbox waar niemand naar keek', () => {
  assert.ok(ONZE_MAILBOXEN.includes('onboarding@deforexopleiding.nl'));
});

// ── het verzamelverschil ────────────────────────────────────────────────────

test('filterNieuw: wat al bekend is, blijft weg', () => {
  const rijen = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const nieuw = filterNieuw(rijen, new Set(['wa:a', 'wa:c']), 'whatsapp');
  assert.deepEqual(nieuw.map((r) => r.id), ['b']);
});

test('filterNieuw: een bericht van gisteren dat vandaag pas binnenkomt wordt gewoon opgepakt', () => {
  // Dit is het geval waar een tijdstempel-cursor op stukloopt. Het verzamel-
  // verschil kent geen volgorde en heeft er dus geen last van.
  const rijen = [
    { id: 'oud', created_at: '2026-09-19T08:00:00Z' },
    { id: 'nieuw', created_at: '2026-09-21T08:00:00Z' },
  ];
  const nieuw = filterNieuw(rijen, new Set(['wa:nieuw']), 'whatsapp');
  assert.deepEqual(nieuw.map((r) => r.id), ['oud'],
    'het oudere bericht dat nog niet opgenomen is, hoort er gewoon uit te komen');
});

test('filterNieuw: de bron-sleutel komt mee zodat de insert hem niet opnieuw hoeft te bouwen', () => {
  const nieuw = filterNieuw([{ id: 'a' }], new Set(), 'email');
  assert.equal(nieuw[0]._bron_uniek, 'mail:a');
});

test('filterNieuw: rijen zonder id worden overgeslagen', () => {
  const nieuw = filterNieuw([{ id: 'a' }, {}, null, { id: '' }], new Set(), 'whatsapp');
  assert.equal(nieuw.length, 1);
});

test('filterNieuw: een gewone lijst werkt ook als bekende sleutels', () => {
  const nieuw = filterNieuw([{ id: 'a' }, { id: 'b' }], ['wa:a'], 'whatsapp');
  assert.deepEqual(nieuw.map((r) => r.id), ['b']);
});

test('filterNieuw: niets bekend betekent alles nieuw', () => {
  assert.equal(filterNieuw([{ id: 'a' }, { id: 'b' }], null, 'whatsapp').length, 2);
});

test('filterNieuw: lege invoer geeft een lege uitvoer, geen fout', () => {
  assert.deepEqual(filterNieuw(null, new Set(), 'whatsapp'), []);
  assert.deepEqual(filterNieuw([], new Set(), 'whatsapp'), []);
});

// ── de vorm van een rij ─────────────────────────────────────────────────────

test('vormWa: een gewoon bericht', () => {
  const r = vormWa({ id: 'x', direction: 'in', body: 'hallo', created_at: '2026-09-21T10:00:00Z' });
  assert.equal(r.bron, 'whatsapp');
  assert.equal(r.bron_uniek, 'wa:x');
  assert.equal(r.richting, 'in');
  assert.equal(r.tekst_kort, 'hallo');
});

test('vormWa: een template zonder tekst wordt herkenbaar benoemd', () => {
  const r = vormWa({ id: 'x', direction: 'out', body: null, template_name: 'aanmaning_dag7' });
  assert.equal(r.tekst_kort, '[template] aanmaning_dag7');
});

test('vormWa: een foto zonder bijschrift wordt herkenbaar benoemd', () => {
  const r = vormWa({ id: 'x', direction: 'in', body: null, media_type: 'image' });
  assert.equal(r.tekst_kort, '[image]');
});

test('vormWa: een heel lang bericht wordt op 500 tekens afgekapt', () => {
  const r = vormWa({ id: 'x', direction: 'in', body: 'a'.repeat(2000) });
  assert.equal(r.tekst_kort.length, 500);
});

test('vormWa: zonder tijdstempel valt hij terug op nu, niet op null', () => {
  const r = vormWa({ id: 'x', direction: 'in', body: 'hallo' });
  assert.ok(!Number.isNaN(Date.parse(r.ontvangen_op)));
});

test('vormMail: snippet gaat voor, dan body_text, dan het onderwerp', () => {
  assert.equal(vormMail({ id: 'x', snippet: 'A', body_text: 'B', subject: 'C' }).tekst_kort, 'A');
  assert.equal(vormMail({ id: 'x', snippet: null, body_text: 'B', subject: 'C' }).tekst_kort, 'B');
  assert.equal(vormMail({ id: 'x', snippet: null, body_text: null, subject: 'C' }).tekst_kort, 'C');
});

test('vormMail: een mail die alleen HTML is valt terug op het onderwerp', () => {
  // Moderne mail heeft vaak geen text/plain-deel. Dan staan snippet en
  // body_text allebei op NULL. Zonder de terugval op het onderwerp krijgt Iris
  // een leeg bericht te lezen en deelt ze het in als 'overig' — wat er in het
  // scherm uitziet als een fout van haar in plaats van een lege bron.
  const r = vormMail({ id: 'x', snippet: null, body_text: null, subject: 'Vraag over mijn factuur' });
  assert.equal(r.tekst_kort, 'Vraag over mijn factuur');
});

test('vormMail: een mail zonder enige tekst geeft een lege tekst, geen crash', () => {
  const r = vormMail({ id: 'x' });
  assert.equal(r.tekst_kort, '');
});

test('vormMail: de richting komt uit het afzenderadres', () => {
  assert.equal(vormMail({ id: 'x', from_address: 'jan@example.com' }).richting, 'in');
  assert.equal(vormMail({ id: 'x', from_address: 'info@deforexopleiding.nl' }).richting, 'uit');
});

// ── de terugblik ────────────────────────────────────────────────────────────

test('terugblikVanaf: veertien dagen terug', () => {
  assert.equal(TERUGBLIK_DAGEN, 14);
  const nu = new Date('2026-09-21T12:00:00Z');
  assert.equal(terugblikVanaf(nu), '2026-09-07T12:00:00.000Z');
});

test('terugblikVanaf: het aantal dagen is instelbaar', () => {
  const nu = new Date('2026-09-21T12:00:00Z');
  assert.equal(terugblikVanaf(nu, 1), '2026-09-20T12:00:00.000Z');
});

test('de opnamegrens is groot genoeg voor een drukke dag maar past binnen een functieduur', () => {
  assert.ok(OPNAME_PER_RONDE >= 50 && OPNAME_PER_RONDE <= 500);
});
