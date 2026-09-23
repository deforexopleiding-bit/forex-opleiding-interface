// tests/brug-herkoppel-en-wachthond.test.js
//
// DE KOPPELKNOP MOET ALTIJD TOT EEN QR LEIDEN.
//
// Gemeten op 23 september op productie: de brugserver leefde (leadlijst 63
// nummers om 18:04, http 200) maar `verbonden=false`, `nummer=null`,
// `wacht_op_qr=false`, alle tellers nul, laatste actie 06:04, geen fout. De
// client lag eruit zónder fout en bood ook geen QR aan. Maxim klikte op
// koppelen en kreeg een leeg scherm.
//
// Drie dingen maakten dat mogelijk, en elk krijgt hier zijn eigen test:
//
//   1. EEN HANGENDE POGING WEDGDE ALLES. `await verbind()` had geen grens, dus
//      een initialize() die nooit terugkomt liet `bezig` voor altijd op waar
//      staan: geen tweede poging, geen fout, geen spoor.
//   2. ZONDER GEBEURTENIS GEBEURT ER NIETS. De herverbinder hangt aan
//      `disconnected` en `auth_failure`. Valt Chromium stil om, dan roept
//      niemand 'verbroken'.
//   3. HET WAS NERGENS TE ZIEN. De stand van de herverbinder zat alleen in de
//      hartslag, niet in /status.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maakHerverbinder, POGINGEN_VOOR_VERVERSEN, POGING_TIJDSLIMIET_MS,
} from '../services/whatsapp-brug/lib/herverbinden.js';
import {
  beoordeelWachthond, maakWachthond, WACHTHOND_STILTE_MS,
} from '../services/whatsapp-brug/lib/wachthond.js';

/**
 * Een herverbinder met een wachtrij die de test zelf afdraait.
 *
 * `verbindHangt` bootst de gemeten storing na: initialize() komt nooit terug.
 * De tijdslimiet moet daar doorheen breken.
 */
