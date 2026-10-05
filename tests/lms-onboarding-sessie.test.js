// tests/lms-onboarding-sessie.test.js
//
// De machine-route die het LMS aanroept zodra een sessie afgerond is, en de
// gedeelde afsluitregel die de cron en die route samen gebruiken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import handler, { machineToegang } from '../api/lms-onboarding-sessie.js';
import {
  besluitAfsluiting, afsluitPatch,
  AFSLUITEN, GEEN_ONBOARDING, AL_AUTOMATISCH, NIET_AANRAKEN, AL_AFGEROND,
} from '../api/_lib/onboarding-afsluiten-na-sessie.js';

function nepRes() {
  const uit = { status: null, body: null, headers: {} };
  return {
    uit,
    setHeader: (k, v) => { uit.headers[k] = v; },
    status(c) { uit.status = c; return this; },
    json(b) { uit.body = b; return this; },
  };
}

test('ZONDER GEHEIM IS DE ROUTE DICHT — geen lege string die toevallig matcht', () => {
  assert.equal(machineToegang('', {}), 'niet_geconfigureerd');
  assert.equal(machineToegang('x', { DFO_LMS_PUSH_SECRET: '' }), 'niet_geconfigureerd');
});

test('beide gedeelde geheimen werken, een fout geheim niet', () => {
  const env = { DFO_LMS_PUSH_SECRET: 'push', DFO_LMS_AGENDA_SECRET: 'agenda' };
  assert.equal(machineToegang('push', env), 'ok');
  assert.equal(machineToegang('agenda', env), 'ok');
  assert.equal(machineToegang('fout', env), 'dicht');
  assert.equal(machineToegang(undefined, env), 'dicht');
});

test('de route weigert zonder geheim, met een fout geheim, en een onbekende actie', async () => {
  const oud = { ...process.env };
  try {
    delete process.env.DFO_LMS_PUSH_SECRET; delete process.env.DFO_LMS_AGENDA_SECRET;
    let r = nepRes();
    await handler({ method: 'POST', headers: {}, body: {} }, r);
    assert.equal(r.uit.status, 503);

    process.env.DFO_LMS_PUSH_SECRET = 'geheim';
    r = nepRes();
    await handler({ method: 'POST', headers: { 'x-dfo-secret': 'fout' }, body: {} }, r);
    assert.equal(r.uit.status, 403);
    assert.equal(r.uit.body.code, 'machine_toegang_dicht');

    r = nepRes();
    await handler({ method: 'POST', headers: { 'x-dfo-secret': 'geheim' },
      body: { actie: 'iets', student_id: '00000000-0000-4000-8000-000000000001' } }, r);
    assert.equal(r.uit.body.code, 'ongeldige_actie');

    r = nepRes();
    await handler({ method: 'POST', headers: { 'x-dfo-secret': 'geheim' },
      body: { actie: 'sessie_afgerond', student_id: 'geen-uuid' } }, r);
    assert.equal(r.uit.body.code, 'ongeldig_verzoek');
  } finally {
    process.env = oud;
  }
});

test('besluitAfsluiting: dezelfde volgorde als de cron altijd had', () => {
  assert.equal(besluitAfsluiting(null), GEEN_ONBOARDING);
  assert.equal(besluitAfsluiting({ id: 'o', auto_afgerond_sessie_id: 's', status: 'bezig' }), AL_AUTOMATISCH);
  assert.equal(besluitAfsluiting({ id: 'o', status: 'geannuleerd' }), NIET_AANRAKEN);
  assert.equal(besluitAfsluiting({ id: 'o', status: 'bezig', archived_at: '2026-10-01' }), NIET_AANRAKEN);
  assert.equal(besluitAfsluiting({ id: 'o', status: 'afgerond' }), AL_AFGEROND);
  assert.equal(besluitAfsluiting({ id: 'o', status: 'aangemeld' }), AFSLUITEN);
  assert.equal(besluitAfsluiting({ id: 'o', status: 'bezig' }), AFSLUITEN);
});

test('de patch legt de OORZAAK vast: sessie-id, -tijd, -titel en het moment', () => {
  const p = afsluitPatch({ id: 's1', start_tijd: '2026-10-05T17:00:00.000Z', titel: 'Eerste sessie' }, 'NU');
  assert.deepEqual(p, {
    status: 'afgerond', completed_at: 'NU',
    auto_afgerond_sessie_id: 's1', auto_afgerond_sessie_op: '2026-10-05T17:00:00.000Z',
    auto_afgerond_sessie_titel: 'Eerste sessie', auto_afgerond_op: 'NU', updated_at: 'NU',
  });
});

