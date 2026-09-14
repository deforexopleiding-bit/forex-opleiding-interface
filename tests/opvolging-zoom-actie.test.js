// tests/opvolging-zoom-actie.test.js
//
// DE VIER UITGANGEN VAN EEN OPWARMKAART.
//
// De kaart komt uit cron-opvolging-zoom-opwarm en zegt: 'deze zoomcall is
// geboekt, bel om te bevestigen'. Dat gesprek kent vier afloopen. De bestaande
// 'Wat nu?' heeft er geen enkele van — die gaat over een lead die je niet te
// pakken krijgt, niet over een afspraak die al staat.
//
// ── DRIE VALLEN DIE DEZE MODULE AL TWEE KEER HEEFT OPGELEVERD ───────────
// Alle drie zijn STIL: niets gaat stuk, er komt geen melding, en het werkt
// niet. Elk van de drie heeft hieronder een eigen test.
//
//   1. een venster zonder `class="scrim on"` staat er wel maar is onzichtbaar;
//   2. HTML-entities binnen esc() komen als letterlijke tekst op het scherm;
//   3. een guard bovenin modalHtml() slaat de nieuwe takken over en levert een
//      lege string op — geen console-fout, geen venster, geen spoor.
//
// Daarom draait deze test het ECHTE viewbestand en opent de vensters via
// dezelfde handlers die de knoppen aanroepen. Een test die alleen de bronregels
// leest zou deze fouten niet vinden: de code ziet er correct uit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { REDEN } from '../api/_lib/opvolging-zoom-opwarm.js';
import { ACTIES, ARCHIEF } from '../api/opvolging-zoom-actie.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BADGE_HELPER = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');
const ENDPOINT = join(ROOT, 'api/opvolging-zoom-actie.js');
const ANNULEER_CRON = join(ROOT, 'api/cron-opvolging-annuleringen.js');
const INDEX = join(ROOT, 'modules/klanten-v2/index.html');

function laadView() {
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
    Date, Math, Number, String, JSON, Boolean, Array, Object, RegExp, Intl, Set,
  });
  runInContext(readFileSync(BADGE_HELPER, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvModalHaak, 'de view hoort __opvModalHaak te zetten');
  return window;
}

const OPWARM = {
  id: 'tk-op', naam: 'Redouane', telefoon: '+32470111222', reden: REDEN,
  due: '2026-09-15', badge_label: 'Zoomcall vr 25/09 14:00', pogingen: [],
  bron_ref: { appointment_id: 'ap-1', start: '2026-09-25T12:00:00Z', soort: 'zoom_opwarm' },
};

const GEWOON = {
  id: 'tk-gewoon', naam: 'Jan Peeters', reden: 'no_show_call', due: '2026-09-14', pogingen: [],
};

function opstelling(taken = [OPWARM]) {
  const w = laadView();
  w.__opvModalHaak.zetCalls([]);
  w.__opvModalHaak.zetTaken(taken);
  return w;
}

// ═══════════════════════════════════════════════════════════════════════════
// HET KEUZEVENSTER
// ═══════════════════════════════════════════════════════════════════════════

test('een opwarmkaart krijgt zijn eigen vier uitgangen, niet de gewone', () => {
  const w = opstelling();
  w.__opvWatNu('tk-op');
  const h = w.__opvModalHaak.modalHtml();
  assert.notEqual(h, '', 'leeg venster: de tak wordt overgeslagen door een guard erboven');
  assert.match(h, /Wat nu met Redouane/);

  for (const [knop, wat] of [
    ["__opvOpwarmActie('bevestigd')", 'bevestigd'],
    ['__opvOpwarmVerzet()', 'verplaatsen'],
    ["__opvOpwarmActie('annuleren')", 'annuleren'],
    ["__opvOpwarmActie('gesprek_gehad')", 'gesprek gehad'],
  ]) {
    assert.ok(h.includes(knop), wat + ' hoort een knop te hebben');
  }

  // En niet de uitgangen van een gewone kaart: er staat al een afspraak, dus
  // 'opnieuw inplannen' en 'agenda doorgestuurd' slaan hier nergens op.
  assert.ok(!h.includes("__opvActie('agenda_gestuurd')"),
    'de gewone uitgangen horen hier niet te staan');
  assert.ok(!h.includes("__opvActie('inplannen')"));
});

