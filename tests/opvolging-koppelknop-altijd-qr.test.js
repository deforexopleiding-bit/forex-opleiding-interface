// tests/opvolging-koppelknop-altijd-qr.test.js
//
// DE KOPPELKNOP MOET ALTIJD TOT EEN QR LEIDEN.
//
// Wat er op 23 september gebeurde: Maxim klikte op koppelen en kreeg een leeg
// wit venster. De brugserver leefde — de leadlijst werd om 18:04 nog opgehaald,
// 63 nummers, http 200 — maar de WhatsApp-client lag eruit: verbonden=false,
// nummer=null, wacht_op_qr=FALSE, alle tellers nul, laatste actie van 06:04,
// en laatste_fout leeg. Er was geen QR, en er was ook niets dat er een maakte.
//
// Het paneel had voor die toestand geen woord. Geen QR betekende in de oude
// code letterlijk 'QR wordt opgehaald…' met de vier scaninstructies eronder,
// en dat bleef staan terwijl er nooit een kwam. Een lege doos is geen toestand.
//
// Twee dingen worden hier bewaakt:
//
//  · brugToestand() geeft voor ELKE toestand een kop en een uitleg terug, en
//    voor elke toestand waarin een mens iets kan doen ook een knop.
//  · het paneel tekent die toestand ook echt, en toont de scaninstructies
//    ALLEEN bij een code die er werkelijk staat.
//
// De view is een browser-script en niet te importeren; net als in
// tests/opvolging-whatsapp-koppel.test.js draaien we het ECHTE bestand in een
// vm-sandbox. Een nagebouwde kopie zou meteen uit elkaar lopen met het scherm,
// en dat is precies het soort groen naast kapot waar dit bestand over gaat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BADGE_HELPER = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');

