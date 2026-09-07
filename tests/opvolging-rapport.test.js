// tests/opvolging-rapport.test.js
//
// Het dagrapport (item R). Dit rapport gaat over een persoon: elk getal wordt
// een gesprek tussen Maxim en Dave. Een cijfer dat niet klopt kost niet alleen
// zichzelf maar de geloofwaardigheid van het hele rapport.
//
// Deze tests draaien de ECHTE bouwers op echte invoer, niet op de brontekst.
// Een test die alleen naar de code kijkt bewaakt hoe het er staat en niet wat
// het doet, en dat is op 6 september drie keer misgegaan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  telVolume, bouwVensters, bouwZoomcalls, bouwArchief, vulAandacht,
} from '../api/opvolging-rapport.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRON = readFileSync(join(ROOT, 'api/opvolging-rapport.js'), 'utf8');

const DAG = '2026-09-01';
const op = (uur, min = 0) => `${DAG}T${String(uur - 2).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`;

// ═══════════════════════════════════════════════════════════════════════════
// SECTIE 4 · DE UITKOMST WORDT NOOIT UIT status GERADEN
// ═══════════════════════════════════════════════════════════════════════════
// Dit is de kern van item R. `status` kent maar drie waarden voor zeven
// uitkomsten: sale en gesprek_gehad worden allebei 'completed', wilt_niet_meer
// en niet_geschikt allebei 'cancelled'. Uit status afleiden wat de uitkomst was
// is dus per definitie een gok — dezelfde verleiding als de notitietekst
// uitparseren, en net zo fout.

test('een call met status completed maar zonder uitkomst geldt als NIET vastgelegd', () => {
  const [c] = bouwZoomcalls({
    afspraken: [{ id: 'a1', lead_name: 'Jan', scheduled_at: op(10), status: 'completed', uitkomst: null, uitkomst_op: null }],
    uitkomstKolommen: true,
  });
  assert.equal(c.vastgelegd, false);
  assert.equal(c.uitkomst, null);
});

test('status cancelled wordt niet als wilt_niet_meer of niet_geschikt geraden', () => {
  const [c] = bouwZoomcalls({
    afspraken: [{ id: 'a1', lead_name: 'Jan', scheduled_at: op(10), status: 'cancelled', uitkomst: null }],
    uitkomstKolommen: true,
  });
  assert.equal(c.uitkomst, null);
  assert.equal(c.vastgelegd, false);
});

test('status no_show wordt evenmin als uitkomst overgenomen', () => {
  const [c] = bouwZoomcalls({
    afspraken: [{ id: 'a1', lead_name: 'Jan', scheduled_at: op(10), status: 'no_show', uitkomst: null }],
    uitkomstKolommen: true,
  });
  assert.equal(c.uitkomst, null);
});

test('een vastgelegde uitkomst komt wél door, met zijn eigen moment', () => {
  const [c] = bouwZoomcalls({
    afspraken: [{
      id: 'a1', lead_name: 'Jan', scheduled_at: op(10), status: 'completed',
      uitkomst: 'sale', uitkomst_op: '2026-09-01T12:00:00Z',
    }],
    uitkomstKolommen: true,
  });
  assert.equal(c.vastgelegd, true);
  assert.equal(c.uitkomst, 'sale');
  assert.equal(c.uitkomst_op, '2026-09-01T12:00:00Z');
});

test('sale en gesprek_gehad blijven te onderscheiden — dat kan status niet', () => {
  // Zonder deze test zou een implementatie die alles op 'completed' plat slaat
  // er groen doorheen komen.
  const calls = bouwZoomcalls({
    afspraken: [
      { id: 'a1', lead_name: 'A', scheduled_at: op(10), status: 'completed', uitkomst: 'sale' },
      { id: 'a2', lead_name: 'B', scheduled_at: op(11), status: 'completed', uitkomst: 'gesprek_gehad' },
    ],
    uitkomstKolommen: true,
  });
  assert.deepEqual(calls.map((c) => c.uitkomst), ['sale', 'gesprek_gehad']);
});

test('zonder de migratie zegt het rapport dat uitkomsten nog niet bewaard worden', () => {
  // Het verschil tussen "Dave vulde niets in" en "het systeem legde het niet
  // vast" is precies wat op 6 september gerepareerd is. Dat verschil hoort
  // zichtbaar te blijven, ook in de reden.
  const [c] = bouwZoomcalls({
    afspraken: [{ id: 'a1', lead_name: 'Jan', scheduled_at: op(10), status: 'completed' }],
    uitkomstKolommen: false,
  });
  assert.equal(c.vastgelegd, false);
  assert.match(c.reden_leeg, /nog niet bewaard/);
});

test('mét de migratie maar zonder uitkomst luidt de reden anders', () => {
  const [c] = bouwZoomcalls({
    afspraken: [{ id: 'a1', lead_name: 'Jan', scheduled_at: op(10), status: 'completed', uitkomst: null }],
    uitkomstKolommen: true,
  });
  assert.match(c.reden_leeg, /geen uitkomst vastgelegd/i);
  assert.doesNotMatch(c.reden_leeg, /nog niet bewaard/);
});

test('de code noemt status nergens als bron voor een uitkomst', () => {
  const i = BRON.indexOf('function bouwZoomcalls');
  const blok = BRON.slice(i, BRON.indexOf('// ── Sectie 5', i));
  // a.status mag gelezen worden om te tonen, maar nooit in een toewijzing aan
  // uitkomst. Een ternary op a.status is precies de gok die hier niet mag.
  assert.doesNotMatch(blok, /uitkomst\s*:\s*[^,\n]*a\.status/);
  assert.doesNotMatch(blok, /a\.status\s*===\s*'completed'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTIE 1 · STILTE IS GEEN GOEDKEURING
// ═══════════════════════════════════════════════════════════════════════════

test('een blinde vlek verschijnt als aandachtspunt', () => {
  // Zonder dit zou een sectie die niets kon meten stil blijven, en dan leest
  // 'geen afwijkingen' als 'alles in orde'. Dat is de duurste fout die dit
  // rapport kan maken.
  const aandacht = [];
  vulAandacht({
    aandacht,
    blindeVlekken: [{ sectie: 'dekking', wat: 'De lijst is niet bewaard.', waarom: 'due wordt overschreven.' }],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] },
    zoomcalls: [], archief: [],
  });
  assert.equal(aandacht.length, 1);
  assert.equal(aandacht[0].soort, 'blinde_vlek');
  assert.match(aandacht[0].tekst, /niet bewaard/);
});

test('de aandachtlijst is alleen leeg als er echt niets is', () => {
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [{ naam: 'Jan' }], onbehandeld: [] },
    vensters: { rijen: [{ naam: 'Jan', dag: DAG, spraak: { staat: 'op_tijd', tijd: '08:30' }, nabel: { staat: 'niet_nodig', reden: 'heeft geantwoord' } }], zonder_taak: [] },
    zoomcalls: [{ naam: 'Jan', dag: DAG, vastgelegd: true, uitkomst: 'sale' }],
    archief: [{ naam: 'Jan', moeite: { staat: 'genoeg' }, bel_totaal: 3, bel_dagen: 3, wa_totaal: 1 }],
  });
  assert.equal(aandacht.length, 0);
});

