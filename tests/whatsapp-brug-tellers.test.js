// tests/whatsapp-brug-tellers.test.js
//
// Meten zonder te kijken.
//
// Aanleiding: een bericht dat vanaf Daves telefoon naar een lead ging is stil
// gedropt tussen raakAan() en webhook.duw(). De brug zag om 17:38:57 iets, maar
// webhook.verstuurd bleef 0 en er stond geen enkele waarschuwing in journalctl.
// Dat gat maakt het privacyfilter per definitie: wat we niet mogen loggen,
// kunnen we ook niet terugvinden.
//
// De uitweg is niet dat filter opgeven maar tellen. Deze tests bewaken twee
// dingen tegelijk:
//
//   1. dat de tellers de juiste vraag beantwoorden — kwam het event binnen, en
//      zo ja, op welke regel viel het af;
//   2. dat er nooit een nummer, een tekst of een bericht-id in terechtkomt.
//      Dat tweede is het punt: zodra dat wél zou mogen, is het filter een
//      formaliteit geworden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { maakTellers, EVENT_TYPES, REDENEN, OPLOS_WEGEN, jidVorm } from '../services/whatsapp-brug/lib/tellers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WA = join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js');

/** Cross-realm speelt hier niet, maar plat vergelijken leest prettiger. */
const plat = (o) => JSON.parse(JSON.stringify(o));

// ═══════════════════════════════════════════════════════════════════════════
// DE TELLERS ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('een verse teller staat overal op nul, niet op null', () => {
  // Nul betekent 'geteld en er was niets'. Dat is hier de waarheid: de brug is
  // net gestart. Een ontbrekend veld zou als 'niet gemeten' moeten lezen, en
  // dat onderscheid maakt het CRM-paneel aan de andere kant.
  const t = maakTellers().status();
  for (const type of EVENT_TYPES) {
    assert.equal(t.gezien[type], 0);
    assert.equal(t.doorgelaten[type], 0);
    for (const r of REDENEN) assert.equal(t.genegeerd[type][r], 0);
  }
  assert.deepEqual(plat(t.ack_codes), {});
  assert.equal(t.laatste_genegeerd, null);
});

test('gezien telt alles, ook wat straks afvalt', () => {
  const t = maakTellers();
  t.zag('message_create'); t.zag('message_create'); t.zag('message');
  t.negeer('message_create', 'niet_op_leadlijst');
  const s = t.status();
  assert.equal(s.gezien.message_create, 2, 'allebei gezien');
  assert.equal(s.genegeerd.message_create.niet_op_leadlijst, 1);
  assert.equal(s.gezien.message, 1);
});

test('het verschil tussen gezien en doorgelaten is precies wat afviel', () => {
  // Dat is de hele diagnose in één regel: gezien 3, door 1, genegeerd 2 — en
  // waarom die twee afvielen staat ernaast.
  const t = maakTellers();
  for (let i = 0; i < 3; i++) t.zag('message_create');
  t.liet('message_create');
  t.negeer('message_create', 'niet_van_ons');
  t.negeer('message_create', 'groep');
  const s = t.status();
  const genegeerd = Object.values(s.genegeerd.message_create).reduce((a, b) => a + b, 0);
  assert.equal(s.gezien.message_create - s.doorgelaten.message_create, genegeerd);
});

test('ack-codes worden als getal geteld', () => {
  const t = maakTellers();
  t.ack(0); t.ack(0); t.ack(1); t.ack(3);
  assert.deepEqual(plat(t.status().ack_codes), { 0: 2, 1: 1, 3: 1 });
});

test('alleen nullen bij de acks is zelf een antwoord', () => {
  // Zien we uitsluitend 0 en -1, dan heeft WhatsApp nog niets bevestigd en
  // hoeft niemand een bericht te openen om dat vast te stellen.
  const t = maakTellers();
  t.ack(-1); t.ack(0);
  assert.deepEqual(Object.keys(plat(t.status().ack_codes)).sort(), ['-1', '0']);
});

