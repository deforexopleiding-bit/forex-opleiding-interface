// tests/gesprekken-mailkoppel.test.js
//
// Mail bij een gesprek dat nog geen klant heeft — gat G6.
//
// `inbox-thread-unified` haalde mail op met `.eq('customer_id', …)`. Geen
// klantkoppeling betekent dus: geen mail in de draad. Dat is omgekeerd aan wat
// je nodig hebt — juist bij een ongekoppeld gesprek wil je álle context die er
// is, want misschien staat in een mail van vorige week precies wie dit is.
//
// De brug is `iris_contacten`: één rij per persoon, met zijn adressen én zijn
// nummers, ook zonder klant. Wat hier getest wordt zijn de randen van die brug,
// want daar kan hij de verkeerde mail in een draad zetten — en dat is erger dan
// geen mail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mailadressenVan, telefoonSleutels, viaContactZoeken, orReeks, MAX_ADRESSEN,
} from '../api/_lib/gesprekken-mailkoppel.js';

/* ── Welke adressen tellen mee ────────────────────────────────────────── */

test('adressen worden opgeschoond en ontdubbeld', () => {
  assert.deepEqual(
    mailadressenVan({ emails: ['  Jan@Voorbeeld.BE ', 'jan@voorbeeld.be', 'piet@acme.nl'] }),
    ['jan@voorbeeld.be', 'piet@acme.nl'],
  );
});

test('wat geen adres is, telt niet mee', () => {
  assert.deepEqual(mailadressenVan({ emails: ['geen-adres', '', null, undefined, 42, '@nope', 'a@b'] }), []);
});

test('een adres met een komma komt er niet door', () => {
  // Dit is de scherpe rand. Een komma hakt de or-reeks van PostgREST in
  // tweeën, en dan zoekt de opvraging iets anders dan bedoeld — mogelijk de
  // mail van een wildvreemde in de draad van deze klant.
  assert.deepEqual(mailadressenVan({ emails: ['a,b@voorbeeld.be'] }), []);
  assert.deepEqual(mailadressenVan({ emails: ['a@voorbeeld.be,c@kwaad.be'] }), []);
  assert.deepEqual(mailadressenVan({ emails: ['"quoted"@voorbeeld.be', 'a(b)@voorbeeld.be'] }), []);
});

test('geen contact, geen adressen — zonder uitzondering', () => {
  for (const r of [null, undefined, {}, { emails: null }, { emails: 'a@b.nl' }]) {
    assert.deepEqual(mailadressenVan(r), []);
  }
});

test('er zit een bovengrens op', () => {
  const veel = Array.from({ length: 40 }, (_, i) => `n${i}@voorbeeld.be`);
  assert.equal(mailadressenVan({ emails: veel }).length, MAX_ADRESSEN);
});

/* ── Waarop we het contact zoeken ─────────────────────────────────────── */

test('het nummer wordt tot cijfers teruggebracht', () => {
  // iris_contacten.telefoons bevat ALLEEN CIJFERS — het commentaar in de
  // migratie zegt "E.164 met een plus", maar normaliseerTelefoon is
  // stripToDigits. De code is wat telt, want dat is wat er in de rijen staat.
  const s = telefoonSleutels('+32 470 12 34 56');
  assert.equal(s.volledig, '32470123456');
});

test('de laatste negen cijfers zijn de terugval', () => {
  const s = telefoonSleutels('+32470123456');
  assert.equal(s.staart, '470123456');
});

test('is de staart gelijk aan het geheel, dan is het geen tweede kans', () => {
  // Anders doen we dezelfde opvraging twee keer en lijkt dat op grondigheid.
  const s = telefoonSleutels('470123456');
  assert.equal(s.volledig, '470123456');
  assert.equal(s.staart, null);
});

test('zonder nummer valt er niets te zoeken', () => {
  for (const r of [null, undefined, '', 'geen nummer']) {
    assert.deepEqual(telefoonSleutels(r), { volledig: null, staart: null });
  }
});

/* ── Wanneer de omweg überhaupt gelopen wordt ─────────────────────────── */

test('alleen zonder klant, en alleen achter de vlag', () => {
  const basis = { telefoon: '+32470123456' };
  assert.equal(viaContactZoeken({ ...basis, customerId: null, vlagAan: true }), true);
  assert.equal(viaContactZoeken({ ...basis, customerId: null, vlagAan: false }), false);
  // Mét klant is de bestaande weg nauwkeuriger: die kijkt naar wat er aan de
  // KLANT hangt, en dat is meer dan wat er aan één persoon hangt.
  assert.equal(viaContactZoeken({ ...basis, customerId: 'k1', vlagAan: true }), false);
  assert.equal(viaContactZoeken({ customerId: null, telefoon: '', vlagAan: true }), false);
});

test('alleen een echte true zet de vlag aan', () => {
  assert.equal(viaContactZoeken({ customerId: null, telefoon: '+32470123456', vlagAan: 'ja' }), false);
  assert.equal(viaContactZoeken({ customerId: null, telefoon: '+32470123456' }), false);
});

/* ── De zoekreeks ─────────────────────────────────────────────────────── */

test('de or-reeks gebruikt ilike, niet een exacte vergelijking', () => {
  // IMAP levert adressen aan in de vorm waarin de afzender ze typte —
  // Jan.Janssen@Voorbeeld.BE komt echt voor. Een exacte vergelijking mist die,
  // en dan lijkt er gewoon geen mail te zijn.
  assert.equal(
    orReeks('from_address', ['jan@voorbeeld.be', 'piet@acme.nl']),
    'from_address.ilike.jan@voorbeeld.be,from_address.ilike.piet@acme.nl',
  );
});

test('zonder adressen komt er null terug, geen lege reeks', () => {
  // Een lege or() is een opvraging zonder filter, en die geeft ALLE mail terug.
  // Dat is precies de fout die je pas merkt als er een vreemde in de draad staat.
  assert.equal(orReeks('from_address', []), null);
  assert.equal(orReeks('from_address', null), null);
  assert.equal(orReeks('from_address', ['onzin', 'a,b@c.nl']), null);
});

/* ── De bedrading in de draad ─────────────────────────────────────────── */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DRAAD = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'api/inbox-thread-unified.js'), 'utf8');

test('de omweg loopt langs de vlag en langs viaContactZoeken', () => {
  assert.match(DRAAD, /viaContactZoeken\(\{[\s\S]{0,200}vlagAan: gesprekkenV2Aan\(\)/);
});

test('twee contacten op hetzelfde nummer levert er geen op', () => {
  // Een draad vullen met de mail van misschien-iemand-anders is erger dan een
  // lege draad.
  assert.match(DRAAD, /if \(Array\.isArray\(data\) && data\.length === 1\) contact = data\[0\];/);
  assert.match(DRAAD, /\.limit\(2\)/);
});

test('er wordt nooit met een lege filter gezocht', () => {
  assert.match(DRAAD, /if \(includeEmail && orInkomend && orUitgaand\) \{/);
});

test('de bestaande weg via customer_id staat er nog', () => {
  // Met een klant is die nauwkeuriger, en met de vlag uit is hij de enige.
  assert.match(DRAAD, /if \(includeEmail && conv\.customer_id\) \{/);
  assert.match(DRAAD, /\.eq\('customer_id', conv\.customer_id\)/);
});

test('de mailkoppeling mag de WhatsApp-draad niet blokkeren', () => {
  const blok = DRAAD.slice(DRAAD.indexOf('G6 — geen klant?'));
  assert.match(blok.slice(0, 2500), /catch \(cEx\)[\s\S]{0,200}console\.warn/);
});
