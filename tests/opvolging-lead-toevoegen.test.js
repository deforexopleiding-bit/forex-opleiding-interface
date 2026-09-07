// tests/opvolging-lead-toevoegen.test.js
//
// G2 — '+ Lead toevoegen'. Iemand die Dave buiten de trechter om tegenkomt had
// geen weg naar binnen: kaarten kwamen alleen uit een event of uit het afronden
// van een call.
//
// WAT HIER STIL FOUT KAN GAAN:
//
//  1. EEN REDEN DIE DE DATABASE WEIGERT.
//     opvolging_taken.reden staat onder een CHECK-constraint. Een keuze in het
//     scherm die daar niet in staat levert een insert-fout op het moment van
//     opslaan — dus pas als iemand het formulier al heeft ingevuld. De lijst in
//     het scherm wordt daarom naast de migratie gelegd.
//
//  2. EEN BESTAANDE AANROEPER DIE MEEVERANDERT.
//     Het endpoint bestond al en wordt gebruikt door het afronden van een call.
//     'bron' is optioneel met 'call' als standaard; wie hem niet meestuurt
//     hoort exact hetzelfde gedrag te houden.
//
//  3. EEN VENSTER DAT SNEUVELT OP DE TAAK-GUARD.
//     Dit venster máákt de taak en heeft er dus nog geen — dezelfde vorm als de
//     vier call-uitkomsten die daardoor nooit gewerkt hebben.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const API  = join(ROOT, 'api/opvolging-taak-create.js');
const MIGRATIE = join(ROOT, 'docs/sql-migrations/2026-09-05-opvolging-aanmelding-en-wacht-verplaatsing.sql');
// Het etiket-helperbestand: opvolging-v2 weigert te starten zonder
// KV_V2.helpers.opvBadgeTekst, net als op de pagina.
const BADGE_HELPER = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');

const NU = '2026-09-06';

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
  assert.ok(window.__opvLeadHelpers, 'de view hoort __opvLeadHelpers te zetten');
  return window;
}