test('een call zonder vastgelegde uitkomst wordt niet als Daves nalatigheid geformuleerd', () => {
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] },
    zoomcalls: [{ naam: 'Jan', dag: DAG, vastgelegd: false, reden_leeg: 'Er is voor deze call geen uitkomst vastgelegd.', appointment_id: 'a1' }],
    archief: [],
  });
  assert.equal(aandacht.length, 1);
  assert.match(aandacht[0].tekst, /is geen uitkomst vastgelegd/);
  // Het mag niet klinken alsof vaststaat dat Dave het liet liggen: het kan ook
  // aan het systeem liggen, en dat verschil weten we hier niet.
  assert.doesNotMatch(aandacht[0].tekst, /Dave|vulde|vergat|niet ingevuld/i);
});

test('te weinig moeite komt in de aandachtlijst, n.v.t. niet', () => {
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] }, zoomcalls: [],
    archief: [
      { naam: 'Weinig', taak_id: 't1', bel_totaal: 1, bel_dagen: 1, wa_totaal: 0, moeite: { staat: 'te_weinig' } },
      { naam: 'Zei nee', taak_id: 't2', bel_totaal: 0, bel_dagen: 0, wa_totaal: 0, moeite: { staat: 'nvt' } },
    ],
  });
  assert.equal(aandacht.length, 1);
  assert.match(aandacht[0].naam, /Weinig/);
});

test('calls zonder taak melden zich als blinde vlek, niet als gemist spraakbericht', () => {
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [{ appointment_id: 'a1', naam: 'Los' }] },
    zoomcalls: [], archief: [],
  });
  assert.equal(aandacht.length, 1);
  assert.equal(aandacht[0].soort, 'blinde_vlek');
  assert.doesNotMatch(aandacht[0].tekst, /geen spraakbericht/);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTIE 6 · VOLUME — GEMETEN SECONDEN, GEEN GESCHATTE
// ═══════════════════════════════════════════════════════════════════════════

test('uit en in worden apart geteld', () => {
  const v = telVolume([
    { taak_id: 't1', soort: 'whatsapp', richting: 'uit', tijdstip: op(9) },
    { taak_id: 't1', soort: 'whatsapp', richting: 'in', tijdstip: op(10) },
    { taak_id: 't1', soort: 'spraakbericht', richting: 'uit', tijdstip: op(8) },
    { taak_id: 't1', soort: 'spraakbericht', richting: 'in', tijdstip: op(11) },
  ], new Map([['t1', { naam: 'Jan' }]]));
  assert.deepEqual({ ...v.wa }, { uit: 1, in: 1 });
  assert.deepEqual({ ...v.spraak }, { uit: 1, in: 1 });
});

test('een antwoord van de lead telt niet als belpoging', () => {
  // isMoeite gaat over de moeite die Dave doet; een antwoord is het resultaat
  // daarvan, niet de inspanning.
  const v = telVolume([
    { taak_id: 't1', soort: 'whatsapp', richting: 'in', tijdstip: op(10) },
  ], new Map());
  assert.equal(v.bel.uit, 0);
  assert.equal(v.wa.uit, 0);
  assert.equal(v.wa.in, 1);
});

test('calls zonder duur worden geteld, niet geschat', () => {
  const v = telVolume([
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: op(9), duur_sec: 120, resultaat: 'gesproken' },
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: op(10), duur_sec: null, resultaat: 'niet opgenomen' },
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: op(11), resultaat: 'niet opgenomen' },
  ], new Map());
  assert.equal(v.bel.uit, 3);
  assert.equal(v.bel.seconden, 120);      // niet 360, niet 180
  assert.equal(v.bel.gesproken, 1);
  // De twee zonder duur zijn hier ook NIET OPGENOMEN, en dat is sinds de
  // vier-emmers-fix de eerste vraag: een call waar niemand opnam heeft geen
  // ontbrekende duur maar geen gesprek. zonder_duur is voortaan 'opgenomen,
  // maar we weten niet hoe lang'.
  assert.equal(v.bel.niet_opgenomen, 2);
  assert.equal(v.bel.zonder_duur, 0);
});

test('agenda_doorgestuurd en ingepland zijn geen volume', () => {
  const v = telVolume([
    { taak_id: 't1', soort: 'agenda_doorgestuurd', richting: 'uit', tijdstip: op(9) },
    { taak_id: 't1', soort: 'ingepland', richting: 'uit', tijdstip: op(10) },
  ], new Map());
  assert.equal(v.rijen.length, 0);
  assert.equal(v.bel.uit + v.wa.uit + v.spraak.uit, 0);
});

test('elke gebeurtenis draagt zijn rij, zodat een getal terug te klikken is', () => {
  const v = telVolume([
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: op(9), duur_sec: 60, resultaat: 'gesproken' },
  ], new Map([['t1', { naam: 'Jan' }]]));
  assert.equal(v.rijen.length, 1);
  assert.equal(v.rijen[0].naam, 'Jan');
  assert.equal(v.rijen[0].dag, DAG);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTIE 3 · WIE HOORT ER IN DE VENSTERS
// ═══════════════════════════════════════════════════════════════════════════

test('alleen leads met een zoomcall die dag komen in de vensters', () => {
  // Een masterclass-aanmelding hoort geen ochtendspraakbericht te krijgen. Die
  // meetellen leverde eerder tien keer rood op voor mensen voor wie er geen
  // spraakbericht bestaat.
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Jan', lead_phone: '+32470111222', scheduled_at: op(14) }],
    taken: [
      { id: 't1', naam: 'Jan', telefoon: '+32470111222' },
      { id: 't2', naam: 'Aanmelding', telefoon: '+32470999888' },
    ],
    pogingen: [],
    dagen: [DAG],
  });
  assert.equal(v.rijen.length, 1);
  assert.equal(v.rijen[0].naam, 'Jan');
  assert.equal(v.spraak.totaal, 1);      // niet 2
});

