// tests/lms-stilte.test.js
//
// DE MOTOR ZWIJGT ALS ER EEN AFSPRAAK LOOPT.
//
// Wat hier bewaakt wordt is een poort vóór het versturen, en de kosten van
// de twee fouten zijn niet gelijk: een dag te laat manen kost weinig, manen
// tegen een afspraak in kost vertrouwen. Daarom staat bij elk geval de
// TEGENPROEF — niet alleen "een lopende afspraak blokkeert", maar ook "de
// dag erna niet meer", "een klant zonder afspraak gaat gewoon door" en "een
// onleesbare bron legt niet de hele inning stil".
//
// Een poort die alleen op dichtgaan getoetst is, is niet getoetst: dan komt
// een fout die ALLES blokkeert er net zo goed doorheen, en dan staat de
// complete aanmaanmotor stil zonder dat iemand het ziet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isActieveStilte, stilteTekst, stilteBlokkade, stilteStandSamenvatting,
  beoordeelStilteBron, STILTE_CODE, STILTE_EVENT, ONBEKEND_CODE, ONBEKEND_EVENT,
  ALARM_NA_MS, BRON_GELEZEN, BRON_ONBEREIKBAAR, BRON_NIET_GECONFIGUREERD,
} from '../api/_lib/lms-stilte.js';
import {
  classifyRunBucket, reconstructPauseReason, buildBucketCounts,
  BUCKET_WACHT_LMS_STILTE,
} from '../api/_lib/pipeline-overview-helpers.js';
import { labelForDunningEvent } from '../api/_lib/dunning-event-labels.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const VANDAAG = '2026-09-21';

/** De stilterij zoals hij op 21 september op productie stond. */
function stilte(extra = {}) {
  return {
    student_id : '94da55c0-b275-4a41-92fa-d7c9a34739c2',
    stil_tot   : '2026-10-01',
    reden      : 'anders',
    reden_tekst: 'facturen open,',
    door_naam  : 'Maxim Delo (admin)',
    bron       : 'hold',
    ...extra,
  };
}

