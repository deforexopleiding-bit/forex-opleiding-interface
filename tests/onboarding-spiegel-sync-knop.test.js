// tests/onboarding-spiegel-sync-knop.test.js
//
// WAT HIER MIS GING. Op 10 september 2026 stond `hlms_crm_onboarding` op NUL
// rijen terwijl de inhaalslag-knop 23 koppelingen als geslaagd had gemeld. De
// koppeling was gelegd, de spiegel was nergens geschreven — en van buiten zag
// dat er identiek uit. `spiegelNaActie()` is faalzacht en schreef zijn reden
// alleen naar de log; de knop telde 'm niet mee en de gebruiker zag "gelukt".
//
// Twee dingen worden hier bewaakt:
//   1. De hersync heeft één implementatie met twee ingangen (cron + knop), en
//      de knop zit achter dezelfde rechtensleutel als de rest.
//   2. Een mislukte spiegel telt als mislukt — in de hersync én in de
//      inhaalslag. Een knop die "gelukt" zegt over half werk is erger dan
//      geen knop.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const url = (p) => pathToFileURL(path.resolve(process.cwd(), p)).href;
const lees = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8');

const KNOP = 'api/onboarding-spiegel-sync-run.js';
const CRON = 'api/cron/onboarding-spiegel-sync.js';
const KERN = 'api/_lib/onboarding-spiegel-sync.js';
const HUB  = 'modules/onboarding-hub.html';

// ══════════════════════════════════════════════════════════════════════════
// ÉÉN IMPLEMENTATIE, TWEE INGANGEN
// ══════════════════════════════════════════════════════════════════════════

