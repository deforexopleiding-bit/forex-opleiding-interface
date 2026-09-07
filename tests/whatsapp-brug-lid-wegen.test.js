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
  probeer, BESTAAT_NIET, GEEN_RESULTAAT, ONBRUIKBAAR, GELUKT, FOUT, ONBRUIKBARE_INVOER, STATUSSEN,
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
    ['bestaat_niet', 'fout', 'geen_resultaat', 'gelukt', 'onbruikbaar', 'onbruikbare_invoer']);
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
  // Ruimer venster: de systeemtype-controle staat tussen het filter en de tekst,
  // en msg.body zit daardoor op +1556. Gemeten, niet geraden.
  const blok = b.slice(i, i + 2200);
  assert.ok(blok.indexOf('msg.body') > 0, 'het venster hoort de tekst te bereiken');
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
  // Ruimer venster: er zijn twee commentaarblokken bij gekomen — over waarom de
  // status zelf bewaard wordt, en over de foutmelding. Gemeten, niet geraden:
  // het blok tot en met de beschikbaar-regels is ~1100 tekens.
  const blok = b.slice(i, i + 1400);
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

// ═══════════════════════════════════════════════════════════════════════════
// DE STATUS WEGGOOIEN BIJ DE TELLER WAS EEN EIGEN FOUT
// ═══════════════════════════════════════════════════════════════════════════

test('de teller bewaart de status, niet alleen gelukt-ja-of-nee', () => {
  // probeer() rekent al uit óf iets niet bestond, niets teruggaf, iets
  // onbruikbaars gaf of wierp. noteer() gooide dat weg, en dan staat er
  // 'geprobeerd 2, gelukt 0' terwijl je nog steeds niets weet. Precies de
  // stilte die uitkomst.js moest wegnemen — en ik had hem zelf teruggebouwd.
  const b = bron();
  const i = b.indexOf('const noteer =');
  const blok = b.slice(i, i + 800);
  assert.match(blok, /t\.statussen\[res\.status\] = \(t\.statussen\[res\.status\] \|\| 0\) \+ 1/);
  assert.match(b, /geprobeerd: 0, gelukt: 0, beschikbaar: null, statussen: \{\}/);
});

test('getChats logt het AANTAL gesprekken', () => {
  // Dit is de vraag die openstond: kwam de lijst leeg terug, of ging het zoeken
  // erin mis? Een aantal is een getal, geen gegeven van iemand.
  const b = bron();
  const i = b.indexOf('async function haalChats');
  const blok = b.slice(i, i + 1200);
  assert.match(blok, /chatsCache\.length, 'gesprekken'/);
  assert.match(blok, /console\.log\('\[brug\] getChats:', res\.status/,
    'en bij een mislukking de status');
});

test('het moment van de póging wordt vastgelegd, niet alleen dat van het succes', () => {
  // Stond dit alleen op de gelukte tak, dan zag een mislukte ronde eruit als
  // 'nooit geprobeerd' — en dat is iets heel anders.
  const b = bron();
  const i = b.indexOf('async function haalChats');
  const blok = b.slice(i, i + 1200);
  const geprobeerd = blok.indexOf('chatsGeprobeerdAt = new Date()');
  const mislukt = blok.indexOf("if (res.status !== GELUKT)");
  assert.ok(geprobeerd > 0 && mislukt > 0);
  assert.ok(geprobeerd < mislukt, 'eerst vastleggen dát het geprobeerd is');
});

test('de status onderscheidt nooit-geprobeerd, mislukt en leeg', () => {
  const b = bron();
  const i = b.indexOf('lidkaartStatus: () =>');
  const blok = b.slice(i, i + 700);
  for (const veld of ['chats_in_cache', 'chats_opgehaald', 'chats_geprobeerd', 'chats_status']) {
    assert.ok(blok.includes(veld), 'veld ontbreekt: ' + veld);
  }
});

test('het paneel zegt bij een lege lijst dat er niets op te halen valt', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /chats_in_cache === 0/);
  assert.match(view, /geen gesprekken\s*\+?\s*'?\s*gesynchroniseerd|gesynchroniseerd gekregen/,
    'en dat dat betekent dat er geen historiek is');
  assert.match(view, /Dat is geen lege lijst maar een mislukte aanvraag/,
    'en een mislukte aanvraag is iets anders dan een lege lijst');
});

// ═══════════════════════════════════════════════════════════════════════════
// ONZE EIGEN ONBRUIKBARE INVOER IS GEEN ONTBREKENDE FUNCTIE
// ═══════════════════════════════════════════════════════════════════════════
//
// getNumberId en getChatById stonden allebei op 'bestaat_niet ×6', terwijl het
// aftasten meldde dat die functies er wél waren. Dat wrong, en terecht: de
// oorzaak zat in de meting zelf. `bestaat: !!chatId && kunde.api.…` gooide twee
// vragen op één hoop, en naarChatId() geeft null bij minder dan tien cijfers of
// een leidende nul — zes leadlijst-nummers missen een landcode.
//
// Dezelfde fout als hierboven, één laag dieper, en dit keer door mijzelf
// gemaakt in de laag die de stiltes juist moest wegnemen.

test('onbruikbare invoer krijgt een eigen status', async () => {
  const r = await probeer({ bestaat: true, invoerOk: false, haal: () => 'x' });
  assert.equal(r.status, ONBRUIKBARE_INVOER);
  assert.notEqual(r.status, BESTAAT_NIET, 'anders leest het als een ontbrekende functie');
});

