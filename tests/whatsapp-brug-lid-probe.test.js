// tests/whatsapp-brug-lid-probe.test.js
//
// De vorige ronde bouwde op Store.LidUtils.getCurrentLid en leverde 0 van 28
// op, zónder fout. Dat is de slechtst mogelijke uitkomst: je weet niet of de
// functie ontbrak of niets teruggaf, en dus weet je ook niet wat je nu moet
// proberen. Twee ronden zijn daaraan opgegaan.
//
// Wat dit toevoegt is niet nog een gok maar het gereedschap dat ontbrak:
//
//   1. De FUNCTIENAMEN die deze versie aanbiedt, opgesomd en gelogd. Namen uit
//      een library zijn geen gegevens van iemand, dus die mogen gewoon in beeld.
//      Staat 'getCurrentLid' er niet bij, dan is de vraag beantwoord.
//   2. Een probe die álle varianten voor één nummer draait en per stuk zegt wat
//      eruit kwam — als vorm, nooit als waarde.
//   3. Een tweede weg die niet van die ene functie afhangt: de koppeling uit de
//      contactenlijst halen.
//
// Bij die derde is de grens scherper dan elders, en dat is geen formaliteit: de
// contactenlijst van dat toestel bevat álle contacten, dus ook Daves
// privécontacten. Vandaar dat het filteren BINNEN de pagina gebeurt — de
// toegestane nummers gaan erin, en er komen alleen paren uit die daarop staan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WA = join(ROOT, 'services/whatsapp-brug/lib/whatsapp.js');
const SERVER = join(ROOT, 'services/whatsapp-brug/server.js');
const bron = () => readFileSync(WA, 'utf8');

/** Het blok van één functie, ruim genomen. */
function blokVan(naam, lengte = 2600) {
  const b = bron();
  const i = b.indexOf(naam);
  assert.ok(i > 0, naam + ' hoort te bestaan');
  return b.slice(i, i + lengte);
}

// ═══════════════════════════════════════════════════════════════════════════
// DE FUNCTIENAMEN, IN PLAATS VAN ONZE AANNAME EROVER
// ═══════════════════════════════════════════════════════════════════════════

test('de brug somt op wat LidUtils aanbiedt', () => {
  const blok = blokVan('async function tastKundeAf');
  assert.match(blok, /lidutils_keys/);
  assert.match(blok, /typeof o\[k\] === 'function'/, 'de functienamen, niet de waarden');
});

test('en welke Store-onderdelen er zijn', () => {
  const blok = blokVan('async function tastKundeAf');
  for (const m of ['LidUtils', 'ContactMethods', 'WidFactory', 'Contact', 'Chat']) {
    assert.ok(blok.includes(m), m + ' hoort in de probe te zitten');
  }
});

test('het aftasten gebeurt bij verbinden, niet pas bij de eerste poging', () => {
  // Dit was het echte gemis: lid_kunde stond in /status maar werd pas gevuld
  // tijdens de kaartopbouw. Wie ernaar keek vóór die ronde zag niets, en dat is
  // precies het gegeven dat had moeten vertellen of de functie bestond.
  const b = bron();
  const i = b.indexOf("client.on('ready'");
  const blok = b.slice(i, i + 1400);
  assert.match(blok, /tastKundeAf\(\)/);
  assert.ok(blok.indexOf('tastKundeAf()') < blok.indexOf('bouwLidkaart()'),
    'eerst weten wat er kan, dan pas proberen');
});

