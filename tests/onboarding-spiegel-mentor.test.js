// tests/onboarding-spiegel-mentor.test.js
//
// DE VRAAG DIE DIT BEANTWOORDT. Na de eerste geslaagde hersync stonden er 25
// rijen in hlms_crm_onboarding, waarvan er 13 een mentor_id hadden en 12 niet.
// Die twaalf konden twee dingen betekenen:
//
//   a) in het CRM is er nog geen mentor toegewezen — normaal voor een verse
//      onboarding, en het mentorscherm hoort ze dan ook niemand te tonen;
//   b) er staat in het CRM WEL een mentor, maar we konden 'm niet vertalen
//      naar hlms_personeel — een mankement, en dan blijft het scherm bij die
//      klanten leeg om de verkeerde reden.
//
// Het verschil was NIET vast te stellen: `leesLmsMentorId()` gaf in beide
// gevallen `null`, en vier verschillende oorzaken kwamen op één hoop. Dat is
// dezelfde vorm als "leeg is niet hetzelfde als niet-gelukt", nu op het
// mentorveld.
//
// Vanaf nu draagt de spiegel de REDEN mee en telt de hersync ze apart, zodat
// één druk op de knop het antwoord geeft in plaats van een vergelijking tussen
// twee databanken.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const url = (p) => pathToFileURL(path.resolve(process.cwd(), p)).href;
const lees = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8');

const KERN = 'api/_lib/onboarding-spiegel-sync.js';

// ══════════════════════════════════════════════════════════════════════════
// DE REDEN MOET BESTAAN
// ══════════════════════════════════════════════════════════════════════════

test('MENTOR 1 — geen-mentor-in-crm is een EIGEN reden, niet hetzelfde als mislukt', () => {
  const bron = lees('api/_lib/onboarding-spiegel.js');
  assert.match(bron, /MENTOR_GEEN_IN_CRM\s*=\s*'geen-mentor-in-crm'/,
    'er hoort een aparte reden te zijn voor "nog niemand toegewezen"');
  assert.match(bron, /return \{ id: null, reden: MENTOR_GEEN_IN_CRM \}/,
    'ontbrekende mentor_user_id hoort die reden terug te geven');
});

test('MENTOR 2 — de vier oorzaken komen niet meer op één hoop', () => {
  const bron = lees('api/_lib/onboarding-spiegel.js');
  const stuk = bron.slice(bron.indexOf('async function leesLmsMentorId'));
  const eind = stuk.indexOf('\n}');
  const fn = stuk.slice(0, eind);
  for (const reden of ['geen-mentor-in-crm', 'mentor-niet-in-team_members',
    'mentor-niet-actief-in-crm', 'mentor-zonder-email-in-crm']) {
    assert.ok(fn.includes(reden) || fn.includes('MENTOR_GEEN_IN_CRM'),
      'oorzaak ' + reden + ' heeft geen eigen reden');
  }
  // En een kale `return null` mag er niet meer in zitten: dat is precies de
  // vorm waarin het verschil verdween.
  assert.ok(!/\breturn null;/.test(fn),
    'leesLmsMentorId geeft nog ergens een kale null terug');
});

