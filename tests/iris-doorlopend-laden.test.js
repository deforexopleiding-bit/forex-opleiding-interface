// tests/iris-doorlopend-laden.test.js
//
// Doorlopend laden, en wat eerst moet staat bovenaan (P-4).
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// De lijst laadde vijftig per keer en bladeren deed je met vorige/volgende.
// Bij 318 items zijn dat zeven keer klikken om te weten of er onderaan nog iets
// ligt -- en niemand doet dat zeven keer.
//
// Maar dat is niet het hele probleem. Doorlopend laden lost het klikken op,
// niet het zoeken. Wat onderaan ligt zou je niet moeten hoeven zoeken: als het
// belangrijk is, hoort het bovenaan. Sorteren op "wat het laatst binnenkwam"
// zet juist het gesprek dat al drie dagen wacht onderaan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ORDENINGEN, MAX_DRINGEND, DRINGEND_BIJ,
  leesOrdening, klokVenster, voegSamen,
} from '../api/_lib/iris/ordening.js';
import { BIJNA_DICHT_MINUTEN, VENSTER_MS } from '../api/_lib/iris/venster.js';

// ── welke ordening ───────────────────────────────────────────────────────────

test('dringend is de standaard waar hij iets toevoegt', () => {
  assert.equal(leesOrdening(undefined, 'wacht_op_ons'), 'dringend');
  assert.equal(leesOrdening('', 'alles'), 'dringend');
});

test('dringend zegt niets bij een filter zonder klok', () => {
  // In "venster bijna dicht" is alles dringend; in "niet gekoppeld" loopt er
  // geen enkele klok. Een groep bovenaan zetten zegt daar niets.
  for (const f of ['venster_bijna_dicht', 'niet_gekoppeld', 'spam', 'wacht_op_klant']) {
    assert.equal(leesOrdening('dringend', f), 'nieuwste', f);
  }
});

test('een onbekende ordening valt terug op wat de lijst altijd deed', () => {
  // Niet op iets onverwachts: een tikfout in een bookmark hoort de volgorde
  // niet stilletjes om te gooien.
  assert.equal(leesOrdening('willekeurig', 'wacht_op_klant'), 'nieuwste');
  assert.ok(ORDENINGEN.includes(leesOrdening('onzin', 'wacht_op_ons')));
});

test('DRINGEND_BIJ en leesOrdening zeggen hetzelfde', () => {
  for (const f of DRINGEND_BIJ) assert.equal(leesOrdening('dringend', f), 'dringend', f);
});

// ── het tijdvenster van de klok-groep ────────────────────────────────────────

test('de klok-groep is precies het laatste stuk van het venster', () => {
  const nu = new Date('2026-09-28T12:00:00.000Z');
  const k = klokVenster(nu, VENSTER_MS, BIJNA_DICHT_MINUTEN);
  // van = 24 uur geleden (het venster gaat dan dicht)
  assert.equal(k.van, '2026-09-27T12:00:00.000Z');
  // tot = twee uur later; daarbinnen staat het nog open maar niet lang meer
  assert.equal(k.tot, '2026-09-27T14:00:00.000Z');
  assert.ok(k.van < k.tot);
});

test('een gesprek van net binnen valt buiten de klok-groep', () => {
  // Wie tien minuten geleden schreef heeft nog 23u50. Die hoort niet bovenaan
  // bij "hier dringt de tijd", anders dringt alles en dringt niets.
  const nu = new Date('2026-09-28T12:00:00.000Z');
  const k = klokVenster(nu);
  const netBinnen = '2026-09-28T11:50:00.000Z';
  assert.ok(netBinnen > k.tot, 'net binnen hoort boven de bovengrens te liggen');
});

// ── samenvoegen ──────────────────────────────────────────────────────────────

const A = { id: 'a' }, B = { id: 'b' }, C = { id: 'c' };

test('de klok-groep staat bovenaan en de rest eronder', () => {
  const r = voegSamen([A, B], [C]);
  assert.deepEqual(r.items.map((x) => x.id), ['a', 'b', 'c']);
  assert.equal(r.dringend_aantal, 2);
});

test('een gesprek staat nooit twee keer in de lijst', () => {
  // Een gesprek uit de klok-groep zit ook gewoon in de hoofdopvraging. Twee
  // keer tonen maakt de telling eronder onwaar.
  const r = voegSamen([A, B], [B, C]);
  assert.deepEqual(r.items.map((x) => x.id), ['a', 'b', 'c']);
});

test('DE KLOK-GROEP KOMT NIET TERUG BIJ HET DOORLADEN', () => {
  // Dit is de val. Hem op elke pagina herhalen zou betekenen dat je bij het
  // doorscrollen dezelfde gesprekken opnieuw ziet -- en dan vertrouw je de
  // lijst niet meer.
  const r = voegSamen([A, B], [C], { eerstePagina: false });
  assert.deepEqual(r.items.map((x) => x.id), ['c']);
  assert.equal(r.dringend_aantal, 0);
});

test('de klok-groep is begrensd', () => {
  const veel = Array.from({ length: 100 }, (_, i) => ({ id: 'x' + i }));
  const r = voegSamen(veel, []);
  assert.equal(r.items.length, MAX_DRINGEND);
  assert.equal(r.dringend_aantal, MAX_DRINGEND);
});

test('rommel loopt er niet doorheen', () => {
  const r = voegSamen(null, [null, { geen: 'id' }, C]);
  assert.deepEqual(r.items.map((x) => x.id), ['c']);
  assert.deepEqual(voegSamen(undefined, undefined).items, []);
});