const bronView = () => readFileSync(VIEW, 'utf8');
const bronApi  = () => readFileSync(API, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// DE REDENEN KOMEN UIT DE CHECK-CONSTRAINT
// ═══════════════════════════════════════════════════════════════════════════

/** De waarden die de database daadwerkelijk toestaat, uit de laatste migratie. */
function redenenUitMigratie() {
  const sql = readFileSync(MIGRATIE, 'utf8');
  const i = sql.indexOf('ADD CONSTRAINT opvolging_taken_reden_chk');
  assert.ok(i > 0, 'de reden-constraint hoort in deze migratie te staan');
  const blok = sql.slice(i, sql.indexOf('));', i));
  return (blok.match(/'([a-z_]+)'/g) || []).map((x) => x.replace(/'/g, ''));
}

test('elke reden in het scherm staat in de CHECK-constraint', () => {
  // Anders faalt de insert pas op het moment van opslaan, als het formulier al
  // ingevuld is.
  const toegestaan = new Set(redenenUitMigratie());
  const H = laadView().__opvLeadHelpers;
  assert.ok(H.LEAD_REDEN_KEYS.length >= 4, 'er horen redenen te zijn');
  for (const k of H.LEAD_REDEN_KEYS) assert.ok(toegestaan.has(k), 'niet toegestaan door de DB: ' + k);
});

test("'aanmelding' staat er bewust niet bij", () => {
  // Die reden is instroom uit de eventmodule. Met de hand gezet belandt de
  // kaart in het aanmeldblok zonder event erachter, en klopt de groepskop niet.
  assert.ok(redenenUitMigratie().includes('aanmelding'), 'de DB staat hem wél toe');
  const H = laadView().__opvLeadHelpers;
  assert.ok(!H.LEAD_REDEN_KEYS.includes('aanmelding'), 'het scherm hoort hem niet aan te bieden');
  // Alleen de code; het commentaar legt juist uit waaróm hij er niet in staat.
  const code = bronApi().split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.ok(!code.includes("'aanmelding'"), 'en het endpoint ook niet');
});

test('elke reden in het scherm wordt door het endpoint geaccepteerd', () => {
  const H = laadView().__opvLeadHelpers;
  const i = bronApi().indexOf('const REDENEN');
  const regel = bronApi().slice(i, bronApi().indexOf(';', i));
  for (const k of H.LEAD_REDEN_KEYS) assert.ok(regel.includes("'" + k + "'"), k);
});

test('elke reden draagt een uitleg', () => {
  const H = laadView().__opvLeadHelpers;
  for (const [key, label, uitleg] of H.LEAD_REDENEN) {
    assert.ok(label && label.length > 2, key);
    assert.ok(uitleg && uitleg.length > 10, key + ': een keuze zonder uitleg is een gok');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HET FORMULIER
// ═══════════════════════════════════════════════════════════════════════════

const modal = (over) => ({ soort: 'lead-nieuw', velden: {}, fout: null, bezig: false, ...over });

test('het formulier draagt de vier velden en de notitie', () => {
  const H = laadView().__opvLeadHelpers;
  const h = H.leadModalHtml(modal());
  for (const id of ['opv-lead-naam', 'opv-lead-tel', 'opv-lead-reden', 'opv-lead-due', 'opv-lead-notitie']) {
    assert.match(h, new RegExp('id="' + id + '"'), id);
  }
});

test('de notitie staat als verplicht aangegeven', () => {
  const H = laadView().__opvLeadHelpers;
  assert.match(H.leadModalHtml(modal()), /Notitie <small>\(verplicht\)<\/small>/);
});

test('de datum begint op vandaag en kan niet in het verleden', () => {
  const H = laadView().__opvLeadHelpers;
  const h = H.leadModalHtml(modal({ velden: { due: NU } }));
  assert.match(h, new RegExp('value="' + NU + '" min="' + NU + '"'));
});

test('wat al ingevuld was blijft staan bij een hertekening', () => {
  // Zonder dit wist één klik op de keuzelijst de naam en de notitie.
  const H = laadView().__opvLeadHelpers;
  const h = H.leadModalHtml(modal({ velden: {
    naam: 'Jan Peeters', telefoon: '+32470123456', reden: 'afgemeld',
    due: '2026-09-10', notitie: 'via Wim',
  } }));
  assert.match(h, /value="Jan Peeters"/);
  assert.match(h, /value="\+32470123456"/);
  assert.match(h, /value="afgemeld" selected/);
  assert.match(h, /via Wim<\/textarea>/);
});

test('de uitleg volgt de gekozen reden', () => {
  const H = laadView().__opvLeadHelpers;
  const uitleg = (k) => H.LEAD_REDENEN.find((r) => r[0] === k)[2];
  assert.match(H.leadModalHtml(modal({ velden: { reden: 'afgemeld' } })), new RegExp(uitleg('afgemeld')));
  assert.match(H.leadModalHtml(modal({ velden: { reden: 'no_show_call' } })), new RegExp(uitleg('no_show_call')));
});

test('ingevoerde tekst wordt ontsnapt', () => {
  const H = laadView().__opvLeadHelpers;
  const h = H.leadModalHtml(modal({ velden: { naam: '"><script>alert(1)</script>', notitie: '<b>x</b>' } }));
  assert.doesNotMatch(h, /<script>/);
  assert.doesNotMatch(h, /<b>x<\/b>/);
});

test('een fout blijft in beeld staan boven het formulier', () => {
  const H = laadView().__opvLeadHelpers;
  const h = H.leadModalHtml(modal({ fout: 'telefoon is verplicht bij een handmatige lead' }));
  assert.match(h, /Nog niet opgeslagen/);
  assert.match(h, /telefoon is verplicht/);
  assert.match(h, /id="opv-lead-naam"/, 'en het formulier verdwijnt niet');
});

test('tijdens het opslaan gaat de knop op slot', () => {
  const H = laadView().__opvLeadHelpers;
  const h = H.leadModalHtml(modal({ bezig: true }));
  assert.match(h, /disabled/);
  assert.match(h, /Bezig/);
});

test('het venster staat in MODAL_ZONDER_TAAK', () => {
  const w = laadView();
  const zonder = new Set(Array.from(w.__opvModalHaak.MODAL_ZONDER_TAAK));
  assert.ok(zonder.has('lead-nieuw'), 'anders sneuvelt het stil op de taak-guard');
});

test('het venster wordt afgehandeld vóór de taak-guard', () => {
  const b = bronView();
  const i = b.indexOf('function modalHtml(');
  const kop = b.slice(i, i + 600);
  assert.ok(kop.indexOf("m.soort === 'lead-nieuw'") > 0);
  assert.ok(kop.indexOf("m.soort === 'lead-nieuw'") < kop.indexOf('zoekTaak(m.taakId)'));
});

test('de knop staat in de kop van het dagscherm', () => {
  const b = bronView();
  assert.match(b, /\+ Lead toevoegen/);
  assert.match(b, /window\.__opvLeadNieuw\(\)/);
});

test('het scherm controleert de verplichte velden voor het verstuurt', () => {
  const b = bronView();
  // Anker op de definitie: de naam staat 21k tekens eerder ook al, als
  // onclick-tekst in het formulier, en een venster vanaf dáár meet niets.
  const i = b.indexOf('window.__opvLeadOpslaan = async');
  assert.ok(i > 0, 'de handler hoort te bestaan');
  const blok = b.slice(i, i + 2400);
  assert.ok(blok.indexOf('const ontbreekt') < blok.indexOf("post('/api/opvolging-taak-create'"),
    'eerst kijken, dan pas versturen');
  for (const veld of ['!f.naam', '!f.telefoon', '!f.due', '!f.notitie']) {
    assert.ok(blok.includes(veld), veld);
  }
});

test('het scherm stuurt bron handmatig mee', () => {
  const b = bronView();
  const i = b.indexOf('window.__opvLeadOpslaan = async');
  assert.match(b.slice(i, i + 2400), /bron\s*:\s*'handmatig'/);
});

test('na het opslaan wordt de takenlijst geleegd', () => {
  const b = bronView();
  const i = b.indexOf('window.__opvLeadOpslaan = async');
  assert.match(b.slice(i, i + 2600), /leegTakenCache\(\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ENDPOINT BLIJFT DOEN WAT HET DEED
// ═══════════════════════════════════════════════════════════════════════════

test('bron is optioneel en valt terug op call', () => {
  // Het afronden van een call stuurt geen bron mee. Zou de standaard wijzigen,
  // dan verandert stil het gedrag van een weg die al maanden draait.
  const b = bronApi();
  assert.match(b, /const bron = b\.bron != null \? String\(b\.bron\)\.trim\(\) : 'call'/);
});

test('de bestaande aanroeper stuurt nog steeds geen bron mee', () => {
  const b = bronView();
  // Vanaf de call-afronding zelf, niet vanaf de eerste de beste aanroep: sinds
  // G2 zijn er twee, en de nieuwe staat eerder in het bestand.
  const i = b.indexOf('window.__opvCallBevestig = async');
  assert.ok(i > 0, 'de call-afronding hoort te bestaan');
  // Tot het EINDE van de handler, niet tot de eerste leegTakenCache(): sinds
  // item Q eindigt de klant_geworden-tak daar al, ruim vóór de taak-create die
  // deze test wil bekijken. Een venster op gevoel meet dan de verkeerde helft.
  const eind = b.indexOf('window.__opv', i + 30);
  const blok = b.slice(i, eind > 0 ? eind : i + 6000);
  assert.ok(blok.includes("post('/api/opvolging-taak-create'"), 'dit is de call-afronding');
  assert.ok(!/\bbron\s*:/.test(blok), 'die weg hoort ongewijzigd te blijven');
});

test('alleen call en handmatig zijn toegestaan', () => {
  const b = bronApi();
  assert.match(b, /const BRONNEN\s*=\s*new Set\(\['call', 'handmatig'\]\)/);
  assert.match(b, /onbekende bron/);
});

test('de bron_ref-source volgt de bron', () => {
  const b = bronApi();
  assert.match(b, /BRON_SOURCE = \{ call: 'opvolging-call', handmatig: 'opvolging-handmatig' \}/);
  assert.match(b, /source: BRON_SOURCE\[bron\]/);
});

test('bij handmatig zijn notitie, telefoon en due verplicht op de server', () => {
  // Ook op de server, zodat een oud tabblad ze niet kan omzeilen — dezelfde
  // redenering als bij bepaalStartPoging.
  const b = bronApi();
  for (const eis of [
    /handmatig && !notitie/,
    /handmatig && !telefoon/,
    /handmatig && !due/,
  ]) assert.match(b, eis);
});

test('die eisen gelden niet voor de bestaande bron', () => {
  // Een call-afronding met reden no_show_call heeft geen notitie en geen due,
  // en dat moet zo blijven werken.
  const b = bronApi();
  assert.ok(!/^\s*if \(!notitie\)/m.test(b), 'geen onvoorwaardelijke notitie-eis');
  assert.ok(!/^\s*if \(!telefoon\)/m.test(b), 'geen onvoorwaardelijke telefoon-eis');
});

test('de duplicaatmelding blokkeert niet', () => {
  const b = bronApi();
  const i = b.indexOf('let duplicaat = null');
  const blok = b.slice(i, i + 1800);
  assert.ok(!/return res\.status\(4\d\d\)/.test(blok), 'een dubbele lead is geen fout');
  assert.match(blok, /console\.warn\('\[opvolging-taak-create\] duplicaatcheck \(soft\)/,
    'en een mislukte controle blokkeert het aanmaken evenmin');
});

test('de duplicaatmelding vergelijkt op de laatste negen cijfers', () => {
  // Het CRM heeft nummers in elke notatie die ooit is ingetypt, met en zonder
  // landcode. Zie lesson learned 18.
  const b = bronApi();
  assert.match(b, /normaliseerNummer/);
  assert.match(b, /slice\(-9\)/);
});

test('de duplicaatmelding zegt het als hij niet alles gezien heeft', () => {
  // 'geen dubbele gevonden' zou anders een bewering zijn die we niet kunnen
  // doen zodra de lijst tegen de grens loopt.
  const b = bronApi();
  assert.match(b, /volledig: \(data \|\| \[\]\)\.length < DUP_MAX/);
});

test('het endpoint schrijft nog steeds alleen in de twee eigen tabellen', () => {
  const b = bronApi();
  const tabellen = new Set((b.match(/\.from\('([a-z_]+)'\)/g) || []).map((x) => x.slice(7, -2)));
  assert.deepEqual([...tabellen].sort(), ['opvolging_pogingen', 'opvolging_taken']);
});