function laadView() {
  const window = {
    DFO   : { VIEWS: {}, render() {} },
    KV_V2 : { helpers: {} },
    KV    : { authedJson: async () => ({}) },
    addEventListener() {},
    setInterval() { return 0; },
    clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window,
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    console,
    queueMicrotask: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Date, Math, Number, String, JSON, Object, Promise, Error, Boolean, Array,
  });
  runInContext(readFileSync(BADGE_HELPER, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  const h = window.__opvWaHelpers;
  assert.ok(h, 'de view hoort __opvWaHelpers te zetten — is die weggehaald?');
  assert.ok(h.brugToestand, 'brugToestand hoort erbij te staan');
  assert.ok(h.waPaneelHtml, 'waPaneelHtml hoort erbij te staan');
  return { h, window };
}

const { h } = laadView();
const { brugToestand, waPaneelHtml, zetWa } = h;

/** De gemeten toestand van 23 september, letterlijk. */
const GEMETEN = {
  verbonden: false,
  nummer: null,
  wacht_op_qr: false,
  laatste_actie: '2026-09-23T06:04:00.000Z',
  laatste_fout: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ELKE TOESTAND HEEFT EEN WOORD
// ═══════════════════════════════════════════════════════════════════════════

test('de gemeten toestand van 23 september krijgt een kop, een uitleg en een knop', () => {
  // Dit is de regel die er niet was. Geen verbinding, geen QR, geen fout: de
  // oude code had hier niets en toonde 'QR wordt opgehaald…'.
  const t = brugToestand({ data: GEMETEN });
  assert.equal(t.staat, 'client_weg');
  assert.ok(t.kop, 'zonder kop is het venster leeg');
  assert.ok(t.uitleg, 'zonder uitleg weet niemand wat er aan de hand is');
  assert.equal(t.knop, 'opnieuw', 'en er moet een uitgang zijn');
  assert.match(t.kop, /06:04|uur geleden|dag/, 'sinds wanneer hoort erbij');
});

test('geen enkele toestand komt leeg terug', () => {
  // Dit is de eigenlijke afspraak: wat je er ook in stopt, er komt een zin uit.
  const gevallen = [
    { naam: 'niets',          in: {} },
    { naam: 'alleen laden',   in: { data: null } },
    { naam: 'onbereikbaar',   in: { error: 'De WhatsApp-brug is niet bereikbaar.' } },
    { naam: 'verbonden',      in: { data: { verbonden: true, nummer: '32470111222' } } },
    { naam: 'qr klaar',       in: { data: { verbonden: false }, qr: 'data:image/png;base64,xx' } },
    { naam: 'client weg',     in: { data: GEMETEN } },
    { naam: 'herverbindt',    in: { data: { ...GEMETEN, herverbinden: { bezig: true, poging: 3 } } } },
    { naam: 'opgegeven',      in: { data: { ...GEMETEN, herverbinden: { opgegeven: true, poging: 6, laatste_fout: 'geen antwoord binnen 90s' } } } },
    { naam: 'bezig',          in: { herkoppelBezig: true } },
    { naam: 'mislukt',        in: { herkoppelFout: 'sessie wissen faalde' } },
  ];
  for (const g of gevallen) {
    const t = brugToestand(g.in);
    assert.ok(t && t.staat, g.naam + ': geen staat');
    assert.ok(t.kop && t.kop.trim().length > 3, g.naam + ': geen kop — dat is de lege doos');
    assert.ok(['goed', 'fout', 'bezig', 'actie'].includes(t.ernst), g.naam + ': ernst onbekend');
  }
});

test('elke toestand waarin een mens iets kan doen heeft ook een knop', () => {
  // Zonder uitgang is een eerlijke melding nog steeds een doodlopende straat.
  for (const [naam, inv] of [
    ['client weg',   { data: GEMETEN }],
    ['opgegeven',    { data: { ...GEMETEN, herverbinden: { opgegeven: true, poging: 6 } } }],
    ['herverbindt',  { data: { ...GEMETEN, herverbinden: { bezig: true, poging: 2 } } }],
    ['mislukt',      { herkoppelFout: 'start mislukt' }],
  ]) {
    assert.ok(brugToestand(inv).knop, naam + ': geen knop, dus geen uitgang');
  }
});

test('een lopende herkoppeling gaat vóór alles, ook vóór een oude status', () => {
  // De status die ernaast opgehaald wordt loopt per definitie achter: die weet
  // nog van niets terwijl de client al afgebroken is.
  const t = brugToestand({ data: GEMETEN, herkoppelBezig: true });
  assert.equal(t.staat, 'herkoppelen');
  assert.equal(t.ernst, 'bezig');
  assert.match(t.kop, /verbinden/i);
  assert.equal(t.knop, null, 'nog een keer drukken helpt niet');
});

test('een onbereikbare brug is geen scanscherm', () => {
  const t = brugToestand({ error: 'De WhatsApp-brug is niet bereikbaar.' });
  assert.equal(t.staat, 'onbereikbaar');
  assert.equal(t.ernst, 'fout');
  assert.equal(t.knop, null, 'herkoppelen loopt via dezelfde brug, dus die knop zou niets doen');
});

test('laatste_fout komt in beeld, waar hij ook vandaan komt', () => {
  // Uit de brug zelf…
  const a = brugToestand({ data: { ...GEMETEN, laatste_fout: 'Protocol error: Target closed' } });
  assert.match(a.uitleg, /Target closed/);
  // …of uit de herverbinder.
  const b = brugToestand({ data: { ...GEMETEN, herverbinden: { bezig: false, opgegeven: true, poging: 6, laatste_fout: 'geen antwoord binnen 90s' } } });
  assert.match(b.uitleg, /geen antwoord binnen 90s/);
});

test('een brug die het opgegeven heeft zegt dat, en hoeveel pogingen het waren', () => {
  // Stilzwijgend opgeven is wat er nu gebeurt. Als het zichtbaar is kan iemand
  // erop drukken in plaats van te wachten op iets dat niet meer komt.
  const t = brugToestand({ data: { ...GEMETEN, herverbinden: { opgegeven: true, poging: 6 } } });
  assert.equal(t.staat, 'opgegeven');
  assert.match(t.uitleg, /6/);
  assert.equal(t.knop, 'opnieuw');
});

test('een lopende poging van de brug zelf wordt niet als storing gebracht', () => {
  const t = brugToestand({ data: { ...GEMETEN, herverbinden: { bezig: true, poging: 2, laatste_poging: new Date(Date.now() - 30000).toISOString() } } });
  assert.equal(t.staat, 'herverbindt');
  assert.equal(t.ernst, 'bezig');
  assert.match(t.uitleg, /Poging 2/);
  assert.equal(t.knop, 'nu', 'maar wachten mag geen verplichting zijn');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · HET PANEEL TEKENT DIE TOESTAND OOK ECHT
// ═══════════════════════════════════════════════════════════════════════════
// Een brugToestand die het goed weet en een paneel dat het niet toont is nog
// steeds een leeg venster. Daarom hier de HTML zelf.

function paneel(wa) {
  zetWa({
    paneelOpen: true, data: null, error: null, qr: null, qrError: null,
    herkoppelBezig: false, herkoppelFout: null, herkoppelSinds: null,
    ...wa,
  });
  return waPaneelHtml();
}

test('het paneel van 23 september is niet meer leeg', () => {
  const html = paneel({ data: GEMETEN });
  assert.match(html, /ligt eruit/, 'de toestand hoort er letterlijk te staan');
  assert.match(html, /Opnieuw koppelen/, 'en de knop erbij');
  assert.match(html, /__opvWaHerkoppel\(true\)/, 'die de sessie wist, want dan is een QR onvermijdelijk');
});

test('de scaninstructies staan er ALLEEN bij een code die er is', () => {
  // Dit was de fout: vier stappen om iets te scannen dat er nooit kwam.
  const zonder = paneel({ data: GEMETEN });
  assert.doesNotMatch(zonder, /Apparaat koppelen/, 'geen scanstappen zonder code');
  assert.doesNotMatch(zonder, /QR wordt opgehaald/, 'en geen belofte die niet waargemaakt wordt');
  assert.doesNotMatch(zonder, /<img class="waqr"/, 'en geen leeg plaatje');

  const met = paneel({ data: { verbonden: false }, qr: 'data:image/png;base64,xx' });
  assert.match(met, /Apparaat koppelen/);
  assert.match(met, /<img class="waqr"/);
});

test('tijdens het herkoppelen staat er dat er iets gebeurt, en geen knop', () => {
  const html = paneel({ data: GEMETEN, herkoppelBezig: true });
  assert.match(html, /Bezig met verbinden/);
  assert.doesNotMatch(html, /__opvWaHerkoppel/, 'twee keer starten is geen opdracht');
});

test('een mislukte herkoppeling zegt waarom, en biedt hem opnieuw aan', () => {
  const html = paneel({ data: GEMETEN, herkoppelFout: 'sessie wissen faalde: map op slot' });
  assert.match(html, /map op slot/);
  assert.match(html, /__opvWaHerkoppel\(true\)/);
});

test('een onbereikbare brug krijgt geen knop die toch niets kan', () => {
  const html = paneel({ error: 'De WhatsApp-brug is niet bereikbaar.' });
  assert.match(html, /niet bereikbaar/);
  assert.doesNotMatch(html, /__opvWaHerkoppel/);
});

test('gekoppeld blijft gekoppeld: geen QR, geen herkoppelknop', () => {
  const html = paneel({ data: { verbonden: true, nummer: '32470111222' } });
  assert.match(html, /Gekoppeld/);
  assert.doesNotMatch(html, /Apparaat koppelen/);
  assert.doesNotMatch(html, /__opvWaHerkoppel/);
});

test('bij een wachtende QR heet de knop niet "opnieuw koppelen" maar "nieuwe code"', () => {
  // Een code die er staat en werkt moet je niet per ongeluk weggooien, maar
  // een verlopen code moet je wél kunnen vervangen.
  const html = paneel({ data: { verbonden: false }, qr: 'data:image/png;base64,xx' });
  assert.match(html, /Nieuwe code ophalen/);
});

test('er staat nooit een knop zonder onclick, en nooit een onclick zonder tekst', () => {
  // Een knop die niets doet is erger dan geen knop: dan denk je dat je het
  // geprobeerd hebt.
  for (const wa of [
    { data: GEMETEN },
    { data: { ...GEMETEN, herverbinden: { bezig: true, poging: 2 } } },
    { data: { ...GEMETEN, herverbinden: { opgegeven: true, poging: 6 } } },
    { data: { verbonden: false }, qr: 'data:image/png;base64,xx' },
    { herkoppelFout: 'stuk' },
  ]) {
    const html = paneel(wa);
    const knop = html.match(/<button[^>]*id="opv-wa-koppel"[^>]*>([^<]*)</);
    assert.ok(knop, 'geen koppelknop gevonden in: ' + JSON.stringify(wa));
    assert.match(knop[0], /onclick="window\.__opvWaHerkoppel\((true|false)\)"/);
    assert.ok(knop[1].trim().length > 3, 'de knop heeft geen tekst');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE KNOP ZELF
// ═══════════════════════════════════════════════════════════════════════════
// Wat er gebeurt tussen de klik en de QR. Hier draait het echte
// window.__opvWaHerkoppel tegen een nagebootst /api-endpoint, zodat de drie
// dingen die mis kunnen gaan ook echt betrapt worden: niets tonen tijdens het
// wachten, een 200 met gestart:false voor succes aanzien, en een fout
// opslokken.

/** Een verse view met een eigen nagebootst netwerk. */
function versView() {
  const gevraagd = [];
  let antwoord = async () => ({ ok: true, gestart: true, sessie_gewist: true, fout: null });
  const { h, window } = laadView();
  window.KV.authedJson = async (url, opties) => {
    gevraagd.push({ url, body: opties?.body ? JSON.parse(opties.body) : null });
    return antwoord(url);
  };
  return {
    h, window, gevraagd,
    zetAntwoord: (fn) => { antwoord = fn; },
    herkoppel: (wis) => window.__opvWaHerkoppel(wis),
    wa: () => h.leesWa(),
  };
}

test('de knop roept het herkoppel-endpoint aan, met de wis-keuze erin', async () => {
  const v = versView();
  v.h.zetWa({ paneelOpen: true, data: { ...GEMETEN }, error: null, qr: null });
  await v.herkoppel(true);
  const post = v.gevraagd.find((g) => g.url === '/api/opvolging-whatsapp-herkoppel');
  assert.ok(post, 'er is niets aangeroepen — dan doet de knop niets');
  assert.deepEqual(post.body, { wis_sessie: true });
});

test('wis_sessie is alleen waar als erom gevraagd is', async () => {
  const v = versView();
  await v.herkoppel(false);
  const post = v.gevraagd.find((g) => g.url === '/api/opvolging-whatsapp-herkoppel');
  assert.deepEqual(post.body, { wis_sessie: false });
});

test('zolang het loopt staat er dat het loopt', async () => {
  // Dit is het gat waar het lege venster in viel: tussen de klik en het
  // antwoord stond er niets.
  const v = versView();
  v.h.zetWa({ paneelOpen: true, data: { ...GEMETEN } });
  let losmaken;
  v.zetAntwoord(() => new Promise((r) => { losmaken = () => r({ ok: true, gestart: true }); }));
  const bezigMee = v.herkoppel(true);
  await new Promise((r) => setImmediate(r));
  assert.equal(v.wa().herkoppelBezig, true);
  assert.match(v.h.waPaneelHtml(), /Bezig met verbinden/, 'en dat hoort ook op het scherm te staan');
  losmaken();
  await bezigMee;
  assert.equal(v.wa().herkoppelBezig, false, 'en daarna staat het weer stil');
});

test('een 200 met gestart:false is GEEN succes', async () => {
  // De brug kan netjes antwoorden en tóch niet gestart zijn — sessie wissen
  // mislukt, initialize gooit meteen. Dat als goed tellen laat iemand wachten
  // op een QR die niet komt.
  const v = versView();
  v.h.zetWa({ paneelOpen: true });
  v.zetAntwoord(async (url) => (url === '/api/opvolging-whatsapp-herkoppel'
    ? { ok: true, gestart: false, fout: 'sessie wissen faalde: map op slot' }
    : {}));
  await v.herkoppel(true);
  assert.match(v.wa().herkoppelFout || '', /map op slot/);
  assert.match(v.h.waPaneelHtml(), /map op slot/);
});

test('een fout van het endpoint wordt getoond, niet opgeslokt', async () => {
  const v = versView();
  v.zetAntwoord(async (url) => {
    if (url === '/api/opvolging-whatsapp-herkoppel') return { error: 'De WhatsApp-brug is niet bereikbaar.' };
    return {};
  });
  await v.herkoppel(true);
  assert.match(v.wa().herkoppelFout || '', /niet bereikbaar/);
});

test('na afloop wordt er meteen opnieuw gekeken in plaats van een tel gewacht', async () => {
  // Wie net op de knop drukte wil de QR zien zodra hij er is, niet vijf
  // seconden naar 'bezig' blijven kijken.
  const v = versView();
  await v.herkoppel(true);
  const urls = v.gevraagd.map((g) => g.url);
  assert.ok(urls.includes('/api/opvolging-whatsapp-status?wat=status'), 'status niet opnieuw opgehaald');
  assert.ok(urls.includes('/api/opvolging-whatsapp-status?wat=qr'), 'QR niet opgehaald');
});

test('na een mislukte poging wordt er geen QR opgehaald die er niet is', async () => {
  const v = versView();
  v.zetAntwoord(async (url) => (url === '/api/opvolging-whatsapp-herkoppel'
    ? { ok: true, gestart: false, fout: 'stuk' } : {}));
  await v.herkoppel(true);
  assert.ok(!v.gevraagd.some((g) => g.url.includes('wat=qr')), 'dat zou de fout meteen overschrijven met "QR wordt opgehaald"');
});

test('twee keer drukken is één opdracht', async () => {
  const v = versView();
  let losmaken;
  v.zetAntwoord(() => new Promise((r) => { losmaken = () => r({ ok: true, gestart: true }); }));
  const a = v.herkoppel(true);
  await new Promise((r) => setImmediate(r));
  // NIET awaiten op de tweede klik. Haal je het slot weg, dan blijft die tweede
  // aanroep hangen op hetzelfde onafgemaakte antwoord, en dan laat de testloper
  // deze test wég in plaats van hem af te keuren — groen naast kapot.
  v.herkoppel(true);                             // tweede klik tijdens de eerste
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  assert.equal(v.gevraagd.filter((g) => g.url === '/api/opvolging-whatsapp-herkoppel').length, 1);
  losmaken();
  await a;
});