function stand(extra = {}) {
  return {
    bron_status: BRON_GELEZEN,
    stiltes: new Map([['k1', stilte()]]),
    vangnet: new Set(),
    fout: null,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) WANNEER LOOPT EEN AFSPRAAK
// ═══════════════════════════════════════════════════════════════════════════

test('een lopende afspraak is actief', () => {
  assert.equal(isActieveStilte(stilte(), VANDAAG), true);
});

test('stil_tot is INCLUSIEF — op die dag zwijgt de motor nog', () => {
  // Het contract zegt "tot en MET die dag". Dit is het verschil met de
  // hold-poort, waar `tot` exclusief is; door elkaar halen kost precies één
  // dag te vroeg een aanmaning.
  assert.equal(isActieveStilte(stilte({ stil_tot: VANDAAG }), VANDAAG), true);
});

test('TEGENPROEF: de dag NA stil_tot loopt de motor weer', () => {
  assert.equal(isActieveStilte(stilte({ stil_tot: '2026-09-20' }), VANDAAG), false);
  // En dezelfde rij op de dag zelf nog wel — zodat vaststaat dat het om de
  // grens gaat en niet om iets anders.
  assert.equal(isActieveStilte(stilte({ stil_tot: '2026-09-20' }), '2026-09-20'), true);
});

test('TEGENPROEF: zonder stil_tot is er geen stilte', () => {
  // De kolom staat op NOT NULL, dus een lege waarde is geen "loopt door"
  // maar een rij die niet had mogen bestaan. Er een eeuwige stilte van maken
  // zou een klant onbereikbaar maken zonder dat iemand een datum koos.
  assert.equal(isActieveStilte(stilte({ stil_tot: null }), VANDAAG), false);
  assert.equal(isActieveStilte(null, VANDAAG), false);
});

test('een tijdstempel in plaats van een datum verandert niets', () => {
  assert.equal(isActieveStilte(stilte({ stil_tot: '2026-10-01T00:00:00Z' }), VANDAAG), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) DE POORT
// ═══════════════════════════════════════════════════════════════════════════

test('een klant met een lopende afspraak krijgt niets, met de reden erbij', () => {
  const blok = stilteBlokkade(stand(), 'k1');
  assert.ok(blok, 'k1 hoort geblokkeerd te zijn');
  assert.equal(blok.code, STILTE_CODE);
  assert.equal(blok.event, STILTE_EVENT);
  assert.equal(blok.stil_tot, '2026-10-01');
  assert.equal(blok.door_naam, 'Maxim Delo (admin)');
  // reden_tekst en door_naam moeten in de zin staan: dat is wat er in het
  // CRM naleesbaar moet zijn.
  assert.match(blok.reden, /facturen open/);
  assert.match(blok.reden, /Maxim Delo/);
  assert.match(blok.reden, /01-10-2026/);
});

test('TEGENPROEF: een klant zonder afspraak gaat gewoon door', () => {
  // Verreweg de meeste wanbetalers hebben geen afspraak; die horen de motor
  // gewoon te krijgen. Op 21 september: 108 klanten met een vervallen
  // factuur, 1 lopende stilte.
  assert.equal(stilteBlokkade(stand(), 'k2'), null);
});

test('TEGENPROEF: geen stand geladen blokkeert niets', () => {
  assert.equal(stilteBlokkade(null, 'k1'), null);
  assert.equal(stilteBlokkade(stand(), null), null);
});

test('TEGENPROEF: dfo-lms niet geconfigureerd blokkeert niets', () => {
  const uit = { bron_status: BRON_NIET_GECONFIGUREERD, stiltes: new Map(), vangnet: new Set() };
  assert.equal(stilteBlokkade(uit, 'k1'), null);
});

test('ONLEESBARE BRON: klant met LMS-koppeling krijgt niets, en dat heet anders', () => {
  // "Er is een afspraak" en "we konden niet kijken" zijn niet hetzelfde en
  // horen in het dossier ook niet hetzelfde te lezen.
  const uit = {
    bron_status: BRON_ONBEREIKBAAR, stiltes: new Map(),
    vangnet: new Set(['k1', 'k9']), fout: 'connectie geweigerd',
  };
  const blok = stilteBlokkade(uit, 'k9');
  assert.ok(blok);
  assert.equal(blok.code, ONBEKEND_CODE);
  assert.equal(blok.event, ONBEKEND_EVENT);
  assert.equal(blok.stil_tot, null);
  assert.match(blok.reden, /niet te lezen/);
  assert.match(blok.reden, /volgende ronde/);
});

test('ONLEESBARE BRON: een klant ZONDER LMS-koppeling gaat wél door', () => {
  // Anders legt één storing de complete inning stil — ook voor de honderd
  // klanten die niets met het LMS te maken hebben.
  const uit = {
    bron_status: BRON_ONBEREIKBAAR, stiltes: new Map(),
    vangnet: new Set(['k1']), fout: 'timeout',
  };
  assert.equal(stilteBlokkade(uit, 'k2'), null);
});

test('twee afspraken op één klant: de laatste datum wint', () => {
  // Bijvoorbeeld twee studenten met dezelfde betaler. De motor zwijgt tot de
  // laatste afspraak af is, niet tot de eerste.
  const s = stand();
  s.stiltes.set('k1', stilte({ stil_tot: '2026-10-15' }));
  assert.equal(stilteBlokkade(s, 'k1').stil_tot, '2026-10-15');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) DE ZICHTBARE REDEN IN HET CRM
// ═══════════════════════════════════════════════════════════════════════════

test('de zin draagt datum, reden en wie het afsprak', () => {
  assert.equal(
    stilteTekst({ stil_tot: '2026-10-01', reden_tekst: 'belt zelf terug', door_naam: 'Dave' }),
    'Afspraak in het LMS — stil tot en met 01-10-2026 · belt zelf terug · afgesproken door Dave');
});

test('een ontbrekende naam levert geen "afgesproken door undefined"', () => {
  // door_naam mag leeg zijn: alleen `door` staat aan LMS-kant op NOT NULL.
  assert.equal(stilteTekst({ stil_tot: '2026-10-01' }),
    'Afspraak in het LMS — stil tot en met 01-10-2026');
  assert.equal(stilteTekst({ stil_tot: '2026-10-01', door_naam: '   ' }),
    'Afspraak in het LMS — stil tot en met 01-10-2026');
});

test('de wanbetalersmodule zet een overgeslagen run in een eigen bak', () => {
  const run = { status: 'active', next_action_at: '2026-09-22T09:00:00Z' };
  const log = {
    event_type: STILTE_EVENT, created_at: '2026-09-21T06:00:00Z',
    payload: { reason: 'lms_stilte', message: 'Afspraak in het LMS — stil tot en met 01-10-2026',
      stil_tot: '2026-10-01', door_naam: 'Maxim Delo (admin)' },
  };
  assert.equal(classifyRunBucket(run, log, Date.parse('2026-09-21T08:00:00Z')),
    BUCKET_WACHT_LMS_STILTE);

  const reden = reconstructPauseReason(run, log);
  assert.equal(reden.code, 'lms_stilte');
  assert.equal(reden.stil_tot, '2026-10-01');
  assert.equal(reden.door_naam, 'Maxim Delo (admin)');
  assert.match(reden.message, /01-10-2026/);
});

test('de onbekende variant valt in dezelfde bak maar houdt zijn eigen code', () => {
  const log = { event_type: ONBEKEND_EVENT, payload: { reason: 'lms_stilte_onbekend' } };
  assert.equal(classifyRunBucket({ status: 'active' }, log, Date.now()), BUCKET_WACHT_LMS_STILTE);
  assert.equal(reconstructPauseReason({ status: 'active' }, log).code, 'lms_stilte_onbekend');
});

test('een oude logregel zonder tekst geeft nooit een lege reden', () => {
  const reden = reconstructPauseReason({ status: 'active' },
    { event_type: STILTE_EVENT, payload: {} });
  assert.match(reden.message, /afspraak in het LMS/i);
});

test('de nieuwe bak wordt geteld in de KPI-strip', () => {
  const { counts } = buildBucketCounts([{ _bucket: BUCKET_WACHT_LMS_STILTE }]);
  assert.equal(counts[BUCKET_WACHT_LMS_STILTE], 1);
});

test('beide log-events hebben een leesbaar label, geen ruwe code', () => {
  const a = labelForDunningEvent(STILTE_EVENT, { message: 'Afspraak in het LMS — stil tot en met 01-10-2026' });
  assert.match(a.title, /afspraak in het LMS/i);
  assert.equal(a.detail, 'Afspraak in het LMS — stil tot en met 01-10-2026');
  const b = labelForDunningEvent(ONBEKEND_EVENT, {});
  assert.match(b.title, /onbekend/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) DE GEZONDHEIDSCONTROLE
// ═══════════════════════════════════════════════════════════════════════════

test('een leesbare bron alarmeert niet', () => {
  const uit = beoordeelStilteBron({ nuMs: Date.now(), stand: { status: BRON_GELEZEN } });
  assert.equal(uit.alarm, false);
});

test('TEGENPROEF: een paar uur onleesbaar is een hikje, geen alarm', () => {
  const nu = Date.parse('2026-09-21T12:00:00Z');
  const uit = beoordeelStilteBron({ nuMs: nu, stand: {
    status: BRON_ONBEREIKBAAR, onleesbaar_sinds: '2026-09-21T06:00:00Z' } });
  assert.equal(uit.alarm, false);
  assert.equal(uit.uren_stil, 6);
});

test('langer dan een etmaal onleesbaar wordt wél zichtbaar', () => {
  const nu = Date.parse('2026-09-22T13:00:00Z');
  const uit = beoordeelStilteBron({ nuMs: nu, stand: {
    status: BRON_ONBEREIKBAAR, onleesbaar_sinds: '2026-09-21T06:00:00Z',
    laatste_fout: 'connectie geweigerd' } });
  assert.equal(uit.alarm, true);
  assert.equal(uit.uren_stil, 31);
  assert.equal(uit.laatste_fout, 'connectie geweigerd');
});

test('precies op de drempel alarmeert', () => {
  const sinds = '2026-09-21T06:00:00Z';
  const uit = beoordeelStilteBron({ nuMs: Date.parse(sinds) + ALARM_NA_MS, stand: {
    status: BRON_ONBEREIKBAAR, onleesbaar_sinds: sinds } });
  assert.equal(uit.alarm, true);
});

test('onleesbaar zonder begintijd alarmeert niet op een getal dat we niet hebben', () => {
  const uit = beoordeelStilteBron({ nuMs: Date.now(), stand: { status: BRON_ONBEREIKBAAR } });
  assert.equal(uit.alarm, false);
  assert.equal(uit.uren_stil, null);
});

test('de samenvatting zegt bij een storing WAT er dan gebeurt', () => {
  const t = stilteStandSamenvatting({
    bron_status: BRON_ONBEREIKBAAR, fout: 'timeout', vangnet: new Set(['a', 'b']) });
  assert.match(t, /ONBEREIKBAAR/);
  assert.match(t, /timeout/);
  assert.match(t, /2 klant/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5) CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

const LIB = lees('api/_lib/lms-stilte.js');

test('CONTRACT: er wordt NIETS naar het LMS geschreven', () => {
  // De brug loopt één kant op. Het LMS schrijft, wij lezen.
  const naarLms = LIB.split('\n')
    .filter((r) => /lms\s*\n?\s*\.from\(|from\(STILTE_TABEL\)|from\('hlms_/.test(r));
  for (const regel of naarLms) {
    assert.doesNotMatch(regel, /\.(insert|update|upsert|delete)\s*\(/,
      'er wordt naar het LMS geschreven: ' + regel.trim());
  }
  // En breder: geen enkele schrijfopdracht op een hlms_-tabel in dit bestand.
  assert.doesNotMatch(LIB, /hlms_[a-z_]*['"]\)[\s\S]{0,80}?\.(insert|update|upsert|delete)\s*\(/,
    'er staat een schrijfopdracht op een LMS-tabel in lms-stilte.js');
});

test('CONTRACT: de koppeling is die van de factuurspiegel, geen tweede', () => {
  assert.match(LIB, /factuurstand-spiegel\.js/);
  assert.match(LIB, /kiesKlant\(/);
  assert.match(LIB, /zoekKlantKandidaten\(/);
  assert.doesNotMatch(LIB, /from\(['"]customers['"]\)/,
    'de stilte-lib zoekt zelf klanten op — dat hoort via de spiegel te lopen');
});

test('CONTRACT: het vangnet is gedeeld met de hold-poort, niet gekopieerd', () => {
  assert.match(LIB, /import \{[\s\S]{0,120}bouwVangnet[\s\S]{0,120}\} from '\.\/lms-hold\.js'/,
    'het vangnet is niet gedeeld — twee lijsten van "wie hangt aan het LMS" lopen uiteen');
});

test('CONTRACT: de automatische verzendpaden vragen de stilte-poort', () => {
  for (const kort of ['api/_lib/dunning-engine.js', 'api/cron-dunning-conversation-reminders.js']) {
    const bron = lees(kort);
    assert.match(bron, /haalStilteStand\(/, kort + ' haalt de stilte-stand niet op');
    assert.match(bron, /stilteBlokkade\(/, kort + ' toetst de stilte-poort niet');
  }
});

test('CONTRACT: de handmatige bulk-flow is NIET aangeraakt', () => {
  // Beslissing van Maxim: de bulk-flows blijven zoals ze zijn. De hold-poort
  // die daar al stond blijft staan; er komt geen stilte-poort bij.
  const bulk = lees('api/cron-dunning-bulk-send.js');
  assert.doesNotMatch(bulk, /stilteBlokkade|haalStilteStand/,
    'de bulk-flow heeft er een poort bij gekregen — dat was expliciet niet de bedoeling');
  assert.match(bulk, /holdBlokkade\(/, 'de bestaande hold-poort in de bulk-flow is weg');
});

test('CONTRACT: de motor haalt de stand ÉÉN keer op, niet per klant', () => {
  const bron = lees('api/_lib/dunning-engine.js');
  assert.equal((bron.match(/await haalStilteStand\(/g) || []).length, 1,
    'haalStilteStand() hoort precies één keer per engine-run te draaien');
});

test('CONTRACT: de vervaldatum-poort staat VÓÓR de stilte-poort', () => {
  // Dat is wat "op de dag na stil_tot eerst de factuurstand opnieuw
  // controleren" in de praktijk betekent: de harde overdue-poort heeft de
  // klant dan al afgewezen als er niets meer openstaat.
  const bron = lees('api/_lib/dunning-engine.js');
  const overdue = bron.indexOf('if (!isOverdue(agg.oldest_due_iso, todayIso, graceDays))');
  const poort   = bron.indexOf('const blokkadeStilte = stilteBlokkade(stilteStand, customerId)');
  assert.ok(overdue > 0 && poort > 0, 'een van de twee poorten is niet te vinden');
  assert.ok(overdue < poort,
    'de stilte-poort staat vóór de vervaldatum-poort — dan zou een klant die '
    + 'tijdens zijn afspraak betaalde alsnog als wanbetaler behandeld worden');
});