test('de functienamen mogen in het log — dat zijn geen gegevens van iemand', () => {
  const blok = blokVan('async function tastKundeAf');
  assert.match(blok, /console\.log\('\[brug\] LidUtils biedt:'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE PROBE ZEGT VORMEN, GEEN WAARDEN
// ═══════════════════════════════════════════════════════════════════════════

test('de probe draait meerdere varianten, niet één', () => {
  const blok = blokVan('async function probeerLid', 3600);
  for (const v of ['getCurrentLid(wid)', 'getCurrentLid(string)', 'Contact.get(wid).id',
                   'Contact.get(wid).lid', 'Chat.get(wid).id', 'ContactMethods.getUserid']) {
    assert.ok(blok.includes(v), 'variant ontbreekt: ' + v);
  }
});

test('de wid-variant én de kale string worden allebei geprobeerd', () => {
  // De voor de hand liggende variant — createWid en het object doorgeven — was
  // al wat er draaide. Nu staan ze er allebei, zodat de probe uitwijst welke
  // van de twee iets oplevert in plaats van dat wij dat aannemen.
  const blok = blokVan('async function zoekLidVoor', 2400);
  assert.match(blok, /createWid\(id\)/);
  assert.match(blok, /getCurrentLid\(id\)/, 'ook de kale string');
});

test('de probe geeft alleen een domein en een lengte terug', () => {
  const blok = blokVan('async function probeerLid', 3600);
  assert.match(blok, /const vorm = \(v\)/);
  assert.match(blok, /\.length/, 'de lengte, niet de waarde');
  assert.doesNotMatch(blok, /return \{ naam, uit: fn\(\) \}/, 'nooit de rauwe uitkomst');
});

test('de probe geeft veldNAMEN terug, geen veldwaarden', () => {
  const blok = blokVan('async function probeerLid', 3600);
  assert.match(blok, /veldnamen\.push\(k\)/, 'de sleutel, niet c\\[k\\]');
  assert.doesNotMatch(blok, /veldnamen\.push\(c\[k\]\)/);
});

test('de probe weigert een nummer dat niet op de leadlijst staat', () => {
  // Anders wordt dit een manier om over een willekeurig nummer iets te weten te
  // komen, en dat is exact wat het filter moet voorkomen.
  const blok = blokVan('async function probeerLid', 900);
  assert.match(blok, /leadlijst\.mag\(n\)/);
  assert.match(blok, /NIET_TOEGESTAAN/);
  assert.ok(blok.indexOf('leadlijst.mag(n)') < blok.indexOf('pupPage.evaluate'),
    'weigeren vóór er iets opgevraagd wordt');
});

test('de probe-route weigert stil, zonder te verklappen waarom', () => {
  const s = readFileSync(SERVER, 'utf8');
  const i = s.indexOf("app.get('/lid/probe'");
  assert.ok(i > 0, 'de route hoort te bestaan');
  const blok = s.slice(i, i + 900);
  assert.match(blok, /NIET_TOEGESTAAN[\s\S]*403[\s\S]*Niet toegestaan/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TWEEDE WEG, EN WAAR DAAR DE GRENS LIGT
// ═══════════════════════════════════════════════════════════════════════════

test('de contactscan filtert BINNEN de pagina op de leadlijst', () => {
  // Dit is het hele punt. De contactenlijst bevat alle contacten van dat
  // toestel. Zou het filteren buiten de pagina gebeuren, dan verlaten Daves
  // privécontacten de browser — ook al gooien we ze daarna weg.
  const blok = blokVan('async function zoekLidsUitContacten', 3000);
  const set = blok.indexOf('new Set(toegestaan)');
  const push = blok.indexOf('paren.push');
  const check = blok.indexOf('toestaan.has(telefoon)');
  assert.ok(set > 0 && push > 0 && check > 0);
  assert.ok(check < push, 'eerst de leadlijst-check, dan pas in de lijst');
});

test('de scan geeft alleen totalen terug, geen namen', () => {
  const blok = blokVan('async function zoekLidsUitContacten', 3000);
  assert.match(blok, /return \{ paren, bekeken, met_lid: metLid \}/);
  assert.doesNotMatch(blok, /c\?\.name|pushname|formattedName/,
    'namen van contacten hebben hier niets te zoeken');
});

test('de scan draait alleen als de eerste weg niets opleverde', () => {
  // Anders lopen we elke vijf minuten door de hele contactenlijst voor niets.
  const blok = blokVan('async function bouwLidkaart', 2200);
  assert.match(blok, /if \(uit\.gevonden === 0\)/);
  assert.ok(blok.indexOf('lidkaart.bouw(nummers, zoekLidVoor)') < blok.indexOf('zoekLidsUitContacten'),
    'de directe weg eerst');
});

test('de brug meldt via welke weg de koppelingen kwamen', () => {
  // Zonder dat weet je na de volgende test weer niet of het langs de kaart of
  // langs de contactoplossing ging — precies de onduidelijkheid die dit hele
  // spoor gekost heeft.
  const blok = blokVan('async function bouwLidkaart', 2200);
  assert.match(blok, /kaartBron = 'contactenlijst'/);
  assert.match(blok, /kaartBron = uit\.gevonden > 0 \? 'getCurrentLid' : null/);
  const s = readFileSync(SERVER, 'utf8');
  assert.match(s, /lid_bron\s*:\s*wa\.lidBron\(\)/);
});

test('het opbouw-log noemt aantallen en een weg, geen identiteiten', () => {
  const blok = blokVan('async function bouwLidkaart', 2200);
  const logs = blok.match(/console\.\w+\([^)]*\)/g) || [];
  assert.ok(logs.length >= 2);
  for (const l of logs) {
    const zonderTekst = l.replace(/'[^']*'/g, "''");
    assert.doesNotMatch(zonderTekst, /\bparen\[|\bnummers\[|\blid\b/,
      'geen identiteit in het log: ' + l);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HET CRM LAAT HET ZIEN
// ═══════════════════════════════════════════════════════════════════════════

test('status draagt de kunde en de bron door naar het CRM', () => {
  const s = readFileSync(SERVER, 'utf8');
  assert.match(s, /lid_kunde\s*:\s*wa\.lidKunde\(\)/);
  assert.match(s, /lid_bron\s*:\s*wa\.lidBron\(\)/);
  // Het CRM-endpoint geeft het antwoord ongewijzigd door; daar hoeft niets
  // toegevoegd te worden.
  const proxy = readFileSync(join(ROOT, 'api/opvolging-whatsapp-status.js'), 'utf8');
  assert.match(proxy, /return res\.status\(200\)\.json\(data\)/);
});

test('het paneel toont de functienamen, ook als er geen enkele is', () => {
  const view = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
  assert.match(view, /LidUtils biedt/);
  assert.match(view, /geen enkele functie/,
    'juist dát geval is het antwoord waar we naar zoeken');
  assert.match(view, /Koppelingen gevonden via/);
});