function opstelling({ verbindFaalt = false, verbindHangt = false, tijdslimietMs } = {}) {
  const rij = [];
  const gedaan = { verbind: 0, exit: null, meldingen: [], log: [] };
  // De hang moet BESTUURBAAR zijn. Een `new Promise(() => {})` blijft voor
  // altijd hangen, en dan klaagt de testrunner aan het eind over een openstaande
  // belofte en valt het hele bestand om — nul tests, geen enkele meting. De
  // test laat hem dus aan het eind zelf aflopen; de code onder test merkt daar
  // niets van, want die is dan al op zijn tijdslimiet afgebroken.
  const hangers = [];
  const h = maakHerverbinder({
    verbind: () => {
      gedaan.verbind += 1;
      if (verbindHangt) return new Promise((r) => hangers.push(r));
      if (verbindFaalt) return Promise.reject(new Error('nee'));
      return Promise.resolve();
    },
    plan    : (ms, fn) => { rij.push({ ms, fn }); return rij.length; },
    annuleer: (id) => { const i = rij.findIndex((r, n) => n + 1 === id); if (i >= 0) rij.splice(i, 1); },
    beeindig: (code) => { gedaan.exit = code; },
    meld    : (soort, data) => gedaan.meldingen.push({ soort, data }),
    log     : (...a) => gedaan.log.push(a.join(' ')),
    ...(tijdslimietMs ? { tijdslimietMs } : {}),
  });
  // Eén ronde: alles afvuren wat er NU in de rij staat, en daarna de
  // beloftenketens laten uitlopen.
  //
  // NIET AWAITEN op de callback zelf. De herverbind-poging wacht intern op
  // verbind(), en juist in de hang-test komt die nooit terug — dan blijft
  // draaiRonde zelf hangen en valt het hele bestand om zonder één meting.
  // Precies de storing die we nabootsen, alleen dan in de test.
  const draaiRonde = async () => {
    const nu = rij.splice(0, rij.length);
    for (const t of nu) { try { t.fn(); } catch (_) { /* fouten komen via de stand */ } }
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };
  /** Alle hangende pogingen alsnog laten aflopen, zodat de runner niet klaagt. */
  const losmaken = () => { while (hangers.length) hangers.shift()(); };
  return { h, rij, gedaan, draaiRonde, losmaken };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · EEN HANGENDE POGING MAG NIET ALLES WEDGEN
// ═══════════════════════════════════════════════════════════════════════════

test('een initialize die nooit terugkomt loopt af op de tijdslimiet', async () => {
  const { h, rij, draaiRonde, losmaken } = opstelling({ verbindHangt: true });
  h.verbroken('test');
  await draaiRonde();                    // de geplande poging start de hang
  assert.equal(h.stand().poging, 1, 'na de eerste poging staat de teller op 1');
  // De tijdslimiet staat nu in de rij; die afdraaien breekt de hang af.
  await draaiRonde();
  // NIET op `bezig` meten. Dat staat hier terecht weer op waar: de hang is
  // afgebroken én er is meteen een vólgende poging gepland, en die zet hem
  // opnieuw. Wat het verschil maakt met de gemeten storing is dat de teller
  // doorloopt en er weer iets in de wachtrij staat — zonder tijdslimiet bleef
  // beide staan waar het stond, voor altijd.
  assert.equal(h.stand().poging, 2, 'de teller loopt niet door — de hang heeft alles vastgezet');
  assert.match(String(h.stand().laatste_fout), /geen antwoord binnen/);
  assert.ok(rij.length > 0, 'er hoort een volgende poging gepland te staan');
  losmaken();
});

test('en daarna loopt de gewone trap gewoon door', async () => {
  const { h, draaiRonde, losmaken } = opstelling({ verbindHangt: true });
  h.verbroken('test');
  await draaiRonde(); await draaiRonde();
  assert.equal(h.stand().poging, 2, 'de teller hoort door te lopen na een hang');
  losmaken();
});

test('de tijdslimiet is ruim genoeg voor een trage start', () => {
  // Een koude Chromium op een kale VPS heeft tientallen seconden nodig. Te
  // krap afbreken maakt van elke trage start een mislukking.
  assert.ok(POGING_TIJDSLIMIET_MS >= 60000, 'te krap: een trage start wordt dan een fout');
  assert.ok(POGING_TIJDSLIMIET_MS <= 180000, 'te ruim: dan duurt het te lang voor er iets gebeurt');
});

test('een poging die WEL op tijd klaar is wordt niet afgebroken', async () => {
  const { h, gedaan, draaiRonde } = opstelling();
  h.verbroken('test');
  await draaiRonde();
  assert.equal(gedaan.verbind, 1);
  assert.equal(h.stand().bezig, false);
  assert.equal(h.stand().laatste_fout, null, 'een geslaagde poging hoort geen fout achter te laten');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · WAT ER TE ZIEN MOET ZIJN
// ═══════════════════════════════════════════════════════════════════════════

test('de stand draagt de pogingen, de laatste fout en het laatste moment', async () => {
  const { h, draaiRonde } = opstelling({ verbindFaalt: true });
  h.verbroken('test');
  await draaiRonde();
  const s = h.stand();
  assert.equal(s.poging, 2);
  assert.equal(s.laatste_fout, 'nee');
  assert.ok(s.laatste_poging, 'zonder tijdstip is niet te zien wanneer hij het opgaf');
});

test('opgeven is ZICHTBAAR, niet stil', async () => {
  // Het proces sluit daarna af en systemd hoort een vers exemplaar te starten.
  // Blijft dat uit, dan is deze vlag het enige spoor dat er iets aan de hand is.
  const { h, gedaan, draaiRonde } = opstelling({ verbindFaalt: true });
  for (let i = 0; i <= POGINGEN_VOOR_VERVERSEN + 1; i += 1) { h.verbroken('x'); await draaiRonde(); }
  assert.equal(gedaan.exit, 1);
  assert.equal(h.stand().opgegeven, true);
  assert.match(String(h.stand().laatste_fout), /opgegeven na/);
});

test('een geslaagde verbinding wist het verleden', async () => {
  const { h, draaiRonde } = opstelling({ verbindFaalt: true });
  h.verbroken('test'); await draaiRonde();
  assert.ok(h.stand().laatste_fout);
  h.gelukt();
  const s = h.stand();
  assert.equal(s.poging, 0);
  assert.equal(s.laatste_fout, null);
  assert.equal(s.opgegeven, false);
  assert.ok(s.laatst_gelukt, 'wanneer het voor het laatst goed ging hoort zichtbaar te zijn');
});

test('de stand draagt GEEN nummer en GEEN tekst', async () => {
  // Het privacyfilter geldt ook hier: /status is voor Maxim, niet voor Daves
  // contacten. Alleen tellingen, tijdstempels en een foutregel.
  const { h, draaiRonde } = opstelling({ verbindFaalt: true });
  h.verbroken('test'); await draaiRonde();
  const tekst = JSON.stringify(h.stand());
  assert.doesNotMatch(tekst, /\+?\d{9,}/, 'er staat iets dat op een telefoonnummer lijkt in de stand');
  assert.deepEqual(Object.keys(h.stand()).sort(), [
    'bezig', 'laatst_gelukt', 'laatste_fout', 'laatste_poging', 'opgegeven', 'poging', 'tijdslimiet_ms', 'wacht_ms',
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE WACHTHOND — zonder gebeurtenis gebeurt er anders niets
// ═══════════════════════════════════════════════════════════════════════════

const stil = (ms, extra = {}) => beoordeelWachthond({
  verbonden: false, heeftQr: false, herverbinden: {}, stilMs: ms, ...extra,
});

test('de gemeten toestand van 23 september leidt tot porren', () => {
  // verbonden=false, geen QR, geen poging, twaalf uur stil.
  const uit = stil(12 * 3600 * 1000);
  assert.equal(uit.actie, 'porren');
  assert.match(uit.reden, /geen verbinding, geen QR, geen poging/);
});

test('verbonden betekent niets doen', () => {
  assert.equal(stil(9e9, { verbonden: true }).actie, 'niets');
});

test('een wachtende QR wordt NIET onderbroken', () => {
  // Er wordt op een mens gewacht, niet op ons. Porren zou de code onder zijn
  // handen vandaan verversen terwijl hij staat te scannen.
  const uit = stil(9e9, { heeftQr: true });
  assert.equal(uit.actie, 'niets');
  assert.match(uit.reden, /wacht op scan/);
});

test('een lopende poging wordt niet dubbel aangezwengeld', () => {
  assert.equal(stil(9e9, { herverbinden: { bezig: true } }).actie, 'niets');
});

test('opgegeven blijft opgegeven — anders poetst de wachthond het signaal weg', () => {
  // Die vlag staat in /status zodat het CRM kan tonen dat er niet meer
  // geprobeerd wordt. Zelf opnieuw beginnen zou hem elke minuut wissen.
  const uit = stil(9e9, { herverbinden: { opgegeven: true } });
  assert.equal(uit.actie, 'niets');
  assert.match(uit.reden, /opgegeven/);
});

test('binnen de drempel gebeurt er niets', () => {
  // Bij het opstarten duurt het even voor de eerste QR er is; meteen porren
  // zou die start afbreken.
  assert.equal(stil(WACHTHOND_STILTE_MS - 1000).actie, 'niets');
  assert.equal(stil(WACHTHOND_STILTE_MS).actie, 'porren');
});

test('de drempel ligt boven de langste wachttijd van de herverbinder', () => {
  // Anders trekt de wachthond aan een trap die zijn werk nog aan het doen is.
  assert.ok(WACHTHOND_STILTE_MS > 120000 + POGING_TIJDSLIMIET_MS - 1,
    'de wachthond kan een lopende herverbind-trap onderbreken');
});

test('zonder meting wordt er niet gegokt', () => {
  assert.equal(stil(-1).actie, 'niets');
});

// ── De wachthond in bedrijf ────────────────────────────────────────────────

function wachthondOpstelling(standen) {
  const rij = [];
  const gepord = [];
  let i = 0;
  const w = maakWachthond({
    stand   : () => standen[Math.min(i++, standen.length - 1)],
    porren  : (reden) => gepord.push(reden),
    plan    : (ms, fn) => { rij.push({ ms, fn }); return rij.length; },
    annuleer: () => {},
    log     : () => {},
  });
  const slag = () => { const t = rij.shift(); if (t) t.fn(); };
  return { w, rij, gepord, slag };
}

const LANG_GELEDEN = new Date(Date.now() - 12 * 3600 * 1000).toISOString();

test('de wachthond trekt aan de bel bij de gemeten toestand', () => {
  const { w, gepord, slag } = wachthondOpstelling([
    { verbonden: false, heeftQr: false, herverbinden: {}, laatsteActie: LANG_GELEDEN },
  ]);
  w.start(); slag();
  assert.equal(gepord.length, 1);
});

test('en hij blijft kijken — één slag is geen vangnet', () => {
  const { w, rij, slag } = wachthondOpstelling([
    { verbonden: true, heeftQr: false, herverbinden: {}, laatsteActie: new Date().toISOString() },
  ]);
  w.start(); slag();
  assert.equal(rij.length, 1, 'na een slag hoort de volgende gepland te staan');
});

test('een kapotte meting zet de wachthond niet stil', () => {
  // Juist dan is het vangnet nodig; stoppen zou het weghalen op het moment dat
  // er iets aan de hand is.
  const rij = [];
  const w = maakWachthond({
    stand   : () => { throw new Error('stuk'); },
    porren  : () => {},
    plan    : (ms, fn) => { rij.push({ ms, fn }); return rij.length; },
    annuleer: () => {}, log: () => {},
  });
  w.start();
  rij.shift().fn();
  assert.equal(rij.length, 1, 'de volgende slag hoort gewoon gepland te staan');
});

test('een porren dat gooit zet de wachthond ook niet stil', () => {
  const rij = [];
  const w = maakWachthond({
    stand   : () => ({ verbonden: false, heeftQr: false, herverbinden: {}, laatsteActie: LANG_GELEDEN }),
    porren  : () => { throw new Error('stuk'); },
    plan    : (ms, fn) => { rij.push({ ms, fn }); return rij.length; },
    annuleer: () => {}, log: () => {},
  });
  w.start();
  rij.shift().fn();
  assert.equal(rij.length, 1);
});

test('de stand van de wachthond draagt alleen tellingen', () => {
  const { w, gepord, slag } = wachthondOpstelling([
    { verbonden: false, heeftQr: false, herverbinden: {}, laatsteActie: LANG_GELEDEN },
  ]);
  w.start(); slag();
  const s = w.stand();
  assert.equal(s.porren, gepord.length);
  assert.ok(s.laatste_por);
  assert.doesNotMatch(JSON.stringify(s), /\+?\d{9,}/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HERKOPPELEN — met een nagebootste client die uit kan vallen
// ═══════════════════════════════════════════════════════════════════════════
// De echte client trekt puppeteer en een Chromium binnen; die staan hier niet
// en horen er ook niet te staan. Wat getest moet worden is het PAD: breekt hij
// af, wist hij als het gevraagd wordt, begint hij opnieuw, en wat zegt hij als
// een van die stappen misgaat.

const { herkoppel } = await import('../services/whatsapp-brug/lib/herkoppelen.js');

function nepClient({ afbrekenFaalt = false, wisFaalt = false, startFaalt = false } = {}) {
  const gedaan = { afgebroken: 0, gewist: 0, gestart: 0 };
  const staat = { verbonden: true, qrDataUrl: 'oude-qr', qrSindsIso: 'toen', laatsteFout: 'oude fout' };
  const herverbinder = { gelukt_aangeroepen: 0, gelukt() { this.gelukt_aangeroepen += 1; } };
  return {
    staat, gedaan, herverbinder,
    roep: (wisSessie = false) => herkoppel({
      staat,
      afbreken: async () => { gedaan.afgebroken += 1; if (afbrekenFaalt) throw new Error('client al stuk'); },
      wis     : async () => { gedaan.gewist += 1; if (wisFaalt) throw new Error('map op slot'); },
      start   : async () => { gedaan.gestart += 1; if (startFaalt) throw new Error('start mislukt'); },
      herverbinder, wisSessie, log: () => {},
    }),
  };
}

test('herkoppelen breekt af en begint opnieuw', async () => {
  const c = nepClient();
  const uit = await c.roep();
  assert.equal(uit.gestart, true);
  assert.equal(c.gedaan.afgebroken, 1);
  assert.equal(c.gedaan.gestart, 1);
});

test('de oude QR gaat weg — die is niet meer te scannen', async () => {
  // Hem laten staan zou iemand ernaar laten kijken terwijl er een nieuwe
  // onderweg is, en dan scant hij een code die nergens meer op slaat.
  const c = nepClient();
  await c.roep();
  assert.equal(c.staat.qrDataUrl, null);
  assert.equal(c.staat.qrSindsIso, null);
  assert.equal(c.staat.verbonden, false);
  assert.equal(c.staat.laatsteFout, null);
});

test('zonder wissen blijft de sessie staan', async () => {
  // Dat is het snelle pad: hervatten vraagt geen telefoon.
  const c = nepClient();
  const uit = await c.roep(false);
  assert.equal(c.gedaan.gewist, 0);
  assert.equal(uit.sessie_gewist, false);
});

test('met wissen gaat de sessiemap weg — dan komt er gegarandeerd een QR', async () => {
  const c = nepClient();
  const uit = await c.roep(true);
  assert.equal(c.gedaan.gewist, 1);
  assert.equal(uit.sessie_gewist, true);
  assert.equal(uit.gestart, true);
});

test('een client die al stuk is houdt het herkoppelen NIET tegen', async () => {
  // Juist dán wil je opnieuw beginnen. destroy() op een omgevallen Chromium
  // gooit, en dat afbreken zou de knop precies onbruikbaar maken wanneer hij
  // nodig is.
  const c = nepClient({ afbrekenFaalt: true });
  const uit = await c.roep();
  assert.equal(uit.gestart, true);
  assert.equal(c.gedaan.gestart, 1);
});

test('wissen dat mislukt stopt de boel, en zegt waarom', async () => {
  // Stil doorgaan zou de oude, kapotte sessie terug laten komen: dan blijft de
  // QR uit terwijl er juist om gevraagd is, en niemand weet waarom.
  const c = nepClient({ wisFaalt: true });
  const uit = await c.roep(true);
  assert.equal(uit.gestart, false);
  assert.equal(uit.sessie_gewist, false);
  assert.match(uit.fout, /sessie wissen faalde/);
  assert.equal(c.gedaan.gestart, 0, 'starten na een mislukt wissen is precies de val');
});

test('een start die mislukt wordt gemeld, niet verzwegen', async () => {
  const c = nepClient({ startFaalt: true });
  const uit = await c.roep();
  assert.equal(uit.gestart, false);
  assert.match(uit.fout, /herkoppelen faalde/);
  assert.equal(c.staat.laatsteFout, uit.fout, 'de fout hoort ook in /status te staan');
});

test('de teller van de herverbinder gaat terug op nul', async () => {
  // Zonder dit telt een handmatige poging door op een teller die misschien al
  // bijna aan de afsluitgrens zat, en sluit het proces af terwijl iemand staat
  // te kijken naar het venster.
  const c = nepClient();
  await c.roep();
  assert.equal(c.herverbinder.gelukt_aangeroepen, 1);
});

test('bij een mislukt wissen wordt de teller NIET teruggezet', async () => {
  // Er is niets opnieuw begonnen; doen alsof van wel zou de trap laten denken
  // dat alles goed ging.
  const c = nepClient({ wisFaalt: true });
  await c.roep(true);
  assert.equal(c.herverbinder.gelukt_aangeroepen, 0);
});
