// tests/opvolging-weekbalk-later.test.js
//
// G1 — de weekbalk afmaken: een zevende tegel 'Later', een getal per dag, en
// een tijdlijn achter een voorbije dag.
//
// DRIE DINGEN DIE HIER STIL FOUT KUNNEN GAAN:
//
//  1. EEN NUL DIE GEEN METING IS.
//     Zolang de balk niets terug heeft staat er een punt, geen nul. Een nul
//     leest als 'gemeten en er is niets', en dat is iets anders dan 'nog niet
//     gevraagd'. Dezelfde regel als bij de vensters en de brug-tellers.
//
//  2. TWEE VERSCHILLENDE GETALLEN MET ÉÉN VORM.
//     Een taak die blijft liggen houdt zijn oude `due`, en de dagweergave van
//     vandaag haalt alles op met due <= vandaag. 'Open op dinsdag' is voor een
//     dinsdag in het verleden dus geen zinnig getal — die taak staat inmiddels
//     onder vandaag. Vandaar: verleden toont wat er gebeurd is, vandaag en
//     later tonen wat er open staat. Het getal op de tegel hoort te kloppen
//     met wat je ziet als je erop klikt.
//
//  3. EEN VENSTER DAT STIL SNEUVELT OP DE TAAK-GUARD.
//     De vier uitkomsten van een zoomcall hebben nooit gewerkt omdat
//     modalHtml() met een taak-guard begon en een call geen taak heeft. Deze
//     twee vensters gaan over een dag en over een verzameling — ook geen taak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const API  = join(ROOT, 'api/opvolging-weekbalk.js');
// Het etiket-helperbestand: opvolging-v2 weigert te starten zonder
// KV_V2.helpers.opvBadgeTekst, net als op de pagina.
const BADGE_HELPER = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');

// Zaterdag 5 september 2026. Dave werkt op zaterdag, dus die dag hoort in de
// balk — zie opvolging-weekbalk.test.js voor die les.
const NU = '2026-09-05';

function laadView(nu = NU) {
  const vast = Date.parse(nu + 'T10:00:00Z');
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
  runInContext(readFileSync(BADGE_HELPER, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvWeekHelpers, 'de view hoort __opvWeekHelpers te zetten');
  return window;
}

const bronView = () => readFileSync(VIEW, 'utf8');
const bronApi  = () => readFileSync(API, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// EEN PUNT IS GEEN NUL
// ═══════════════════════════════════════════════════════════════════════════

test('zonder antwoord staat er een punt op de tegel, geen nul', () => {
  const H = laadView().__opvWeekHelpers;
  for (const d of ['2026-09-01', NU, '2026-09-08']) {
    assert.equal(H.tegelGetal(d, NU).getal, '·', d);
    assert.equal(H.tegelGetal(d, NU).gemeten, false, d);
  }
});

test('een gemeten nul is wél een nul', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetBalk({ data: { dagen: [{ dag: NU, open: 0, acties: 0 }] }, key: 'x' });
  const g = H.tegelGetal(NU, NU);
  assert.equal(g.getal, '0');
  assert.equal(g.gemeten, true);
});

test('een dag die niet in het antwoord zit blijft een punt', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetBalk({ data: { dagen: [{ dag: NU, open: 3, acties: 1 }] } });
  assert.equal(H.tegelGetal('2026-09-08', NU).getal, '·');
});

// ═══════════════════════════════════════════════════════════════════════════
// TWEE GETALLEN, EN ELK OP ZIJN EIGEN DAG
// ═══════════════════════════════════════════════════════════════════════════

test('een voorbije dag toont wat er gedaan is, niet wat er open staat', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetBalk({ data: { dagen: [{ dag: '2026-09-01', open: null, acties: 7 }] } });
  const g = H.tegelGetal('2026-09-01', NU);
  assert.equal(g.getal, '7');
  assert.equal(g.label, ' gedaan');
});

test('vandaag en later tonen wat er open staat', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetBalk({ data: { dagen: [
    { dag: NU, open: 12, acties: 4 },
    { dag: '2026-09-08', open: 2, acties: 0 },
  ] } });
  assert.deepEqual(
    [H.tegelGetal(NU, NU), H.tegelGetal('2026-09-08', NU)].map((g) => g.getal + g.label),
    ['12 open', '2 open']);
});

