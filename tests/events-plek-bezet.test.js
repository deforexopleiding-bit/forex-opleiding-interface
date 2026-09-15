// tests/events-plek-bezet.test.js
//
// BEVESTIGD NEEMT EEN PLEK IN.
//
// Maxim, 15 september 2026: "Wie in de eventmodule op bevestigd komt te staan,
// neemt automatisch ook het slot in. Bevestigd overrult de vragenlijst."
//
// Aanleiding: Masterclass Gent 19-09 toonde Aanm/Cap 1/8 terwijl er vier
// mensen op belstatus Bevestigd stonden. Die ene kwam er enkel doordat de rest
// de vragenlijst niet had ingevuld — de zaal was in werkelijkheid halfvol.
//
// De regel, overal dezelfde:
//   status IN ('aangemeld','aanwezig') AND is_test = false
//   AND ( assessment_response_id IS NOT NULL
//         OR lower(trim(call_status)) = 'bevestigd' )
//
// Deze test toetst de JS-kant (isPlekBezet) tegen dezelfde gevallentabel die
// als verwachting in het SQL-commentaar van de migratie staat, plus de
// query-helper die de regel op een Supabase-query zet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPlekBezet,
  normalizeCallStatus,
  applyPlekBezetFilter,
  PLEK_BEZET_OR_FILTER,
  PLEK_BEZET_CALL_STATUS,
  CONFIRMED_STATUSES,
} from '../api/_lib/event-registration.js';

const AR = '11111111-2222-3333-4444-555555555555'; // assessment_response_id

/**
 * De gevallentabel. Elke regel: [omschrijving, rij, verwacht].
 *
 * Elk geval moet dezelfde uitkomst geven als de regel in het commentaar van
 * docs/sql-migrations/2026-09-15-events-belstatus-bevestigd-telt-mee.sql —
 * wijkt er één af, dan lopen Node en de DB-trigger uit de pas. Dat verband
 * wordt hard getoetst in tests/events-plek-bezet-sql-spiegel.test.js, die de
 * migratie inleest en hem tegen isPlekBezet legt.
 */
const GEVALLEN = [
  // ── Vragenlijst ingevuld: telt mee, wat de belstatus ook doet ──────────
  ['aangemeld + vragenlijst',                 { status:'aangemeld', assessment_response_id:AR,   is_test:false, call_status:null },            true],
  ['aanwezig + vragenlijst',                  { status:'aanwezig',  assessment_response_id:AR,   is_test:false, call_status:'geen_gehoor' },   true],

  // ── Belstatus bevestigd zónder vragenlijst: telt sinds 15-09 óók mee ──
  ['aangemeld + bevestigd, geen vragenlijst', { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:'bevestigd' },     true],
  ['aanwezig + bevestigd, geen vragenlijst',  { status:'aanwezig',  assessment_response_id:null, is_test:false, call_status:'bevestigd' },     true],
  ['hoofdletters: "Bevestigd"',               { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:'Bevestigd' },     true],
  ['spaties: " bevestigd "',                  { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:' bevestigd ' },   true],
  ['BEVESTIGD met spaties',                   { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:'  BEVESTIGD ' },  true],

  // ── Enkel de status telt nog steeds ───────────────────────────────────
  ['wachtlijst + bevestigd',                  { status:'wachtlijst',              assessment_response_id:null, is_test:false, call_status:'bevestigd' }, false],
  ['geannuleerd + vragenlijst',               { status:'geannuleerd',             assessment_response_id:AR,   is_test:false, call_status:'bevestigd' }, false],
  ['no_show + bevestigd',                     { status:'no_show',                 assessment_response_id:null, is_test:false, call_status:'bevestigd' }, false],
  ['switched_to_other_event + vragenlijst',   { status:'switched_to_other_event', assessment_response_id:AR,   is_test:false, call_status:null },        false],
  ['sale + bevestigd',                        { status:'sale',                    assessment_response_id:AR,   is_test:false, call_status:'bevestigd' }, false],

  // ── Testrijen tellen nooit mee ────────────────────────────────────────
  ['is_test + bevestigd',                     { status:'aangemeld', assessment_response_id:null, is_test:true,  call_status:'bevestigd' },     false],
  ['is_test + vragenlijst',                   { status:'aangemeld', assessment_response_id:AR,   is_test:true,  call_status:null },            false],

  // ── Geen van beide ────────────────────────────────────────────────────
  ['aangemeld, niets',                        { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:null },            false],
  ['aangemeld + geen_gehoor',                 { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:'geen_gehoor' },   false],
  ['aangemeld + komt_niet',                   { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:'komt_niet' },     false],
  ['aangemeld + lege belstatus',              { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:'   ' },           false],
  ['belstatus lijkt erop maar is het niet',   { status:'aangemeld', assessment_response_id:null, is_test:false, call_status:'niet_bevestigd' },false],
];

