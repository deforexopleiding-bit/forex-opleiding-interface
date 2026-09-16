// tests/factuurstand-spiegel.test.js
//
// De spiegel van de CRM-factuurstand naar het LMS.
//
// Twee soorten toetsen staan hier, en ze doen iets anders:
//
//   CONTRACT — bewaakt iets dat je aan losse gedragstests niet kunt zien:
//   dat er precies één schrijver is, dat de "te laat"-grens er maar één keer
//   staat, en dat elk schrijfpunt op `invoices` de spiegel aanroept.
//
//   TEGENPROEF — bewaakt de definitie zelf, en dan van BEIDE kanten: niet
//   alleen "een vervallen factuur telt mee", maar ook "een betaalde laat het
//   aantal zakken", "een gecrediteerde telt niet", "een testrij telt niet" en
//   "een factuur die pas volgende maand vervalt telt niet als vervallen".
//   Een teller die alleen omhoog getoetst is, is niet getoetst.
//
// Deze getallen gaan in het LMS gedrag sturen — bij twee vervallen facturen
// kan een mentor straks niet meer inplannen. Dan is "we hebben het geteld"
// niet genoeg; er moet vastliggen wát er geteld wordt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SPIEGEL_TABEL,
  BRON_ONBEREIKBAAR,
  REDEN_MEERDERE_KLANTEN, REDEN_GEEN_KANDIDAAT,
  VIA_ONBOARDING, VIA_BUBBLE, VIA_EMAIL,
  restbedrag, teltMeeAlsOpen, telFactuurstand,
  isActieveMentorshipStudent, isEchteKlant,
  kiesKlant, bepaalOnbereikbaarPatch, isTabelOntbreekt,
} from '../api/_lib/factuurstand-spiegel.js';
import { isOverdue } from '../api/_lib/dunning-overdue-guard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VANDAAG = '2026-09-16';

/** Een openstaande factuur met alles op de normale stand. */
function factuur(extra = {}) {
  return {
    id: 'inv-' + Math.random().toString(36).slice(2, 8),
    customer_id: 'klant-1',
    status: 'open',
    amount_total: 100, amount_paid: 0, credited_amount: 0,
    due_date: '2026-09-01',
    is_test: false, is_historical: false,
    ...extra,
  };
}

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

