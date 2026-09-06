// tests/opvolging-nu-doen.test.js
//
// G3 — de nu-doen-balk bovenaan de dag. Wat is er nú aan de beurt, en oranje
// zodra een venster verstreken is.
//
// DE VALKUIL WAAR DEZE BALK OMHEEN GEBOUWD IS:
//
// Er staat maar één ding in deze module met een echte klok eraan — de twee
// vensters (spraakbericht vóór 09:00, nabellen 12:00-13:00) en de starttijden
// van de zoomcalls. Een open taak draagt een `due`, en dat is een DAG. Er is
// dus geen deadline om te tonen, en er mag er ook geen verzonnen worden: 'voor
// 17:00 afbellen' zou een getal zijn dat nergens vandaan komt, en dat is over
// twee weken niet meer van een echte afspraak te onderscheiden.
//
// Daarnaast: 'nog geen spraakbericht' is alleen te zeggen als de brug uitgaande
// berichten ziet. Ziet hij die niet, dan is dat geen nul maar een blinde vlek,
// en dan hoort de balk daarover te zwijgen in plaats van te alarmeren.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');

// Maandag 7 september 2026, 08:00 Amsterdamse tijd (= 06:00 UTC, zomertijd).
const DAG = '2026-09-07';

function laadView(iso = DAG + 'T06:00:00Z') {
  const vast = Date.parse(iso);
  class VasteDate extends Date {
    constructor(...a) { if (a.length === 0) super(vast); else super(...a); }
    static now() { return vast; }
  }
  const window = {
    DFO: { VIEWS: {}, render() {} }, KV_V2: { helpers: {} },
    KV: { authedJson: async () => ({}) },
    addEventListener() {}, setInterval: () => 0, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window, console: { debug() {}, log() {}, warn() {}, error() {} },
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date: VasteDate, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set, Map,
  });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvNuHelpers, 'de view hoort __opvNuHelpers te zetten');
  return window;
}

const H = () => laadView().__opvNuHelpers;

/** Een taak met pogingen, in de vorm die beoordeelDag verwacht. */
const taak = (over) => ({ id: 't1', naam: 'Jan', telefoon: '+32470123456', pogingen: [], ...over });
const spraakOm = (tijd) => ({ soort: 'spraakbericht', resultaat: 'verstuurd', tijdstip: DAG + 'T' + tijd + ':00+02:00' });
const callOm   = (tijd) => ({ soort: 'call', resultaat: 'gesproken', tijdstip: DAG + 'T' + tijd + ':00+02:00' });
const agenda   = (tijd, naam) => ({ naam: naam || 'Ann', telefoon: '+32470999888', start: DAG + 'T' + tijd + ':00+02:00', tijd });

const basis = (over) => ({
  dag: DAG, nu: DAG, minuut: 8 * 60, brugZiet: true,
  calls: [], callsStaat: 'geen_calls', vensterTaken: [], openTaken: 0, ...over,
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN OPEN TAAK KRIJGT GEEN VERZONNEN DEADLINE
// ═══════════════════════════════════════════════════════════════════════════

test('open taken worden geteld, zonder tijdstip', () => {
  const a = H().bepaalNuDoen(basis({ openTaken: 5 }));
  assert.equal(a.soort, 'taken');
  assert.match(a.titel, /5 open taken/);
  assert.match(a.uitleg, /aan een taak hangt een dag, geen klok/);
  assert.equal(a.deadline, undefined, 'er is geen deadline, dus er staat er geen');
  assert.equal(a.telaat, false, 'zonder deadline kan niets te laat zijn');
});

test('nergens in de balk staat een tijd die niet uit de data komt', () => {
  // De enige uren die mogen voorkomen zijn de twee vensters en echte
  // starttijden uit de agenda.
  const h = H();
  const toegestaan = new Set(['09:00', '12:00', '13:00']);
  for (const opts of [
    basis({ openTaken: 3 }),
    basis({ openTaken: 0 }),
    basis({ dag: '2026-09-08' }),
    basis({ brugZiet: false }),
  ]) {
    const a = h.bepaalNuDoen(opts);
    const uren = (JSON.stringify(a).match(/\b\d{2}:\d{2}\b/g) || []);
    for (const u of uren) assert.ok(toegestaan.has(u), 'onverwachte tijd in de balk: ' + u);
  }
});

test('enkelvoud en meervoud kloppen', () => {
  assert.match(H().bepaalNuDoen(basis({ openTaken: 1 })).titel, /1 open taak vandaag/);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET SPRAAKVENSTER: 09:00 IS EEN ECHTE DEADLINE
// ═══════════════════════════════════════════════════════════════════════════

test('vóór 09:00 telt de balk af', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 8 * 60 + 30, vensterTaken: [taak()] }));
  assert.equal(a.soort, 'spraak');
  assert.equal(a.telaat, false);
  assert.match(a.uitleg, /Nog 30 minuten tot 09:00/);
});

