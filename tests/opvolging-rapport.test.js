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
  assert.equal(v.bel.zonder_duur, 2);
  assert.equal(v.bel.gesproken, 1);
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
  const hist = new Map([['t1', [
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-20T09:00:00Z' },
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-21T09:00:00Z' },
    { taak_id: 't1', soort: 'call', richting: 'uit', tijdstip: '2026-08-22T09:00:00Z' },
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
  assert.match(BRON, /bouwVensters\(\{ afspraken, taken: alleTaken, pogingen, dagen \}\)/);
});

test('een afgekapte takenlijst wordt gemeld en niet stil geslikt', () => {
  const i = BRON.indexOf('telefoonAfgekapt = ');
  assert.ok(i > 0);
  const blok = BRON.slice(i, i + 700);
  assert.match(blok, /blindeVlekken\.push/);
});
