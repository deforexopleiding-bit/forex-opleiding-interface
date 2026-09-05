// tests/whatsapp-brug-lidkaart.test.js
//
// De vertaling tussen een telefoonnummer en de LID waaronder WhatsApp hetzelfde
// gesprek aanlevert.
//
// WAT DE METING OPLEVERDE. De tellers zeiden: vormen lid/15 drie keer, opgelost
// via contact drie keer, en tóch drie keer niet_op_leadlijst. Succes gemeld,
// niets vertaald — want wat een LID-contact teruggeeft is opnieuw het LID.
//
// In de bron van whatsapp-web.js 1.26.0 staat waarom: Store.LidUtils biedt
// getCurrentLid(wid), en dat is nummer → LID. Een omgekeerde vertaling bestaat
// er niet. De richting waarin we het probeerden bestaat dus simpelweg niet.
//
// Vandaar deze kaart, opgebouwd uit de leadlijst. Twee winstpunten die het niet
// alleen mogelijk maar ook béter maken:
//
//   · Het werkt. Nummer → LID is de richting die WhatsApp wél biedt, en de
//     omgekeerde tabel maken we dan zelf.
//   · Het is strenger. De oude weg vroeg 'wie is dit?' over elke binnenkomende
//     jid, óók over mensen die geen lead zijn. Deze weg vraagt alleen naar
//     nummers die al op de lijst staan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { maakLidkaart } from '../services/whatsapp-brug/lib/lidkaart.js';
import { maakTellers } from '../services/whatsapp-brug/lib/tellers.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WA = join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js');
const plat = (o) => JSON.parse(JSON.stringify(o));

// Het echte geval: nummer van 11 cijfers, LID van 15.
const NUMMER = '32456816410';
const LID    = '123456789012345';

// ═══════════════════════════════════════════════════════════════════════════
// DE KAART VERTAALT BEIDE KANTEN OP
// ═══════════════════════════════════════════════════════════════════════════

test('een opgebouwde kaart vindt het nummer achter een LID', () => {
  const k = maakLidkaart();
  return k.bouw([NUMMER], async () => LID + '@lid').then(() => {
    assert.equal(k.nummerVoorLid(LID), NUMMER, 'dit is wat het filter nodig heeft');
    assert.equal(k.lidVoorNummer(NUMMER), LID, 'en dit wat versturen nodig heeft');
  });
});

test('een lege kaart geeft netjes niets in plaats van te gokken', () => {
  const k = maakLidkaart();
  assert.equal(k.nummerVoorLid(LID), null);
  assert.equal(k.lidVoorNummer(NUMMER), null);
  assert.equal(k.nummerVoorLid(null), null);
  assert.equal(k.lidVoorNummer(undefined), null);
});

test('het apenstaart-deel wordt afgestript, zodat beide notaties werken', async () => {
  const k = maakLidkaart();
  await k.bouw([NUMMER], async () => LID + '@lid');
  assert.equal(k.nummerVoorLid(LID), NUMMER);
});

test('een nummer waar WhatsApp niets over weet levert geen koppeling op', async () => {
  const k = maakLidkaart();
  const uit = await k.bouw(['32470111222'], async () => null);
  assert.equal(uit.gevonden, 0);
  assert.equal(k.lidVoorNummer('32470111222'), null, 'geen halve koppeling');
});

test('één nummer dat faalt laat de rest van de lijst niet liggen', async () => {
  const k = maakLidkaart();
  const uit = await k.bouw(['1', '2', '3'], async (n) => {
    if (n === '2') throw new Error('stuk');
    return n + '00@lid';
  });
  assert.equal(uit.gevonden, 2);
  assert.equal(uit.fouten, 1);
  assert.equal(k.lidVoorNummer('3'), '300');
});

test('een volledig mislukte ronde laat de vorige kaart staan', async () => {
  // Dezelfde regel als bij de leadlijst zelf: een storing hoort geen leads te
  // laten wegvallen. Zou de kaart leeggemaakt worden, dan valt elk LID-gesprek
  // stil buiten het filter tot de volgende ronde.
  const k = maakLidkaart();
  await k.bouw([NUMMER], async () => LID + '@lid');
  const uit = await k.bouw([NUMMER], async () => { throw new Error('verbinding weg'); });
  assert.equal(uit.behouden, true);
  assert.equal(k.nummerVoorLid(LID), NUMMER, 'de oude koppeling staat er nog');
});

test('een geslaagde ronde vervangt de kaart in plaats van hem aan te vullen', async () => {
  // Een lead die van de lijst gaat hoort ook uit de kaart te verdwijnen.
  const k = maakLidkaart();
  await k.bouw(['1', '2'], async (n) => n + '00@lid');
  await k.bouw(['1'], async (n) => n + '00@lid');
  assert.equal(k.lidVoorNummer('1'), '100');
  assert.equal(k.lidVoorNummer('2'), null, 'weg van de lijst is weg uit de kaart');
});

test('zonder zoekfunctie gebeurt er niets', async () => {
  const k = maakLidkaart();
  const uit = await k.bouw([NUMMER], null);
  assert.equal(uit.gevonden, 0);
});