test('de laatste genegeerde draagt type, reden, vorm en tijd — verder niets', () => {
  // `vorm` is erbij gekomen toen bleek dat het filter op de verkeerde soort
  // identiteit stond te kijken. Het is een domein en een lengte, geen jid.
  const t = maakTellers({ nu: () => '2026-09-06T17:38:57.000Z' });
  t.negeer('message_create', 'niet_op_leadlijst', '123456789012345@lid');
  const l = t.status().laatste_genegeerd;
  assert.deepEqual(plat(l), {
    type: 'message_create', reden: 'niet_op_leadlijst',
    vorm: 'lid/15', tijd: '2026-09-06T17:38:57.000Z',
  });
});

test('onbekende types en redenen worden genegeerd in plaats van aangemaakt', () => {
  // Anders groeit deze structuur met wat een aanroeper toevallig doorgeeft, en
  // dan is er een dag waarop daar een nummer in staat.
  const t = maakTellers();
  t.zag('iets_anders');
  t.negeer('message', 'omdat het nummer 32470111222 is');
  t.negeer('verzonnen_type', 'groep');
  const s = t.status();
  assert.equal('iets_anders' in s.gezien, false);
  assert.equal('verzonnen_type' in s.genegeerd, false);
  for (const r of Object.keys(s.genegeerd.message)) assert.ok(REDENEN.includes(r));
});

test('de redenen zijn een vaste lijst zonder vrije tekst', () => {
  // 'systeemtype' is er in september bijgekomen: WhatsApp stuurt over dezelfde
  // stroom ook dingen die geen bericht zijn (e2e_notification en verwanten).
  // Zie tests/whatsapp-systeemtypes.test.js.
  assert.deepEqual([...REDENEN].sort(),
    ['geen_ack_soort', 'groep', 'niet_op_leadlijst', 'niet_van_ons', 'onbruikbaar', 'systeemtype']);
});

test('rommel in ack() maakt geen sleutel aan', () => {
  const t = maakTellers();
  t.ack('geen getal'); t.ack(null); t.ack(undefined); t.ack(NaN);
  assert.deepEqual(plat(t.status().ack_codes), {});
});