test('CONTRACT: alleen factuurstand-spiegel.js SCHRIJFT naar hlms_crm_factuurstand', () => {
  // De ronde mag de tabel LEZEN (hij moet weten wat er staat om te kunnen
  // verzoenen) en overtollige rijen verwijderen; inhoud schrijven gebeurt
  // uitsluitend via spiegelFactuurstandVoorStudent(). Daarom kijken we naar
  // upsert/insert/update, niet naar select/delete.
  const SCHRIJFWOORDEN = /\.(upsert|insert|update)\s*\(/;
  const overtreders = [];

  for (const pad of apiBestanden()) {
    const kort = pad.slice(ROOT.length + 1);
    if (kort === 'api/_lib/factuurstand-spiegel.js') continue;
    const bron = readFileSync(pad, 'utf8');
    if (!bron.includes(SPIEGEL_TABEL)) continue;
    const regels = bron.split('\n');
    for (let i = 0; i < regels.length; i++) {
      if (!regels[i].includes(SPIEGEL_TABEL)) continue;
      const venster = regels.slice(i, i + 6).join('\n');
      if (SCHRIJFWOORDEN.test(venster)) overtreders.push(kort + ':' + (i + 1));
    }
  }

  assert.deepEqual(overtreders, [],
    'er schrijft iets anders dan factuurstand-spiegel.js naar ' + SPIEGEL_TABEL
    + ' — de spiegel heeft precies één schrijver, zie de kop van die lib');
});

test('CONTRACT: elk schrijfpunt op invoices meldt de wijziging aan de spiegel', () => {
  // Een betaling, een teruggedraaide betaling, een creditering of een
  // TL-synchronisatie verandert het aantal openstaande of vervallen
  // facturen. Zonder aanroep staat de mentor tot de volgende ochtend naar
  // een achterhaalde stand te kijken.
  const AANROEPERS = [
    ['api/_lib/register-payment-internal.js',   /spiegelFactuurstandNaWijziging\(/],
    ['api/finance-invoice-remove-payment.js',   /spiegelFactuurstandNaWijziging\(/],
    ['api/_lib/invoice-upsert.js',              /spiegelFactuurstandNaWijziging\(/],
    ['api/_lib/creditnote-upsert.js',           /spiegelFactuurstandNaWijziging\(/],
    // Deze twee hoeven niet zelf te spiegelen, maar wel via de gedeelde
    // herberekening te lopen — daar zit de aanroep in. Een eigen kopie van
    // die lus zou de spiegel stilzwijgend overslaan; dat is precies wat er
    // stond voordat dit vastgelegd werd.
    ['api/finance-creditnote-sync.js',          /recomputeCreditedAmount\(/],
    ['api/_lib/invoice-credit.js',              /recomputeCreditedAmount\(/],
  ];
  for (const [kort, patroon] of AANROEPERS) {
    const bron = readFileSync(join(ROOT, kort), 'utf8');
    assert.match(bron, patroon,
      kort + ' meldt een factuurwijziging niet aan de LMS-spiegel');
    assert.doesNotMatch(bron, new RegExp(SPIEGEL_TABEL),
      kort + ' noemt de spiegeltabel zelf; dat hoort via de helper te lopen');
  }
});

test('CONTRACT: de "te laat"-grens komt uit de wanbetalersmotor, niet uit een eigen som', () => {
  const bron = readFileSync(join(ROOT, 'api/_lib/factuurstand-spiegel.js'), 'utf8');
  assert.match(bron, /dunning-overdue-guard\.js/,
    'de spiegel rekent niet via de guard van de wanbetalersmotor');
  assert.match(bron, /isOverdue\(/);
  // Geen tweede definitie van dezelfde begrippen in dit bestand.
  assert.doesNotMatch(bron, /function\s+isOverdue\s*\(/);
  assert.doesNotMatch(bron, /function\s+daysOverdue\w*\s*\(/);
});

test('CONTRACT: de openstaand-statussen komen uit de gedeelde lijst', () => {
  const bron = readFileSync(join(ROOT, 'api/_lib/factuurstand-spiegel.js'), 'utf8');
  assert.match(bron, /OPEN_INVOICE_STATUSES/,
    'de spiegel heeft een eigen lijstje statussen; die liep bij de aanmaanmotor '
    + 'al eens uiteen en hoort op één plek te staan');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) DE GRENS — dezelfde als die van Joost, aantoonbaar
// ═══════════════════════════════════════════════════════════════════════════

test('de spiegel telt precies vervallen wat de wanbetalersmotor vervallen noemt', () => {
  // Niet "dezelfde uitkomst bij toeval", maar de twee naast elkaar gelegd:
  // voor elke vervaldatum en elke gratieperiode moet de teller van de spiegel
  // hetzelfde zeggen als de poort van de motor. Gaat er ooit iemand hier een
  // eigen vergelijking schrijven, dan valt deze om.
  const gevallen = [
    ['2026-09-15', 0], ['2026-09-16', 0], ['2026-09-17', 0],
    ['2026-09-01', 0], ['2026-09-15', 7], ['2026-09-01', 7],
    ['2026-08-01', 30], ['2026-09-10', 3], ['2026-09-13', 3],
  ];
  for (const [due, grace] of gevallen) {
    const uit = telFactuurstand([factuur({ due_date: due })],
      { todayIso: VANDAAG, graceDays: grace });
    const verwacht = isOverdue(due, VANDAAG, grace) ? 1 : 0;
    assert.equal(uit.vervallen_aantal, verwacht,
      'vervaldatum ' + due + ' met ' + grace + ' gratiedagen');
  }
});

test('een factuur zonder vervaldatum telt open, maar nooit vervallen', () => {
  // Fail-closed, net als de poort van de motor: zonder vervaldatum kunnen we
  // niet aantonen dat er iets te laat is, en dan zeggen we het ook niet.
  const uit = telFactuurstand([factuur({ due_date: null })], { todayIso: VANDAAG });
  assert.equal(uit.open_aantal, 1);
  assert.equal(uit.vervallen_aantal, 0);
  assert.equal(uit.oudste_vervaldatum, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) TEGENPROEF — wat er NIET meetelt
// ═══════════════════════════════════════════════════════════════════════════

test('TEGENPROEF: een betaalde factuur laat het aantal zakken', () => {
  const voor = telFactuurstand(
    [factuur(), factuur({ due_date: '2026-08-01' })], { todayIso: VANDAAG });
  assert.equal(voor.open_aantal, 2);
  assert.equal(voor.vervallen_aantal, 2);

  const na = telFactuurstand(
    [factuur(), factuur({ due_date: '2026-08-01', status: 'paid', amount_paid: 100 })],
    { todayIso: VANDAAG });
  assert.equal(na.open_aantal, 1, 'betaald hoort niet meer open te staan');
  assert.equal(na.vervallen_aantal, 1);
  assert.equal(na.openstaand_bedrag, 100);
});

test('TEGENPROEF: volledig betaald telt niet mee, ook niet als de status blijft hangen', () => {
  // Komt voor tussen een betaling in Teamleader en de eerstvolgende sync: de
  // status staat nog op 'open' terwijl het bedrag al binnen is. Het
  // restbedrag is dan de waarheid, niet de status.
  const uit = telFactuurstand([factuur({ amount_paid: 100 })], { todayIso: VANDAAG });
  assert.equal(uit.open_aantal, 0);
  assert.equal(uit.vervallen_aantal, 0);
});

test('TEGENPROEF: een gecrediteerde factuur telt niet', () => {
  assert.equal(
    telFactuurstand([factuur({ credited_amount: 100 })], { todayIso: VANDAAG }).open_aantal, 0);
  assert.equal(
    telFactuurstand([factuur({ status: 'credited' })], { todayIso: VANDAAG }).open_aantal, 0);
  // Half gecrediteerd is wél nog een vordering — voor het restant.
  const half = telFactuurstand([factuur({ credited_amount: 40 })], { todayIso: VANDAAG });
  assert.equal(half.open_aantal, 1);
  assert.equal(half.openstaand_bedrag, 60);
});

test('TEGENPROEF: een testrij telt niet', () => {
  assert.equal(
    telFactuurstand([factuur({ is_test: true })], { todayIso: VANDAAG }).open_aantal, 0);
});

test('TEGENPROEF: een niet-vervallen factuur telt wel open, niet vervallen', () => {
  const uit = telFactuurstand([factuur({ due_date: '2026-10-01' })], { todayIso: VANDAAG });
  assert.equal(uit.open_aantal, 1);
  assert.equal(uit.vervallen_aantal, 0, 'vervalt pas volgende maand');
  assert.equal(uit.oudste_vervaldatum, null,
    'een datum hier zou in het LMS lezen als "loopt al zo lang"');
});

test('TEGENPROEF: de vervaldag zelf is nog niet te laat', () => {
  const uit = telFactuurstand([factuur({ due_date: VANDAAG })], { todayIso: VANDAAG });
  assert.equal(uit.open_aantal, 1);
  assert.equal(uit.vervallen_aantal, 0);
});

test('TEGENPROEF: een concept telt nergens mee', () => {
  const uit = telFactuurstand(
    [factuur({ status: 'concept', due_date: '2026-01-01' })], { todayIso: VANDAAG });
  assert.equal(uit.open_aantal, 0);
  assert.equal(uit.vervallen_aantal, 0);
  assert.equal(uit.openstaand_bedrag, 0);
});

test('een deels betaalde factuur telt gewoon mee, voor het restant', () => {
  const uit = telFactuurstand(
    [factuur({ status: 'partially_paid', amount_paid: 30 })], { todayIso: VANDAAG });
  assert.equal(uit.open_aantal, 1);
  assert.equal(uit.vervallen_aantal, 1);
  assert.equal(uit.openstaand_bedrag, 70);
});

test('de oudste vervaldatum is de oudste VERVALLEN, niet de oudste openstaande', () => {
  const uit = telFactuurstand([
    factuur({ due_date: '2026-09-10' }),
    factuur({ due_date: '2026-07-04' }),
    factuur({ due_date: '2026-12-01' }),
  ], { todayIso: VANDAAG });
  assert.equal(uit.open_aantal, 3);
  assert.equal(uit.vervallen_aantal, 2);
  assert.equal(uit.oudste_vervaldatum, '2026-07-04');
});

test('restbedrag klemt op nul en rekent in centen', () => {
  assert.equal(restbedrag({ amount_total: 100, amount_paid: 150 }), 0);
  assert.equal(restbedrag({ amount_total: 100.10, amount_paid: 0.05 }), 100.05);
  assert.equal(restbedrag(null), 0);
});

test('teltMeeAlsOpen is streng op de status', () => {
  for (const status of ['open', 'partially_paid', 'overdue']) {
    assert.equal(teltMeeAlsOpen(factuur({ status })), true, status);
  }
  for (const status of ['concept', 'paid', 'credited', 'writeoff', '', null]) {
    assert.equal(teltMeeAlsOpen(factuur({ status })), false, String(status));
  }
});

test('is_historical telt gewoon mee — zelfde antwoord als de wanbetalersmotor', () => {
  // Bewuste beslissing, zie de notitie onderaan factuurstand-spiegel.js. Gaat
  // iemand er ooit toch op filteren, dan hoort dat een zichtbare wijziging te
  // zijn en geen stille.
  const uit = telFactuurstand([factuur({ is_historical: true })], { todayIso: VANDAAG });
  assert.equal(uit.open_aantal, 1);
  assert.equal(uit.vervallen_aantal, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) DE KOPPELING
// ═══════════════════════════════════════════════════════════════════════════

test('de zekerste weg wint', () => {
  const uit = kiesKlant({ onboarding: ['k1'], bubble: ['k2'], email: ['k3'] });
  assert.equal(uit.customer_id, 'k1');
  assert.equal(uit.via, VIA_ONBOARDING);
});

test('een lagere weg komt pas aan bod als de hogere niets oplevert', () => {
  assert.equal(kiesKlant({ bubble: ['k2'], email: ['k3'] }).via, VIA_BUBBLE);
  assert.equal(kiesKlant({ email: ['k3'] }).via, VIA_EMAIL);
});

test('dezelfde klant twee keer via dezelfde weg is geen dubbelzinnigheid', () => {
  const uit = kiesKlant({ email: ['k9', 'k9'] });
  assert.equal(uit.customer_id, 'k9');
  assert.equal(uit.reden, null);
});

test('TWEE KANDIDATEN: niet koppelen, wel melden', () => {
  // Het bekende geval: dezelfde persoon onder twee adressen. Een gok zou
  // betekenen dat een mentor iemand aanspreekt op de factuur van een ander.
  const uit = kiesKlant({ email: ['k1', 'k2'] });
  assert.equal(uit.customer_id, null);
  assert.equal(uit.via, VIA_EMAIL);
  assert.equal(uit.reden, REDEN_MEERDERE_KLANTEN);
});

test('dubbelzinnigheid valt NIET terug op een lagere weg', () => {
  // Twee onboardings die naar verschillende klanten wijzen is een
  // gegevensprobleem dat een mens hoort te zien. Stilletjes op het
  // e-mailadres uitkomen zou dat probleem juist verstoppen.
  const uit = kiesKlant({ onboarding: ['k1', 'k2'], email: ['k3'] });
  assert.equal(uit.customer_id, null);
  assert.equal(uit.via, VIA_ONBOARDING);
});

test('geen enkele kandidaat is een eigen uitkomst met een reden', () => {
  const uit = kiesKlant({});
  assert.equal(uit.customer_id, null);
  assert.equal(uit.via, null);
  assert.equal(uit.reden, REDEN_GEEN_KANDIDAAT);
});

test('lege en rommelige waarden tellen niet als kandidaat', () => {
  assert.equal(kiesKlant({ onboarding: [null, '', '  '], email: ['k1'] }).customer_id, 'k1');
});

test('een testklant is geen kandidaat', () => {
  assert.equal(isEchteKlant({ id: 'k1', is_test: true }), false);
  assert.equal(isEchteKlant({ id: 'k1', is_test: false }), true);
  assert.equal(isEchteKlant(null), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5) WIE KRIJGT EEN RIJ
// ═══════════════════════════════════════════════════════════════════════════

test('alleen mentorship-studenten krijgen een rij', () => {
  assert.equal(isActieveMentorshipStudent({ product_soort: 'mentorship' }, VANDAAG), true);
  assert.equal(isActieveMentorshipStudent({ product_soort: 'membership' }, VANDAAG), false);
  assert.equal(isActieveMentorshipStudent({ product_soort: null }, VANDAAG), false);
  assert.equal(isActieveMentorshipStudent({ product_soort: 'MENTORSHIP' }, VANDAAG), true,
    'hoofdletters mogen het antwoord niet veranderen');
});

test('een afgelopen traject valt af, een lopend of open einde blijft', () => {
  const m = (eind) => isActieveMentorshipStudent(
    { product_soort: 'mentorship', eind_datum: eind }, VANDAAG);
  assert.equal(m('2026-09-15'), false, 'gisteren afgelopen');
  assert.equal(m('2026-09-16'), true, 'loopt vandaag nog');
  assert.equal(m('2027-01-01'), true);
  assert.equal(m(null), true, 'geen einddatum leest als "loopt door" — de voorzichtige kant');
});

// ═══════════════════════════════════════════════════════════════════════════
// 6) ONBEREIKBAAR — de vorige stand blijft staan
// ═══════════════════════════════════════════════════════════════════════════

test('een onbereikbare bron overschrijft een bestaande stand NOOIT met nul', () => {
  const patch = bepaalOnbereikbaarPatch({ student_id: 's1' }, 'invoices lezen: kapot', 'NU');
  assert.equal(patch.bron_status, BRON_ONBEREIKBAAR);
  assert.equal(patch.bron_fout, 'invoices lezen: kapot');
  assert.equal(patch.bijgewerkt_op, 'NU');
  assert.equal('vervallen_aantal' in patch, false,
    'de getallen horen NIET in de patch — een mislukte lezing is geen uitspraak '
    + 'over de factuurstand van deze klant');
  assert.equal('open_aantal' in patch, false);
  assert.equal('openstaand_bedrag' in patch, false);
});

test('bestond er nog geen rij, dan komt er wel één — met de waarheid erbij', () => {
  const patch = bepaalOnbereikbaarPatch(null, 'kapot', 'NU');
  assert.equal(patch.bron_status, BRON_ONBEREIKBAAR);
  assert.equal(patch.vervallen_aantal, 0);
  assert.equal(patch.open_aantal, 0);
  assert.equal(patch.openstaand_bedrag, null,
    'geen bedrag bekend is iets anders dan nul euro openstaand');
});

test('een ontbrekende LMS-tabel is herkenbaar en geen gewone fout', () => {
  assert.equal(isTabelOntbreekt({ code: '42P01' }), true);
  assert.equal(isTabelOntbreekt({ message: 'relation "hlms_crm_factuurstand" does not exist' }), true);
  assert.equal(isTabelOntbreekt({ message: 'permission denied' }), false);
  assert.equal(isTabelOntbreekt(null), false);
});