test('een lokaal geschreven nummer koppelt via de laatste negen cijfers', () => {
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Jan', lead_phone: '0470 11 12 22', scheduled_at: op(14) }],
    taken: [{ id: 't1', naam: 'Jan', telefoon: '+32470111222' }],
    pogingen: [], dagen: [DAG],
  });
  assert.equal(v.rijen.length, 1);
  assert.equal(v.zonder_taak.length, 0);
});

test('twee taken met dezelfde staart leveren geen gok op', () => {
  // Ambiguïteit is een niet-gekoppelde call, geen 'kies de eerste'.
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Jan', lead_phone: '0470111222', scheduled_at: op(14) }],
    taken: [
      { id: 't1', naam: 'Jan', telefoon: '+32470111222' },
      { id: 't2', naam: 'Jan Bis', telefoon: '+31470111222' },
    ],
    pogingen: [], dagen: [DAG],
  });
  assert.equal(v.rijen.length, 0);
  assert.equal(v.zonder_taak.length, 1);
});

test('een call zonder taak telt niet als gemist spraakbericht', () => {
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Los', lead_phone: '+32470000000', scheduled_at: op(14) }],
    taken: [], pogingen: [], dagen: [DAG],
  });
  assert.equal(v.spraak.niet_gedaan, 0);
  assert.equal(v.zonder_taak.length, 1);
});

test('twee calls voor dezelfde persoon op één dag tellen één keer', () => {
  const v = bouwVensters({
    afspraken: [
      { id: 'a1', lead_name: 'Jan', lead_phone: '+32470111222', scheduled_at: op(10) },
      { id: 'a2', lead_name: 'Jan', lead_phone: '+32470111222', scheduled_at: op(15) },
    ],
    taken: [{ id: 't1', naam: 'Jan', telefoon: '+32470111222' }],
    pogingen: [], dagen: [DAG],
  });
  assert.equal(v.rijen.length, 1);
  assert.equal(v.spraak.totaal, 1);
});

