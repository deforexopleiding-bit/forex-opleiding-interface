// tests/lms-onboarding-overzicht.test.js
//
// Hoofdmentor > Onboarding in het LMS (5 oktober 2026): de live leesroute en
// de schrijfacties op onboarding-id. Het CRM blijft de bron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import overzicht from '../api/lms-onboarding-overzicht.js';
import sessie, { ONBOARDING_ACTIES } from '../api/lms-onboarding-sessie.js';
import { zetStartdatumOnboarding, zetStartstatus } from '../api/_lib/onboarding-acties.js';

function nepRes() {
  const uit = { status: null, body: null, headers: {} };
  return {
    uit,
    setHeader: (k, v) => { uit.headers[k] = v; },
    status(c) { uit.status = c; return this; },
    json(b) { uit.body = b; return this; },
  };
}

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('DE LEESROUTE IS DICHT zonder geheim, met een fout geheim, en voor POST', async () => {
  const oud = { ...process.env };
  try {
    delete process.env.DFO_LMS_PUSH_SECRET; delete process.env.DFO_LMS_AGENDA_SECRET;
    let r = nepRes();
    await overzicht({ method: 'GET', headers: {} }, r);
    assert.equal(r.uit.status, 503);

    process.env.DFO_LMS_PUSH_SECRET = 'geheim';
    r = nepRes();
    await overzicht({ method: 'GET', headers: { 'x-dfo-secret': 'fout' } }, r);
    assert.equal(r.uit.status, 403);

    r = nepRes();
    await overzicht({ method: 'POST', headers: { 'x-dfo-secret': 'geheim' } }, r);
    assert.equal(r.uit.status, 405);
  } finally {
    process.env = oud;
  }
});

test('CONTRACT: de leesroute gebruikt DEZELFDE bouwer en afleiding als het CRM-scherm, en schrijft niets', () => {
  const bron = lees('api/lms-onboarding-overzicht.js');
  assert.match(bron, /bouwOverzichtRijen\(/);
  assert.match(bron, /intakeItemsVoor\(/);
  assert.doesNotMatch(bron, /\.(insert|update|upsert|delete)\(/, 'de leesroute schrijft');
  //  Het betaaltoken van de klant gaat niet naar het LMS.
  assert.match(bron, /token:\s*undefined/);
  //  En het CRM-scherm leest via dezelfde bouwer.
  assert.match(lees('api/admin-future-students-list.js'), /bouwOverzichtRijen\(/);
  assert.match(lees('api/onboarding-intake-status.js'), /intakeItemsVoor\(/);
});

test('DE SCHRIJFACTIES: acht op onboarding-id, en GEEN annuleren of archiveren', async () => {
  // handmatig_afronden, naar_incasso en terug_activeren kwamen erbij op
  // 6 oktober 2026 (Maxim). Naar incasso is uitdrukkelijk NIET annuleren.
  // koppel_student op 7 oktober 2026: een bedrijf aan zijn LMS-student.
  assert.deepEqual([...ONBOARDING_ACTIES].sort(),
    ['handmatig_afronden', 'koppel_student', 'mentor_toewijzen', 'naar_incasso', 'notitie', 'startdatum', 'startstatus', 'terug_activeren']);
  const oud = { ...process.env };
  try {
    process.env.DFO_LMS_PUSH_SECRET = 'geheim';
    for (const actie of ['annuleren', 'archiveren', 'onboarding_cancel']) {
      const r = nepRes();
      await sessie({ method: 'POST', headers: { 'x-dfo-secret': 'geheim' },
        body: { actie, onboarding_id: '00000000-0000-4000-8000-000000000001' } }, r);
      assert.equal(r.uit.body.code, 'ongeldige_actie', actie + ' hoort niet te bestaan');
    }
    const r = nepRes();
    await sessie({ method: 'POST', headers: { 'x-dfo-secret': 'geheim' },
      body: { actie: 'notitie', onboarding_id: 'geen-uuid', tekst: 'x' } }, r);
    assert.equal(r.uit.body.code, 'ongeldig_verzoek');
  } finally {
    process.env = oud;
  }
  const bron = lees('api/lms-onboarding-sessie.js');
  assert.doesNotMatch(bron, /onboarding-cancel|onboarding-archive/);
  assert.match(bron, /wijsMentorToe\(/);
  assert.match(bron, /zetStartdatumOnboarding\(/);
});

test('DE STARTDATUMGRENS GELDT OOK VIA DE GEDEELDE FUNCTIE — vóór er iets gelezen wordt', async () => {
  const gisteren = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const uit = await zetStartdatumOnboarding({ onboardingId: 'x', startDatum: gisteren });
  assert.equal(uit.status, 400);
  assert.equal(uit.body.code, 'START_DATE_TOO_EARLY');
  assert.ok(uit.body.min);
  const fout = await zetStartdatumOnboarding({ onboardingId: 'x', startDatum: '05-10-2026' });
  assert.equal(fout.status, 400);
});

test('DE STARTSTATUS weigert een woord buiten de lijst — vóór er iets gelezen wordt', async () => {
  const uit = await zetStartstatus({ onboardingId: 'x', status: 'gestart' });
  assert.equal(uit.status, 400);
});

test('CONTRACT: de CRM-schermen en de LMS-route delen één uitvoering', () => {
  assert.match(lees('api/onboarding-assign-mentor.js'), /wijsMentorToe\(/);
  assert.match(lees('api/admin-onboarding-start-date.js'), /zetStartdatumOnboarding\(/);
  assert.match(lees('api/admin-onboarding-note.js'), /schrijfOnboardingNotitie\(/);
  //  En de automatische statuswijziging spiegelt nu ook.
  assert.match(lees('api/_lib/onboarding-automation-engine.js'), /spiegelNaActie\(onboarding\.id, 'automation-update-status'\)/);
});