test('de functie wordt bij onbruikbare invoer niet eens aangeroepen', async () => {
  let aangeroepen = 0;
  await probeer({ bestaat: true, invoerOk: false, haal: () => { aangeroepen += 1; return 'x'; } });
  assert.equal(aangeroepen, 0);
});

test('een ontbrekende functie gaat nog steeds vóór de invoercontrole', async () => {
  // Bestaat het ding niet, dan is de invoer niet meer de vraag.
  const r = await probeer({ bestaat: false, invoerOk: false, haal: () => 'x' });
  assert.equal(r.status, BESTAAT_NIET);
});

test('invoerOk staat standaard aan, zodat bestaande aanroepen niet omslaan', async () => {
  const r = await probeer({ bestaat: true, haal: () => '32456816410@c.us' });
  assert.equal(r.status, GELUKT);
});

test('de twee LID-wegen scheiden "kan de bibliotheek dit" van "hebben wij een nummer"', () => {
  const b = bron();
  for (const fn of ['async function lidViaNumberId', 'async function lidViaChat']) {
    const i = b.indexOf(fn);
    assert.ok(i > 0, fn);
    const blok = b.slice(i, i + 700);
    assert.match(blok, /invoerOk\s*:\s*!!chatId/, fn + ': de invoer apart');
    assert.doesNotMatch(blok, /bestaat\s*:\s*!!chatId/, fn + ': en niet meer op één hoop');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DE FOUTMELDING VAN getChats IS DE CONCLUSIE
// ═══════════════════════════════════════════════════════════════════════════

test('probeer geeft de foutmelding van de bibliotheek door', async () => {
  const r = await probeer({ bestaat: true, haal: () => { throw new Error('Evaluation failed'); } });
  assert.equal(r.status, FOUT);
  assert.equal(r.melding, 'Evaluation failed');
});

test('bij de andere statussen blijft melding leeg', async () => {
  for (const opts of [{ bestaat: false }, { bestaat: true, invoerOk: false },
                      { bestaat: true, haal: () => null }]) {
    const r = await probeer({ haal: () => 'x', ...opts });
    assert.equal(r.melding, null, r.status);
  }
});

test('de teller bewaart de laatste foutmelding per weg', () => {
  // 'fout ×2' zonder tekst is opnieuw een stilte. Bibliotheektekst is geen
  // gegeven van iemand en mag dus gewoon bewaard en getoond worden.
  const b = bron();
  const i = b.indexOf('const noteer =');
  const blok = b.slice(i, i + 1100);
  assert.match(blok, /res\.status === FOUT && res\.melding\) t\.laatste_fout/);
  assert.match(blok, /slice\(0, 300\)/, 'begrensd, zodat een stacktrace /status niet vult');
  assert.match(b, /laatste_fout: null/, 'en het veld bestaat vanaf het begin');
});

test('haalChats legt de foutmelding vast en logt hem', () => {
  const b = bron();
  const i = b.indexOf('async function haalChats');
  const blok = b.slice(i, i + 1200);
  assert.match(blok, /chatsFout = res\.melding \|\| null/);
  assert.match(blok, /console\.log\('\[brug\] getChats:', res\.status, '—', chatsFout/);
});

test('chats_fout komt mee in /status', () => {
  const b = bron();
  const i = b.indexOf('lidkaartStatus: () =>');
  assert.ok(b.slice(i, i + 800).includes('chats_fout'));
});

test('het paneel toont de foutmelding én de conclusie', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /lk\.chats_status === 'fout'/);
  assert.match(view, /esc\(lk\.chats_fout\)/, 'de tekst zelf, ontsnapt');
  assert.match(view, /alles wat de interne opslag moet lézen faalt/);
});

test('de conclusie in het paneel is gemeten, niet aangenomen', () => {
  // Zonder meting blijft de uitnodiging om het te proberen gewoon staan. Een
  // 'kan niet' zonder meting zou dezelfde stilte zijn als het probleem zelf.
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const i = view.indexOf('function historiekOnbereikbaar');
  assert.ok(i > 0, 'de helper hoort te bestaan');
  const blok = view.slice(i, i + 500);
  assert.match(blok, /lk\.chats_status !== 'fout'\) return null/);
});

test('het lege gesprek meldt eerlijk dat ophalen niet kan', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  const i = view.indexOf('function gesprekPaneelHtml');
  const blok = view.slice(i, i + 4000);
  assert.match(blok, /const onbereikbaar = historiekOnbereikbaar\(\)/);
  assert.match(blok, /Vanaf de koppeling is dit gesprek volledig/);
  assert.match(blok, /gemeten, niet aangenomen/);
  // En de uitnodiging blijft bestaan voor het geval er niets gemeten is.
  assert.match(blok, /Historiek ophalen/);
});

test('de README noemt de versienummers bij de conclusie', () => {
  // Zodat we dit over drie maanden niet opnieuw uitzoeken.
  const rd = readFileSync(join(ROOT, 'services/whatsapp-brug/README.md'), 'utf8');
  const i = rd.indexOf('Historiek ophalen kan niet met deze combinatie');
  assert.ok(i > 0, 'de sectie hoort te bestaan');
  const blok = rd.slice(i, i + 2000);
  assert.match(blok, /1\.34\.7/);
  assert.match(blok, /2\.3000\.1046904178/);
  assert.match(blok, /vanaf de koppeling volledig/i);
});
