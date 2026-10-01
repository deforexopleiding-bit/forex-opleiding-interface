// tests/call-uitkomst-categorie.test.js
//
// WAT EEN CALL-UITKOMST BETEKENT — één mapping, twee jassen, één antwoord.
//
// api/_lib/call-uitkomst-categorie.js (ES-module) en
// modules/shared/call-uitkomst-categorie.js (browser-script) dragen dezelfde
// kern. Deze tests eisen:
//   1. dat die kern tekst voor tekst gelijk is;
//   2. dat beide op dezelfde invoer hetzelfde antwoord geven;
//   3. dat elke waarde van de motor een categorie heeft, en een onbekende
//      waarde 'Onbekend' wordt — nooit weggelaten;
//   4. dat afspraakStaat precies callStaat uit het rapport is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as lib from '../api/_lib/call-uitkomst-categorie.js';
import { callStaat } from '../api/opvolging-rapport.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_BESTAND = join(ROOT, 'api/_lib/call-uitkomst-categorie.js');
const WEB_BESTAND = join(ROOT, 'modules/shared/call-uitkomst-categorie.js');
const MOTOR = join(ROOT, 'api/follow-up-appointment-outcome.js');

function kern(pad) {
  const t = readFileSync(pad, 'utf8');
  const i = t.indexOf('// ── KERN BEGIN');
  const j = t.indexOf('// ── KERN EIND');
  assert.ok(i >= 0 && j > i, pad + ' mist de KERN-markers');
  return t.slice(i, j);
}

function laadWeb() {
  const window = {};
  const ctx = createContext({ window, Date, Number, String, Object, Array, Math });
  runInContext(readFileSync(WEB_BESTAND, 'utf8'), ctx, { filename: 'call-uitkomst-categorie.js' });
  assert.ok(window.CallUitkomstCategorie, 'het browser-script hoort window.CallUitkomstCategorie te zetten');
  return window.CallUitkomstCategorie;
}
const web = laadWeb();
const plat = (o) => JSON.parse(JSON.stringify(o));

const NU = Date.parse('2026-10-01T12:00:00Z');
const VERLEDEN = '2026-10-01T09:00:00Z';   // ruim voorbij (30 min + 15 speling)
const STRAKS = '2026-10-01T15:00:00Z';

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE TWEE JASSEN
// ═══════════════════════════════════════════════════════════════════════════

test('de kern is in beide bestanden byte voor byte gelijk', () => {
  assert.equal(kern(WEB_BESTAND), kern(API_BESTAND));
});

test('de browser-jas exporteert dezelfde constanten', () => {
  assert.deepEqual(plat(web.CATEGORIEEN), plat(lib.CATEGORIEEN));
  assert.deepEqual(plat(web.CATEGORIE_KEYS), plat(lib.CATEGORIE_KEYS));
  assert.deepEqual(plat(web.UITKOMST_NAAR_CATEGORIE), plat(lib.UITKOMST_NAAR_CATEGORIE));
  assert.deepEqual(plat(web.BEKENDE_UITKOMSTEN), plat(lib.BEKENDE_UITKOMSTEN));
});

const UITKOMSTEN = [null, undefined, '', '  ', 'sale', 'SALE ', 'gesprek_gehad', 'later_opnieuw',
  'terugbel', 'wilt_niet_meer', 'niet_geschikt', 'no_show', 'geen_geld', 'onbereikbaar',
  'verzetten', 'annuleren', 'iets_nieuws', 'klant_geworden'];
const STATUSSEN = [undefined, null, 'scheduled', 'in_progress', 'completed', 'no_show', 'cancelled',
  'verplaatst', 'wacht_op_reschedule', 'verwijderd', 'noshow', 'raar'];
const MOMENTEN = [VERLEDEN, STRAKS, 'geen-datum', null];

test('beide jassen geven op elke combinatie hetzelfde antwoord', () => {
  let n = 0;
  for (const uitkomst of UITKOMSTEN) {
    for (const status of STATUSSEN) {
      for (const scheduled_at of MOMENTEN) {
        for (const heeftOpvolger of [false, true]) {
          const a = { uitkomst, status, scheduled_at, duration_minutes: 30 };
          const o = { nuMs: NU, heeftOpvolger };
          assert.equal(web.categorieVoorAfspraak(a, o), lib.categorieVoorAfspraak(a, o),
            JSON.stringify({ a, o }));
          n += 1;
        }
      }
    }
  }
  assert.ok(n > 1000);
});