test('de status geeft alleen aantallen prijs', async () => {
  const k = maakLidkaart();
  await k.bouw([NUMMER], async () => LID + '@lid');
  const s = plat(k.status());
  assert.deepEqual(Object.keys(s).sort(), ['koppelingen', 'laatste_fout', 'laatste_opbouw']);
  assert.equal(s.koppelingen, 1);
  assert.equal(JSON.stringify(s).includes(NUMMER), false, 'geen nummer in de status');
  assert.equal(JSON.stringify(s).includes(LID), false, 'en geen LID');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TELLER DIE HET BEWIJST
// ═══════════════════════════════════════════════════════════════════════════

test('opgelost_vorm laat zien dat er een LID uit kwam in plaats van een nummer', () => {
  // Dit is de teller die het verschil maakt tussen 'de oplossing werkte' en
  // 'de teller zei succes terwijl er niets vertaald is'.
  const t = maakTellers();
  t.oplossing('contact', LID);          // 15 cijfers: opnieuw een LID
  t.oplossing('lidkaart', NUMMER);      // 11 cijfers: een telefoonnummer
  const s = plat(t.status());
  assert.deepEqual(s.opgelost_vorm, { 'contact/15': 1, 'lidkaart/11': 1 });
});

test('het nummer zelf komt nooit in de teller terecht', () => {
  const t = maakTellers();
  t.oplossing('contact', NUMMER);
  const s = JSON.stringify(t.status());
  assert.equal(s.includes(NUMMER), false);
  assert.match(s, /contact\/11/);
});

test('zonder nummer wordt er geen lengte bijgehouden', () => {
  const t = maakTellers();
  t.oplossing('mislukt');
  assert.deepEqual(plat(t.status().opgelost_vorm), {});
  assert.equal(t.status().opgelost.mislukt, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BRUG GEBRUIKT DE KAART, EN OP DE JUISTE VOLGORDE
// ═══════════════════════════════════════════════════════════════════════════

test('bepaalNummer probeert de kaart vóór de contactoplossing', () => {
  // De kaart is de weg die wérkt en die niets opvraagt over niet-leads. De
  // contactoplossing blijft als terugval, maar niet als eerste keuze.
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('async function bepaalNummer');
  const blok = bron.slice(i, i + 2200);
  const kaart = blok.indexOf('lidkaart.nummerVoorLid(');
  const contact = blok.indexOf('client.getContactById(');
  assert.ok(kaart > 0 && contact > 0);
  assert.ok(kaart < contact, 'de kaart eerst, het opvragen als terugval');
});

test('de kaart wordt uit de leadlijst opgebouwd, niet uit binnenkomend verkeer', () => {
  // Het privacy-argument: we vragen alleen naar nummers die we al mogen kennen.
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('async function bouwLidkaart');
  const blok = bron.slice(i, i + 2200);
  assert.match(blok, /leadlijst\.nummers\(\)/);
  assert.match(blok, /koppelingenUitApi\(nummers\)/);
});

test('het opbouw-log noemt aantallen en wegnamen, geen identiteiten', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('async function bouwLidkaart');
  const blok = bron.slice(i, i + 2200);
  const logs = blok.match(/console\.\w+\([^)]*\)/g) || [];
  assert.ok(logs.length >= 2, 'er hoort iets gelogd te worden');
  for (const l of logs) {
    const zonderTekst = l.replace(/'[^']*'/g, "''");
    assert.doesNotMatch(zonderTekst, /\bparen\[|\bnummers\[|\blid\b/, 'geen identiteit: ' + l);
  }
});

test('versturen en historiek kennen de LID-vorm', () => {
  const bron = readFileSync(WA, 'utf8');
  const i = bron.indexOf('function chatIdVoor');
  assert.match(bron.slice(i, i + 700), /lidkaart\.lidVoorNummer\(n\)/,
    'anders gaat een antwoord op een LID-gesprek naar de verkeerde draad');
  const h = bron.indexOf('async historiek(');
  assert.match(bron.slice(h, h + 1400), /lidkaart\.lidVoorNummer\(/,
    'en dan vindt het ophalen het gesprek niet');
});

test('de brug tast af welke bibliotheek er draait, in plaats van het aan te nemen', () => {
  // Drie ronden lang zijn alle metingen tegen de bron van 1.26.0 gedaan zonder
  // te weten of dát draait. package.json zegt ^1.26.0, dus npm kan elke 1.x
  // geinstalleerd hebben, en de interne opbouw verschilt daar sterk tussen.
  const bron = readFileSync(WA, 'utf8');
  assert.match(bron, /async function tastKundeAf/);
  assert.match(bron, /whatsapp-web\.js\/package\.json/, 'de versie uit haar eigen package.json');
  assert.match(bron, /kunde\.api\[naam\] = typeof client\[naam\] === 'function'/,
    'en welke publieke methodes er echt zijn');
  const server = readFileSync(join(ROOT, 'services/whatsapp-brug/server.js'), 'utf8');
  assert.match(server, /lid_kunde\s*:\s*wa\.lidKunde\(\)/);
});

test('de LID-kaart komt als aantallen in /status, niet als koppelingen', () => {
  const server = readFileSync(join(ROOT, 'services/whatsapp-brug/server.js'), 'utf8');
  assert.match(server, /lidkaart\s*:\s*wa\.lidkaartStatus\(\)/);
  assert.doesNotMatch(server, /nummerVoorLid|lidVoorNummer/,
    'de vertaaltabel zelf blijft binnen de service');
});

test('de kaart loopt mee met de leadlijst en stopt bij stop()', () => {
  const bron = readFileSync(WA, 'utf8');
  assert.match(bron, /lidTimer = setInterval\(bouwLidkaart, cfg\.nummersIntervalMs\)/,
    'een nieuwe lead heeft ook een koppeling nodig');
  const i = bron.indexOf('async stop()');
  assert.match(bron.slice(i, i + 300), /clearInterval\(lidTimer\)/);
});