test('de status is een kopie, geen venster op de binnenkant', () => {
  const t = maakTellers();
  const s = t.status();
  s.gezien.message = 999;
  assert.equal(t.status().gezien.message, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// GEEN ENKEL GEGEVEN LEKT MEE
// ═══════════════════════════════════════════════════════════════════════════

test('de status bevat uitsluitend getallen en woorden uit de vaste lijsten', () => {
  const t = maakTellers();
  t.zag('message'); t.liet('message'); t.negeer('message_ack', 'geen_ack_soort'); t.ack(2);
  const s = t.status();

  const loop = (waarde, pad) => {
    if (waarde === null) return;
    if (typeof waarde === 'number') return;
    if (typeof waarde === 'string') {
      const vormPatroon = /^(c\.us|lid|g\.us|s\.whatsapp\.net|broadcast|anders|geen_domein)\/\d+$|^geen$/;
      assert.ok(EVENT_TYPES.includes(waarde) || REDENEN.includes(waarde) ||
        OPLOS_WEGEN.includes(waarde) || vormPatroon.test(waarde) ||
        /^\d{4}-\d{2}-\d{2}T/.test(waarde),
        'onverwachte tekst op ' + pad + ': ' + waarde);
      return;
    }
    assert.equal(typeof waarde, 'object', pad);
    for (const [k, v] of Object.entries(waarde)) loop(v, pad + '.' + k);
  };
  loop(s, 'status');
});

test('de brug logt bij een genegeerde gebeurtenis alleen type, reden en vorm', () => {
  // De vorm mag mee omdat hij niets identificeert — 'lid/15' is een domein en
  // een lengte. De jid zelf mag NIET, en dat is hier het verschil dat telt.
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('function negeer(');
  assert.ok(i > 0, 'de helper hoort te bestaan');
  const blok = bron.slice(i, i + 700);
  assert.match(blok, /console\.debug\('\[brug\] genegeerd:', type, reden, jidVorm\(jid\)\)/,
    'precies deze drie; de jid gaat er door jidVorm() heen en niet rauw in');
  const logs = blok.match(/console\.\w+\([^)]*\)/g) || [];
  for (const l of logs) {
    assert.doesNotMatch(l, /, *jid *[,)]/, 'de rauwe jid hoort nooit in een log: ' + l);
    assert.doesNotMatch(l, /msg|tekst|bericht_id/, 'niets van het bericht: ' + l);
  }
});

test('de debug-regel staat standaard uit', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('function negeer(');
  assert.match(bron.slice(i, i + 500), /BRUG_DEBUG === '1'/,
    'op een drukke dag is dit ruis; standaard uit');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE DRIE HANDLERS TELLEN, EN HET FILTER BLIJFT VOOROP
// ═══════════════════════════════════════════════════════════════════════════

test('elke handler telt wat hij ziet', () => {
  const bron = readFileSync(WA, 'utf8');
  for (const type of EVENT_TYPES) {
    const i = bron.indexOf("client.on('" + type + "'");
    assert.ok(i > 0, 'handler ' + type + ' hoort te bestaan');
    assert.match(bron.slice(i, i + 300), new RegExp("tellers\\.zag\\('" + type + "'\\)"),
      type + ' hoort te tellen wat binnenkomt');
  }
});

test('elke afvalregel heeft een eigen reden', () => {
  const bron = readFileSync(WA, 'utf8');
  const blok = (type) => {
    const i = bron.indexOf("client.on('" + type + "'");
    return bron.slice(i, i + 2000);
  };
  // De derde parameter is de jid, die alleen als vorm bewaard wordt.
  const negeerMet = (type, reden) =>
    new RegExp("negeer\\('" + type + "', '" + reden + "'(, [^)]+)?\\)");
  assert.match(blok('message_create'), negeerMet('message_create', 'niet_van_ons'));
  assert.match(blok('message_create'), negeerMet('message_create', 'niet_op_leadlijst'));
  assert.match(blok('message_create'), negeerMet('message_create', 'groep'));
  assert.match(blok('message_create'), negeerMet('message_create', 'onbruikbaar'));
  assert.match(blok('message_ack'), negeerMet('message_ack', 'geen_ack_soort'));
  assert.match(blok('message'), negeerMet('message', 'niet_op_leadlijst'));
});

test('de fromMe-check staat vóór het filter, en het filter vóór elk gebruik', () => {
  // Die volgorde is bewust. message_create vuurt óók voor binnengekomen
  // berichten, en daar is `to` óns eigen nummer; zonder de fromMe-check eerst
  // zouden die allemaal als 'niet_op_leadlijst' geteld worden en het beeld
  // vertroebelen precies waar we naar kijken. De check leest één boolean van de
  // envelop — geen nummer, geen tekst — en er wordt niets van bewaard.
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf("client.on('message_create'");
  const blok = bron.slice(i, i + 2000);
  const fromMe = blok.indexOf('msg?.fromMe !== true');
  const filter = blok.indexOf('leadlijst.mag(');
  const bouw   = blok.indexOf('bouwUitgaandeGebeurtenis(');
  assert.ok(fromMe > 0 && filter > 0 && bouw > 0);
  assert.ok(fromMe < filter, 'eerst de boolean, dan het filter');
  assert.ok(filter < bouw, 'en het filter nog altijd vóór er iets gebouwd wordt');
});

test('de tellers komen mee in /status', () => {
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/server.js'), 'utf8');
  assert.match(bron, /gebeurtenissen\s*:\s*wa\.tellers\(\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VORM VAN DE IDENTITEIT — DIT BESLIST DE DIAGNOSE
// ═══════════════════════════════════════════════════════════════════════════

test('jidVorm geeft domein en lengte, nooit de cijfers', () => {
  assert.equal(jidVorm('32456816410@c.us'), 'c.us/11');
  assert.equal(jidVorm('123456789012345@lid'), 'lid/15');
  assert.equal(jidVorm('120363000000@g.us'), 'g.us/12');
  assert.equal(jidVorm('32470111222@s.whatsapp.net'), 's.whatsapp.net/11');
});

test('de cijfers zelf komen er nooit in voor', () => {
  // Dit is het hele punt: een lengte is een lengte. Zodra hier een nummer in
  // zou staan is dit een logbestand met leadgegevens geworden.
  const v = jidVorm('32456816410@c.us');
  assert.doesNotMatch(v, /32456816410/);
  assert.equal(v.split('/')[1], '11', 'alleen de lengte');
});

test('onbekende en rare vormen krijgen een vast woord', () => {
  assert.equal(jidVorm('iets@raarding'), 'anders/0');
  assert.equal(jidVorm('geenapenstaart'), 'geen_domein/0');
  assert.equal(jidVorm(''), 'geen');
  assert.equal(jidVorm(null), 'geen');
  assert.equal(jidVorm(undefined), 'geen');
  assert.equal(jidVorm(42), 'geen');
});

test('negeer bewaart de vorm, niet de jid', () => {
  const t = maakTellers();
  t.negeer('message_create', 'niet_op_leadlijst', '123456789012345@lid');
  const s = t.status();
  assert.deepEqual(plat(s.vormen), { 'lid/15': 1 });
  assert.equal(s.laatste_genegeerd.vorm, 'lid/15');
  assert.equal(JSON.stringify(s).includes('123456789012345'), false, 'de jid hoort nergens te staan');
});

test('zonder jid blijft de vorm-teller leeg', () => {
  // Oudere aanroepen geven geen jid mee; die horen geen lege sleutel aan te
  // maken die als meting leest.
  const t = maakTellers();
  t.negeer('message', 'niet_op_leadlijst');
  assert.deepEqual(plat(t.status().vormen), {});
  assert.equal(t.status().laatste_genegeerd.vorm, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// HOE DE IDENTITEIT IS OPGELOST
// ═══════════════════════════════════════════════════════════════════════════

test('de oploswegen zijn een vaste lijst', () => {
  // 'lidkaart' is erbij gekomen: de weg via de leadlijst, die als enige een LID
  // écht naar een telefoonnummer vertaalt.
  //
  // 7 september, twee erbij, en allebei om dezelfde reden:
  //   lidkaart_basis — de kaart raakte pas na het afsnijden van het
  //                    apparaat-achtervoegsel. Apart van 'lidkaart', want dat
  //                    getal IS de meting die het vermoeden staaft of onderuit
  //                    haalt.
  //   onbruikbaar    — er kwam een antwoord, maar het was geen telefoonnummer.
  //                    Dat stond eerder als opgelost.contact geboekt: succes
  //                    dus, terwijl er niets vertaald was.
  //
  // Deze test hoort rood te worden bij elke uitbreiding — dat is zijn functie.
  assert.deepEqual([...OPLOS_WEGEN].sort(),
    ['contact', 'contact_zonder_nummer', 'geen_jid', 'jid', 'lidkaart',
     'lidkaart_basis', 'mislukt', 'onbruikbaar']);
});

test('elke weg wordt apart geteld', () => {
  const t = maakTellers();
  t.oplossing('jid'); t.oplossing('jid'); t.oplossing('contact'); t.oplossing('mislukt');
  const o = t.status().opgelost;
  assert.equal(o.jid, 2);
  assert.equal(o.contact, 1);
  assert.equal(o.mislukt, 1);
  assert.equal(o.geen_jid, 0);
});

test('een verzonnen weg maakt geen sleutel aan', () => {
  const t = maakTellers();
  t.oplossing('via het nummer 32470111222');
  assert.deepEqual(Object.keys(plat(t.status().opgelost)).sort(), [...OPLOS_WEGEN].sort());
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BRUG LOST OP VÓÓR HET FILTERT
// ═══════════════════════════════════════════════════════════════════════════

test('elke handler bepaalt het nummer vóór hij filtert', () => {
  // Je kunt niet filteren op een nummer dat je niet kent. Stond het filter
  // ervóór, dan filtert het op de cijfers van een LID en valt alles weg — dat
  // was precies de bug.
  const bron = readFileSync(WA, 'utf8');
  for (const type of EVENT_TYPES) {
    const i = bron.indexOf("client.on('" + type + "'");
    const blok = bron.slice(i, i + 2000);
    const bepaal = blok.indexOf('bepaalNummer(');
    const filter = blok.indexOf('leadlijst.mag(');
    assert.ok(bepaal > 0, type + ' hoort de identiteit op te lossen');
    assert.ok(filter > 0, type + ' hoort te filteren');
    assert.ok(bepaal < filter, type + ': oplossen hoort vóór filteren');
  }
});

test('het filter staat nog altijd vóór elk gebruik van tekst', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf("client.on('message'");
  // Gemeten, niet geraden: msg.body staat op +1556 sinds de systeemtype-controle
  // ertussen kwam. Een te klein venster laat deze test slagen op een leeg
  // resultaat, en dat is geen bewaking.
  const blok = bron.slice(i, i + 2200);
  assert.ok(blok.indexOf('msg.body') > 0, 'het venster hoort de tekst te bereiken');
  assert.ok(blok.indexOf('leadlijst.mag(') < blok.indexOf('msg.body'),
    'de tekst hoort pas aangeraakt te worden nadat het filter door is');
});

test('een mislukte oplossing geeft geen LID door aan het filter', () => {
  // DEZE TEST STOND OMGEKEERD, EN DAT WAS DE TWEEDE DEUR NAAR DEZELFDE FOUT.
  //
  // Hij eiste `return normaliseerNummer(jid)` met als redenering: dan is het
  // gedrag precies dat van vóór de wijziging, dus een mislukking maakt het
  // nooit slechter. Die redenering klopte niet. Bij een LID-jid levert
  // normaliseerNummer de LID-cijfers op, en die gingen als 'telefoonnummer' de
  // leadlijst in. Daar werden ze terecht geweigerd met 'niet_op_leadlijst' — en
  // zo viel op 7 september al het WhatsApp-verkeer weg met een reden die klopte
  // terwijl de oorzaak ergens anders zat.
  //
  // 'Precies zoals het was' is geen kwaliteit als het was fout. Het nieuwe
  // contract: bij een mislukking geven we de jid alleen terug als die een
  // telefoonnummer KAN zijn; anders null, en dat is het eerlijke antwoord — we
  // weten niet wie dit is.
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('async function bepaalNummer');
  const blok = bron.slice(i, i + 3600);
  assert.match(blok, /catch \(e\)[\s\S]*oplossing\('mislukt'\)/);
  assert.match(blok, /beoordeelKandidaat\(kaal, jid\)/, 'de terugval hoort beoordeeld te worden');
  assert.match(blok, /return null;/, 'een onbruikbare jid hoort null op te leveren');
  assert.doesNotMatch(blok, /return normaliseerNummer\(jid\);/,
    'de kale terugval op de jid hoort weg te zijn — dat was de tweede deur');
});

test('het oplossen logt geen jid en geen tekst', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('async function bepaalNummer');
  const blok = bron.slice(i, i + 1200);
  const logs = blok.match(/console\.\w+\([^)]*\)/g) || [];
  for (const l of logs) {
    assert.doesNotMatch(l, /jid|nummer|contact\?|msg/, 'log zonder identiteit: ' + l);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN LID-CHAT WERKT OOK BIJ VERSTUREN EN OPHALEN
// ═══════════════════════════════════════════════════════════════════════════

test('versturen gebruikt de chat waar het gesprek echt onder staat', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('async stuur(');
  const blok = bron.slice(i, i + 900);
  assert.match(blok, /chatIdVoor\(nummer\)/,
    'anders gaat een LID-gesprek naar <nummer>@c.us en komt het in de verkeerde draad');
});

test('historiek probeert de LID-vorm en daarna de gewone vorm', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('async historiek(');
  const blok = bron.slice(i, i + 3400);
  // Drie vormen, in volgorde van betrouwbaarheid: de jid die WhatsApp zelf gaf,
  // wat we bij een echt bericht zagen, en de gewone @c.us-vorm. Die laatste
  // blijft nodig voor de leads zonder LID.
  assert.match(blok, /const vormen = \[viaKaart, viaBericht, gewoon\]\.filter\(Boolean\)/);
  const volgorde = ['const viaKaart', 'const viaBericht', 'const gewoon'].map((k) => blok.indexOf(k));
  assert.ok(volgorde.every((n) => n > 0), 'alle drie horen erin te staan');
  assert.deepEqual(volgorde, [...volgorde].sort((a, b) => a - b), 'en in die volgorde');
});

test('de nummerkaart geeft alleen zijn omvang prijs', () => {
  const wa = readFileSync(WA, 'utf8');
  assert.match(wa, /nummerkaartAantal: \(\) => nummerkaart\.size/);
  const server = readFileSync(join(ROOT, 'services/whatsapp-brug/server.js'), 'utf8');
  assert.match(server, /nummerkaart\s*:\s*wa\.nummerkaartAantal\(\)/);
  assert.doesNotMatch(server, /nummerkaart\.entries|\[\.\.\.nummerkaart\]/,
    'de kaart zelf blijft binnen');
});
