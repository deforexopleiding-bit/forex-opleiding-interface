// tests/lms-hold.test.js
//
// ON HOLD IN HET LMS PAUZEERT JOOST.
//
// De poort die hier getoetst wordt bepaalt of er een bericht naar een klant
// gaat. Dat is de duurste kant van dit systeem: een aanmaning naar iemand die
// net een pauze kreeg is niet terug te nemen. Daarom staat bij elk geval ook
// de TEGENPROEF — niet alleen "een actieve hold blokkeert", maar ook "een
// verlopen hold blokkeert NIET", "een opgeheven hold blokkeert NIET" en
// "een klant zonder LMS-koppeling gaat gewoon door".
//
// Een poort die alleen op dichtgaan getoetst is, is niet getoetst: dan zou
// een fout die ALLES blokkeert er net zo goed doorkomen, en dan staat de
// hele aanmaanmotor stil zonder dat iemand het ziet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isActieveHold, holdTekst, nlDatum, holdBlokkade, holdStandSamenvatting,
  HOLD_CODE, HOLD_EVENT,
  BRON_GELEZEN, BRON_ONBEREIKBAAR, BRON_NIET_GECONFIGUREERD,
} from '../api/_lib/lms-hold.js';
import {
  classifyRunBucket, reconstructPauseReason, buildBucketCounts,
  BUCKET_WACHT_LMS_HOLD,
} from '../api/_lib/pipeline-overview-helpers.js';
import { labelForDunningEvent } from '../api/_lib/dunning-event-labels.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VANDAAG = '2026-09-17';

/** Een hold die vandaag loopt. */
function hold(extra = {}) {
  return {
    student_id: 'stu-1', van: '2026-09-10', tot: '2026-10-01',
    reden: 'betaalachterstand', materiaal_open: true,
    door: 'hoofdmentor', opgeheven_op: null,
    ...extra,
  };
}