test('open op een voorbije dag is null en wordt niet als nul getoond', () => {
  // De server stuurt null omdat de vraag voor die dag niet te stellen is. Zou
  // de tegel daar 0 van maken, dan staat er een meting die niet gedaan is.
  const H = laadView().__opvWeekHelpers;
  H.zetBalk({ data: { dagen: [{ dag: '2026-09-01', open: null, acties: 0 }] } });
  assert.equal(H.tegelGetal('2026-09-01', NU).getal, '0', 'acties, en die zijn wél geteld');
  H.zetBalk({ data: { dagen: [{ dag: '2026-09-01', open: null, acties: null }] } });
  assert.equal(H.tegelGetal('2026-09-01', NU).getal, '·', 'geen acties gemeten → punt');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE ZEVENDE TEGEL
// ═══════════════════════════════════════════════════════════════════════════

test('de balk heeft zeven tegels: zes dagen en Later', () => {
  const H = laadView().__opvWeekHelpers;
  const h = H.weekbalk(NU);
  assert.equal((h.match(/class="wkd/g) || []).length, H.WEEKDAG_LABELS.length + 1);
  assert.match(h, /class="wkd later"/);
});

test('de Later-tegel toont het aantal dat wacht, en anders een punt', () => {
  const H = laadView().__opvWeekHelpers;
  assert.match(H.weekbalk(NU), /·<small> wacht<\/small>/);
  H.zetBalk({ data: { dagen: [], later: { aantal: 20, na: '2026-09-05' } } });
  assert.match(H.weekbalk(NU), /20<small> wacht<\/small>/);
});

test('een voorbije dag opent de tijdlijn, vandaag en later de dagweergave', () => {
  const H = laadView().__opvWeekHelpers;
  const h = H.weekbalk(NU);
  assert.match(h, /__opvTijdlijn\('2026-08-31'\)/, 'maandag ligt achter ons');
  assert.match(h, /__opvDag\('2026-09-05'\)/, 'zaterdag is vandaag');
  assert.doesNotMatch(h, /__opvTijdlijn\('2026-09-05'\)/);
});

test('de grens verschuift mee met de week die je bekijkt', () => {
  // Een week vooruit staat er niets meer in het verleden; een week terug staat
  // er niets meer in de toekomst.
  const H = laadView().__opvWeekHelpers;
  H.zetOffset(1);
  assert.doesNotMatch(H.weekbalk(NU), /__opvTijdlijn\(/);
  H.zetOffset(-1);
  const terug = H.weekbalk(NU);
  assert.equal((terug.match(/__opvTijdlijn\(/g) || []).length, H.WEEKDAG_LABELS.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TWEE VENSTERS
// ═══════════════════════════════════════════════════════════════════════════

test('beide vensters staan in MODAL_ZONDER_TAAK', () => {
  // Anders sneuvelen ze stil op de taak-guard, precies zoals de vier
  // call-uitkomsten dat deden.
  const w = laadView();
  const zonder = new Set(Array.from(w.__opvModalHaak.MODAL_ZONDER_TAAK));
  for (const soort of Array.from(w.__opvWeekHelpers.MODAL_BALK)) {
    assert.ok(zonder.has(soort), soort);
  }
});

test('de tijdlijn zegt het eerlijk als er niets geregistreerd is', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetTijdlijn({ loading: false, error: null, key: '2026-09-01', data: { dag: '2026-09-01', items: [] } });
  const h = H.balkModalHtml({ soort: 'tijdlijn', dag: '2026-09-01' });
  assert.match(h, /Op deze dag is niets geregistreerd/);
  assert.match(h, /alleen dat er niets is vastgelegd/,
    'niets vastgelegd is iets anders dan er is niets gebeurd');
});

test('de tijdlijn toont tijd, soort en naam per gebeurtenis', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetTijdlijn({ loading: false, error: null, key: '2026-09-01', data: { dag: '2026-09-01', items: [
    { id: 'p1', soort: 'call', tijdstip: '2026-09-01T09:12:00Z', resultaat: 'niet opgenomen',
      automatisch: false, taak: { id: 't1', naam: 'Jan Peeters', badge_label: 'Masterclass Gent' } },
    { id: 'p2', soort: 'spraakbericht', tijdstip: '2026-09-01T09:20:00Z', resultaat: null,
      automatisch: true, taak: { id: 't1', naam: 'Jan Peeters' } },
  ] } });
  const h = H.balkModalHtml({ soort: 'tijdlijn', dag: '2026-09-01' });
  assert.match(h, /Gebeld/);
  assert.match(h, /Spraakbericht/);
  assert.match(h, /Jan Peeters/);
  assert.match(h, /niet opgenomen/);
  assert.match(h, /automatisch geregistreerd/);
  assert.match(h, /Masterclass Gent/);
});

test('de takenlijst van die dag blijft bereikbaar vanuit de tijdlijn', () => {
  // Zonder die knop zou de dagweergave van een voorbije dag verdwenen zijn, en
  // dat zou iets weghalen dat er al was.
  const H = laadView().__opvWeekHelpers;
  H.zetTijdlijn({ loading: false, error: null, key: '2026-09-01', data: { items: [] } });
  assert.match(H.balkModalHtml({ soort: 'tijdlijn', dag: '2026-09-01' }),
    /__opvDagVanuitTijdlijn\('2026-09-01'\)/);
});

test('een taak die er niet meer is wordt benoemd, niet leeggelaten', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetTijdlijn({ loading: false, error: null, key: '2026-09-01', data: { items: [
    { id: 'p1', soort: 'call', tijdstip: '2026-09-01T09:12:00Z', taak: null },
  ] } });
  assert.match(H.balkModalHtml({ soort: 'tijdlijn', dag: '2026-09-01' }), /taak niet meer gevonden/);
});

test('het Later-venster groepeert per dag en telt per groep', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetLater({ loading: false, error: null, key: '2026-09-05', data: { aantal: 3, afgekapt: false, dagen: [
    { dag: '2026-09-14', taken: [
      { id: 'a', naam: 'Ann', reden: 'wil_nog_beslissen', badge_label: 'Masterclass Gent' },
      { id: 'b', naam: 'Bob', reden: 'no_show_event' }] },
    { dag: '2026-09-21', taken: [{ id: 'c', naam: 'Cis', reden: 'afgemeld' }] },
  ] } });
  const h = H.balkModalHtml({ soort: 'later', na: '2026-09-05' });
  assert.match(h, /Ann/); assert.match(h, /Bob/); assert.match(h, /Cis/);
  assert.match(h, /Wil nog beslissen/);
  assert.equal((h.match(/class="ltgroep"/g) || []).length, 2);
  assert.match(h, /3 taken met een datum na 05\/09/);
});

test('een afgekapte lijst zegt dat hij afgekapt is', () => {
  // Anders is 'dit is alles' een bewering die we niet kunnen doen — en dit
  // venster bestaat juist omdat er meer stond dan er te zien was.
  const H = laadView().__opvWeekHelpers;
  H.zetLater({ loading: false, error: null, key: '2026-09-05',
    data: { aantal: 500, afgekapt: true, dagen: [{ dag: '2026-09-14', taken: [{ id: 'a', naam: 'Ann', reden: 'afgemeld' }] }] } });
  assert.match(H.balkModalHtml({ soort: 'later', na: '2026-09-05' }), /meer dan hier passen/);
});

test('een leeg Later-venster is geen fout', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetLater({ loading: false, error: null, key: '2026-09-05', data: { aantal: 0, dagen: [] } });
  assert.match(H.balkModalHtml({ soort: 'later', na: '2026-09-05' }), /Er staat niets ingepland na 05\/09/);
});

test('een naam met opmaak erin wordt ontsnapt', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetLater({ loading: false, error: null, key: '2026-09-05', data: { aantal: 1, dagen: [
    { dag: '2026-09-14', taken: [{ id: 'a', naam: '<img src=x onerror=alert(1)>', reden: 'afgemeld' }] }] } });
  const h = H.balkModalHtml({ soort: 'later', na: '2026-09-05' });
  assert.doesNotMatch(h, /<img src=x/);
  assert.match(h, /&lt;img src=x/);
});

test('een fout in een venster geeft uitleg en een knop, geen leeg scherm', () => {
  const H = laadView().__opvWeekHelpers;
  H.zetTijdlijn({ loading: false, error: 'Netwerkfout', key: '2026-09-01', data: null });
  const h = H.balkModalHtml({ soort: 'tijdlijn', dag: '2026-09-01' });
  assert.match(h, /Netwerkfout/);
  assert.match(h, /Opnieuw proberen/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE SERVERKANT
// ═══════════════════════════════════════════════════════════════════════════

test('het endpoint is read-only en zit achter dezelfde rechten', () => {
  const b = bronApi();
  assert.match(b, /req\.method !== 'GET'/);
  assert.match(b, /requirePermission\(req, 'opvolging\.module\.access'\)/);
  for (const schrijf of ['.insert(', '.update(', '.delete(', '.upsert(']) {
    assert.ok(!b.includes(schrijf), 'dit endpoint hoort niets te schrijven: ' + schrijf);
  }
});

test('vandaag telt met due <= vandaag, precies zoals de lijst eronder', () => {
  // De takenlijst van vandaag haalt alles op met due <= vandaag. Zou de tegel
  // alleen due = vandaag tellen, dan staat er een ander getal op de tegel dan
  // in de lijst waar hij naartoe wijst.
  const b = bronApi();
  assert.match(b, /t\.due <= vandaag/);
  const taken = readFileSync(join(ROOT, 'api/opvolging-taken.js'), 'utf8');
  assert.match(taken, /lte\('due', vandaag\)/, 'de lijst doet hetzelfde — dat is de reden');
});

test('een voorbije dag krijgt open: null, niet nul', () => {
  const b = bronApi();
  assert.match(b, /dag: d, open: null, acties:/);
});

test('de dag wordt in Amsterdamse tijd bepaald, niet in UTC', () => {
  // toISOString().slice(0,10) zit er een dag naast rond middernacht, en dat is
  // precies het uur waarop een poging van gisteren op vandaag zou landen.
  //
  // dagPlus() mag toISOString wél gebruiken: dat is rekenen op een anker van
  // 12:00 UTC, geen omzetting van een moment naar een dag. De twee functies die
  // dát doen zijn vandaagNL() en dagVan(), en die moeten door Intl.
  const b = bronApi();
  for (const fn of ['function vandaagNL', 'function dagVan']) {
    const i = b.indexOf(fn);
    assert.ok(i > 0, fn + ' hoort te bestaan');
    // Tot de sluitende accolade in kolom 0, niet een venster op gevoel: een te
    // ruim venster leest de volgende functie mee en meet dan iets anders.
    const eind = b.indexOf('\n}', i);
    const blok = b.slice(i, eind);
    assert.match(blok, /timeZone: 'Europe\/Amsterdam'/, fn);
    assert.doesNotMatch(blok, /toISOString/, fn + ': geen UTC-string voor een kalenderdag');
  }
});

test('de tijdlijn haalt ruim op en filtert daarna op de Amsterdamse dag', () => {
  // Het venster in de query is een grens voor wát we ophalen; de dag zelf komt
  // uit dagVan(). Zou de query de grens zijn, dan valt het eerste of laatste
  // uur van de dag eraf, afhankelijk van de zomertijd.
  const b = bronApi();
  const i = b.indexOf("if (view === 'tijdlijn')");
  const blok = b.slice(i, i + 1600);
  assert.match(blok, /dagPlus\(dag, -1\)/);
  assert.match(blok, /dagPlus\(dag, 2\)/);
  assert.match(blok, /filter\(\(p\) => dagVan\(p\.tijdstip\) === dag\)/);
});

test('er gaat geen select(*) naar de client', () => {
  // De taken dragen ook notities en interne velden; naar buiten gaat alleen wat
  // het scherm nodig heeft.
  // Alleen de code; het commentaar legt juist uit waarom select('*') hier niet
  // hoort, en die zin mag de test niet omvergooien.
  const code = bronApi().split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.ok(!code.includes("select('*')"));
  assert.match(code, /const kaal = \(t\) =>/);
  // En geen enkele select haalt meer op dan hij noemt.
  for (const sel of (code.match(/\.select\('[^']*'/g) || [])) {
    assert.doesNotMatch(sel, /\*/, sel);
  }
});

test('een afgekapte later-lijst wordt als zodanig gemeld', () => {
  const b = bronApi();
  assert.match(b, /afgekapt: taken\.length >= 500/);
});

test('het endpoint logt zijn eigen fouten', () => {
  // Een 500 zonder regel in de logs is niet te onderzoeken.
  assert.match(bronApi(), /console\.error\('\[opvolging-weekbalk\]'/);
});

test('het endpoint raakt geen bestaande route aan', () => {
  // Puur additief: de takenlijst blijft precies zoals hij was.
  const taken = readFileSync(join(ROOT, 'api/opvolging-taken.js'), 'utf8');
  assert.doesNotMatch(taken, /opvolging-weekbalk/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BALK BLIJFT KLOPPEN NA EEN ACTIE
// ═══════════════════════════════════════════════════════════════════════════

test('een actie leegt ook de balk-cache', () => {
  // Blijft die staan, dan toont een tegel het getal van vóór de actie — en dat
  // ziet eruit alsof het klopt.
  const b = bronView();
  const i = b.indexOf('const leegTakenCache =');
  const blok = b.slice(i, i + 700);
  for (const veld of ['_live.balk.data = null', '_live.later.data = null', '_live.tijdlijn.data = null']) {
    assert.ok(blok.includes(veld), veld);
  }
});

test('de balk vraagt de week op die hij tekent', () => {
  const b = bronView();
  const i = b.indexOf('function weekbalk(');
  const blok = b.slice(i, i + 900);
  assert.match(blok, /fetchBalk\(wk\.dagen\[0\], laatste\)/);
});

test('Later kijkt voorbij de laatste dag van de getoonde week', () => {
  const b = bronView();
  const i = b.indexOf('window.__opvLater =');
  const blok = b.slice(i, i + 500);
  assert.match(blok, /wk\.dagen\[wk\.dagen\.length - 1\]/);
});