test('KNOP 1 — de knop heeft GEEN eigen sync-logica, hij deelt de kern', () => {
  const bron = lees(KNOP);
  assert.match(bron, /draaiSpiegelSync/, 'de knop hoort de gedeelde kern aan te roepen');
  // Zou de knop zelf onboardings bevragen of naar het LMS schrijven, dan
  // kunnen de twee ingangen uit elkaar lopen en bewaakt de rest maar de helft.
  assert.doesNotMatch(bron, /from\(['"]onboardings['"]\)/,
    'de knop bevraagt zelf onboardings — dat hoort in de kern');
  assert.doesNotMatch(bron, /getDfoLmsClient/,
    'de knop praat zelf met het LMS — dat hoort in de kern');
});

test('KNOP 2 — de cron heeft ook geen eigen logica meer', () => {
  const bron = lees(CRON);
  assert.match(bron, /draaiSpiegelSync/);
  assert.doesNotMatch(bron, /from\(['"]onboardings['"]\)/);
  assert.doesNotMatch(bron, /getDfoLmsClient/);
});

test('KNOP 3 — dezelfde rechtensleutel als de inhaalslag ernaast', () => {
  const bron = lees(KNOP);
  assert.match(bron, /requirePermission\(req,\s*['"]students\.all\.view['"]\)/,
    'de knop hoort achter students.all.view te zitten');
  assert.match(bron, /res\.status\(403\)/, 'zonder recht hoort er een 403 te komen');
  assert.match(bron, /res\.status\(401\)/, 'zonder sessie hoort er een 401 te komen');
});

test('KNOP 4 — POST-only; een GET mag dit niet in gang zetten', () => {
  const bron = lees(KNOP);
  assert.match(bron, /req\.method\s*!==\s*['"]POST['"]/);
  assert.match(bron, /res\.status\(405\)/);
});

test('KNOP 5 — de rechtencontrole staat VOOR het werk, niet erna', () => {
  const bron = lees(KNOP);
  const rechten = bron.indexOf('requirePermission');
  const werk    = bron.indexOf('draaiSpiegelSync(');
  assert.ok(rechten > -1 && werk > -1);
  assert.ok(rechten < werk,
    'de rechtencontrole moet vóór draaiSpiegelSync staan');
});

test('KNOP 6 — het cron-geheim geeft GEEN toegang tot de knop', () => {
  // Anders zou een gelekt CRON_SECRET langs de rechtencontrole komen.
  // Op GEBRUIK toetsen, niet op het woord: de toelichting bovenaan het
  // bestand noemt CRON_SECRET om uit te leggen waarom deze knop bestaat, en
  // een test die daarop afgaat dwingt je om het commentaar te slopen in
  // plaats van de code te repareren.
  const bron = lees(KNOP);
  assert.doesNotMatch(bron, /process\.env\.CRON_SECRET/,
    'de knop leest het cron-geheim uit');
  assert.doesNotMatch(bron, /['"]Bearer\s/,
    'de knop accepteert een Bearer-geheim naast de gebruikerssessie');
  assert.doesNotMatch(bron, /req\.headers\[['"]authorization['"]\]/,
    'de knop kijkt zelf naar de authorization-header in plaats van naar de sessie');
});

// ══════════════════════════════════════════════════════════════════════════
// DE REDEN MOET MEEKOMEN
// ══════════════════════════════════════════════════════════════════════════

test('REDEN 1 — de kern draagt de letterlijke fout per onboarding mee', () => {
  const bron = lees(KERN);
  assert.match(bron, /errors\.push\(\{\s*onboarding_id/,
    'per mislukte rij hoort de onboarding-id én de melding in errors te komen');
  assert.match(bron, /uit\.fout/,
    'de melding uit spiegelOnboarding hoort overgenomen te worden, niet weggegooid');
});

test('REDEN 2 — het scherm toont die redenen, niet alleen een totaal', () => {
  const bron = lees(HUB);
  assert.match(bron, /Waarom het misging/,
    'het scherm hoort de foutredenen te tonen');
  assert.match(bron, /spiegelRender/);
  assert.match(bron, /onboarding-spiegel-sync-run/,
    'het scherm hoort het knop-endpoint aan te roepen');
});

test('REDEN 3 — de inhaalslag telt een mislukte spiegel als mislukt', () => {
  const bron = lees('api/_lib/onboarding-lms-backfill.js');
  assert.match(bron, /spiegel_mislukt/,
    'de inhaalslag hoort een mislukte spiegel apart te tellen');
  assert.match(bron, /spiegel_geschreven/);
  // En de uitkomst van spiegelNaActie moet daadwerkelijk gelezen worden,
  // niet aangeroepen-en-weggegooid zoals eerst.
  assert.match(bron, /const\s+sp\s*=\s*await\s+spiegelNaActie/,
    'de uitkomst van spiegelNaActie moet vastgehouden worden');
});

test('REDEN 4 — het scherm laat de spiegel-mislukking van de inhaalslag zien', () => {
  assert.match(lees(HUB), /spiegel MISLUKT/,
    'een mislukte spiegel mag niet achter het koppel-totaal verdwijnen');
});

// ══════════════════════════════════════════════════════════════════════════
// GEDRAG VAN DE KERN — met een nagebootste databank
// ══════════════════════════════════════════════════════════════════════════

function nepAdmin(ids) {
  const from = () => {
    const k = {
      select() { return k; }, neq() { return k; }, is() { return k; },
      not() { return k; },
      async limit() { return { data: ids.map((id) => ({ id })), error: null }; },
    };
    return k;
  };
  return { from };
}

function nepLms({ aanwezig = [], leesFout = null, deleteFout = null } = {}) {
  const verwijderd = [];
  const from = () => {
    const k = {
      _del: false,
      select() { return k; },
      delete() { k._del = true; return k; },
      eq(_kolom, waarde) {
        if (k._del) verwijderd.push(waarde);
        return k;
      },
      then(res, rej) {
        if (k._del) {
          return Promise.resolve({ error: deleteFout }).then(res, rej);
        }
        return Promise.resolve(leesFout
          ? { data: null, error: leesFout }
          : { data: aanwezig.map((id) => ({ crm_onboarding_id: id })), error: null }
        ).then(res, rej);
      },
    };
    return k;
  };
  return { from, _verwijderd: verwijderd };
}

async function draai({ ids = [], aanwezig = [], spiegelUitkomst = null,
  leesFout = null, dry = false } = {}) {
  const lms = nepLms({ aanwezig, leesFout });
  mock.restoreAll();
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: nepAdmin(ids) } });
  mock.module(url('api/_lib/dfo-lms-db.js'), {
    namedExports: {
      getDfoLmsClient: () => lms,
      UNIQUE_VIOLATION: '23505',
      isUniqueViolation: () => false,
    },
  });
  mock.module(url('api/_lib/onboarding-spiegel.js'), {
    namedExports: {
      SPIEGEL_TABEL: 'hlms_crm_onboarding',
      SPIEGEL_GESCHREVEN: 'geschreven', SPIEGEL_VERWIJDERD: 'verwijderd',
      SPIEGEL_AFWEZIG: 'afwezig', SPIEGEL_MISLUKT: 'mislukt',
      BRON_GELEZEN: 'gelezen', BRON_ONBEREIKBAAR: 'onbereikbaar',
      BRON_NIET_GECONFIGUREERD: 'niet-geconfigureerd',
      spiegelOnboarding: async (id) => (spiegelUitkomst
        ? spiegelUitkomst(id)
        : { resultaat: 'geschreven', bron_status: 'gelezen', fout: null }),
    },
  });
  const mod = await import(url(KERN) + '?t=' + Math.random());
  return { ...(await mod.draaiSpiegelSync({ dry, door: 'test' })), lms };
}

test('KERN 1 — schrijft elke verwachte onboarding', async () => {
  const { status, result } = await draai({ ids: ['a', 'b', 'c'] });
  assert.equal(status, 200);
  assert.equal(result.verwacht, 3);
  assert.equal(result.geschreven, 3);
  assert.equal(result.mislukt, 0);
});

test('KERN 2 — een mislukte rij telt als mislukt EN draagt zijn reden mee', async () => {
  const { result } = await draai({
    ids: ['a', 'b'],
    spiegelUitkomst: (id) => (id === 'b'
      ? { resultaat: 'mislukt', bron_status: 'onbereikbaar', fout: 'tabel bestaat niet' }
      : { resultaat: 'geschreven', bron_status: 'gelezen', fout: null }),
  });
  assert.equal(result.geschreven, 1);
  assert.equal(result.mislukt, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].onboarding_id, 'b');
  assert.match(result.errors[0].error, /tabel bestaat niet/,
    'de letterlijke reden hoort mee te komen — daar is de knop voor');
});

test('KERN 3 — overtollige rijen worden verwijderd', async () => {
  const { result, lms } = await draai({ ids: ['a'], aanwezig: ['a', 'oud'] });
  assert.equal(result.overtollig_verwijderd, 1);
  assert.deepEqual(lms._verwijderd, ['oud']);
});

test('KERN 4 — mislukt de LEZING van de spiegel, dan wordt er NIETS verwijderd', async () => {
  // Anders zou één storing de hele spiegel legen.
  const { status, result, lms } = await draai({
    ids: ['a'], aanwezig: ['a', 'oud'],
    leesFout: { message: 'databank weg' },
  });
  assert.equal(status, 502);
  assert.equal(result.ok, false);
  assert.equal(lms._verwijderd.length, 0, 'er mag niets verwijderd zijn');
  assert.match(result.error, /databank weg/);
});

test('KERN 5 — droogloop schrijft en verwijdert niets', async () => {
  const geschreven = [];
  const { result, lms } = await draai({
    ids: ['a', 'b'], aanwezig: ['oud'], dry: true,
    spiegelUitkomst: (id) => { geschreven.push(id); return { resultaat: 'geschreven' }; },
  });
  assert.equal(geschreven.length, 0, 'droogloop mag spiegelOnboarding niet aanroepen');
  assert.equal(lms._verwijderd.length, 0);
  assert.equal(result.geschreven, 0);
  assert.equal(result.overtollig_verwijderd, 1, 'wel TELLEN wat er zou gebeuren');
});