test('het venster-oordeel gebruikt de pogingen van die lead', () => {
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Jan', lead_phone: '+32470111222', scheduled_at: op(14) }],
    taken: [{ id: 't1', naam: 'Jan', telefoon: '+32470111222' }],
    pogingen: [
      { taak_id: 't1', soort: 'spraakbericht', richting: 'uit', tijdstip: op(8, 30) },
      { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: op(12, 15) },
    ],
    dagen: [DAG],
  });
  assert.equal(v.spraak.op_tijd, 1);
  assert.equal(v.nabel.op_tijd, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTIE 5 · DE MOEITE TELT OVER DE HELE LEVENSLOOP
// ═══════════════════════════════════════════════════════════════════════════

test('de moeite naast een gearchiveerde lead telt zijn hele historiek', () => {
  // Met een gemeten duur erbij: zonder dat is het oordeel terecht 'onbekend'
  // en meet deze test niet meer wat hij wil meten.
  const hist = new Map([['t1', [
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-20T09:00:00Z', duur_sec: 40 },
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-21T09:00:00Z', duur_sec: 35 },
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-22T09:00:00Z', duur_sec: 50 },
    { taak_id: 't1', soort: 'whatsapp', richting: 'uit', tijdstip: '2026-08-22T10:00:00Z' },
  ]]]);
  const [a] = bouwArchief({
    gearchiveerd: [{ id: 't1', naam: 'Jan', gearchiveerd_at: op(16), archief_reden: 'geen reactie' }],
    histPerTaak: hist,
  });
  assert.equal(a.bel_totaal, 3);
  assert.equal(a.bel_dagen, 3);
  assert.equal(a.wa_totaal, 1);
  assert.equal(a.moeite.staat, 'genoeg');
  assert.equal(a.moeite_over, 'levensloop');
});

test('een antwoord van de lead telt niet mee als moeite bij het archief', () => {
  const hist = new Map([['t1', [
    { taak_id: 't1', soort: 'whatsapp', richting: 'in', tijdstip: '2026-08-22T10:00:00Z' },
  ]]]);
  const [a] = bouwArchief({
    gearchiveerd: [{ id: 't1', naam: 'Jan', gearchiveerd_at: op(16) }],
    histPerTaak: hist,
  });
  assert.equal(a.wa_totaal, 0);
  assert.equal(a.moeite.staat, 'te_weinig');
});

test('zoom_geen_interesse krijgt n.v.t. en geen rood, ook zonder pogingen', () => {
  const [a] = bouwArchief({
    gearchiveerd: [{ id: 't1', naam: 'Jan', gearchiveerd_at: op(16), reden_code: 'zoom_geen_interesse' }],
    histPerTaak: new Map(),
  });
  assert.equal(a.moeite.staat, 'nvt');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE RECHTEN — GEEN STILLE TERUGVAL
// ═══════════════════════════════════════════════════════════════════════════

test('het endpoint gebruikt de strikte requirePermission op zijn eigen sleutel', () => {
  assert.match(BRON, /requirePermission\(req, 'opvolging\.rapport\.view'\)/);
  // NIET de fail-open variant: die laat een request zonder token gewoon door.
  assert.doesNotMatch(BRON, /requirePermissionFailOpen/);
});

test('er is geen terugval op een andere rechtensleutel', () => {
  // Zou dit terugvallen op module.access of dashboard.view, dan zou een
  // beheerder die het rapport uitzet niets zien gebeuren. Dat is precies het
  // soort stille terugval waar deze module drie keer op is vastgelopen.
  const aanroepen = BRON.match(/requirePermission\(req, '[^']+'\)/g) || [];
  assert.deepEqual(aanroepen, ["requirePermission(req, 'opvolging.rapport.view')"]);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE MIGRATIE
// ═══════════════════════════════════════════════════════════════════════════

test('de migratie voegt de twee kolommen toe en vult ze niet met terugwerkende kracht', () => {
  const sql = readFileSync(join(ROOT, 'docs/sql-migrations/2026-09-06-opvolging-rapport.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS uitkomst text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS uitkomst_op timestamptz/);
  // Een UPDATE die uitkomst uit status afleidt zou precies de gok zijn die
  // dit hele onderdeel wil vermijden — en dan staat hij ook nog in de databank.
  assert.doesNotMatch(sql, /UPDATE\s+public\.follow_up_appointments\s+SET\s+uitkomst/i);
});

test('de migratie zet de rechtensleutel voor manager en sales op true', () => {
  const sql = readFileSync(join(ROOT, 'docs/sql-migrations/2026-09-06-opvolging-rapport.sql'), 'utf8');
  for (const rol of ['manager', 'sales']) {
    const re = new RegExp("SELECT '" + rol + "', 'opvolging\\.rapport\\.view', true");
    assert.match(sql, re, rol + ' hoort de sleutel op true te krijgen');
  }
  // Dave is sales. Ziet hij zijn eigen rapport niet, dan gaat het gesprek over
  // of de cijfers wel kloppen in plaats van over de leads die bleven liggen.
  for (const rol of ['mentor', 'administratie', 'marketing']) {
    const re = new RegExp("SELECT '" + rol + "', 'opvolging\\.rapport\\.view', false");
    assert.match(sql, re, rol + ' hoort een expliciete false-rij te krijgen');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DE LEAD MET EEN ZOOMCALL MAAR ZONDER ENKELE POGING
// ═══════════════════════════════════════════════════════════════════════════
// Dat is precies de lead die het rapport moet aanwijzen. Zou hij alleen uit de
// pogingen komen, dan zit hij er niet in — en dan telt zijn gemiste
// spraakbericht nergens mee. Het cijfer dat ontbreekt is het cijfer dat ertoe
// doet.

test('een zoomcall-lead zonder pogingen levert een gemist spraakbericht op', () => {
  const v = bouwVensters({
    afspraken: [{ id: 'a1', lead_name: 'Stil', lead_phone: '+32470111222', scheduled_at: op(14) }],
    taken: [{ id: 't1', naam: 'Stil', telefoon: '+32470111222' }],
    pogingen: [],                       // niets gedaan voor deze lead
    dagen: [DAG],
  });
  assert.equal(v.rijen.length, 1);
  assert.equal(v.spraak.niet_gedaan, 1);
  assert.equal(v.zonder_taak.length, 0, 'hij hoort NIET in de niet-te-beoordelen hoek te belanden');
});

test('het endpoint haalt de taken achter de zoomcalls apart op', () => {
  // Zonder deze tweede query bevat de takenset alleen leads die in de periode
  // een poging kregen of dicht gingen — en dan verdwijnt de lead hierboven.
  const i = BRON.indexOf('De taken achter de ZOOMCALLS');
  assert.ok(i > 0, 'de tweede takenquery hoort te bestaan');
  const blok = BRON.slice(i, i + 1800);
  assert.match(blok, /\.not\('telefoon', 'is', null\)/);
  assert.match(blok, /TAKEN_LIMIET/);
});

test('bouwVensters krijgt de samengevoegde takenset, niet alleen de pogingen-set', () => {
  // De afspraken-parameter heet sinds de filterfix vensterAfspraken; de
  // takenset is nog steeds de samengevoegde.
  assert.match(BRON, /bouwVensters\(\{ afspraken: vensterAfspraken, taken: alleTaken, pogingen, dagen \}\)/);
});

test('een afgekapte takenlijst wordt gemeld en niet stil geslikt', () => {
  const i = BRON.indexOf('telefoonAfgekapt = ');
  assert.ok(i > 0);
  const blok = BRON.slice(i, i + 700);
  assert.match(blok, /blindeVlekken\.push/);
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN CALL DIE NOG MOET PLAATSVINDEN IS GEEN GEMISTE UITKOMST
// ═══════════════════════════════════════════════════════════════════════════
// Op 7 september stonden er om acht uur 's ochtends zeven verwijten in de
// aandachtlijst over calls van later die dag. Een rapport dat werk afkeurt dat
// nog niet gedaan hoefde te zijn, verspeelt zijn geloofwaardigheid bij het
// eerste gesprek.

import { callStaat, groepeerDubbele, GESPREK_MIN_SEC } from '../api/opvolging-rapport.js';

const OCHTEND = Date.parse('2026-09-07T06:00:00Z');   // 08:00 in Amsterdam

test('een call van vanavond staat als gepland, niet als gemist', () => {
  const a = { scheduled_at: '2026-09-07T18:30:00Z', duration_minutes: 30 };
  assert.equal(callStaat(a, OCHTEND), 'gepland');
});

test('een call van 20:30 is om 20:35 nog niet te beoordelen', () => {
  const a = { scheduled_at: '2026-09-07T18:30:00Z', duration_minutes: 30 };
  assert.equal(callStaat(a, Date.parse('2026-09-07T18:35:00Z')), 'gepland');
});

test('na de duur plus speling mag hij wel beoordeeld worden', () => {
  const a = { scheduled_at: '2026-09-07T18:30:00Z', duration_minutes: 30 };
  // 30 minuten duur + 15 speling = 19:15 UTC.
  assert.equal(callStaat(a, Date.parse('2026-09-07T19:14:00Z')), 'gepland');
  assert.equal(callStaat(a, Date.parse('2026-09-07T19:16:00Z')), 'te_beoordelen');
});

test('een langere call krijgt ook langer de tijd', () => {
  const a = { scheduled_at: '2026-09-07T18:30:00Z', duration_minutes: 60 };
  assert.equal(callStaat(a, Date.parse('2026-09-07T19:16:00Z')), 'gepland');
});

test('een verzette rij wordt nooit beoordeeld', () => {
  // follow-up-verplaats-call zet de oude rij op 'verplaatst' en maakt een
  // nieuwe. Die oude hoort geen uitkomst te krijgen.
  const a = { scheduled_at: '2026-09-01T08:00:00Z', status: 'verplaatst' };
  assert.equal(callStaat(a, OCHTEND), 'verplaatst');
});

test('een call van gisteren is gewoon te beoordelen', () => {
  const a = { scheduled_at: '2026-09-06T10:00:00Z', duration_minutes: 30 };
  assert.equal(callStaat(a, OCHTEND), 'te_beoordelen');
});

test('geplande calls komen niet in de aandachtlijst', () => {
  const zoomcalls = bouwZoomcalls({
    afspraken: [
      { id: 'a1', lead_name: 'Mehmet', scheduled_at: '2026-09-07T18:30:00Z', duration_minutes: 30 },
      { id: 'a2', lead_name: 'Sander', scheduled_at: '2026-09-07T19:00:00Z', duration_minutes: 30 },
    ],
    uitkomstKolommen: true, nuMs: OCHTEND,
  });
  assert.deepEqual(zoomcalls.map((c) => c.staat), ['gepland', 'gepland']);
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] },
    zoomcalls, archief: [],
  });
  assert.equal(aandacht.length, 0, 'werk dat nog niet gedaan hoefde te zijn is geen afwijking');
});

test('een call die wél voorbij is en geen uitkomst heeft, staat er nog steeds', () => {
  // Zonder deze test zou 'alles gepland noemen' er groen doorheen komen.
  const zoomcalls = bouwZoomcalls({
    afspraken: [{ id: 'a1', lead_name: 'Gisteren', scheduled_at: '2026-09-06T10:00:00Z' }],
    uitkomstKolommen: true, nuMs: OCHTEND,
  });
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] },
    zoomcalls, archief: [],
  });
  assert.equal(aandacht.length, 1);
  assert.equal(aandacht[0].soort, 'geen_uitkomst');
});

// ═══════════════════════════════════════════════════════════════════════════
// TWEE IDENTIEKE VERWIJTEN IS GEEN BEVINDING MAAR EEN TELFOUT
// ═══════════════════════════════════════════════════════════════════════════

const dubbelAfspraken = [
  { id: 'a1', lead_name: 'Yasmine Aouada', lead_email: 'y@x.nl', scheduled_at: '2026-09-06T09:00:00Z' },
  { id: 'a2', lead_name: 'Yasmine Aouada', lead_email: 'y@x.nl', scheduled_at: '2026-09-06T14:00:00Z' },
];

test('twee afspraken voor dezelfde persoon op dezelfde dag worden één regel', () => {
  const zoomcalls = bouwZoomcalls({ afspraken: dubbelAfspraken, uitkomstKolommen: true, nuMs: OCHTEND });
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] },
    zoomcalls, archief: [],
  });
  assert.equal(aandacht.length, 1, 'niet twee identieke verwijten naast elkaar');
  assert.equal(aandacht[0].soort, 'dubbele_afspraak');
  assert.match(aandacht[0].tekst, /2 afspraken voor Yasmine Aouada/);
});

test('de dubbeling is zelf het aandachtspunt, met beide tijden erbij', () => {
  const zoomcalls = bouwZoomcalls({ afspraken: dubbelAfspraken, uitkomstKolommen: true, nuMs: OCHTEND });
  const [d] = groepeerDubbele(zoomcalls);
  assert.equal(d.tijden.length, 2);
  assert.deepEqual(d.appointment_ids, ['a1', 'a2']);
  assert.equal(d.verzet_ernaast, 0);
});

test('een verzetting is geen dubbele boeking', () => {
  const zoomcalls = bouwZoomcalls({
    afspraken: [
      { ...dubbelAfspraken[0], status: 'verplaatst' },
      dubbelAfspraken[1],
    ],
    uitkomstKolommen: true, nuMs: OCHTEND,
  });
  assert.equal(groepeerDubbele(zoomcalls).length, 0);
});

test('koppelen gaat op e-mail, niet alleen op naam', () => {
  const zoomcalls = bouwZoomcalls({
    afspraken: [
      { id: 'a1', lead_name: 'Jan Jansen', lead_email: 'jan1@x.nl', scheduled_at: '2026-09-06T09:00:00Z' },
      { id: 'a2', lead_name: 'Jan Jansen', lead_email: 'jan2@x.nl', scheduled_at: '2026-09-06T14:00:00Z' },
    ],
    uitkomstKolommen: true, nuMs: OCHTEND,
  });
  assert.equal(groepeerDubbele(zoomcalls).length, 0, 'twee verschillende mensen met dezelfde naam');
});

test('zonder e-mail koppelt hij op de laatste negen cijfers van het nummer', () => {
  const zoomcalls = bouwZoomcalls({
    afspraken: [
      { id: 'a1', lead_name: 'Jan', lead_phone: '+32470111222', scheduled_at: '2026-09-06T09:00:00Z' },
      { id: 'a2', lead_name: 'Jan', lead_phone: '0470 11 12 22', scheduled_at: '2026-09-06T14:00:00Z' },
    ],
    uitkomstKolommen: true, nuMs: OCHTEND,
  });
  assert.equal(groepeerDubbele(zoomcalls).length, 1);
});

test('twee afspraken op VERSCHILLENDE dagen zijn geen dubbeling', () => {
  const zoomcalls = bouwZoomcalls({
    afspraken: [
      { id: 'a1', lead_name: 'Jan', lead_email: 'j@x.nl', scheduled_at: '2026-09-05T09:00:00Z' },
      { id: 'a2', lead_name: 'Jan', lead_email: 'j@x.nl', scheduled_at: '2026-09-06T09:00:00Z' },
    ],
    uitkomstKolommen: true, nuMs: OCHTEND,
  });
  assert.equal(groepeerDubbele(zoomcalls).length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE ECHTE DAG VAN 7 SEPTEMBER — ZES RIJEN, DRIE CALLS
// ═══════════════════════════════════════════════════════════════════════════
// Uit follow_up_appointments voor 2026-09-07. Dit zijn de werkelijke rijen,
// niet een verzonnen geval: het rapport meldde er zes en beschuldigde Dave van
// een ontbrekende uitkomst op een call die geannuleerd was.
const DAG_7_SEP = [
  { id: 'jb',   lead_name: 'jb aanbied',      lead_email: 'jb@x.nl',  scheduled_at: '2026-09-07T07:30:00Z', status: 'cancelled', annulering_reden: 'geen interesse meer' },
  { id: 'y-oud', lead_name: 'Yasmine Aouada', lead_email: 'y@x.nl',   scheduled_at: '2026-09-07T14:00:00Z', status: 'verplaatst' },
  { id: 'y-nw',  lead_name: 'Yasmine Aouada', lead_email: 'y@x.nl',   scheduled_at: '2026-09-07T14:00:00Z', status: 'scheduled', parent_appointment_id: 'y-oud' },
  { id: 'shu',  lead_name: 'Shudino Andrade', lead_email: 's@x.nl',   scheduled_at: '2026-09-07T17:00:00Z', status: 'scheduled' },
  { id: 'sak',  lead_name: 'Sakvan Mohammed', lead_email: 'sak@x.nl', scheduled_at: '2026-09-07T18:30:00Z', status: 'cancelled' },
  { id: 'san',  lead_name: 'sander De groot', lead_email: 'san@x.nl', scheduled_at: '2026-09-07T18:30:00Z', status: 'scheduled' },
];
// 09:43 UTC, het moment waarop Maxim het rapport opvroeg.
const OM_09_43 = Date.parse('2026-09-07T09:43:00Z');

test('een geannuleerde call krijgt GEEN verwijt over een ontbrekende uitkomst', () => {
  // De call van 07:30 was geannuleerd. Een geannuleerde call hoort geen
  // uitkomst te hebben; hem daarop afrekenen is een verwijt voor iets wat niet
  // had moeten gebeuren.
  const zoomcalls = bouwZoomcalls({ afspraken: DAG_7_SEP, uitkomstKolommen: true, nuMs: OM_09_43 });
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] },
    zoomcalls, archief: [],
  });
  const overJb = aandacht.filter((a) => a.soort === 'geen_uitkomst' && /jb aanbied/.test(a.naam || ''));
  assert.equal(overJb.length, 0, 'een geannuleerde call hoort niet beoordeeld te worden');
});