test('CONTRACT: de route leest de afgeronde sessie zelf en vertrouwt het verzoek niet', () => {
  const bron = readFileSync(new URL('../api/lms-onboarding-sessie.js', import.meta.url), 'utf8');
  assert.match(bron, /\.eq\('status', 'afgerond'\)/);
  assert.match(bron, /order\('start_tijd', \{ ascending: true \}\)/, 'de EERSTE afgeronde sessie');
  assert.match(bron, /sluitOnboardingAf\(/, 'afsluiten via de gedeelde helper met de wacht in de update');
  assert.doesNotMatch(bron, /Access-Control-Allow-Origin/, 'machine-route: geen CORS');
});

test('CONTRACT: de afsluiting heeft de wacht tegen dubbel afsluiten in de update zelf', () => {
  const bron = readFileSync(new URL('../api/_lib/onboarding-afsluiten-na-sessie.js', import.meta.url), 'utf8');
  assert.match(bron, /\.is\('auto_afgerond_sessie_id', null\)/);
});

// ── START LATER OP: de startdatum vanuit het LMS ────────────────────────────

import {
  besluitStartdatum, SD_WIJZIGEN, SD_ONGEWIJZIGD, SD_GEEN_ONBOARDING, SD_NIET_AANRAKEN,
  SD_AL_AFGEROND, SD_TE_VROEG, SD_ONGELDIG,
} from '../api/_lib/onboarding-startdatum-lms.js';

test('besluitStartdatum: dezelfde ondergrens als de CRM-knop (vandaag + 3)', () => {
  const nu = new Date('2026-10-05T10:00:00Z');
  const ob = { id: 'o1', status: 'nieuw', start_date: '2026-10-20' };
  assert.equal(besluitStartdatum(ob, '2026-11-01', nu).besluit, SD_WIJZIGEN);
  const vroeg = besluitStartdatum(ob, '2026-10-06', nu);
  assert.equal(vroeg.besluit, SD_TE_VROEG);
  assert.equal(vroeg.min, '2026-10-08');
  // TEGENPROEF: precies op de grens mag het.
  assert.equal(besluitStartdatum(ob, '2026-10-08', nu).besluit, SD_WIJZIGEN);
  assert.equal(besluitStartdatum(ob, '2026-10-20', nu).besluit, SD_ONGEWIJZIGD);
  assert.equal(besluitStartdatum(ob, '20-10-2026', nu).besluit, SD_ONGELDIG);
  assert.equal(besluitStartdatum(null, '2026-11-01', nu).besluit, SD_GEEN_ONBOARDING);
  assert.equal(besluitStartdatum({ ...ob, status: 'gearchiveerd' }, '2026-11-01', nu).besluit, SD_NIET_AANRAKEN);
  assert.equal(besluitStartdatum({ ...ob, archived_at: '2026-01-01' }, '2026-11-01', nu).besluit, SD_NIET_AANRAKEN);
  assert.equal(besluitStartdatum({ ...ob, status: 'afgerond' }, '2026-11-01', nu).besluit, SD_AL_AFGEROND);
});

test('de route kent de actie startdatum, en een ongeldige datum is een 400', async () => {
  const oud = { ...process.env };
  try {
    process.env.DFO_LMS_PUSH_SECRET = 'geheim';
    const r = nepRes();
    await handler({ method: 'POST', headers: { 'x-dfo-secret': 'geheim' },
      body: { actie: 'startdatum', student_id: 'geen-uuid', start_datum: '2027-01-04' } }, r);
    // Niet 'ongeldige_actie': de actie bestaat, het verzoek klopt niet.
    assert.equal(r.uit.body.code, 'ongeldig_verzoek');
  } finally {
    process.env = oud;
  }
});

test('CONTRACT: de startdatum-actie schrijft alleen start_date en stuurt niets naar de klant', () => {
  const bron = readFileSync(new URL('../api/lms-onboarding-sessie.js', import.meta.url), 'utf8');
  const stuk = bron.slice(bron.indexOf('async function zetStartdatum'), bron.indexOf('async function meldHoofdmentoren'));
  assert.match(stuk, /\.update\(\{ start_date: startDatum \}\)/);
  assert.doesNotMatch(stuk, /sendOnboardingMail|sendOnboardingTemplate|createNotification|whatsapp/i);
  assert.match(stuk, /besluitStartdatum\(/);
});