test('na 09:00 wordt hij oranje met de gemiste deadline erbij', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 10 * 60, vensterTaken: [taak()] }));
  assert.equal(a.soort, 'spraak');
  assert.equal(a.telaat, true);
  assert.match(a.uitleg, /Te laat — deadline was 09:00/);
});

test('precies 09:00 is te laat, niet net op tijd', () => {
  // Dezelfde grens als beoordeelSpraak: '< 09:00' is op tijd.
  const a = H().bepaalNuDoen(basis({ minuut: 9 * 60, vensterTaken: [taak()] }));
  assert.equal(a.telaat, true);
});

test('is het spraakbericht er, dan alarmeert de balk niet meer', () => {
  // Een gemiste deadline waar niets meer voor te doen valt is geschiedenis,
  // geen alarm. Die hoort in de tijdlijn, niet bovenaan de dag.
  const a = H().bepaalNuDoen(basis({
    minuut: 10 * 60, openTaken: 2,
    vensterTaken: [taak({ pogingen: [spraakOm('08:30')] })],
  }));
  assert.notEqual(a.soort, 'spraak');
  assert.equal(a.telaat, false);
});

test('een te laat verstuurd spraakbericht alarmeert ook niet meer', () => {
  const a = H().bepaalNuDoen(basis({
    minuut: 11 * 60, openTaken: 1,
    vensterTaken: [taak({ pogingen: [spraakOm('09:40')] })],
  }));
  assert.notEqual(a.soort, 'spraak');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET NABELVENSTER: 12:00 TOT 13:00
// ═══════════════════════════════════════════════════════════════════════════

const nabelNodig = [taak({ pogingen: [spraakOm('08:30')] })];

test('vóór 12:00 meldt de balk wanneer het venster opengaat', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 11 * 60, vensterTaken: nabelNodig }));
  assert.equal(a.soort, 'nabel');
  assert.equal(a.telaat, false);
  assert.match(a.uitleg, /gaat om 12:00 open/);
});

test('binnen het venster telt hij af', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 12 * 60 + 20, vensterTaken: nabelNodig }));
  assert.equal(a.telaat, false);
  assert.match(a.uitleg, /Nog 40 minuten tot 13:00/);
});

test('na 13:00 wordt hij oranje met het gemiste venster erbij', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 14 * 60, vensterTaken: nabelNodig }));
  assert.equal(a.soort, 'nabel');
  assert.equal(a.telaat, true);
  assert.match(a.uitleg, /Te laat — het venster was 12:00 tot 13:00/);
});

test('wie al nagebeld is telt niet meer mee', () => {
  const a = H().bepaalNuDoen(basis({
    minuut: 14 * 60, openTaken: 1,
    vensterTaken: [taak({ pogingen: [spraakOm('08:30'), callOm('12:10')] })],
  }));
  assert.notEqual(a.soort, 'nabel');
});

test('het spraakvenster gaat voor het nabelvenster', () => {
  // Staat er nog een spraakbericht open, dan is dát het eerste dat moet.
  const a = H().bepaalNuDoen(basis({
    minuut: 14 * 60,
    vensterTaken: [taak(), taak({ id: 't2', pogingen: [spraakOm('08:30')] })],
  }));
  assert.equal(a.soort, 'spraak');
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN CALL MET EEN ECHTE STARTTIJD GAAT VOOR
// ═══════════════════════════════════════════════════════════════════════════

test('een call die nu bezig is staat bovenaan', () => {
  const a = H().bepaalNuDoen(basis({
    minuut: 10 * 60 + 10, calls: [agenda('10:00', 'Ann')], vensterTaken: [taak()],
  }));
  assert.equal(a.soort, 'call_bezig');
  assert.match(a.titel, /Ann/);
  assert.equal(a.telaat, false, 'een lopende call is geen alarm');
});

test('een call die zo komt ook, met de minuten erbij', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 9 * 60 + 30, calls: [agenda('10:00')] }));
  assert.equal(a.soort, 'call_straks');
  assert.match(a.uitleg, /Over 30 minuten/);
  assert.equal(a.deadline, '10:00');
});

test('een call ver weg neemt de balk niet over', () => {
  const h = H();
  const a = h.bepaalNuDoen(basis({ minuut: 8 * 60, openTaken: 2, calls: [agenda('16:00')] }));
  assert.equal(a.soort, 'taken');
  assert.ok(h.CALL_VOORUIT_MIN < 8 * 60, 'de grens hoort een echte grens te zijn');
});

test('een call van gisteren telt niet mee', () => {
  const a = H().bepaalNuDoen(basis({
    minuut: 10 * 60, openTaken: 1,
    calls: [{ naam: 'Oud', start: '2026-09-06T10:00:00+02:00' }],
  }));
  assert.equal(a.soort, 'taken');
});