test('geannuleerd is een eigen staat, geen te_beoordelen', () => {
  assert.equal(callStaat({ scheduled_at: '2026-09-07T07:30:00Z', status: 'cancelled' }, OM_09_43), 'geannuleerd');
});

test('de zoomcall-lijst toont precies één rij per echte call', () => {
  // Zes rijen in de tabel, drie echte calls: Yasmine (de opvolger), Shudino en
  // sander. De twee geannuleerde staan er apart bij, de verplaatste voorganger
  // valt weg ten voordele van zijn opvolger.
  const lijst = bouwZoomcalls({ afspraken: DAG_7_SEP, uitkomstKolommen: true, nuMs: OM_09_43 });
  const echt = lijst.filter((c) => c.staat !== 'geannuleerd' && c.staat !== 'verplaatst');
  assert.equal(echt.length, 3, 'drie echte calls, niet zes');
  assert.deepEqual(echt.map((c) => c.appointment_id).sort(), ['san', 'shu', 'y-nw']);
});

test('de verplaatste voorganger valt weg als zijn opvolger in dezelfde periode valt', () => {
  const lijst = bouwZoomcalls({ afspraken: DAG_7_SEP, uitkomstKolommen: true, nuMs: OM_09_43 });
  assert.equal(lijst.find((c) => c.appointment_id === 'y-oud'), undefined,
    'de voorganger hoort helemaal uit de lijst te verdwijnen, niet alleen uit de bevinding');
  assert.ok(lijst.find((c) => c.appointment_id === 'y-nw'), 'de opvolger blijft staan');
});

