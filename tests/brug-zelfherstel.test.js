// tests/brug-zelfherstel.test.js
//
// Het zelfherstel van de brug. Elke test staat voor een storing die vandaag
// eenentwintig uur onopgemerkt was gebleven.
//
// WAT DEZE TESTS NIET BEWIJZEN: dat de service op de VPS daadwerkelijk
// terugkomt na `systemctl stop`. Dat bewijst alleen een echte proef op de VPS.
// Zie docs/whatsapp-brug-zelfherstel.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  maakHerverbinder, wachttijdVoor, POGINGEN_VOOR_VERVERSEN, MAX_WACHT_MS,
} from '../services/whatsapp-brug/lib/herverbinden.js';
import { maakHartslag } from '../services/whatsapp-brug/lib/hartslag.js';
import {
  beoordeelHartslag, bouwAlarmMail, STIL, LEEFT, NOOIT_GEZIEN,
  STIL_DREMPEL_MS, HARTSLAG_VERWACHT_MS, MIN_WAARNEMINGEN,
} from '../api/_lib/brug-waakhond.js';

/** Een herverbinder met een geplande-taken-wachtrij die de test zelf afdraait. */
function opstelling({ verbindFaalt = false } = {}) {
  const rij = [];
  const gedaan = { verbind: 0, exit: null, meldingen: [] };
  const h = maakHerverbinder({
    verbind : async () => { gedaan.verbind += 1; if (verbindFaalt) throw new Error('nee'); },
    plan    : (ms, fn) => { rij.push({ ms, fn }); return rij.length; },
    annuleer: () => {},
    beeindig: (code) => { gedaan.exit = code; },
    meld    : (soort, data) => gedaan.meldingen.push({ soort, data }),
  });
  const draai = async () => { while (rij.length) await rij.shift().fn(); };
  return { h, rij, gedaan, draai };
}

// ═══════════════════════════════════════════════════════════════════════════
// HERVERBINDEN
// ═══════════════════════════════════════════════════════════════════════════

test('een verbroken verbinding leidt tot een nieuwe poging — de oude code deed niets', () => {
  const { h, rij } = opstelling();
  h.verbroken('CONFLICT');
  assert.equal(rij.length, 1, 'er moet een poging gepland staan');
  assert.equal(rij[0].ms, 5000);
});

test('de wachttijd loopt op en vlakt af, hij loopt niet oneindig door', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(wachttijdVoor), [5000, 10000, 20000, 40000, 80000]);
  assert.equal(wachttijdVoor(6), MAX_WACHT_MS);
  assert.equal(wachttijdVoor(99), MAX_WACHT_MS);
});

test('een geslaagde verbinding zet de teller terug op nul', () => {
  const { h, rij } = opstelling();
  h.verbroken('a'); h.gelukt();
  h.verbroken('b');
  assert.equal(rij[rij.length - 1].ms, 5000, 'na een geslaagde verbinding weer vanaf 5s');
  assert.equal(h.stand().poging, 1);
});

test('na zes mislukte pogingen sluit het proces af zodat systemd vers start', async () => {
  const { h, gedaan, draai } = opstelling({ verbindFaalt: true });
  h.verbroken('start');
  await draai();
  assert.equal(gedaan.exit, 1, 'afsluiten met een foutcode, niet met 0');
  assert.equal(gedaan.meldingen.at(-1).soort, 'brug_ververst');
});

test('hij sluit NIET af zolang de teller onder de grens ligt', async () => {
  const { h, gedaan, rij } = opstelling({ verbindFaalt: true });
  h.verbroken('een');
  await rij.shift().fn();                     // één mislukte poging
  assert.equal(gedaan.exit, null, 'één storing mag geen proces-uitgang zijn');
  assert.ok(POGINGEN_VOOR_VERVERSEN > 1);
});

test('twee verbroken-meldingen tegelijk stapelen geen dubbele pogingen', () => {
  const { h, rij } = opstelling();
  h.verbroken('a'); h.verbroken('b');
  assert.equal(rij.length, 1, 'niet twee timers voor dezelfde storing');
});

test('initialize() dat slaagt telt nog niet als verbonden — dat doet ready', async () => {
  // De val: initialize() kan slagen en de verbinding daarna alsnog wegvallen.
  const { h, rij, gedaan } = opstelling();
  h.verbroken('a');
  await rij.shift().fn();
  assert.equal(gedaan.verbind, 1);
  assert.equal(h.stand().poging, 1, 'de teller blijft staan tot ready() hem wist');
});

// ═══════════════════════════════════════════════════════════════════════════
// HARTSLAG — en de privacygrens
// ═══════════════════════════════════════════════════════════════════════════