// ═══════════════════════════════════════════════════════════════════════════
// WAT NIET TE METEN IS, WORDT NIET BEWEERD
// ═══════════════════════════════════════════════════════════════════════════

test('zonder brug zegt de balk niets over spraak of nabellen', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 14 * 60, brugZiet: false, vensterTaken: [taak()] }));
  assert.notEqual(a.soort, 'spraak');
  assert.notEqual(a.soort, 'nabel');
  assert.equal(a.telaat, false, 'geen alarm op iets dat niet gekeken is');
});

test('zonder brug en zonder taken heet dat een blinde vlek, geen "klaar"', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 14 * 60, brugZiet: false }));
  assert.equal(a.soort, 'niet_meetbaar');
  assert.match(a.uitleg, /blinde vlek/);
  assert.doesNotMatch(a.titel + a.uitleg, /alles (is )?rond|klaar voor vandaag/i);
});

test('een andere dag krijgt geen nu-balk maar uitleg', () => {
  const a = H().bepaalNuDoen(basis({ dag: '2026-09-10' }));
  assert.equal(a.soort, 'andere_dag');
  assert.match(a.uitleg, /"Nu" bestaat alleen vandaag/);
  assert.equal(a.telaat, false);
});

test('zonder klok wordt er niets beweerd', () => {
  const a = H().bepaalNuDoen(basis({ minuut: null }));
  assert.equal(a.soort, 'geen_klok');
});

test('een agenda die eruit ligt wordt benoemd', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 14 * 60, callsStaat: 'agenda_fout' }));
  assert.equal(a.soort, 'agenda_fout');
  assert.match(a.uitleg, /niet bereikbaar/);
});

test('"klaar" wordt alleen gemeld als alles daadwerkelijk bekeken is', () => {
  const a = H().bepaalNuDoen(basis({ minuut: 14 * 60, brugZiet: true, callsStaat: 'geen_calls' }));
  assert.equal(a.soort, 'klaar');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BALK OP HET SCHERM
// ═══════════════════════════════════════════════════════════════════════════

test('de balk staat boven de weekbalk', () => {
  const b = readFileSync(VIEW, 'utf8');
  assert.ok(b.indexOf('h += nuDoenBalk(dag)') > 0);
  assert.ok(b.indexOf('h += nuDoenBalk(dag)') < b.indexOf('h += weekbalk(dag)'),
    'wat nú moet hoort het eerste te zijn wat je ziet');
});

test('te laat wordt oranje, en anders niet', () => {
  const w = laadView(DAG + 'T12:00:00Z');   // 14:00 lokaal
  const h = w.__opvNuHelpers;
  h.zetWa({ data: { verbonden: true, ziet_uitgaand: true } });
  h.zetTaken(DAG, [taak()]);
  h.zetCalls(DAG, [{ naam: 'Jan', telefoon: '+32470123456', start: DAG + 'T09:00:00+02:00', tijd: '09:00' }]);
  const html = h.nuDoenBalk(DAG);
  assert.match(html, /class="nudoen laat"/);
  assert.match(html, /Te laat — deadline was 09:00/);
});

test('de balk toont het aantal dat ook in de lijst staat', () => {
  const w = laadView();
  const h = w.__opvNuHelpers;
  h.zetWa({ data: { verbonden: true, ziet_uitgaand: false } });
  h.zetTaken(DAG, [taak(), taak({ id: 't2' }), taak({ id: 't3' })]);
  assert.match(h.nuDoenBalk(DAG), /3 open taken vandaag/);
});

test('de tekst in de balk wordt ontsnapt', () => {
  const w = laadView();
  const h = w.__opvNuHelpers;
  h.zetWa({ data: { verbonden: true, ziet_uitgaand: true } });
  h.zetCalls(DAG, [{ naam: '<img src=x onerror=alert(1)>', start: DAG + 'T08:30:00+02:00', tijd: '08:30' }]);
  const html = h.nuDoenBalk(DAG);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

test('de CSS staat gescoped onder .opv', () => {
  const b = readFileSync(VIEW, 'utf8');
  for (const regel of (b.match(/^\.opv \.nudoen[^{]*\{/gm) || [])) {
    assert.match(regel, /^\.opv /, regel);
  }
  assert.ok((b.match(/^\.opv \.nudoen/gm) || []).length >= 4, 'de balk hoort eigen regels te hebben');
  assert.ok(!/^\.nudoen/m.test(b), 'niets ongescoped');
});

test('de duur en de vooruitblik van een call zijn schattingen, en staan apart', () => {
  // De agenda levert een starttijd en geen eind. Dat mag, maar het moet
  // zichtbaar blijven dat deze twee getallen niet gemeten zijn.
  const b = readFileSync(VIEW, 'utf8');
  const i = b.indexOf('const CALL_DUUR_MIN');
  assert.ok(i > 0);
  assert.match(b.slice(Math.max(0, i - 400), i), /schattingen/);
});