test('een verplaatste afspraak zonder opvolger in de periode blijft zichtbaar', () => {
  // Anders verdwijnt een verzette call stil uit het beeld, en dan weet Maxim
  // niet dat er iets verplaatst is.
  const lijst = bouwZoomcalls({
    afspraken: [DAG_7_SEP[1]], uitkomstKolommen: true, nuMs: OM_09_43,
  });
  assert.equal(lijst.length, 1);
  assert.equal(lijst[0].staat, 'verplaatst');
});

test('geannuleerde calls verdwijnen niet, maar staan apart met hun reden', () => {
  const lijst = bouwZoomcalls({ afspraken: DAG_7_SEP, uitkomstKolommen: true, nuMs: OM_09_43 });
  const jb = lijst.find((c) => c.appointment_id === 'jb');
  assert.ok(jb, 'een annulering is informatie voor Maxim en hoort zichtbaar te blijven');
  assert.equal(jb.staat, 'geannuleerd');
  assert.equal(jb.annulering_reden, 'geen interesse meer');
});

test('Yasmine levert nu ook geen dubbele bevinding meer op, want de lijst klopt', () => {
  const zoomcalls = bouwZoomcalls({ afspraken: DAG_7_SEP, uitkomstKolommen: true, nuMs: OM_09_43 });
  assert.equal(groepeerDubbele(zoomcalls).length, 0,
    'na het wegvallen van de voorganger is er geen dubbeling meer om te melden');
});

test('een status die we niet kennen wordt niet beoordeeld, maar ook niet verzwegen', () => {
  // follow_up_appointments.status draagt meer waarden dan de CHECK-constraint
  // noemt: wacht_op_reschedule en verwijderd worden ook geschreven. Een
  // onbekende waarde stilzwijgend beoordelen levert een vals verwijt op; hem
  // stilzwijgend overslaan laat werk verdwijnen. Dus geen van beide.
  const lijst = bouwZoomcalls({
    afspraken: [{ id: 'x', lead_name: 'Onbekend', scheduled_at: '2026-09-07T07:00:00Z', status: 'wacht_op_reschedule' }],
    uitkomstKolommen: true, nuMs: OM_09_43,
  });
  assert.equal(lijst.length, 1);
  assert.equal(lijst[0].staat, 'onbeoordeelbaar');
  assert.equal(lijst[0].status_ruw, 'wacht_op_reschedule');
});

// ═══════════════════════════════════════════════════════════════════════════
// EEN CALL VAN VIER SECONDEN IS GEEN GESPREK
// ═══════════════════════════════════════════════════════════════════════════
// De negen uitgaande calls van 7 september duurden 26, 24, 4, 29, 1, 1, 22, 24
// en 2 seconden. Het rapport meldde 'gesproken: 6'. Drie daarvan duurden 1, 1
// en 2 seconden — dat is opnemen en wegdrukken, of een beltoon. Zo meet het
// rapport iets anders dan het zegt, en wel in Daves voordeel.

const CALLS_7_SEP = [26, 24, 4, 29, 1, 1, 22, 24, 2].map((sec, i) => ({
  taak_id: 't1', soort: 'call', richting: 'uit',
  tijdstip: '2026-09-07T08:0' + (i % 10) + ':00Z',
  duur_sec: sec, resultaat: 'gesproken',
}));

test('de korte calls van 7 september tellen niet als gesprek', () => {
  const v = telVolume(CALLS_7_SEP, new Map());
  assert.equal(v.bel.uit, 9, 'alle negen blijven een poging');
  assert.equal(v.bel.gesproken, 5, '26, 24, 29, 22 en 24 seconden — niet de 4, 1, 1 en 2');
  assert.equal(v.bel.seconden, 133);
});

test('een call korter dan de drempel telt wel als poging', () => {
  // De moeite blijft staan: Dave heeft gebeld. Alleen het gesprek niet.
  const v = telVolume([{ taak_id: 't', soort: 'call', richting: 'uit', tijdstip: '2026-09-07T08:00:00Z', duur_sec: 2, resultaat: 'gesproken' }], new Map());
  assert.equal(v.bel.uit, 1);
  assert.equal(v.bel.gesproken, 0);
  assert.equal(v.bel.te_kort, 1);
});

test('een call zonder duur telt niet als gesprek en niet als te kort', () => {
  // We weten het niet. Dat is een derde geval, geen nul en geen ja.
  const v = telVolume([{ taak_id: 't', soort: 'call', richting: 'uit', tijdstip: '2026-09-07T08:00:00Z', duur_sec: null, resultaat: 'gesproken' }], new Map());
  assert.equal(v.bel.uit, 1);
  assert.equal(v.bel.gesproken, 0);
  assert.equal(v.bel.zonder_duur, 1);
  assert.equal(v.bel.te_kort, 0);
});

