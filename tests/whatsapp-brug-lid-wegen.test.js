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
  // De lijst is gegroeid met de wegen die getChatById vervangen.
  for (const w of ['getNumberId', 'getChats', 'getMessageById', 'msg_getchat',
                   'chat_contact', 'contact_data', 'msg_data']) {
    assert.ok(b.includes("'" + w + "'"), 'weg ontbreekt in WEGEN: ' + w);
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// HET OPHALEN VAN HISTORIEK VOLGT DEZELFDE WEG ALS HET VERSTUREN
// ═══════════════════════════════════════════════════════════════════════════

test('de chat wordt opgezocht via de lidkaart, niet rechtstreeks op nummer@c.us', () => {
  // Het gesprek bestaat onder het LID. Wie alleen naar nummer@c.us zoekt krijgt
  // 'geen gesprek gevonden' terwijl het er gewoon is.
  const b = bron();
  const i = b.indexOf('async historiek(');
  const blok = b.slice(i, i + 2600);
  assert.match(blok, /lidkaart\.jidVoorNummer\(n0\)/);
  const kaart = blok.indexOf('viaKaart');
  const nummer = blok.indexOf('const gewoon = naarChatId(nummer)');
  assert.ok(kaart > 0 && nummer > 0);
  assert.ok(kaart < nummer, 'de LID-vorm eerst, het kale nummer als terugval');
  assert.match(blok, /const vormen = \[viaKaart, viaBericht, gewoon\]\.filter\(Boolean\)/);
});

test('de @c.us-vorm blijft staan voor de leads zonder LID', () => {
  // Eenentwintig van de achtentwintig kregen een koppeling. Voor de zeven
  // andere is dit de enige weg, dus die mag niet wegvallen.
  const b = bron();
  const i = b.indexOf('async historiek(');
  const blok = b.slice(i, i + 2600);
  assert.match(blok, /const gewoon = naarChatId\(nummer\)/);
});

test('er wordt geteld welke vorm het gesprek opleverde', () => {
  const b = bron();
  const i = b.indexOf('async historiek(');
  const blok = b.slice(i, i + 2600);
  assert.match(blok, /historiekVormen\[gebruikteVorm \|\| 'niets_gevonden'\]/);
  assert.match(b, /historiek_vormen: \{ \.\.\.historiekVormen \}/);
});

test('de volledige jid wordt bewaard, niet uit cijfers heropgebouwd', () => {
  // Dit was de fout: we bewaarden alleen de cijfers en plakten er zelf '@lid'
  // achter. Wat je gekregen hebt, bewaar je zoals je het gekregen hebt.
  const kaart = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/lidkaart.js'), 'utf8');
  assert.match(kaart, /nummerNaarJid/);
  assert.match(kaart, /if \(volledig\.includes\('@'\)\) nieuwNaarJid\.set/);
  const b = bron();
  const i = b.indexOf('async function lidViaNumberId');
  assert.match(b.slice(i, i + 900), /w\?\._serialized/,
    'weg A hoort de serialisatie terug te geven, niet alleen de cijfers');
});

// ═══════════════════════════════════════════════════════════════════════════
// DRIE UITKOMSTEN, EN MAAR ÉÉN ERVAN IS EEN FOUT
// ═══════════════════════════════════════════════════════════════════════════

test('geen LID-koppeling is iets anders dan geen gesprek', () => {
  const b = bron();
  const i = b.indexOf('async historiek(');
  const blok = b.slice(i, i + 2600);
  // Geen enkele vorm bekend → GEEN_KOPPELING (er is iets te doen).
  // Wel vormen, geen chat → GEEN_GESPREK (klopt gewoon).
  assert.match(blok, /if \(vormen\.length === 0\)[\s\S]*?e\.code = 'GEEN_KOPPELING'/);
  assert.match(blok, /if \(!chat\)[\s\S]*?e\.code = 'GEEN_GESPREK'/);
});

test('een gevonden maar leeg gesprek is geen fout', () => {
  const b = bron();
  const i = b.indexOf('async historiek(');
  const blok = b.slice(i, i + 3200);
  assert.match(blok, /leeg   : berichten\.length === 0/);
  assert.match(blok, /vorm   : gebruikteVorm/);
});

test('de brug-route geeft de twee 404-gevallen een eigen code', () => {
  const s = readFileSync(SERVER, 'utf8');
  const i = s.indexOf("app.get('/historiek'");
  const blok = s.slice(i, i + 1800);
  assert.match(blok, /code : 'GEEN_KOPPELING'/);
  assert.match(blok, /code : 'GEEN_GESPREK'/);
});

test('het CRM vertaalt de drie naar drie verschillende zinnen', () => {
  const api = readFileSync(join(ROOT, 'api/opvolging-whatsapp-historiek.js'), 'utf8');
  assert.match(api, /GEEN_KOPPELING/);
  assert.match(api, /LEEG_GESPREK/);
  assert.match(api, /Stuur eerst een bericht/,
    'bij een ontbrekende koppeling is er wél iets te doen');
  assert.match(api, /Het gesprek is gevonden, maar/,
    'en een leeg gesprek is geen fout');
});

test('alleen de ontbrekende koppeling leest als iets dat aandacht vraagt', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /j\.code === 'GEEN_KOPPELING'\) \? 'fout' : 'leeg'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// getChatById IS DOOD — DE CHAT KOMT UIT DE GESPREKKENLIJST
// ═══════════════════════════════════════════════════════════════════════════

test('historiek gebruikt getChatById niet meer', () => {
  // Gemeten op de VPS: 8 pogingen, 0 gelukt, ongeacht welke vorm we hem voerden.
  // getChats() loopt via window.WWebJS — dezelfde laag als het versturen, en die
  // werkt aantoonbaar.
  const b = bron();
  const i = b.indexOf('async historiek(');
  const blok = b.slice(i, i + 3400);
  // Alleen de code; het commentaar legt juist uit waaróm die weg eruit is.
  const code = blok.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.doesNotMatch(code, /getChatById/, 'die weg is er helemaal uit');
  assert.match(blok, /zoekChatIn\(await haalChats\(false\), vormen\)/);
});

test('de gesprekkenlijst wordt onthouden en pas bij een miss ververst', () => {
  // Het is een zware aanroep. Een miss is precies het geval waarin de lijst
  // verouderd kán zijn — een gesprek dat pas net bestaat.
  const b = bron();
  const i = b.indexOf('async function haalChats');
  assert.ok(i > 0);
  assert.match(b.slice(i, i + 600), /if \(chatsCache && !ververs\) return chatsCache/);
  const h = b.indexOf('async historiek(');
  const blok = b.slice(h, h + 3400);
  assert.ok(blok.indexOf('haalChats(false)') < blok.indexOf('haalChats(true)'),
    'eerst het geheugen, dan pas opnieuw ophalen');
});

test('de chat wordt op serialisatie én op cijfers gezocht', () => {
  // Dan maakt het niet uit of WhatsApp het gesprek onder een LID of onder het
  // nummer bewaart.
  const b = bron();
  const i = b.indexOf('function zoekChatIn');
  const blok = b.slice(i, i + 900);
  assert.match(blok, /gezocht\.add\(String\(v\)\)/, 'de volledige serialisatie');
  assert.ok(blok.includes("split('@')[0]"), 'en de cijfers los');
  assert.match(blok, /gezocht\.has\(ser\)/, 'vergelijkt op serialisatie');
  assert.match(blok, /gezocht\.has\(user\)/, 'en op cijfers');
});

test('de weg via een bericht staat er mét een teller, niet als aanname', () => {
  // In de bron die ik kan lezen is Message.getChat() letterlijk
  // client.getChatById(...) — dus dezelfde dode deur. Op 1.34.7 kan dat anders
  // liggen; daarom meten we het in plaats van erop te bouwen.
  const b = bron();
  const i = b.indexOf('async function chatViaBericht');
  assert.ok(i > 0);
  const blok = b.slice(i, i + 1200);
  assert.match(blok, /noteer\('getMessageById', msg\)/);
  assert.match(blok, /noteer\('msg_getchat', chat\)/);
});

test('het CRM geeft een bekend bericht_id mee', () => {
  const api = readFileSync(join(ROOT, 'api/opvolging-whatsapp-historiek.js'), 'utf8');
  assert.match(api, /from\('opvolging_wa_berichten'\)[\s\S]*select\('bericht_id'\)/);
  assert.match(api, /bericht_id=' \+ encodeURIComponent\(berichtId\)/);
  assert.match(api, /console\.warn\('\[opvolging-whatsapp-historiek\] bericht_id opzoeken \(soft\)/,
    'fail-soft: zonder id gaat het verzoek gewoon door');
});

// ═══════════════════════════════════════════════════════════════════════════
// 'GEEN KANDIDATEN' IS IETS ANDERS DAN 'NIETS GEVONDEN'
// ═══════════════════════════════════════════════════════════════════════════

test('een lege kandidatenlijst wordt apart geteld', () => {
  // Allebei zagen ze er uit als {geen: 1}, en daardoor was de vorige meting niet
  // te lezen. Dit is dezelfde les als bij uitkomst.js: geef twee verschillende
  // antwoorden niet dezelfde vorm.
  const b = bron();
  const i = b.indexOf('async historiek(');
  const blok = b.slice(i, i + 3400);
  assert.match(blok, /historiekVormen\.geen_kandidaten/);
  assert.match(blok, /historiekVormen\[gebruikteVorm \|\| 'niets_gevonden'\]/);
});

test('bij niets gevonden komen het aantal vormen en het aantal gesprekken mee', () => {
  const b = bron();
  const i = b.indexOf('async historiek(');
  const blok = b.slice(i, i + 3400);
  assert.match(blok, /e\.kandidaten = vormen\.length/);
  assert.match(blok, /e\.chats_bekeken = \(chatsCache \|\| \[\]\)\.length/);
});

test('het CRM geeft die twee door zodat het geen stilte wordt', () => {
  const api = readFileSync(join(ROOT, 'api/opvolging-whatsapp-historiek.js'), 'utf8');
  assert.match(api, /kandidaten   : e\?\.data\?\.kandidaten/);
  assert.match(api, /chats_bekeken: e\?\.data\?\.chats_bekeken/);
});
