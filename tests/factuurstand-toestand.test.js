// tests/factuurstand-toestand.test.js
//
// DE VIER TOESTANDEN VAN DE FACTUURSTAND — en de eis dat elk scherm ze uit
// dezelfde bron haalt.
//
// De fout die dit bestand rechtzet, gemeten op 5 oktober 2026: bij een klant
// aan wie nog GEEN factuur verstuurd was, zei het CRM-onboardingoverzicht
// "Open", de onboardingkaart in het LMS "Eerste factuur open" en de
// studentkaart in het LMS "Facturen in orde". Drie schermen, drie berekeningen,
// drie verschillende antwoorden — en alle drie fout.
//
// Er is nu ÉÉN telling (`telFactuurstand` in api/_lib/factuurstand-spiegel.js)
// en ÉÉN woordenlijst (`factuurToestandWeergave`). De CONTRACT-toetsen hieronder
// worden rood zodra een scherm weer zelf gaat rekenen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  telFactuurstand, factuurToestand, factuurToestandWeergave,
  teltMeeAlsVerstuurd, VERSTUURD_STATUSES, TOESTANDEN,
  isKolomOntbreekt, zonderNieuweKolommen, NIEUWE_KOLOMMEN,
} from '../api/_lib/factuurstand-spiegel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VANDAAG = '2026-10-05';

function factuur(extra = {}) {
  return {
    id: 'inv-' + Math.random().toString(36).slice(2, 8), customer_id: 'k1',
    status: 'open', amount_total: 100, amount_paid: 0, credited_amount: 0,
    due_date: '2026-09-01', is_test: false, is_historical: false, ...extra,
  };
}
const tel = (set) => telFactuurstand(set, { todayIso: VANDAAG, graceDays: 0 });

test('geen enkele factuur → geen_factuur, NIET "open"', () => {
  const uit = tel([]);
  assert.equal(uit.toestand, 'geen_factuur');
  assert.equal(uit.verstuurd_aantal, 0);
  assert.equal(factuurToestandWeergave(uit).label, 'Nog geen factuur verstuurd');
});

test('TEGENPROEF: een concept is geen verstuurde factuur', () => {
  // Manjit: een klaargezette eerste factuur mag geen "factuur open" opleveren.
  const uit = tel([factuur({ status: 'concept', due_date: '2026-10-20' })]);
  assert.equal(uit.toestand, 'geen_factuur');
  assert.equal(uit.verstuurd_aantal, 0);
});

test('TEGENPROEF: draft, credited en writeoff tellen niet als verstuurd', () => {
  for (const status of ['draft', 'credited', 'writeoff']) {
    assert.equal(teltMeeAlsVerstuurd(factuur({ status })), false, status);
  }
  assert.deepEqual([...VERSTUURD_STATUSES].sort(), ['open', 'overdue', 'paid', 'partially_paid']);
});

test('TEGENPROEF: een volledig gecrediteerde factuur op "paid" telt niet als verstuurd', () => {
  const f = factuur({ status: 'paid', amount_paid: 0, credited_amount: 100 });
  assert.equal(teltMeeAlsVerstuurd(f), false);
  assert.equal(tel([f]).toestand, 'geen_factuur');
});

test('TEGENPROEF: een testrij telt nergens', () => {
  assert.equal(tel([factuur({ is_test: true })]).toestand, 'geen_factuur');
});

test('open en nog niet vervallen → open_niet_vervallen', () => {
  const uit = tel([factuur({ due_date: '2026-10-20' })]);
  assert.equal(uit.toestand, 'open_niet_vervallen');
  assert.equal(factuurToestandWeergave(uit).ernst, 'neutraal');
});

test('één vervallen → vervallen, oranje; twee → rood', () => {
  const een = tel([factuur()]);
  assert.equal(een.toestand, 'vervallen');
  assert.deepEqual(factuurToestandWeergave(een), { label: '1 factuur vervallen', ernst: 'oranje' });
  const twee = tel([factuur(), factuur({ due_date: '2026-08-01' })]);
  assert.deepEqual(factuurToestandWeergave(twee), { label: '2 facturen vervallen', ernst: 'rood' });
});

test('alles betaald → in_orde ("Betaald", groen)', () => {
  const uit = tel([factuur({ status: 'paid', amount_paid: 100 })]);
  assert.equal(uit.toestand, 'in_orde');
  assert.deepEqual(factuurToestandWeergave(uit), { label: 'Betaald', ernst: 'groen' });
});

test('een achterstand gaat voor alles, ook als er ook betaalde facturen zijn', () => {
  const uit = tel([factuur({ status: 'paid', amount_paid: 100 }), factuur()]);
  assert.equal(uit.toestand, 'vervallen');
  assert.equal(uit.verstuurd_aantal, 2);
});

test('de toestand is altijd één van de vier, en zonder stand is het "onbekend"', () => {
  for (const set of [[], [factuur()], [factuur({ due_date: '2027-01-01' })],
    [factuur({ status: 'paid', amount_paid: 100 })]]) {
    assert.ok(TOESTANDEN.includes(tel(set).toestand));
  }
  assert.equal(factuurToestandWeergave(null).ernst, 'onbekend');
  assert.equal(factuurToestandWeergave({ toestand: null }).label, 'Factuurstand onbekend');
  assert.equal(factuurToestand({}), 'geen_factuur');
});

test('ontbrekende LMS-kolommen worden herkend en weggelaten — de rest gaat door', () => {
  assert.equal(isKolomOntbreekt({ code: 'PGRST204', message: "Could not find the 'toestand' column" }), true);
  assert.equal(isKolomOntbreekt({ code: '42703', message: 'column "toestand" does not exist' }), true);
  assert.equal(isKolomOntbreekt({ code: '23514', message: 'violates check constraint' }), false);
  const rij = zonderNieuweKolommen({ student_id: 's', open_aantal: 1, verstuurd_aantal: 2, toestand: 'vervallen' });
  for (const k of NIEUWE_KOLOMMEN) assert.equal(k in rij, false);
  assert.equal(rij.open_aantal, 1);
});

// ── CONTRACT: één bron ──────────────────────────────────────────────────────

const lees = (pad) => readFileSync(join(ROOT, pad), 'utf8');

test('CONTRACT: de onboardingroutes halen de factuurstand uit de gedeelde telling', () => {
  for (const pad of ['api/admin-future-students-list.js', 'api/mentor-future-students-self.js',
    'api/onboarding-detail.js']) {
    const bron = lees(pad);
    assert.match(bron, /factuurstandPerKlant/, pad + ' leest de gedeelde factuurstand niet');
    assert.match(bron, /factuur\s*[:,]/, pad + ' geeft geen `factuur`-veld terug');
  }
});

test('CONTRACT: geen enkel onboardingscherm rekent de kolom Betaling nog zelf uit `paid`', () => {
  const schermen = ['modules/shared/onboarding-overzicht.js',
    'modules/klanten-v2/views/onboarding-v2.js', 'modules/mentor-onboarding.html'];
  for (const pad of schermen) {
    const bron = lees(pad);
    assert.doesNotMatch(bron, /\.paid\s*\?/, pad + ' gebruikt `paid ?` weer als betaalstand');
    assert.doesNotMatch(bron, /paidBadgeHtml|_paidCell\(!!/, pad + ' gebruikt de oude ja/nee-cel');
    assert.match(bron, /\.factuur\b/, pad + ' leest de factuurstand niet');
  }
  // En het woord "Open" als betaalstand komt nergens meer voor.
  assert.doesNotMatch(lees('modules/klanten-v2/views/onboarding-v2.js'), /H\.pill\('warn', 'Open'\)/);
});