test('de hartslag draagt alleen tellingen, nooit een nummer of tekst', async () => {
  const geduwd = [];
  const hb = maakHartslag({
    duw: async (g) => geduwd.push(g),
    stand: () => ({ verbonden: true, gezien: 9, doorgelaten: 9, sinds: '2026-09-07T10:00:00Z' }),
    plan: () => 1, annuleer: () => {},
  });
  hb.start();
  await new Promise((r) => setTimeout(r, 0));
  const g = geduwd[0];
  const tekst = JSON.stringify(g);
  assert.equal(g.soort, 'hartslag');
  assert.equal(g.verbonden, true);
  assert.equal(g.gezien, 9);
  // De grens: geen enkel veld dat een persoon kan aanwijzen.
  for (const verboden of ['nummer', 'jid', 'body', 'tekst', 'naam', 'from', 'lid']) {
    assert.ok(!Object.keys(g).includes(verboden), 'hartslag mag geen ' + verboden + ' dragen');
  }
  assert.doesNotMatch(tekst, /\+?\d{9,}/, 'geen telefoonnummer-achtige reeks in de hartslag');
});

test('een verbroken verbinding wordt direct gemeld, niet pas bij de volgende slag', async () => {
  const geduwd = [];
  const hb = maakHartslag({ duw: async (g) => geduwd.push(g), stand: () => ({}), plan: () => 1, annuleer: () => {} });
  await hb.meld('verbinding_verbroken', { reden: 'CONFLICT' });
  assert.equal(geduwd[0].soort, 'verbinding_verbroken');
  assert.equal(geduwd[0].reden, 'CONFLICT');
});

test('een mislukte hartslag laat de brug niet vallen', async () => {
  const hb = maakHartslag({
    duw: async () => { throw new Error('CRM plat'); },
    stand: () => ({}), plan: () => 1, annuleer: () => {},
  });
  await hb.meld('hartslag');                  // mag niet gooien
  assert.ok(true);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE WAAKHOND — en vooral: wanneer hij ZWIJGT
// ═══════════════════════════════════════════════════════════════════════════

const NU = Date.parse('2026-09-07T15:00:00Z');
const gel = (min) => new Date(NU - min * 60000).toISOString();

test('een gemiste hartslag is GEEN alarm — anders krijgt Maxim vals alarm', () => {
  const r = beoordeelHartslag({ nuMs: NU, laatsteIso: gel(3) });
  assert.equal(r.staat, LEEFT);
  assert.equal(r.alarm, false);
});

test('zelfs vijf gemiste hartslagen blijven onder de drempel', () => {
  const r = beoordeelHartslag({ nuMs: NU, laatsteIso: gel(10) });
  assert.equal(r.alarm, false);
  assert.ok(STIL_DREMPEL_MS / HARTSLAG_VERWACHT_MS >= 5,
    'de drempel moet een veelvoud van de hartslag zijn, niet een marge erop');
});

test('de eerste waarneming boven de drempel mailt nog niet', () => {
  const r = beoordeelHartslag({ nuMs: NU, laatsteIso: gel(20), stilWaarnemingen: 0 });
  assert.equal(r.staat, STIL);
  assert.equal(r.alarm, false, 'één waarneming is geen alarm');
  assert.equal(r.waarnemingen, 1);
});

test('de tweede waarneming op rij is wél alarm', () => {
  const r = beoordeelHartslag({ nuMs: NU, laatsteIso: gel(20), stilWaarnemingen: 1 });
  assert.equal(r.alarm, true);
  assert.equal(r.waarnemingen, MIN_WAARNEMINGEN);
  assert.match(r.uitleg, /20 minuten/);
});

test('een brug die ademt maar niet verbonden is, is ook stuk', () => {
  const r = beoordeelHartslag({ nuMs: NU, laatsteIso: gel(1), verbonden: false });
  assert.equal(r.staat, LEEFT);
  assert.equal(r.alarm, true);
  assert.equal(r.losgekoppeld, true);
});

test('nooit een hartslag gezien is niet hetzelfde als een hartslag die wegblijft', () => {
  const r = beoordeelHartslag({ nuMs: NU, laatsteIso: null });
  assert.equal(r.staat, NOOIT_GEZIEN);
  assert.equal(r.alarm, false, 'de brug draait deze versie nog niet — dat is geen storing');
});

test('de alarmmail draagt de getallen waarop het oordeel rust', () => {
  const oordeel = beoordeelHartslag({ nuMs: NU, laatsteIso: gel(20), stilWaarnemingen: 1 });
  const { subject, text } = bouwAlarmMail({ oordeel, nuIso: new Date(NU).toISOString(), laatsteIso: gel(20) });
  assert.match(subject, /Brug/);
  assert.match(text, /laatste hartslag = /);
  assert.match(text, /waarnemingen op rij = 2/);
  assert.match(text, /drempel = 12 min/);
});