// ── de bedrading ─────────────────────────────────────────────────────────────

const POST = readFileSync(new URL('../api/iris-post.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');

test('de cursor loopt over de HOOFDopvraging, niet over wat er op het scherm staat', () => {
  // Zou hij over `items` lopen, dan slaat hij bij het doorladen net zoveel
  // gesprekken over als er in de klok-groep stonden -- en die verdwijnen dan
  // stil uit de lijst.
  assert.match(POST, /const hoofdAantal = \(gesprekken \|\| \[\]\)\.length;/);
  assert.match(POST, /volgende_vanaf: vanaf \+ hoofdAantal/);
  assert.match(POST, /meer: \(count \?\? 0\) > vanaf \+ hoofdAantal/);
});

test('de klok-groep wordt alleen op de eerste pagina opgehaald', () => {
  const i = POST.indexOf('let dringendRijen = []');
  const blok = POST.slice(i, i + 1400);
  assert.match(blok, /ordening === 'dringend' && vanaf === 0/);
  assert.match(blok, /\.order\('laatste_inbound', \{ ascending: true \}\)/, 'kortste tijd eerst');
  assert.match(blok, /\.eq\('kanaal', 'whatsapp'\)/);
});

test('een mislukte klok-groep breekt de lijst niet', () => {
  const i = POST.indexOf('let dringendRijen = []');
  const blok = POST.slice(i, i + 1400);
  assert.match(blok, /console\.warn/);
  assert.doesNotMatch(blok, /throw new Error\('klok/);
});

test('zoeken krijgt geen klok-groep', () => {
  // Wie zoekt, wil vinden, niet gesorteerd worden op iets anders.
  assert.match(POST, /const ordening = zoek \? 'nieuwste' : leesOrdening/);
});

test('het scherm plakt eronder in plaats van te vervangen', () => {
  const i = SCHERM.indexOf('async function haalLijst');
  const blok = SCHERM.slice(i, i + 2600);
  assert.match(blok, /if \(meerLaden\)/);
  assert.match(blok, /const gezien = new Set\(st\.items\.map/, 'ontdubbelen bij het aanplakken');
  assert.match(blok, /S\.vanaf = Number\(j\.volgende_vanaf\)/);
});

test('de bladerknoppen zijn weg', () => {
  assert.doesNotMatch(SCHERM, /__irisPagina/);
  assert.match(SCHERM, /window\.__irisMeer = \(\)/);
  assert.match(SCHERM, /window\.__irisLijstScroll = \(bak\)/);
});

test('de knop blijft staan naast het scrollen', () => {
  // Wie met het toetsenbord werkt of een muis zonder wiel heeft, komt anders
  // nooit bij de rest.
  const i = SCHERM.indexOf('const pagina = st.meer');
  const blok = SCHERM.slice(i, i + 900);
  assert.match(blok, /__irisMeer\(\)/);
  assert.match(blok, /Meer laden/);
});

test('scrollen laadt vóór het einde, niet erna', () => {
  const i = SCHERM.indexOf('window.__irisLijstScroll');
  const blok = SCHERM.slice(i, i + 500);
  assert.match(blok, /scrollHeight - bak\.scrollTop - bak\.clientHeight/);
  assert.match(blok, /rest < 240/);
});

test('DE POLL TREKT DE LIJST NIET ONDER JE VANDAAN', () => {
  // Een verversing zet de lijst terug op de eerste vijftig, en wie net tot
  // gesprek 210 gescrold was, staat dan weer bovenaan zonder dat hij iets deed.
  const i = SCHERM.indexOf('function startPoll()');
  const blok = SCHERM.slice(i, SCHERM.indexOf('function stopPoll', i));
  assert.match(blok, /if \(S\.lijst\.items\.length > 50\) return;/);
  // De balk ververst wél: drie head-tellingen kosten niets.
  const aandacht = blok.indexOf('haalAandacht();');
  const stop = blok.indexOf('items.length > 50');
  assert.ok(aandacht > 0 && aandacht < stop, 'de balk hoort vóór de stop te staan');
});

test('de scheiding tussen de twee groepen is zichtbaar', () => {
  // Zonder die regel staan er twee volgordes onder elkaar zonder dat iets zegt
  // waar de ene ophoudt -- en dan lijkt de lijst willekeurig gesorteerd.
  assert.match(SCHERM, /Hier dringt de tijd/);
  assert.match(SCHERM, /De rest, nieuwste eerst/);
  assert.match(SCHERM, /i === st\.dringendAantal/);
});

test('de volgorde-keuze verbergt zich waar hij niets doet', () => {
  const i = SCHERM.indexOf('function ordeningKeuze()');
  const blok = SCHERM.slice(i, i + 900);
  assert.match(blok, /\['wacht_op_ons', 'alles'\]\.includes\(S\.filter\)/);
  assert.match(blok, /if \(S\.zoek\.trim\(\)\) return '';/);
});

test('van volgorde wisselen begint bovenaan', () => {
  // De twee ordeningen zetten dezelfde gesprekken in een andere volgorde;
  // halverwege omschakelen geeft een lijst die noch het een noch het ander is.
  const i = SCHERM.indexOf('window.__irisOrdening');
  const blok = SCHERM.slice(i, i + 400);
  assert.match(blok, /S\.vanaf = 0;/);
  assert.match(blok, /S\.lijst\.opgehaald = false;/);
});
