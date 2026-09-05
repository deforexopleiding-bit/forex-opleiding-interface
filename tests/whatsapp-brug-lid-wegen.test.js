// tests/whatsapp-brug-lid-wegen.test.js
//
// DE LES DIE HIER DRIE KEER TERUGKWAM. Een controle die 'niets gevonden'
// teruggeeft terwijl de functie niet eens bestaat, is geen meting maar een
// stilte. Dat is drie ronden lang misgegaan:
//
//   1. getCurrentLid gaf 0 van 28 — en pas ronde drie liet zien dat die functie
//      in onze context helemaal niet bestond.
//   2. lid_kunde stond in /status maar werd pas gevuld ná de eerste poging, dus
//      wie ernaar keek zag niets.
//   3. Alle metingen zijn gedaan tegen de bron van 1.26.0, zonder te weten of
//      dát draait — package.json zegt ^1.26.0.
//
// Vandaar dat lib/uitkomst.js vier statussen kent in plaats van null, dat elke
// weg apart telt (geprobeerd / gelukt / beschikbaar), en dat de brug haar eigen
// bibliotheekversie rapporteert.
//
// En de sleutelwaarneming die de richting bepaalde: VERSTUREN WERKT. WhatsApp
// weet dus zelf welk gesprek bij een nummer hoort — de vertaling zit al in de
// bibliotheek, wij gebruikten alleen de verkeerde ingang.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  probeer, BESTAAT_NIET, GEEN_RESULTAAT, ONBRUIKBAAR, GELUKT, FOUT, STATUSSEN,
} from '../services/whatsapp-brug/lib/uitkomst.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WA = join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js');
const SERVER = join(ROOT, 'services/whatsapp-brug/server.js');
const bron = () => readFileSync(WA, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// VIER ANTWOORDEN, NIET ÉÉN NULL
// ═══════════════════════════════════════════════════════════════════════════

test('bestaat de functie niet, dan zegt dat dat — en niet "geen resultaat"', async () => {
  // Dit is precies wat er misging: onze code las 'bestaat niet' als 'gaf niets
  // terug', en dus zochten we een ronde lang naar de verkeerde oorzaak.
  const r = await probeer({ bestaat: false, haal: () => 'x' });
  assert.equal(r.status, BESTAAT_NIET);
  assert.equal(r.waarde, null);
});

test('bestond wel maar gaf niets terug', async () => {
  for (const leeg of [null, undefined, '']) {
    const r = await probeer({ bestaat: true, haal: () => leeg });
    assert.equal(r.status, GEEN_RESULTAAT, String(leeg));
  }
});

test('gaf iets terug dat we niet konden gebruiken', async () => {
  const r = await probeer({
    bestaat: true,
    haal: () => '123456789012345@lid',
    bruikbaar: (v) => String(v).endsWith('@c.us'),
  });
  assert.equal(r.status, ONBRUIKBAAR);
  assert.equal(r.waarde, null, 'onbruikbaar levert geen waarde op');
  assert.equal(r.lengte, 15, 'maar de lengte wel — dat is de meting');
});

test('een uitzondering is een eigen status, geen stilte', async () => {
  const r = await probeer({ bestaat: true, haal: () => { throw new Error('stuk'); } });
  assert.equal(r.status, FOUT);
});

test('gelukt geeft de waarde én de lengte', async () => {
  const r = await probeer({ bestaat: true, haal: () => '32456816410@c.us' });
  assert.equal(r.status, GELUKT);
  assert.equal(r.lengte, 11);
});

test('de statussen zijn een vaste lijst', () => {
  assert.deepEqual([...STATUSSEN].sort(),
    ['bestaat_niet', 'fout', 'geen_resultaat', 'gelukt', 'onbruikbaar']);
});

test('probeer werkt ook met een async haal', async () => {
  const r = await probeer({ bestaat: true, haal: async () => '32470111222@c.us' });
  assert.equal(r.status, GELUKT);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIE WEGEN, ALLEMAAL ZONDER STORE
// ═══════════════════════════════════════════════════════════════════════════

test('weg A gebruikt de publieke getNumberId', () => {
  const b = bron();
  const i = b.indexOf('async function lidViaNumberId');
  assert.ok(i > 0, 'weg A hoort te bestaan');
  const blok = b.slice(i, i + 800);
  assert.match(blok, /client\.getNumberId\(chatId\)/);
  assert.match(blok, /deelWid\(v\)\.server === 'lid'/, 'en herkent een LID als zodanig');
});

test('weg B gebruikt getChatById en leest de echte chat-id', () => {
  const b = bron();
  const i = b.indexOf('async function lidViaChat');
  assert.ok(i > 0, 'weg B hoort te bestaan');
  const blok = b.slice(i, i + 1600);
  assert.match(blok, /client\.getChatById\(chatId\)/);
  assert.match(blok, /deelWid\(chat\?\.id\)/);
});

test('weg B pakt het contact VAN HET GESPREK, niet van het bericht', () => {
  // msg.getContact() doet getContactById(author || from) en geeft bij een
  // uitgaand bericht ons eigen nummer. Het contact van het gesprek is in beide
  // richtingen de tegenpartij.
  const b = bron();
  const i = b.indexOf('async function lidViaChat');
  const blok = b.slice(i, i + 1600);
  assert.match(blok, /chat\.getContact\(\)/);
  // Alleen naar de code kijken; het commentaar legt juist uit waaróm de
  // bericht-getter hier niet deugt.
  const code = blok.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.doesNotMatch(code, /msg\.getContact\(\)/);
});

test('het contact wordt ook op zijn ruwe laag bekeken', () => {
  // De Contact-klasse geeft maar een handvol velden door; _data draagt de
  // volledige serialisatie. Bij een LID-contact staat het nummer daar vaak in.
  const b = bron();
  const i = b.indexOf('function lidUitContact');
  assert.ok(i > 0);
  const blok = b.slice(i, i + 900);
  assert.match(blok, /contact\?\._data/);
  assert.match(blok, /lid\|phone\|pn\$\|number/i);
});

test('weg C leest de ruwe laag van het bericht', () => {
  const b = bron();
  const i = b.indexOf('function bekijkRuweBericht');
  assert.ok(i > 0, 'weg C hoort te bestaan');
  const blok = b.slice(i, i + 1200);
  assert.match(blok, /msg\._data/);
  assert.match(blok, /pn\$\|phone\|number/i, 'senderPn en verwanten');
});

test('van het ruwe bericht gaan alleen sleutelnamen en domeinen naar buiten', () => {
  // Sleutelnamen zijn protocolnamen. De waarden zijn dat niet, en die blijven
  // dus binnen.
  const b = bron();
  const i = b.indexOf('function bekijkRuweBericht');
  const blok = b.slice(i, i + 1200);
  assert.match(blok, /vorm\[k\] = d\.server \+ '\/' \+ d\.user\.length/,
    'domein en lengte, nooit de waarde');
  assert.doesNotMatch(blok, /vorm\[k\] = v\b/);
});

test('weg C draait vóór de dure oplossing per bericht', () => {
  // Levert de ruwe laag het nummer, dan is er niets meer op te zoeken.
  const b = bron();
  for (const ev of ['message', 'message_create']) {
    const i = b.indexOf("client.on('" + ev + "'");
    const blok = b.slice(i, i + 1400);
    assert.ok(blok.indexOf('bekijkRuweBericht(msg)') < blok.indexOf('bepaalNummer('),
      ev + ': de ruwe laag eerst');
  }
});

test('het filter blijft ook op die weg de grens', () => {
  const b = bron();
  const i = b.indexOf("client.on('message'");
  const blok = b.slice(i, i + 1400);
  assert.ok(blok.indexOf('bekijkRuweBericht(msg)') < blok.indexOf('leadlijst.mag('),
    'eerst het nummer bepalen');
  assert.ok(blok.indexOf('leadlijst.mag(') < blok.indexOf('msg.body'),
    'en het filter nog altijd vóór de tekst');
});

// ═══════════════════════════════════════════════════════════════════════════
// ELKE WEG TELT APART
// ═══════════════════════════════════════════════════════════════════════════

test('er wordt per weg bijgehouden: geprobeerd, gelukt, beschikbaar', () => {
  const b = bron();
  assert.match(b, /const WEGEN = \['getNumberId', 'getChatById', 'chat_contact', 'contact_data', 'msg_data'\]/);
  assert.match(b, /geprobeerd: 0, gelukt: 0, beschikbaar: null/);
});

test('BESTAAT_NIET zet beschikbaar op nee, en niets anders doet dat', () => {
  const b = bron();
  const i = b.indexOf('const noteer =');
  const blok = b.slice(i, i + 500);
  assert.match(blok, /res\.status === BESTAAT_NIET\) t\.beschikbaar = false/);
  assert.match(blok, /t\.beschikbaar === null\) t\.beschikbaar = true/);
});

test('de wegen komen mee in /status', () => {
  const s = readFileSync(SERVER, 'utf8');
  assert.match(s, /lid_bron\s*:\s*wa\.lidBron\(\)/);
  const b = bron();
  const i = b.indexOf('lidBron: () =>');
  assert.match(b.slice(i, i + 300), /wegen:/);
});

test('de bibliotheekversie wordt gerapporteerd', () => {
  // Zonder dit blijven we bron lezen die misschien niet draait — dat is drie
  // ronden lang het geval geweest.
  const b = bron();
  assert.match(b, /eis\('whatsapp-web\.js\/package\.json'\)\?\.version/);
  assert.match(b, /console\.log\('\[brug\] bibliotheek:'/);
});

test('de probe zegt per weg wat eruit kwam, niet één null', () => {
  const b = bron();
  const i = b.indexOf('async function probeerLid');
  const blok = b.slice(i, i + 3000);
  assert.match(blok, /weg_A_getNumberId/);
  assert.match(blok, /weg_B_getChatById/);
  assert.match(blok, /data_veldnamen/, 'en de veldnamen op de ruwe laag');
});

test('de probe blijft achter de leadlijst', () => {
  const b = bron();
  const i = b.indexOf('async function probeerLid');
  const blok = b.slice(i, i + 900);
  assert.ok(blok.indexOf('leadlijst.mag(n)') < blok.indexOf('tastKundeAf'),
    'weigeren vóór er iets opgevraagd wordt');
});