/** Een stand waarin klant k1 on hold staat. */
function stand(extra = {}) {
  return {
    bron_status: BRON_GELEZEN,
    holds: new Map([['k1', hold()]]),
    vangnet: new Set(),
    fout: null,
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1) WANNEER LOOPT EEN PAUZE
// ═══════════════════════════════════════════════════════════════════════════

test('een lopende hold is actief', () => {
  assert.equal(isActieveHold(hold(), VANDAAG), true);
});

test('TEGENPROEF: een VERLOPEN hold is niet actief', () => {
  assert.equal(isActieveHold(hold({ van: '2026-08-01', tot: '2026-09-01' }), VANDAAG), false);
});

test('TEGENPROEF: een OPGEHEVEN hold is niet actief, ook al loopt de periode nog', () => {
  // De hoofdmentor heeft de pauze ingetrokken. Dat de einddatum nog in de
  // toekomst ligt doet er dan niet toe.
  assert.equal(isActieveHold(hold({ opgeheven_op: '2026-09-15T10:00:00Z' }), VANDAAG), false);
});

test('TEGENPROEF: een hold die pas later begint is nog niet actief', () => {
  assert.equal(isActieveHold(hold({ van: '2026-10-01', tot: '2026-11-01' }), VANDAAG), false);
});

test('de einddatum is EXCLUSIEF — op die dag loopt de motor weer', () => {
  // Zo is de dag waarop de pauze afloopt ook de dag waarop alles hervat,
  // zonder dat iemand ergens een dag moet aftrekken.
  assert.equal(isActieveHold(hold({ tot: VANDAAG }), VANDAAG), false);
  assert.equal(isActieveHold(hold({ tot: '2026-09-18' }), VANDAAG), true);
});

test('de startdatum is INCLUSIEF — op die dag geldt de pauze al', () => {
  assert.equal(isActieveHold(hold({ van: VANDAAG }), VANDAAG), true);
});

test('ontbrekende datums vallen naar de voorzichtige kant: wél een pauze', () => {
  // Geen `van` = al begonnen; geen `tot` = loopt tot iemand 'm opheft. Beide
  // keuzes zijn de kant waar GEEN bericht uitgaat.
  assert.equal(isActieveHold(hold({ van: null }), VANDAAG), true);
  assert.equal(isActieveHold(hold({ tot: null }), VANDAAG), true);
  assert.equal(isActieveHold(hold({ van: null, tot: null }), VANDAAG), true);
});

test('een tijdstempel in plaats van een datum verandert het antwoord niet', () => {
  assert.equal(isActieveHold(hold({ van: '2026-09-10T08:30:00Z', tot: '2026-10-01T00:00:00Z' }), VANDAAG), true);
});

test('geen hold is geen pauze', () => {
  assert.equal(isActieveHold(null, VANDAAG), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2) DE POORT
// ═══════════════════════════════════════════════════════════════════════════

test('een klant met een actieve hold wordt geblokkeerd, met de reden erbij', () => {
  const blok = holdBlokkade(stand(), 'k1');
  assert.ok(blok, 'k1 hoort geblokkeerd te zijn');
  assert.equal(blok.code, HOLD_CODE);
  assert.equal(blok.tot, '2026-10-01');
  assert.match(blok.reden, /^On hold in het LMS tot 01-10-2026/);
});

test('TEGENPROEF: een klant ZONDER LMS-koppeling gaat gewoon door', () => {
  // Dit is de tegenproef die ertoe doet: verreweg de meeste wanbetalers
  // hebben niets met het LMS te maken, en die horen de motor gewoon te
  // krijgen. Een poort die iedereen blokkeert zet de inning stil.
  assert.equal(holdBlokkade(stand(), 'k2'), null);
});

test('TEGENPROEF: geen stand geladen blokkeert niets', () => {
  // Een aanroeper die de stand bewust niet ophaalt (sandbox, test-run) mag
  // niet stilvallen op een lege poort.
  assert.equal(holdBlokkade(null, 'k1'), null);
  assert.equal(holdBlokkade(stand(), null), null);
});

test('TEGENPROEF: dfo-lms niet geconfigureerd blokkeert niets', () => {
  // In een omgeving zonder DFO_LMS_*-variabelen bestaat het LMS niet, en dan
  // zou fail-closed de hele motor stilzetten voor een pauze die niet kan
  // bestaan. Dat is iets anders dan een storing.
  const uit = { bron_status: BRON_NIET_GECONFIGUREERD, holds: new Map(), vangnet: new Set() };
  assert.equal(holdBlokkade(uit, 'k1'), null);
});

test('BRON ONBEREIKBAAR: elke klant MET LMS-koppeling wordt overgeslagen', () => {
  // De voorzichtige kant. We weten niet wie er on hold staat, dus houden we
  // ons in bij iedereen die aan een LMS-student gekoppeld kan zijn.
  const uit = {
    bron_status: BRON_ONBEREIKBAAR, holds: new Map(),
    vangnet: new Set(['k1', 'k9']), fout: 'connectie geweigerd',
  };
  const blok = holdBlokkade(uit, 'k9');
  assert.ok(blok);
  assert.equal(blok.bron_status, BRON_ONBEREIKBAAR);
  assert.equal(blok.tot, null);
  assert.match(blok.reden, /niet te lezen/);
});

test('BRON ONBEREIKBAAR: een klant ZONDER LMS-koppeling gaat wél door', () => {
  // Anders zou één LMS-storing de complete inning stilleggen — ook voor de
  // honderden klanten die niets met het LMS te maken hebben.
  const uit = {
    bron_status: BRON_ONBEREIKBAAR, holds: new Map(),
    vangnet: new Set(['k1']), fout: 'connectie geweigerd',
  };
  assert.equal(holdBlokkade(uit, 'k2'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3) DE ZICHTBARE REDEN
// ═══════════════════════════════════════════════════════════════════════════

test('de reden is de zin die Maxim gevraagd heeft', () => {
  assert.equal(holdTekst({ tot: '2026-09-30' }), 'On hold in het LMS tot 30-09-2026');
  assert.equal(holdTekst({ tot: '2026-09-30', reden: 'uitstel gevraagd' }),
    'On hold in het LMS tot 30-09-2026 — uitstel gevraagd');
});

test('een hold zonder einddatum zegt dat ook, in plaats van een lege datum', () => {
  assert.equal(holdTekst({ tot: null }), 'On hold in het LMS (geen einddatum)');
});

test('datums staan er in gewone Nederlandse volgorde', () => {
  assert.equal(nlDatum('2026-10-01'), '01-10-2026');
  assert.equal(nlDatum('2026-10-01T12:00:00Z'), '01-10-2026');
  assert.equal(nlDatum(null), null);
  assert.equal(nlDatum('rommel'), null);
});

test('de wanbetalersmodule zet een overgeslagen run in een eigen bak', () => {
  const run = { status: 'active', next_action_at: '2026-09-18T09:00:00Z' };
  const log = { event_type: HOLD_EVENT, created_at: '2026-09-17T06:00:00Z',
    payload: { message: 'On hold in het LMS tot 01-10-2026', tot: '2026-10-01' } };
  assert.equal(classifyRunBucket(run, log, Date.parse('2026-09-17T08:00:00Z')),
    BUCKET_WACHT_LMS_HOLD);

  const reden = reconstructPauseReason(run, log);
  assert.equal(reden.code, 'lms_hold');
  assert.equal(reden.message, 'On hold in het LMS tot 01-10-2026');
  assert.equal(reden.tot, '2026-10-01');
});

test('een oude logregel zonder tekst geeft nooit een lege reden', () => {
  const reden = reconstructPauseReason(
    { status: 'active' }, { event_type: HOLD_EVENT, payload: {} });
  assert.equal(reden.code, 'lms_hold');
  assert.match(reden.message, /On hold in het LMS/);
});

test('de nieuwe bak wordt ook geteld in de KPI-strip', () => {
  const { counts } = buildBucketCounts([{ _bucket: BUCKET_WACHT_LMS_HOLD }]);
  assert.equal(counts[BUCKET_WACHT_LMS_HOLD], 1);
});

test('het log-event heeft een leesbaar label, geen ruwe code', () => {
  const { title, detail } = labelForDunningEvent(HOLD_EVENT,
    { message: 'On hold in het LMS tot 01-10-2026 — betaalachterstand' });
  assert.equal(title, 'Overgeslagen: student staat on hold in het LMS');
  assert.equal(detail, 'On hold in het LMS tot 01-10-2026 — betaalachterstand');
});

test('de samenvatting zegt bij een storing WAT er dan gebeurt', () => {
  const tekst = holdStandSamenvatting({
    bron_status: BRON_ONBEREIKBAAR, fout: 'timeout', vangnet: new Set(['a', 'b']),
  });
  assert.match(tekst, /ONBEREIKBAAR/);
  assert.match(tekst, /timeout/);
  assert.match(tekst, /2 klant/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4) CONTRACT — één koppeling, en de poort staat op elk verzendpad
// ═══════════════════════════════════════════════════════════════════════════

test('CONTRACT: de hold gebruikt de koppeling van de factuurspiegel, geen tweede', () => {
  const bron = readFileSync(join(ROOT, 'api/_lib/lms-hold.js'), 'utf8');
  assert.match(bron, /factuurstand-spiegel\.js/,
    'de hold-lib koppelt niet via de spiegel');
  assert.match(bron, /kiesKlant\(/);
  assert.match(bron, /zoekKlantKandidaten\(/);
  // Geen eigen klant-lookup: dat zou een tweede koppeling zijn, en die
  // liepen in dit repo al eens uiteen (computeBedenktijd, viermaal).
  assert.doesNotMatch(bron, /from\(['"]customers['"]\)/,
    'de hold-lib zoekt zelf klanten op — dat hoort via de spiegel te lopen');
});

test('CONTRACT: elk verzendpad van de motor vraagt de hold-poort', () => {
  // De drie paden die daadwerkelijk een bericht naar een klant sturen. Komt
  // er ooit een vierde bij zonder poort, dan hoort deze test rood te worden
  // — niet de klant een aanmaning te krijgen tijdens zijn pauze.
  const PADEN = [
    'api/_lib/dunning-engine.js',
    'api/cron-dunning-bulk-send.js',
    'api/cron-dunning-conversation-reminders.js',
  ];
  for (const kort of PADEN) {
    const bron = readFileSync(join(ROOT, kort), 'utf8');
    assert.match(bron, /haalHoldStand\(/, kort + ' haalt de hold-stand niet op');
    assert.match(bron, /holdBlokkade\(/, kort + ' toetst de hold-poort niet');
  }
});

test('CONTRACT: de motor haalt de stand ÉÉN keer op, niet per klant', () => {
  // Honderden klanten per ronde: een bevraging per klant zou het LMS
  // platleggen en de cron over zijn tijdslimiet duwen.
  const bron = readFileSync(join(ROOT, 'api/_lib/dunning-engine.js'), 'utf8');
  const keren = (bron.match(/await haalHoldStand\(/g) || []).length;
  assert.equal(keren, 1, 'haalHoldStand() hoort precies één keer per engine-run te draaien');
});
