// tests/opvolging-verzet-zelfde-dag.test.js
//
// VERZETTEN BINNEN ÉÉN DAG VIEL TUSSEN DE MAZEN.
//
// ── GEMETEN OP PRODUCTIE, 11 SEPTEMBER ±13:50 ───────────────────────────
// /api/opvolging-agenda?van=2026-09-11&tot=2026-09-11&achterstand=1
//
// Redouane Jerroudi, appointment ac93ae66-3b05-49ca-9883-c2e33f6f441d, in
// DEZELFDE rij verzet van 15:00 naar 19:00:
//
//   dagen[0].bezet    tijd '19:00', start …T17:00:00+00:00  → klopt
//   dagen[0].gepland  tijd '15:00', start …T17:00:00+00:00,
//                     label null, verzet_naar null, alle knoppen aan
//
// De weekagenda toonde dus 19:00 en 'Calls van vandaag' 15:00 — vier uur
// verschil, zonder één woord op het scherm dat er iets verschoven was. En
// omdat de lijst op `tijd` sorteert stond hij ook nog op de verkeerde plek.
//
// Corne Heeren (zelfde rij, naar een ANDERE dag) werkte wél: 'verzet naar
// 17 september om 17:55'. Precies daarom bleef dit zo lang onzichtbaar.
//
// ── DE OORZAAK ──────────────────────────────────────────────────────────
// verzetNaar() vergeleek alleen de DAG:
//
//     if (!eerst || !nu || eerst.dag === nu.dag) return null;
//
// Bleef de dag gelijk, dan was het antwoord 'niet verzet'. En
// dagenVoorAfspraak() zette op die ene regel `oorspronkelijkeTijd(a)` — het uur
// uit eerst_gepland_op, dus 15:00.
//
// ── WAAROM DIT GEEN DOORHALING MAG WORDEN ───────────────────────────────
// De verleiding is om dit als 'verzet' te behandelen zoals de andere dag. Dat
// zou erger zijn dan de bug: agendaFeit().verzet haalt de regel door én neemt
// via knoppenVoor() de knoppen weg. Dave kan die call dan niet meer bellen of
// afronden — terwijl de call gewoon vanavond om 19:00 plaatsvindt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  verzetMoment, verzetNaar, binnenDagVerzet, agendaFeit,
  dagenVoorAfspraak, knoppenVoor, dagEnTijd,
} from '../api/_lib/opvolging-dagbeeld.js';
import { voegAgendaSamen } from '../api/_lib/opvolging-agenda-merge.js';
import { ACHTERSTAND_STATUS, achterstandVenster } from '../api/opvolging-agenda.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');

/** Redouane: 15:00 → 19:00 op 11 september (zomertijd, dus UTC+2). */
const REDOUANE = {
  id: 'ac93ae66-3b05-49ca-9883-c2e33f6f441d',
  lead_name: 'Redouane Jerroudi', lead_phone: '+31612345678',
  eerst_gepland_op: '2026-09-11T13:00:00.000Z',   // 15:00
  scheduled_at    : '2026-09-11T17:00:00.000Z',   // 19:00
  status: 'scheduled', uitkomst: null, zoom_join_url: 'https://zoom/x',
};

/** Corne: zelfde rij, naar een ANDERE dag. Moet blijven werken. */
const CORNE = {
  id: 'ap-corne', lead_name: 'Corne Heeren', lead_phone: '+31699998888',
  eerst_gepland_op: '2026-09-11T13:00:00.000Z',   // 11 sep 15:00
  scheduled_at    : '2026-09-17T15:55:00.000Z',   // 17 sep 17:55
  status: 'scheduled', uitkomst: null,
};

/** Naar een EERDER uur op dezelfde dag — de andere kant op. */
const VROEGER = {
  ...REDOUANE, id: 'ap-vroeger',
  eerst_gepland_op: '2026-09-11T17:00:00.000Z',   // 19:00
  scheduled_at    : '2026-09-11T13:00:00.000Z',   // 15:00
};

const DAG = '2026-09-11';

// ═══════════════════════════════════════════════════════════════════════════
// 1 · HET GEMETEN GEVAL
// ═══════════════════════════════════════════════════════════════════════════