test('de pagina laadt het browser-script vóór de views', () => {
  const html = readFileSync(join(ROOT, 'modules/klanten-v2/index.html'), 'utf8');
  const hulp = html.indexOf('../shared/call-uitkomst-categorie.js?v=');
  const views = html.indexOf('views/_shared-v2.js');
  assert.ok(hulp > 0, 'het script hoort geladen te worden');
  assert.ok(hulp < views, 'vóór de views, zodat elke view hem kan lezen');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE MAPPING
// ═══════════════════════════════════════════════════════════════════════════

const VERWACHT = {
  sale          : 'Sale',
  gesprek_gehad : 'Opvolgen / bedenktijd',
  later_opnieuw : 'Opvolgen / bedenktijd',
  terugbel      : 'Opvolgen / bedenktijd',
  wilt_niet_meer: 'Geen interesse',
  niet_geschikt : 'Niet gekwalificeerd',
  no_show       : 'No show',
  geen_geld     : 'Geen geld',
  onbereikbaar  : 'Onbereikbaar',
};

for (const [uitkomst, label] of Object.entries(VERWACHT)) {
  test(`uitkomst ${uitkomst} → ${label}`, () => {
    // Ook met een status die iets anders zou zeggen: de uitkomst wint.
    for (const status of ['completed', 'cancelled', 'verplaatst', 'no_show']) {
      const key = lib.categorieVoorAfspraak({ uitkomst, status, scheduled_at: VERLEDEN }, { nuMs: NU, heeftOpvolger: true });
      assert.equal(lib.categorieInfo(key).label, label, uitkomst + ' / ' + status);
    }
  });
}

test('elke waarde die de motor kent heeft een plek in de mapping', () => {
  // Komt er in de motor een woord bij zonder plek hier, dan wordt het in elk
  // rapport 'Onbekend'. Dat is beter dan verdwijnen, maar het hoort een
  // bewuste keuze te zijn — dus faalt deze test.
  const bron = readFileSync(MOTOR, 'utf8');
  const set = bron.match(/const OUTCOMES = new Set\(\[([\s\S]*?)\]\)/)[1];
  const motor = [...set.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(motor.length >= 11);
  for (const w of motor) {
    assert.ok(lib.BEKENDE_UITKOMSTEN.includes(w), w + ' staat niet in call-uitkomst-categorie.js');
  }
});

test('een onbekende uitkomst wordt Onbekend — niet weggelaten, niet stil "nog niet vastgelegd"', () => {
  for (const u of ['iets_nieuws', 'klant_geworden', 'geen_interesse']) {
    const key = lib.categorieVoorAfspraak({ uitkomst: u, status: 'completed', scheduled_at: VERLEDEN }, { nuMs: NU });
    assert.equal(key, 'onbekend', u);
    assert.equal(lib.categorieInfo(key).label, 'Onbekend');
  }
  assert.equal(lib.categorieVoorUitkomst('iets_nieuws'), 'onbekend');
});

test('hoofdletters en spaties in de uitkomst maken niet uit', () => {
  assert.equal(lib.categorieVoorUitkomst(' Sale '), 'sale');
  assert.equal(lib.categorieVoorUitkomst('GEEN_GELD'), 'geen_geld');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · AFLEIDINGEN ZONDER (INHOUDELIJKE) UITKOMST
// ═══════════════════════════════════════════════════════════════════════════

const cat = (a, o = {}) => lib.categorieVoorAfspraak(a, { nuMs: NU, ...o });

test('geannuleerd: status cancelled, en ook verwijderd', () => {
  assert.equal(cat({ status: 'cancelled', scheduled_at: VERLEDEN }), 'geannuleerd');
  assert.equal(cat({ status: 'cancelled', scheduled_at: STRAKS }), 'geannuleerd');
  assert.equal(cat({ status: 'verwijderd', scheduled_at: VERLEDEN }), 'geannuleerd');
});

test('nieuw moment: status verplaatst, of een opvolger in de keten', () => {
  assert.equal(cat({ status: 'verplaatst', scheduled_at: VERLEDEN }), 'nieuw_moment');
  assert.equal(cat({ status: 'scheduled', scheduled_at: VERLEDEN }, { heeftOpvolger: true }), 'nieuw_moment');
  assert.equal(lib.categorieInfo('nieuw_moment').label, 'Nieuw moment ingepland');
});

test('wacht_op_reschedule heeft een eigen naam, geen Onbekend', () => {
  assert.equal(cat({ status: 'wacht_op_reschedule', scheduled_at: VERLEDEN }), 'wacht_op_nieuw_moment');
});

test('gepland zolang de call (plus speling) nog niet voorbij is', () => {
  assert.equal(cat({ status: 'scheduled', scheduled_at: STRAKS }), 'gepland');
  // Begonnen om 11:30, 30 min + 15 speling → tot 12:15 nog gepland.
  assert.equal(cat({ status: 'scheduled', scheduled_at: '2026-10-01T11:30:00Z' }), 'gepland');
});

test('voorbij en leeg: nog niet vastgelegd', () => {
  assert.equal(cat({ status: 'scheduled', scheduled_at: VERLEDEN }), 'nog_niet_vastgelegd');
  assert.equal(cat({ status: 'completed', scheduled_at: VERLEDEN }), 'nog_niet_vastgelegd',
    'een status completed zonder uitkomst zegt niet WAT er besloten is');
  assert.equal(cat({ status: 'no_show', scheduled_at: VERLEDEN }), 'nog_niet_vastgelegd',
    'no_show van elders zonder uitkomst praten we niet na');
});

test('verzetten / annuleren als uitkomst vallen terug op de status', () => {
  assert.equal(cat({ uitkomst: 'annuleren', status: 'cancelled', scheduled_at: VERLEDEN }), 'geannuleerd');
  assert.equal(cat({ uitkomst: 'verzetten', status: 'verplaatst', scheduled_at: VERLEDEN }), 'nieuw_moment');
});

test('een onbekende status zonder uitkomst wordt Onbekend', () => {
  assert.equal(cat({ status: 'raar', scheduled_at: VERLEDEN }), 'onbekend');
  assert.equal(cat({ status: 'noshow', scheduled_at: VERLEDEN }), 'onbekend');
});

test('categorieVoorAfspraak geeft altijd een bestaande key', () => {
  for (const uitkomst of UITKOMSTEN) for (const status of STATUSSEN) for (const scheduled_at of MOMENTEN) {
    const k = cat({ uitkomst, status, scheduled_at });
    assert.ok(lib.CATEGORIE_KEYS.includes(k), k);
  }
  assert.ok(lib.CATEGORIE_KEYS.includes(lib.categorieVoorAfspraak(null)));
});

test('categorieën: unieke keys, oplopende volgorde, elk een kleur en label', () => {
  const keys = lib.CATEGORIEEN.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length);
  lib.CATEGORIEEN.forEach((c, i) => {
    assert.equal(c.volgorde, i + 1);
    assert.match(c.kleur, /^#[0-9a-f]{6}$/i);
    assert.ok(c.label && !c.label.includes('_'));
  });
  assert.equal(lib.categorieInfo('bestaat_niet').key, 'onbekend');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · afspraakStaat IS callStaat
// ═══════════════════════════════════════════════════════════════════════════

test('afspraakStaat geeft exact wat callStaat uit het rapport geeft', () => {
  const nu = Date.parse('2026-10-01T12:00:00Z');
  const momenten = ['2026-10-01T09:00:00Z', '2026-10-01T11:15:00Z', '2026-10-01T11:15:00.001Z',
    '2026-10-01T11:14:59Z', '2026-10-01T12:00:00Z', '2026-10-02T09:00:00Z', 'onzin', null, undefined];
  const duren = [undefined, null, 0, -5, 15, 30, 60, '45', NaN];
  for (const status of STATUSSEN) for (const scheduled_at of momenten) for (const duration_minutes of duren) {
    const a = { status, scheduled_at, duration_minutes };
    assert.equal(lib.afspraakStaat(a, nu), callStaat(a, nu), JSON.stringify(a));
  }
});
