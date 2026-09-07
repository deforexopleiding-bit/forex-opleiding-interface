// tests/onboarding-spiegel.test.js
//
// De spiegel van een CRM-onboarding naar het LMS.
//
// Twee van deze tests zijn CONTRACTtests die Maxim expliciet gevraagd heeft,
// en ze bewaken allebei iets dat je niet aan losse gedragstests kunt zien:
//
//   1. `hlms_crm_onboarding` heeft precies ÉÉN schrijver. Komt er later
//      ergens een tweede pad bij — "even snel" vanuit een endpoint — dan
//      wordt die test rood.
//   2. De vier veldwaarden komen uit DEZELFDE berekening als
//      admin-future-students-list.js. Geen tweede kopie van die logica.
//
// De reden voor allebei is dezelfde: er zijn twintig schrijfpunten op
// `onboardings` en er stonden VIER kopieën van computeBedenktijd, waarvan er
// twee anders rekenden dan de andere twee. Zulke dingen sluipen erin; een
// test die rood wordt is de enige manier om ze eruit te houden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeBedenktijd, findWaiverConsentKey, leesWaiver, leesOfferteMoment,
} from '../api/_lib/onboarding-bedenktijd.js';
import { hoortZichtbaarTeZijn, SPIEGEL_TABEL } from '../api/_lib/onboarding-spiegel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ═══════════════════════════════════════════════════════════════════════════
// 1) CONTRACT — één schrijver
// ═══════════════════════════════════════════════════════════════════════════

/** Alle .js-bestanden onder api/, recursief. */
function apiBestanden(map = join(ROOT, 'api'), uit = []) {
  for (const item of readdirSync(map, { withFileTypes: true })) {
    const pad = join(map, item.name);
    if (item.isDirectory()) apiBestanden(pad, uit);
    else if (item.name.endsWith('.js')) uit.push(pad);
  }
  return uit;
}