test('een verzetting binnen één dag wordt herkend', () => {
  const m = verzetMoment(REDOUANE);
  assert.ok(m, 'dit gaf null, en daar begon alles mee');
  assert.equal(m.zelfdeDag, true);
  assert.equal(m.van.tijd, '15:00');
  assert.equal(m.tijd, '19:00');

  const b = binnenDagVerzet(REDOUANE);
  assert.deepEqual(b, { van: '15:00', naar: '19:00' });
});

test('de kaart toont het ECHTE uur en zegt waar hij vandaan komt', () => {
  const plekken = dagenVoorAfspraak(REDOUANE);
  assert.equal(plekken.length, 1, 'één dag, één regel');
  assert.equal(plekken[0].dag, DAG);
  assert.equal(plekken[0].tijd, '19:00', 'dit stond op 15:00');
  assert.equal(plekken[0].feit.label, 'verzet van 15:00');
});

test('en hij blijft gewoon te bellen en af te ronden', () => {
  // Dit is de val. Zou dit als 'verzet' tellen zoals bij een andere dag, dan
  // haalt knoppenVoor() alles weg en kan Dave een call die vanavond gewoon
  // plaatsvindt niet meer aanraken. Erger dan de bug zelf.
  const f = agendaFeit(REDOUANE);
  assert.equal(f.verzet, false, 'binnen één dag is geen doorhaling');
  assert.equal(f.doorgehaald, false);
  assert.equal(f.naar, null, 'er is geen andere dag om naartoe te wijzen');
  assert.deepEqual(f.binnen_dag, { van: '15:00', naar: '19:00' });

  const k = knoppenVoor(REDOUANE, Date.parse('2026-09-11T10:00:00.000Z'));
  assert.equal(k.afronden, true);
  assert.equal(k.bellen, true);
  assert.equal(k.whatsapp, true);
  assert.equal(k.zoom, true, 'de call komt nog, dus de Zoom-link hoort te werken');
});

test('naar een EERDER uur werkt net zo goed', () => {
  const b = binnenDagVerzet(VROEGER);
  assert.deepEqual(b, { van: '19:00', naar: '15:00' });
  const plekken = dagenVoorAfspraak(VROEGER);
  assert.equal(plekken[0].tijd, '15:00');
  assert.equal(plekken[0].feit.label, 'verzet van 19:00');
  assert.equal(plekken[0].feit.doorgehaald, false);
});