test('MENTOR 3 — een onleesbare team_members blijft gooien (bronstoring)', () => {
  // Anders zou "de databank hapert" als "deze mentor bestaat niet" gelezen
  // worden, en dat is een uitspraak die we niet mogen doen.
  const bron = lees('api/_lib/onboarding-spiegel.js');
  assert.match(bron, /throw new Error\('team_members lezen: '/);
});

// ══════════════════════════════════════════════════════════════════════════
// DE HERSYNC TELT ZE APART — met een nagebootste databank
// ══════════════════════════════════════════════════════════════════════════

function nepAdmin(ids) {
  const from = () => {
    const k = {
      select() { return k; }, neq() { return k; }, is() { return k; }, not() { return k; },
      async limit() { return { data: ids.map((id) => ({ id })), error: null }; },
    };
    return k;
  };
  return { from };
}

function nepLms() {
  const from = () => {
    const k = {
      _del: false,
      select() { return k; }, delete() { k._del = true; return k; }, eq() { return k; },
      then(res, rej) {
        return Promise.resolve(k._del ? { error: null } : { data: [], error: null })
          .then(res, rej);
      },
    };
    return k;
  };
  return { from };
}

async function draai({ ids, mentorPer }) {
  mock.restoreAll();
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: nepAdmin(ids) } });
  mock.module(url('api/_lib/dfo-lms-db.js'), {
    namedExports: {
      getDfoLmsClient: () => nepLms(),
      UNIQUE_VIOLATION: '23505', isUniqueViolation: () => false,
    },
  });
  mock.module(url('api/_lib/onboarding-spiegel.js'), {
    namedExports: {
      SPIEGEL_TABEL: 'hlms_crm_onboarding',
      SPIEGEL_GESCHREVEN: 'geschreven', SPIEGEL_VERWIJDERD: 'verwijderd',
      SPIEGEL_AFWEZIG: 'afwezig', SPIEGEL_MISLUKT: 'mislukt',
      BRON_GELEZEN: 'gelezen', BRON_ONBEREIKBAAR: 'onbereikbaar',
      BRON_NIET_GECONFIGUREERD: 'niet-geconfigureerd',
      MENTOR_GEEN_IN_CRM: 'geen-mentor-in-crm',
      spiegelOnboarding: async (id) => ({
        resultaat: 'geschreven', bron_status: 'gelezen', fout: null,
        mentor: mentorPer(id),
      }),
    },
  });
  const mod = await import(url(KERN) + '?t=' + Math.random());
  return (await mod.draaiSpiegelSync({ door: 'test' })).result;
}

test('MENTOR 4 — met mentor, zonder mentor en niet-vertaalbaar worden apart geteld', async () => {
  // Precies het beeld van 10 september, maar dan uitgesplitst.
  const r = await draai({
    ids: ['a', 'b', 'c', 'd'],
    mentorPer: (id) => {
      if (id === 'a') return { id: 'lms-1', reden: null };
      if (id === 'b') return { id: 'lms-2', reden: null };
      if (id === 'c') return { id: null, reden: 'geen-mentor-in-crm' };
      return { id: null, reden: 'geen-lms-mentor-voor-chesney@voorbeeld.nl' };
    },
  });
  assert.equal(r.mentor_gespiegeld, 2);
  assert.equal(r.mentor_geen_in_crm, 1);
  assert.equal(r.mentor_niet_vertaald, 1);
});

test('MENTOR 5 — het niet-vertaalbare geval komt MET reden mee, het normale niet', async () => {
  const r = await draai({
    ids: ['c', 'd'],
    mentorPer: (id) => (id === 'c'
      ? { id: null, reden: 'geen-mentor-in-crm' }
      : { id: null, reden: 'geen-lms-mentor-voor-chesney@voorbeeld.nl' }),
  });
  assert.equal(r.mentor_open.length, 1,
    'alleen het mankement hoort in de lijst; "nog geen mentor" is geen probleem');
  assert.equal(r.mentor_open[0].onboarding_id, 'd');
  assert.match(r.mentor_open[0].reden, /geen-lms-mentor-voor/);
});

test('MENTOR 6 — een geslaagde spiegel met lege mentor telt NIET als mislukt', async () => {
  // De rij is geschreven; dat de mentor leeg is, is een aparte vraag.
  const r = await draai({
    ids: ['c'],
    mentorPer: () => ({ id: null, reden: 'geen-mentor-in-crm' }),
  });
  assert.equal(r.geschreven, 1);
  assert.equal(r.mislukt, 0);
});

test('MENTOR 7 — het scherm toont de uitsplitsing, niet één mentor-teller', () => {
  const hub = lees('modules/onboarding-hub.html');
  assert.match(hub, /nog geen mentor in het CRM/);
  assert.match(hub, /wel in het CRM, niet te koppelen/);
  assert.match(hub, /mentor_open/, 'de lijst met redenen wordt niet gerenderd');
});