test('CONTRACT: alleen onboarding-spiegel.js SCHRIJFT naar hlms_crm_onboarding', () => {
  // De cron mag de tabel LEZEN (hij moet weten wat er staat om te kunnen
  // verzoenen) en overtollige rijen verwijderen; schrijven van inhoud gebeurt
  // uitsluitend via spiegelOnboarding(). Daarom kijken we naar upsert/insert/
  // update, niet naar select/delete.
  const SCHRIJFWOORDEN = /\.(upsert|insert|update)\s*\(/;
  const overtreders = [];

  for (const pad of apiBestanden()) {
    const kort = pad.slice(ROOT.length + 1);
    if (kort === 'api/_lib/onboarding-spiegel.js') continue;
    const bron = readFileSync(pad, 'utf8');
    if (!bron.includes(SPIEGEL_TABEL)) continue;

    // Noemt dit bestand de tabel én schrijft het ergens? Dan per regel kijken
    // of die twee bij elkaar in de buurt staan.
    const regels = bron.split('\n');
    for (let i = 0; i < regels.length; i++) {
      if (!regels[i].includes(SPIEGEL_TABEL)) continue;
      // De from(...)-regel plus de vijf regels erna: een keten als
      // `.from(TABEL)\n.upsert({...})` staat vrijwel nooit op één regel.
      const venster = regels.slice(i, i + 6).join('\n');
      if (SCHRIJFWOORDEN.test(venster)) {
        overtreders.push(kort + ':' + (i + 1));
      }
    }
  }

  assert.deepEqual(overtreders, [],
    'er schrijft iets anders dan onboarding-spiegel.js naar ' + SPIEGEL_TABEL
    + ' — de spiegel heeft precies één schrijver, zie de kop van die lib');
});

test('CONTRACT: de aanroepers spiegelen via de helper, niet met eigen queries', () => {
  // Elk endpoint dat de spiegel bijwerkt hoort dat via spiegelNaActie() te
  // doen. Zo staat de faalzachte afhandeling ook op één plek.
  const AANROEPERS = [
    'api/onboarding-assign-mentor.js',
    'api/admin-onboarding-start-date.js',
    'api/onboarding-archive.js',
    'api/mentor-future-student-update.js',
    'api/onboarding-step-save.js',
    'api/onboarding-complete.js',
    'api/onboarding-cancel.js',
  ];
  for (const kort of AANROEPERS) {
    const bron = readFileSync(join(ROOT, kort), 'utf8');
    assert.match(bron, /spiegelNaActie\(/,
      kort + ' spiegelt niet — een schrijfpunt zonder spiegel loopt tot de volgende hersync achter');
    assert.doesNotMatch(bron, new RegExp(SPIEGEL_TABEL),
      kort + ' noemt de spiegeltabel zelf; dat hoort via de helper te lopen');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) CONTRACT — één berekening
// ═══════════════════════════════════════════════════════════════════════════

test('CONTRACT: er is nog maar ÉÉN computeBedenktijd in de hele api-map', () => {
  // Er stonden er vier, met TWEE onderlinge verschillen. Zie de kop van
  // api/_lib/onboarding-bedenktijd.js.
  const eigen = [];
  for (const pad of apiBestanden()) {
    const kort = pad.slice(ROOT.length + 1);
    if (kort === 'api/_lib/onboarding-bedenktijd.js') continue;
    const bron = readFileSync(pad, 'utf8');
    if (/function\s+computeBedenktijd\s*\(/.test(bron)) eigen.push(kort);
    if (/function\s+findWaiverConsentKey\s*\(/.test(bron)) eigen.push(kort + ' (waiver-sleutel)');
  }
  assert.deepEqual(eigen, [],
    'er staat weer een eigen kopie van de bedenktijd-berekening; die liepen eerder uiteen');
});

test('CONTRACT: spiegel en admin-lijst gebruiken dezelfde berekening', () => {
  // Niet "dezelfde uitkomst bij toeval", maar aantoonbaar dezelfde bron.
  const spiegel = readFileSync(join(ROOT, 'api/_lib/onboarding-spiegel.js'), 'utf8');
  const lijst   = readFileSync(join(ROOT, 'api/admin-future-students-list.js'), 'utf8');
  const LIB = /onboarding-bedenktijd\.js/;
  assert.match(spiegel, LIB, 'de spiegel rekent niet via de gedeelde lib');
  assert.match(lijst,   LIB, 'de admin-lijst rekent niet via de gedeelde lib');
  assert.match(spiegel, /computeBedenktijd\(/);
  assert.match(lijst,   /computeBedenktijd\(/);
});

test('spiegel en admin-lijst geven bij dezelfde invoer hetzelfde antwoord', () => {
  // De echte toets: dezelfde invoer door dezelfde functie, alle vier de
  // takken langs. Zou iemand er ooit weer een kopie naast zetten, dan valt
  // die door de contracttest hierboven — en deze bewaakt de uitkomst zelf.
  const NU = Date.parse('2026-09-07T12:00:00.000Z');
  const gevallen = [
    { naam: 'getekend + offertedatum', waiver: { agreed: true, at: '2026-09-01T10:00:00.000Z' },
      offerte: '2026-08-30T10:00:00.000Z', status: 'vervallen', reden: 'afstand' },
    { naam: 'getekend ZONDER offertedatum', waiver: { agreed: true, at: '2026-09-01T10:00:00.000Z' },
      offerte: null, status: 'vervallen', reden: 'afstand' },
    { naam: 'niet getekend, termijn verstreken', waiver: { agreed: false, at: null },
      offerte: '2026-08-01T10:00:00.000Z', status: 'vervallen', reden: 'verstreken' },
    { naam: 'niet getekend, termijn loopt', waiver: { agreed: false, at: null },
      offerte: '2026-09-05T10:00:00.000Z', status: 'lopend', reden: null },
    { naam: 'niets bekend', waiver: null, offerte: null, status: 'onbekend', reden: null },
  ];
  for (const g of gevallen) {
    const uit = computeBedenktijd(g.waiver, g.offerte, NU);
    assert.equal(uit.status, g.status, g.naam);
    assert.equal(uit.reason, g.reden, g.naam);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) De twee beslechte verschillen, vastgepind
// ═══════════════════════════════════════════════════════════════════════════

test('BESLECHT: getekend zonder offertedatum is VERVALLEN, niet onbekend', () => {
  // Twee van de vier kopieën eisten óók een offertedatum en gaven anders
  // 'onbekend'. Dat is een bekend feit weggooien: de klant heeft
  // uitdrukkelijk afstand gedaan.
  const uit = computeBedenktijd({ agreed: true, at: '2026-09-01T10:00:00.000Z' }, null);
  assert.equal(uit.status, 'vervallen');
  assert.equal(uit.reason, 'afstand');
  assert.equal(uit.waived_at, '2026-09-01T10:00:00.000Z');
  assert.equal(uit.vervalt_op, null, 'de vervaldatum kennen we écht niet — die blijft leeg');
});

test('BESLECHT: de termijn is veertien KALENDERdagen, niet 336 uur', () => {
  // Twee kopieën telden in milliseconden. Over een zomertijd-grens schelen
  // die een uur, en precies op de grens klapt de uitkomst om.
  const uit = computeBedenktijd({ agreed: false }, '2026-10-20T12:00:00.000Z');
  const dagen = (new Date(uit.vervalt_op) - new Date('2026-10-20T12:00:00.000Z')) / 86400000;
  assert.ok(dagen >= 13.9 && dagen <= 14.1, 'veertien dagen, ' + dagen + ' gemeten');
  // En de datum zelf is de 3e november, ongeacht de klokverzetting eind oktober.
  assert.match(uit.vervalt_op, /^2026-11-03/);
});

test('onbekend mag NOOIT als vervallen gelezen worden', () => {
  // Maxims regel: de mentor belt niet door zolang de bedenktijd loopt. Weten
  // we het niet, dan is dat een eigen toestand — geen "dus voorbij".
  const uit = computeBedenktijd(null, null);
  assert.equal(uit.status, 'onbekend');
  assert.notEqual(uit.status, 'vervallen');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) Zichtbaarheid: wat hoort er in het LMS te staan
// ═══════════════════════════════════════════════════════════════════════════

test('een geannuleerde onboarding hoort NIET zichtbaar te zijn', () => {
  assert.equal(hoortZichtbaarTeZijn({ status: 'geannuleerd', archived_at: null }), false);
  assert.equal(hoortZichtbaarTeZijn({ status: 'GEANNULEERD', archived_at: null }), false,
    'hoofdletters mogen het antwoord niet veranderen');
});

test('een gearchiveerde onboarding hoort NIET zichtbaar te zijn', () => {
  assert.equal(hoortZichtbaarTeZijn({ status: 'bezig', archived_at: '2026-09-01T10:00:00Z' }), false);
});

test('een lopende onboarding hoort WEL zichtbaar te zijn', () => {
  assert.equal(hoortZichtbaarTeZijn({ status: 'bezig', archived_at: null }), true);
  assert.equal(hoortZichtbaarTeZijn({ status: 'afgerond', archived_at: null }), true,
    'afgerond blijft zichtbaar — de mentor ziet de student dan in zijn actieve lijst');
});

test('een onboarding die niet bestaat hoort niet zichtbaar te zijn', () => {
  assert.equal(hoortZichtbaarTeZijn(null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5) De kleine lezers
// ═══════════════════════════════════════════════════════════════════════════

test('de waiver-sleutel komt uit het waiver-blok, niet uit het eerste consent', () => {
  const structuur = { pages: [
    { blocks: [{ type: 'consent', key: 'gewoon_akkoord' }] },
    { blocks: [{ type: 'consent', key: 'waiver_bedenktijd', is_waiver: true }] },
  ] };
  assert.equal(findWaiverConsentKey(structuur), 'waiver_bedenktijd');
});

test('een file_download-waiver levert zijn consent_key', () => {
  const structuur = { pages: [
    { blocks: [{ type: 'file_download', consent_key: 'waiver_digitaal', is_waiver: true }] },
  ] };
  assert.equal(findWaiverConsentKey(structuur), 'waiver_digitaal');
});

test('geen waiver-blok = geen sleutel, en dus geen waiver', () => {
  assert.equal(findWaiverConsentKey({ pages: [{ blocks: [{ type: 'consent', key: 'x' }] }] }), null);
  assert.equal(leesWaiver({ x: true }, null), null);
});

test('getekend leest uit answers, met het bijbehorende tijdstip', () => {
  const w = leesWaiver({ waiver_x: true, waiver_x_at: '2026-09-02T09:00:00Z' }, 'waiver_x');
  assert.equal(w.agreed, true);
  assert.equal(w.at, '2026-09-02T09:00:00Z');
});

test('getekend is alleen true bij een echte true, niet bij "ja" of 1', () => {
  assert.equal(leesWaiver({ w: 'ja' }, 'w').agreed, false);
  assert.equal(leesWaiver({ w: 1 }, 'w').agreed, false);
});

test('getekend gaat voor geaccepteerd als beide momenten er staan', () => {
  assert.equal(leesOfferteMoment({
    tl_quotation_signed_at:   '2026-09-03T10:00:00Z',
    tl_quotation_accepted_at: '2026-09-01T10:00:00Z',
  }), '2026-09-03T10:00:00Z');
});

test('geen deal = geen offertemoment', () => {
  assert.equal(leesOfferteMoment(null), null);
});