test('zonder verzetting verandert er niets', () => {
  const gewoon = { ...REDOUANE, eerst_gepland_op: REDOUANE.scheduled_at };
  assert.equal(verzetMoment(gewoon), null);
  assert.equal(binnenDagVerzet(gewoon), null);
  assert.equal(agendaFeit(gewoon).label, null);
  assert.equal(dagenVoorAfspraak(gewoon)[0].tijd, '19:00');

  // En een rij zonder de kolom (migratie niet gedraaid, of een oude rij).
  const zonder = { ...REDOUANE, eerst_gepland_op: null };
  assert.equal(verzetMoment(zonder), null);
  assert.equal(dagenVoorAfspraak(zonder)[0].tijd, '19:00');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · HET CORNE-GEVAL MAG NIET STUKGAAN
// ═══════════════════════════════════════════════════════════════════════════

test('verzet naar een andere dag blijft precies zoals het was', () => {
  const naar = verzetNaar(CORNE);
  assert.deepEqual(naar, { dag: '2026-09-17', tijd: '17:55' });

  const f = agendaFeit(CORNE);
  assert.equal(f.verzet, true, 'dit IS een doorhaling');
  assert.equal(f.doorgehaald, true);
  assert.match(f.label, /^verzet naar 17 september om 17:55$/);

  // Twee plekken: de oude dag met het OUDE uur, de nieuwe dag met het nieuwe.
  const plekken = dagenVoorAfspraak(CORNE);
  assert.equal(plekken.length, 2);
  assert.equal(plekken[0].dag, DAG);
  assert.equal(plekken[0].tijd, '15:00', 'op de oude dag stond hij om 15:00');
  assert.equal(plekken[1].dag, '2026-09-17');
  assert.equal(plekken[1].tijd, '17:55');
  assert.equal(plekken[1].verzet_van, DAG);

  // En op de oude dag vervallen de knoppen — de uitkomst hoort bij de nieuwe
  // datum.
  const k = knoppenVoor(CORNE, Date.parse('2026-09-11T10:00:00.000Z'));
  assert.equal(k.afronden, false);
  assert.equal(k.bellen, false);
});

test('verzetNaar spreekt alleen over een ANDERE dag', () => {
  // Daar hangt meer aan dan een label: doorhaling en het wegnemen van knoppen.
  assert.equal(verzetNaar(REDOUANE), null);
  assert.equal(verzetNaar(VROEGER), null);
  assert.ok(verzetNaar(CORNE));
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · HET DAGBEELD ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('het dagbeeld zet hem op 19:00, met label, op de juiste plek', () => {
  // Precies de vorm die de API teruggaf, nu met de reparatie erin.
  const eerder = {
    id: 'ap-eerder', lead_name: 'Iemand anders', lead_phone: '+31611112222',
    scheduled_at: '2026-09-11T15:00:00.000Z',   // 17:00
    eerst_gepland_op: '2026-09-11T15:00:00.000Z', status: 'scheduled',
  };
  const dagen = voegAgendaSamen({
    slots: [], afspraken: [REDOUANE, eerder], van: DAG, tot: DAG, timeZone: 'Europe/Amsterdam',
  });
  const gepland = dagen[0].gepland;
  assert.equal(gepland.length, 2);

  // De volgorde volgt het ECHTE uur: 17:00 vóór 19:00. Met het oude uur (15:00)
  // stond Redouane bovenaan.
  assert.deepEqual(gepland.map((c) => c.tijd), ['17:00', '19:00']);

  const r = gepland.find((c) => c.appointment_id === REDOUANE.id);
  assert.equal(r.tijd, '19:00');
  assert.equal(r.label, 'verzet van 15:00');
  assert.equal(r.doorgehaald, false);
  assert.deepEqual(r.verzet_binnen_dag, { van: '15:00', naar: '19:00' });
  assert.equal(r.knoppen.afronden, true, 'gewoon af te ronden');
  assert.equal(r.start, REDOUANE.scheduled_at, 'start bleef altijd al kloppen');
});

test('bezet en gepland zeggen nu hetzelfde uur', () => {
  // Dat ze uit elkaar liepen was het zichtbare symptoom: 19:00 in de
  // weekagenda, 15:00 in de daglijst.
  const dagen = voegAgendaSamen({
    slots: [], afspraken: [REDOUANE], van: DAG, tot: DAG, timeZone: 'Europe/Amsterdam',
  });
  assert.equal(dagen[0].bezet[0].tijd, '19:00');
  assert.equal(dagen[0].gepland[0].tijd, '19:00');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · ALLE PLEKKEN DIE HET UUR GEBRUIKEN
// ═══════════════════════════════════════════════════════════════════════════

test('de Nu-doen-balk rekende altijd al met het echte moment', () => {
  // bepaalNuDoen leest `c.start` (de ISO), niet `c.tijd`. Die stond dus al goed
  // — gemeten, niet aangenomen, want een 'fix' op een werkend stuk is ook een
  // regressie.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function bepaalNuDoen(');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1800);
  assert.match(blok, /inZone\(c && c\.start\)/);
  assert.doesNotMatch(blok, /inZone\(c && c\.tijd\)/);
});

test('Nog af te ronden gaat over eerdere dagen, dus nooit over deze call', () => {
  // Het venster loopt tot het BEGIN van vandaag. Een call van vanavond kan daar
  // per definitie niet in staan — ook niet vóór 19:00.
  const v = achterstandVenster(DAG);
  assert.ok(Date.parse(v.totIso) <= Date.parse('2026-09-10T22:00:00.000Z'),
    'het venster stopt bij middernacht Amsterdamse tijd');
  assert.ok(!ACHTERSTAND_STATUS.includes('verplaatst'));

  // En de achterstandsrij leest het echte uur uit scheduled_at.
  const agenda = readFileSync(join(ROOT, 'api/opvolging-agenda.js'), 'utf8');
  const i = agenda.indexOf('export function achterstandRij');
  assert.match(agenda.slice(i, i + 300), /dagEnTijd\(a && a\.scheduled_at\)/);
});

test('de 12u-instroom en het rapport lezen scheduled_at, niet eerst_gepland_op', () => {
  // Allebei rekenen met het moment waarop de call NU staat. Dat was al goed en
  // moet zo blijven: eerst_gepland_op is geschiedenis, geen agenda.
  const nabel = readFileSync(join(ROOT, 'api/cron-opvolging-zoom-nabel.js'), 'utf8');
  assert.doesNotMatch(nabel, /eerst_gepland_op/);
  assert.match(nabel, /\.eq\('status', 'scheduled'\)/);

  const rapport = readFileSync(join(ROOT, 'api/opvolging-rapport.js'), 'utf8');
  assert.doesNotMatch(rapport, /eerst_gepland_op/);
});

test('de gezondheidscontrole telt dubbels op het echte uur', () => {
  // controleerDubbels sleutelt op persoon|dag|tijd uit rapport.zoomcalls, en
  // die lijst komt uit scheduled_at. Twee rijen voor dezelfde persoon op
  // hetzelfde moment blijven dus vindbaar.
  const g = readFileSync(join(ROOT, 'api/_lib/opvolging-gezondheid.js'), 'utf8');
  const i = g.indexOf('export function controleerDubbels');
  assert.ok(i > 0);
  assert.match(g.slice(i, i + 1200), /String\(c\.dag \|\| ''\) \+ '\|' \+ String\(c\.tijd \|\| ''\)/);
});

test('een kaart die het oude uur draagt krijgt een correctie', () => {
  // De nabelkaart wordt om 12:00 gemaakt en bevriest het uur in zijn etiket en
  // notitie. Wordt de call daarna verzet, dan klopt die tekst niet meer — en
  // dat is precies het uur waar Dave naar kijkt.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function verzetChip(');
  assert.ok(i > 0, 'de correctie hoort te bestaan');
  const blok = bron.slice(i, i + 1200);
  assert.match(blok, /t\.bron_ref && t\.bron_ref\.start/);
  assert.match(blok, /callVoorTaak\(t, _calls\.data\)/, 'vergelijken met de LIVE call');
  assert.match(blok, /oudZ\.dag !== nuZ\.dag \|\| oudZ\.tijd === nuZ\.tijd/,
    'alleen binnen dezelfde dag, en alleen als het uur echt verschilt');
  assert.match(blok, /call staat nu om/);
  // Zonder dagbeeld voor deze dag: zwijgen. Een correctie die we niet kunnen
  // meten is geen correctie.
  assert.match(blok, /if \(_calls\.key !== dag \|\| !_calls\.data\) return '';/);
  assert.match(bron, /verzetChip\(t, dag\) \+/, 'en hij staat ook echt op de kaart');
});

test('de view is opgehoogd', () => {
  const html = readFileSync(join(ROOT, 'modules/klanten-v2/index.html'), 'utf8');
  const m = html.match(/views\/opvolging-v2\.js\?v=(\d+)/);
  assert.ok(m);
  assert.ok(Number(m[1]) >= 66, 'PR 13 hoort hem op minstens 66 te zetten');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · WAAR DE SANDER-VORM VANDAAN KOMT
// ═══════════════════════════════════════════════════════════════════════════

test('de GHL-poll overschrijft scheduled_at op de bestaande rij', () => {
  // Dit is de bron van de sander-vorm, en de reden dat deze bug bestaat: wordt
  // een call in de GHL-agenda zelf verplaatst, dan matcht de poll op
  // ghl_appointment_id en werkt hij dezelfde rij bij. eerst_gepland_op staat
  // NIET in die write, dus die blijft het oorspronkelijke moment dragen — wat
  // de verzetting meteen ook herkenbaar maakt.
  const poll = readFileSync(join(ROOT, 'api/follow-up-ghl-appointment-poll.js'), 'utf8');
  assert.match(poll, /scheduled_at:\s*event\.startTime/);
  assert.doesNotMatch(poll, /eerst_gepland_op/,
    'de poll raakt eerst_gepland_op niet aan — anders was de verzetting onzichtbaar');

  // Onze eigen weg maakt de andere vorm: een nieuwe rij met een parent.
  const motor = readFileSync(join(ROOT, 'api/_lib/verzet-afspraak.js'), 'utf8');
  assert.match(motor, /parent_appointment_id: afspraak\.id/);
});