test('isPlekBezet volgt de regel, geval voor geval', () => {
  for (const [naam, rij, verwacht] of GEVALLEN) {
    assert.equal(isPlekBezet(rij), verwacht, naam);
  }
});

test('een ontbrekende is_test leest als "geen testrij"', () => {
  // Niet elke select neemt is_test mee (de lijst-endpoints filteren 'm al weg
  // in de query). undefined mag daar niet als "wel test" gelezen worden.
  assert.equal(isPlekBezet({ status: 'aangemeld', call_status: 'bevestigd' }), true);
  assert.equal(isPlekBezet({ status: 'aangemeld', assessment_response_id: AR }), true);
});

test('rommel in plaats van een rij is nooit een plek', () => {
  for (const rommel of [null, undefined, 0, '', 'aangemeld', 42, []]) {
    assert.equal(isPlekBezet(rommel), false, String(rommel));
  }
});

test('een lege string als assessment_response_id telt niet als vragenlijst', () => {
  // Defensief: een leeg tekstveld is geen koppeling. Zonder deze check zou
  // '' waar zijn en kreeg iedereen met een lege kolom een plek.
  assert.equal(isPlekBezet({ status: 'aangemeld', assessment_response_id: '', is_test: false }), false);
});

test('normalizeCallStatus trimt en lowercased, en maakt van niets een lege string', () => {
  assert.equal(normalizeCallStatus(' Bevestigd '), 'bevestigd');
  assert.equal(normalizeCallStatus('GEEN_GEHOOR'), 'geen_gehoor');
  assert.equal(normalizeCallStatus(null), '');
  assert.equal(normalizeCallStatus(undefined), '');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE QUERY-HELPER — precies één .or(), en de juiste filters
// ═══════════════════════════════════════════════════════════════════════════

/** Query-dubbelganger die elke filterstap onthoudt. */
function nepQuery() {
  const stappen = [];
  const q = {
    stappen,
    eq(c, v) { stappen.push(['eq', c, v]); return q; },
    in(c, v) { stappen.push(['in', c, v]); return q; },
    or(s)    { stappen.push(['or', s]);    return q; },
    not(c, o, v) { stappen.push(['not', c, o, v]); return q; },
  };
  return q;
}

test('applyPlekBezetFilter zet is_test, de statuslijst en de OR-tak', () => {
  const q = applyPlekBezetFilter(nepQuery());
  assert.deepEqual(q.stappen, [
    ['eq', 'is_test', false],
    ['in', 'status', CONFIRMED_STATUSES],
    ['or', PLEK_BEZET_OR_FILTER],
  ]);
});

test('de helper voegt PRECIES ÉÉN .or() toe', () => {
  // supabase-js doet `searchParams.append('or', ...)`, dus twee .or()-aanroepen
  // leveren twee or=-parameters op. Daar rekenen we niet op: wie er nog een
  // disjunctie bij nodig heeft, bouwt één string met PostgREST-nesting
  // (`.or('and(a,b),and(c,d)')`). Deze test bewaakt dat de helper zelf er
  // nooit meer dan één bijzet, zodat een caller er veilig één eigen .or()
  // naast kan hebben als dat ooit nodig is — en niet twee.
  const q = applyPlekBezetFilter(nepQuery());
  assert.equal(q.stappen.filter(([naam]) => naam === 'or').length, 1);
});

test('de OR-filterstring dekt beide takken van de regel', () => {
  assert.equal(PLEK_BEZET_CALL_STATUS, 'bevestigd');
  assert.equal(PLEK_BEZET_OR_FILTER, 'assessment_response_id.not.is.null,call_status.ilike.bevestigd');
  // `not.is.null` en niet `neq.null`: PostgREST kent NULL alleen via `is`.
  assert.match(PLEK_BEZET_OR_FILTER, /assessment_response_id\.not\.is\.null/);
  // `ilike` en niet `eq`: de kolom is vrije tekst, dus hoofdletter-ongevoelig.
  assert.match(PLEK_BEZET_OR_FILTER, /call_status\.ilike\.bevestigd/);
});

test('de helper geeft de query terug zodat je kunt doorketenen', () => {
  const q = nepQuery();
  assert.equal(applyPlekBezetFilter(q), q);
});