test('de gespreksdrempel staat zichtbaar in de drempels, niet verstopt in de code', () => {
  // Een grens die niemand kan zien is een grens waar niemand het over kan
  // hebben. Hij hoort in het antwoord te staan, naast de andere drempels.
  assert.equal(typeof GESPREK_MIN_SEC, 'number');
  assert.ok(GESPREK_MIN_SEC > 0);
  assert.match(BRON, /gesprek_min_sec\s*:\s*GESPREK_MIN_SEC/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE FIX MOET OP HET PAD LIGGEN DAT ECHT GELOPEN WORDT
// ═══════════════════════════════════════════════════════════════════════════
// Dit is nu vier keer misgegaan: een groene test op een pad dat niemand loopt.
// De vorige twee keer riep de test een hulpfunctie rechtstreeks aan; deze keer
// bouwde hij de afspraak-objecten zelf op, met velden die de echte SELECT niet
// ophaalt. bouwZoomcalls kreeg dan undefined en de fix deed niets.
//
// Deze test leest de SELECT uit de bron en controleert dat elk veld dat
// bouwZoomcalls gebruikt er ook in staat.

test('elke kolom die bouwZoomcalls leest, wordt ook echt opgehaald', () => {
  const selects = BRON.match(/\.select\('id, lead_name[^']*'\)/g) || [];
  assert.ok(selects.length >= 2, 'beide afspraken-selects horen te bestaan (met en zonder uitkomst-kolommen)');

  // Wat de bouwer daadwerkelijk van een afspraak-rij leest.
  const nodig = [
    'id', 'lead_name', 'lead_email', 'lead_phone', 'scheduled_at',
    'duration_minutes',        // callStaat: hoelang de call duurt
    'status',                  // callStaat: geannuleerd / verplaatst / onbekend
    'parent_appointment_id',   // de verplaatste voorganger laten wegvallen
    'annulering_reden',        // de annulering tonen zonder oordeel
    'snelle_notitie',
  ];
  for (const s of selects) {
    for (const kolom of nodig) {
      assert.ok(new RegExp('\\b' + kolom + '\\b').test(s),
        `de select mist ${kolom} — dan krijgt bouwZoomcalls undefined en doet de fix niets:\n  ${s}`);
    }
  }
});

test('de uitkomst-kolommen zitten alleen in de eerste select', () => {
  // De tweede is de terugval voor als de migratie nog niet gedraaid is; die
  // mag uitkomst/uitkomst_op juist NIET noemen, anders faalt hij op precies
  // dezelfde ontbrekende kolom.
  const selects = BRON.match(/\.select\('id, lead_name[^']*'\)/g) || [];
  assert.match(selects[0], /uitkomst, uitkomst_op/);
  assert.doesNotMatch(selects[1], /uitkomst/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE EMMERS MOETEN OPTELLEN — PER DEFINITIE, NIET BIJ TOEVAL
// ═══════════════════════════════════════════════════════════════════════════
// Het live endpoint gaf {uit: 9, gesproken: 5, te_kort: 1}: vijf plus één is
// zes, terwijl er negen pogingen waren. Drie calls vielen in geen enkele emmer,
// want te_kort telde alleen mee als de call was opgenomen — en drie stonden op
// 'niet opgenomen'.

import { relevanteAfspraken } from '../api/opvolging-rapport.js';

/** De negen echte calls van 7 september, met hun echte resultaat. */
const NEGEN_CALLS = [
  { duur: 26, res: 'gesproken' },      { duur: 24, res: 'gesproken' },
  { duur: 4,  res: 'gesproken' },      { duur: 29, res: 'gesproken' },
  { duur: 1,  res: 'niet opgenomen' }, { duur: 1,  res: 'niet opgenomen' },
  { duur: 22, res: 'gesproken' },      { duur: 24, res: 'gesproken' },
  { duur: 2,  res: 'niet opgenomen' },
].map((c, i) => ({
  taak_id: 't1', soort: 'call', richting: 'uit',
  tijdstip: '2026-09-07T08:0' + i + ':00Z', duur_sec: c.duur, resultaat: c.res,
}));

test('de vier emmers tellen op tot het aantal pogingen', () => {
  const v = telVolume(NEGEN_CALLS, new Map());
  assert.equal(
    v.bel.gesproken + v.bel.te_kort + v.bel.zonder_duur + v.bel.niet_opgenomen,
    v.bel.uit,
    'elke call hoort in precies één emmer te vallen',
  );
});

test('de echte dag van 7 september valt goed uit elkaar', () => {
  const v = telVolume(NEGEN_CALLS, new Map());
  assert.equal(v.bel.uit, 9);
  assert.equal(v.bel.gesproken, 5, '26, 24, 29, 22 en 24 seconden');
  assert.equal(v.bel.te_kort, 1, 'alleen de call van 4 seconden werd opgenomen');
  assert.equal(v.bel.niet_opgenomen, 3, '1, 1 en 2 seconden — niemand nam op');
  assert.equal(v.bel.zonder_duur, 0);
  assert.equal(v.bel.seconden, 133);
});

test('een niet-opgenomen call heet niet "te kort"', () => {
  // Na de woordenronde: te_kort betekent opgenomen-maar-kort. Een call waar
  // niemand opnam is iets anders en hoort zijn eigen naam te hebben.
  const v = telVolume([{ taak_id: 't', soort: 'call', richting: 'uit',
    tijdstip: '2026-09-07T08:00:00Z', duur_sec: 2, resultaat: 'niet opgenomen' }], new Map());
  assert.equal(v.bel.te_kort, 0);
  assert.equal(v.bel.niet_opgenomen, 1);
});

test('opgenomen zonder bekende duur valt in zonder_duur, niet in te_kort', () => {
  const v = telVolume([{ taak_id: 't', soort: 'call', richting: 'uit',
    tijdstip: '2026-09-07T08:00:00Z', duur_sec: null, resultaat: 'gesproken' }], new Map());
  assert.equal(v.bel.zonder_duur, 1);
  assert.equal(v.bel.te_kort, 0);
  assert.equal(v.bel.gesproken, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// WAT UIT DE ZOOMCALL-SET VOLGT, GEBRUIKT DEZELFDE SET
// ═══════════════════════════════════════════════════════════════════════════

test('geannuleerde en verzette afspraken tellen niet mee voor de vensters', () => {
  // De lijst toonde 5 rijen en de blinde vlek eronder zei 6. Een geannuleerde
  // call heeft geen spraakbericht nodig en kan dus geen venster missen.
  const relevant = relevanteAfspraken(DAG_7_SEP, OM_09_43);
  assert.equal(relevant.length, 3, 'drie echte calls, niet zes rijen');
  assert.deepEqual(relevant.map((a) => a.id).sort(), ['san', 'shu', 'y-nw']);
});

test('de blinde vlek over calls zonder taak telt de gefilterde set', () => {
  const relevant = relevanteAfspraken(DAG_7_SEP, OM_09_43);
  const v = bouwVensters({ afspraken: relevant, taken: [], pogingen: [], dagen: ['2026-09-07'] });
  assert.equal(v.zonder_taak.length, 3, 'niet 6 — de geannuleerde tellen niet mee');
});

test('het endpoint voedt de vensters met relevanteAfspraken, niet met de ruwe lijst', () => {
  // Anders staat er weer een groter getal onder een kortere lijst.
  assert.match(BRON, /const vensterAfspraken = relevanteAfspraken\(afspraken, Date\.now\(\)\)/);
  assert.match(BRON, /bouwVensters\(\{ afspraken: vensterAfspraken/);
  // Op de AANROEP, niet op de definitie: `export function bouwVensters({
  // afspraken, taken, ... })` matcht anders altijd en dan bewaakt dit niets.
  assert.doesNotMatch(BRON, /[^n] bouwVensters\(\{ afspraken, /);
});

// ═══════════════════════════════════════════════════════════════════════════
// A · ONBEKENDE DUUR IS ONBEKEND, GEEN VERWIJT
// ═══════════════════════════════════════════════════════════════════════════
// Alle drie de gearchiveerde taken hebben pogingen, en bij alle drie is
// duur_sec NULL. Er is geen enkel geval van 'gearchiveerd na een korte call';
// er zijn drie gevallen van 'we weten niet hoe lang er gebeld is'.

const DRIE_ZONDER_DUUR = new Map([['t1', [
  { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-20T09:00:00Z', duur_sec: null, resultaat: 'gesproken' },
  { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-21T09:00:00Z', duur_sec: null, resultaat: 'gesproken' },
]]]);

test('een gearchiveerde lead zonder gemeten duur krijgt geen oordeel', () => {
  const [a] = bouwArchief({
    gearchiveerd: [{ id: 't1', naam: 'Onbekend', gearchiveerd_at: '2026-09-07T10:00:00Z' }],
    histPerTaak: DRIE_ZONDER_DUUR,
  });
  assert.equal(a.moeite.staat, 'onbekend');
  assert.equal(a.duur_bekend, false);
  assert.notEqual(a.moeite.staat, 'te_weinig', 'geen verwijt voor iets wat de meting niet weet');
});

test('onbekende duur komt in de blinde vlekken, niet in de bevindingen', () => {
  const archief = bouwArchief({
    gearchiveerd: [{ id: 't1', naam: 'Onbekend', gearchiveerd_at: '2026-09-07T10:00:00Z' }],
    histPerTaak: DRIE_ZONDER_DUUR,
  });
  const aandacht = [];
  vulAandacht({
    aandacht, blindeVlekken: [],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] }, zoomcalls: [], archief,
  });
  assert.equal(aandacht.length, 1);
  assert.equal(aandacht[0].soort, 'blinde_vlek');
  assert.match(aandacht[0].tekst, /geen enkele call de duur vastgelegd/);
  assert.equal(aandacht.filter((x) => x.soort === 'te_weinig_moeite').length, 0);
});

test('mét een gemeten duur valt het oordeel gewoon', () => {
  // Zonder deze test zou 'alles onbekend noemen' er groen doorheen komen.
  const hist = new Map([['t1', [
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-20T09:00:00Z', duur_sec: 30, resultaat: 'gesproken' },
  ]]]);
  const [a] = bouwArchief({
    gearchiveerd: [{ id: 't1', naam: 'Wel gemeten', gearchiveerd_at: '2026-09-07T10:00:00Z' }],
    histPerTaak: hist,
  });
  assert.equal(a.moeite.staat, 'te_weinig');
});

test('een lead zonder enkele call krijgt gewoon het moeite-oordeel', () => {
  // Er ontbreekt dan geen duur; er is niet gebeld. Dat is een verwijt over de
  // moeite, geen blinde vlek over de meting.
  const [a] = bouwArchief({
    gearchiveerd: [{ id: 't1', naam: 'Niets gedaan', gearchiveerd_at: '2026-09-07T10:00:00Z' }],
    histPerTaak: new Map(),
  });
  assert.equal(a.moeite.staat, 'te_weinig');
});

// ═══════════════════════════════════════════════════════════════════════════
// 'DE DAG LOOPT NOG' IS GEEN BEVINDING OVER DAVE
// ═══════════════════════════════════════════════════════════════════════════
// Hij stond twee keer op de pagina: als gele balk bovenaan én als eerste
// bevinding in sectie 1, binnen twee centimeter van elkaar. De tweede leest
// bovendien als een verwijt terwijl het een eigenschap van de periode is.

test('de periode-blinde-vlek staat niet in de aandachtlijst', () => {
  const aandacht = [];
  vulAandacht({
    aandacht,
    blindeVlekken: [
      { sectie: 'periode', wat: 'De dag van vandaag loopt nog.', waarom: 'Stand van dit moment.' },
      { sectie: 'dekking', wat: 'De lijst is niet bewaard.', waarom: 'due wordt overschreven.' },
    ],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] }, zoomcalls: [], archief: [],
  });
  assert.equal(aandacht.length, 1, 'alleen de dekking-vlek hoort hier');
  assert.equal(aandacht[0].sectie, 'dekking');
  assert.doesNotMatch(JSON.stringify(aandacht), /loopt nog/);
});

test('hij blijft wél in blinde_vlekken staan', () => {
  // Het overzicht van wat het rapport niet weet hoort compleet te blijven; het
  // is alleen geen bevinding over een persoon.
  const blindeVlekken = [{ sectie: 'periode', wat: 'De dag van vandaag loopt nog.', waarom: 'x' }];
  vulAandacht({
    aandacht: [], blindeVlekken,
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] }, zoomcalls: [], archief: [],
  });
  assert.equal(blindeVlekken.length, 1, 'vulAandacht hoort de lijst niet te legen');
  assert.equal(blindeVlekken[0].sectie, 'periode');
});

test('andere blinde vlekken komen nog steeds wél in de aandachtlijst', () => {
  // Zonder deze test zou 'alle blinde vlekken overslaan' er groen doorheen
  // komen, en dan leest stilte weer als goedkeuring.
  const aandacht = [];
  vulAandacht({
    aandacht,
    blindeVlekken: [{ sectie: 'volume', wat: 'Van 3 calls is geen duur vastgelegd.', waarom: 'x' }],
    dekking: { behandeld: [], onbehandeld: null },
    vensters: { rijen: [], zonder_taak: [] }, zoomcalls: [], archief: [],
  });
  assert.equal(aandacht.length, 1);
  assert.equal(aandacht[0].soort, 'blinde_vlek');
});