test('een gewone kaart houdt zijn eigen uitgangen — geen regressie', () => {
  const w = opstelling([GEWOON]);
  w.__opvWatNu('tk-gewoon');
  const h = w.__opvModalHaak.modalHtml();
  assert.match(h, /Wat nu met Jan Peeters/);
  assert.ok(h.includes("__opvActie('inplannen')"));
  assert.ok(!h.includes('__opvOpwarmVerzet()'));
});

test('zonder afspraak-id staan verzetten en annuleren uit, met uitleg', () => {
  // Een kaart die niet aan een afspraak hangt kan niets verzetten. Een knop
  // die stil niets doet is erger dan een knop die uitlegt waarom.
  const w = opstelling([{ ...OPWARM, bron_ref: { soort: 'zoom_opwarm' } }]);
  w.__opvWatNu('tk-op');
  const h = w.__opvModalHaak.modalHtml();
  assert.match(h, /hangt niet aan een afspraak/i);
  assert.ok(h.includes("__opvOpwarmActie('bevestigd')"), 'bevestigen kan nog wel');
  assert.ok(!h.includes('__opvOpwarmVerzet()'), 'verzetten hoort uitgeschakeld te zijn');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VERVOLGVENSTERS — en de drie stille vallen
// ═══════════════════════════════════════════════════════════════════════════

test('elke uitgang opent een venster dat ook echt iets zegt', () => {
  const verwacht = {
    bevestigd    : /bevestigt/i,
    gesprek_gehad: /Gesprek gehad met Redouane/,
    annuleren    : /Zoomcall annuleren/,
  };
  for (const [u, re] of Object.entries(verwacht)) {
    const w = opstelling();
    w.__opvWatNu('tk-op');
    w.__opvOpwarmActie(u);
    assert.equal(w.__opvModalHaak.huidigeModal().soort, 'opwarm-actie');
    const h = w.__opvModalHaak.modalHtml();
    assert.notEqual(h, '', u + ' gaf een leeg venster');
    assert.match(h, re);
    assert.ok(h.includes("__opvOpwarmBevestig('" + u + "')"), u + ' mist zijn knop');
  }
});

test('VAL 1 · elk nieuw venster draagt de scrim-klasse waarmee hij zichtbaar is', () => {
  // Zonder `on` houdt de globale .scrim-regel uit het design system opacity op
  // 0 en pointer-events op none. Het venster staat er dan wel, en is
  // onzichtbaar.
  for (const open of [
    (w) => { w.__opvWatNu('tk-op'); },
    (w) => { w.__opvWatNu('tk-op'); w.__opvOpwarmActie('bevestigd'); },
    (w) => { w.__opvWatNu('tk-op'); w.__opvOpwarmActie('gesprek_gehad'); },
    (w) => { w.__opvWatNu('tk-op'); w.__opvOpwarmActie('annuleren'); },
    (w) => { w.__opvWatNu('tk-op'); w.__opvOpwarmVerzet(); },
  ]) {
    const w = opstelling();
    open(w);
    assert.match(w.__opvModalHaak.modalHtml(), /class="scrim on"/);
  }
});

test('VAL 2 · geen HTML-entities binnen esc()', () => {
  // esc() zet & om in &amp;, dus esc('&mdash;') levert letterlijk '&mdash;' op
  // het scherm op. De entities horen buiten de aanhalingstekens van esc.
  const src = readFileSync(VIEW, 'utf8');
  const blok = src.slice(src.indexOf('DE OPWARMKAART: VIER UITGANGEN'),
                         src.indexOf("if (m.soort === 'watnu') {"));
  assert.ok(blok.length > 500, 'het blok is gevonden');
  const fout = [...blok.matchAll(/esc\((?:'|")([^'"]*&[a-z]+;[^'"]*)(?:'|")\)/g)];
  assert.deepEqual(fout.map((m) => m[1]), [], 'entities horen niet binnen esc()');
});

test('VAL 3 · geen enkel nieuw venster geeft een lege string terug', () => {
  // De vorm van de fout die de vier zoomcall-uitkomsten maandenlang stil liet
  // sneuvelen: een guard bovenin modalHtml() die de tak nooit bereikt.
  const soorten = [
    { soort: 'watnu', taakId: 'tk-op' },
    { soort: 'opwarm-verzet', taakId: 'tk-op' },
    { soort: 'opwarm-actie', taakId: 'tk-op', uitkomst: 'bevestigd' },
    { soort: 'opwarm-actie', taakId: 'tk-op', uitkomst: 'gesprek_gehad' },
    { soort: 'opwarm-actie', taakId: 'tk-op', uitkomst: 'annuleren' },
  ];
  for (const m of soorten) {
    const w = opstelling();
    w.__opvLeadHelpers.zetModal(m);
    assert.notEqual(w.__opvModalHaak.modalHtml(), '',
      m.soort + '/' + (m.uitkomst || '-') + ' kwam er leeg uit');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VERPLAATSEN — de agenda, en alleen de agenda
// ═══════════════════════════════════════════════════════════════════════════

test('verplaatsen toont de agenda met weeknavigatie en GEEN datumveld', () => {
  // Een zoomcall heeft een uur nodig. Een kale datum levert een afspraak op
  // waar geen moment bij hoort — dezelfde reden als bij 'liever via zoom'.
  const w = opstelling();
  w.__opvWatNu('tk-op');
  w.__opvOpwarmVerzet();
  assert.equal(w.__opvModalHaak.huidigeModal().soort, 'opwarm-verzet');
  const h = w.__opvModalHaak.modalHtml();
  assert.match(h, /Verplaatsen/);
  assert.ok(h.includes('__opvWeek(-1)') && h.includes('__opvWeek(1)'), 'weeknavigatie hoort erbij');
  assert.ok(!h.includes('type="date"'), 'geen handmatige datumkeuze bij een zoomcall');
  assert.match(h, /niet<\/b> beoordeeld/, 'de oude afspraak wordt niet als no-show geteld');
});

test('het boeken van een slot gaat naar het eigen endpoint, niet naar de agenda-POST', () => {
  // api/opvolging-agenda.js blijft in deze wijziging ongemoeid: daar hoort het
  // sluiten van ONZE kaart niet bij, en dat endpoint mag niet herschreven
  // worden.
  const src = readFileSync(VIEW, 'utf8');
  const boek = src.slice(src.indexOf('window.__opvBoek ='), src.indexOf('window.__opvTerug ='));
  assert.match(boek, /opwarmVerzet\s*\n?\s*\?\s*await post\('\/api\/opvolging-zoom-actie'/);
  assert.match(boek, /actie: 'verplaatsen'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

test('de vier acties en hun archiefredenen liggen vast', () => {
  assert.deepEqual([...ACTIES].sort(),
    ['annuleren', 'bevestigd', 'gesprek_gehad', 'verplaatsen']);
  assert.equal(ARCHIEF.bevestigd, 'bevestigd');
  assert.equal(ARCHIEF.annuleren, 'afspraak geannuleerd na gesprek');
});

test('de view en de server noemen dezelfde reden', () => {
  // Een browser-view kan niet uit api/_lib importeren, dus de sleutel staat op
  // twee plekken. Lopen ze uiteen, dan krijgt de opwarmkaart stil de gewone
  // uitgangen — en die kloppen niet voor een afspraak die al staat.
  const src = readFileSync(VIEW, 'utf8');
  const m = src.match(/const OPWARM_REDEN = '([a-z_]+)'/);
  assert.ok(m, 'OPWARM_REDEN staat in de view');
  assert.equal(m[1], REDEN);
});

test('het endpoint zit achter de drie rechten', () => {
  const src = readFileSync(ENDPOINT, 'utf8');
  assert.match(src, /requirePermission\(req, 'opvolging\.module\.access'\)/);
  assert.match(src, /requirePermission\(req, 'opvolging\.taak\.afronden'\)/);
  // Boeken in de agenda vraagt om dezelfde extra sleutel als de POST op
  // api/opvolging-agenda.js.
  assert.match(src, /verplaatsen' && !\(await requirePermission\(req, 'opvolging\.agenda\.boeken'\)\)/);
});

test('verzetten loopt via de bestaande motor, niet via eigen GHL-code', () => {
  const src = readFileSync(ENDPOINT, 'utf8');
  assert.match(src, /import \{[^}]*verzetAfspraak[^}]*\} from '\.\/_lib\/verzet-afspraak\.js'/s);
  assert.match(src, /verzetBlokkade\(afspraak\)/, 'niet elke status is te verzetten');
  // Geen tweede administratie: geen enkele rechtstreekse call naar de
  // GHL-agenda in dit bestand.
  assert.ok(!/leadconnectorhq/.test(src), 'GHL hoort alleen via de motoren aangeraakt te worden');
});

test('annuleren loopt via follow-up-annuleer, in hetzelfde proces', () => {
  // GHL eerst, dan pas de databank — die volgorde staat compleet in dat
  // bestand, en een tweede kopie hier zou bij elke wijziging aan de GHL-vorm
  // uit elkaar lopen. Geen self-call over HTTP: dat is in deze repo een
  // gedocumenteerd anti-pattern.
  const src = readFileSync(ENDPOINT, 'utf8');
  assert.match(src, /import annuleerHandler from '\.\/follow-up-annuleer\.js'/);
  assert.ok(!/fetch\(\s*(?:basis|`|')?http/.test(src), 'geen HTTP-self-call');
  assert.match(src, /headers: req\.headers/, 'de echte headers, zodat zijn eigen rechtencontrole draait');
});

test('een mislukte annulering laat de kaart staan', () => {
  // De opdracht is dan niet uitgevoerd. Een kaart die toch dichtgaat laat een
  // afspraak achter die nog gewoon in de agenda staat.
  const src = readFileSync(ENDPOINT, 'utf8');
  const blok = src.slice(src.indexOf('async function annuleer('), src.indexOf('async function roepAnnuleerAan('));
  const sluitPos = blok.indexOf('sluitKaart');
  const faalPos = blok.indexOf('return res.status(uit.status');
  assert.ok(faalPos >= 0 && sluitPos > faalPos, 'eerst de faaltak, pas daarna sluiten');
});

// ═══════════════════════════════════════════════════════════════════════════
// HET MERKTEKEN — geen opnieuw-inplannen-kaart na een besproken annulering
// ═══════════════════════════════════════════════════════════════════════════

test('cron-opvolging-annuleringen maakt hier GEEN opnieuw-inplannen-kaart van', () => {
  // Dave heeft deze persoon net aan de lijn gehad. Een kaart 'plan hem opnieuw
  // in' zou hem laten bellen over iets wat hij zojuist zelf besproken heeft —
  // iets heel anders dan iemand die zelf via de link afzegt.
  //
  // Het mechanisme: die cron slaat een afspraak over zodra er een kaart uit
  // die afspraak bestaat, in ELKE status. Onze kaart draagt
  // bron_ref.appointment_id van precies die afspraak en gaat op gearchiveerd.
  const cron = readFileSync(ANNULEER_CRON, 'utf8');
  const lees = cron.slice(cron.indexOf('async function leesKaarten'), cron.indexOf('function kaartOpNummer'));
  assert.ok(!/\.eq\('status'|\.in\('status'|\.neq\('status'/.test(lees),
    'leesKaarten mag geen statusfilter hebben, anders werkt het merkteken niet');
  assert.match(cron, /String\(k\.bron_ref\.appointment_id \|\| ''\) === String\(a\.id\)/);
  assert.match(cron, /summary\.overgeslagen\.kaart_bestaat_al \+= 1;/);

  // En het merkteken zelf staat leesbaar in de data.
  const src = readFileSync(ENDPOINT, 'utf8');
  assert.match(src, /geannuleerd_na_gesprek: true/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BEDRADING
// ═══════════════════════════════════════════════════════════════════════════

test('het viewbestand is met een nieuw ?v=-nummer uitgeleverd', () => {
  // Zonder die bump serveert de browser de oude view uit zijn cache en zijn de
  // nieuwe uitgangen er voor Dave gewoon niet.
  const html = readFileSync(INDEX, 'utf8');
  const m = html.match(/views\/opvolging-v2\.js\?v=(\d+)/);
  assert.ok(m, 'de view wordt met een versienummer geladen');
  assert.ok(Number(m[1]) >= 68, 'het nummer hoort opgehoogd te zijn');
});
