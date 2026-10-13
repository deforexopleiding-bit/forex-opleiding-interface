// tests/gesprekken-lege-lijst-bij-timeout.test.js
//
// Wanbetalers → Gesprekken toonde "Geen wanbetaler-gesprekken in dit filter"
// met categorie "Alles 0", terwijl het endpoint 200 gaf met 249 items.
//
// ── WAT ER ECHT GEBEURDE ────────────────────────────────────────────────────
// Niet het filter. `_fetchInboxConvs` deed dit:
//
//     const j = await tryFetch(..., 10000);
//     if (j && j.error) st.error = j.error;
//     else { st.items = asArr(j?.items); st.fetched = true; ... }
//
// tryFetch geeft bij een timeout of netwerkfout `null` terug. Die viel in de
// else-tak: st.items werd asArr(undefined) = [], st.fetched = true, en
// st.error bleef NULL. Een lijst van nul, gemarkeerd als geslaagd opgehaald,
// zonder foutmelding — op het scherm niet te onderscheiden van "er zijn er
// geen".
//
// Met GESPREKKEN_V2 aan doet het endpoint drie opvragingen extra (werkstand,
// namen, beloftes), serieel, bovenop de basisquery, de mail-aggregatie, de
// facturen en de IMAP-verrijking. Bij 249 gesprekken liep dat over de tien
// seconden die de browser wachtte. Vandaar dat het mét de vlag stuk leek en
// zonder niet: de vlag maakte de respons langzamer, niet het filter strenger.
//
// `_fetchOverzicht`, twintig regels hoger in hetzelfde bestand, deed het al
// goed (`if (!j || j.error)`). Dit was dus geen keuze maar een inconsistentie.
//
// ── WAT DEZE TOETSEN BEWAKEN ────────────────────────────────────────────────
//   1. de echte responsvorm (249 items, de velden die Maxim gemeten heeft)
//      gaat door het filter heen en de wanbetalers blijven staan — mét de vlag;
//   2. een mislukte opvraging wordt NOOIT een lege lijst;
//   3. het endpoint vraagt in blokken op, zodat het sneller en korter is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VIEW = readFileSync(new URL('../modules/klanten-v2/views/wanbetalers-v2.js', import.meta.url), 'utf8');
const EP   = readFileSync(new URL('../api/inbox-conversations-list.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');

/** De gedeelde selectie in een nep-window laden, net als de andere view-toetsen. */
function laadSelectie() {
  const src = readFileSync(new URL('../modules/shared/inbox-wanbetaler-selectie.js', import.meta.url), 'utf8');
  const win = {};
  const mod = { exports: {} };
  new Function('window', 'module', src)(win, mod);
  return win.INBOX_WANBETALER_SELECTIE;
}
function laadCategorie() {
  const src = readFileSync(new URL('../modules/shared/inbox-categorie.js', import.meta.url), 'utf8');
  const win = {};
  const mod = { exports: {} };
  new Function('window', 'module', src)(win, mod);
  return win.INBOX_CATEGORIE;
}
function laadGesprekkenV2() {
  const src = readFileSync(new URL('../modules/shared/gesprekken-v2.js', import.meta.url), 'utf8');
  const win = {};
  const mod = { exports: {} };
  new Function('window', 'module', src)(win, mod);
  return win.GESPREKKEN_V2;
}

const SEL = laadSelectie();
const IC  = laadCategorie();
const GV  = laadGesprekkenV2();

/* ── de echte respons, nagebouwd ──────────────────────────────────────────── */
//
// 249 items, met de categorie-mix en de velden die Maxim op 13 oktober in de
// respons zag: categorie, categorie_label, categorie_tags, iris_status,
// toegewezen_aan, belofte_vandaag, is_debtor. De verhoudingen zijn een
// aanname, het AANTAL en de VELDEN niet.
const MIX = [
  ['wanbetaler', 34],
  ['leadsonderhoud', 70],
  ['lead_aanmelding', 55],
  ['onbekend', 48],
  ['events', 30],
  ['klant', 12],
];

function echteRespons() {
  const items = [];
  let n = 0;
  for (const [categorie, aantal] of MIX) {
    for (let i = 0; i < aantal; i++) {
      n++;
      const wanbetaler = categorie === 'wanbetaler';
      items.push({
        id: `conv-${n}`,
        phone_number: `+31600000${String(n).padStart(3, '0')}`,
        display_name: `Klant ${n}`,
        customer_id: `cust-${n}`,
        customer_name: `Klant ${n}`,
        status: 'open',
        last_message_at: `2026-10-${String(1 + (n % 12)).padStart(2, '0')}T10:00:00Z`,
        last_activity_at: `2026-10-${String(1 + (n % 12)).padStart(2, '0')}T10:00:00Z`,
        last_inbound_at: `2026-10-${String(1 + (n % 12)).padStart(2, '0')}T09:00:00Z`,
        unread_count: n % 5 === 0 ? 2 : 0,
        email_unread_count: 0,
        total_unread: n % 5 === 0 ? 2 : 0,
        can_send_text: true,
        open_invoice_count: wanbetaler ? 2 : 0,
        total_open_cents: wanbetaler ? 24500 : 0,
        is_debtor: wanbetaler,
        brief_sent: false,
        categorie,
        categorie_label: categorie,
        categorie_tags: [],
        iris_status: n % 3 === 0 ? 'wacht_op_ons' : null,
        toegewezen_aan: n % 7 === 0 ? 'uid-dave' : null,
        toegewezen_naam: n % 7 === 0 ? 'Dave' : null,
        belofte_vandaag: false,
      });
    }
  }
  return items;
}

const ITEMS = echteRespons();
const WANBETALERS = MIX.find((m) => m[0] === 'wanbetaler')[1];

const vlagAan = (extra = {}) => ({
  zoek: '', overzichtKlantIds: [], focusModus: 'geen', categorie: 'alles',
  sorteer: 'unread_first', gv: GV, ic: IC, ...extra,
});

/* ── 1. de echte respons door het v2-filter ──────────────────────────────── */

test('de respons heeft 249 items — net als in productie', () => {
  assert.equal(ITEMS.length, 249);
});

test('DE REGRESSIE: met de vlag aan blijven de wanbetalers zichtbaar', () => {
  // Dit is de toets die de melding van 13 oktober zou hebben opgevangen als
  // het filter de oorzaak was geweest. Hij staat er ook nu het dat niet was:
  // deze functie beslist wat Maxim ziet en was niet te toetsen.
  const uit = SEL.kies(ITEMS, vlagAan());
  assert.equal(uit.length, WANBETALERS, `verwacht ${WANBETALERS} wanbetalers, kreeg ${uit.length}`);
  assert.ok(uit.every((c) => c.is_debtor === true));
});

test('zonder de vlag precies dezelfde lijst — de vlag maakt het filter niet strenger', () => {
  const met  = SEL.kies(ITEMS, vlagAan());
  const zonder = SEL.kies(ITEMS, vlagAan({ gv: null }));
  assert.deepEqual(zonder.map((c) => c.id), met.map((c) => c.id));
});

test('de categorie-chips tellen over de lijst ZONDER categoriefilter', () => {
  // "Alles 0" was het symptoom. Die teller komt hiervandaan.
  const basis = SEL.kies(ITEMS, vlagAan({ categorie: 'alles' }));
  assert.equal(basis.length, WANBETALERS);
  assert.ok(basis.length > 0, 'de chiprij zou "Alles 0" tonen');
});

test('een categorie kiezen die niet in de scope zit geeft leeg — en dat is juist', () => {
  // Leadsonderhoud-gesprekken zijn geen wanbetalers; nul is hier het goede
  // antwoord, en het verschil met de regressie is dat de scope dan zichtbaar
  // actief is.
  assert.equal(SEL.kies(ITEMS, vlagAan({ categorie: 'leadsonderhoud' })).length, 0);
  assert.equal(SEL.kies(ITEMS, vlagAan({ categorie: 'wanbetaler' })).length, WANBETALERS);
});

test('de werkstand-filters werken op dezelfde respons', () => {
  const opOns = SEL.kies(ITEMS, vlagAan({ focusModus: 'wacht_op_ons' }));
  assert.ok(opOns.length > 0, 'geen enkel gesprek wacht op ons in deze lijst');
  assert.ok(opOns.every((c) => c.iris_status === 'wacht_op_ons'));

  // 'niet gekoppeld' zoekt BUITEN de wanbetaler-scope; in deze lijst heeft
  // iedereen een klant, dus nul — en niet "alle 249".
  const los = SEL.kies(ITEMS, vlagAan({ focusModus: 'niet_gekoppeld' }));
  assert.equal(los.length, 0);
});

test('zoeken gaat over de VOLLE lijst, niet binnen de scope', () => {
  // Anders vind je een klant zonder open factuur nooit, en lijkt het of hij
  // niets gestuurd heeft.
  const nietWanbetaler = ITEMS.find((c) => !c.is_debtor);
  const uit = SEL.kies(ITEMS, vlagAan({ zoek: nietWanbetaler.customer_name, focusModus: 'niet_gekoppeld' }));
  assert.ok(Array.isArray(uit));
});

test('ongelezen staan vooraan, daarna op activiteit', () => {
  const uit = SEL.kies(ITEMS, vlagAan());
  const eersteGelezen = uit.findIndex((c) => !(Number(c.total_unread) > 0));
  const laatsteOngelezen = uit.reduce((acc, c, i) => (Number(c.total_unread) > 0 ? i : acc), -1);
  if (eersteGelezen !== -1 && laatsteOngelezen !== -1) {
    assert.ok(laatsteOngelezen < eersteGelezen, 'ongelezen staan niet vooraan');
  }
});

test('een respons ZONDER is_debtor valt terug op het overzicht, niet op leeg', () => {
  const zonderVlag = ITEMS.map(({ is_debtor, ...rest }) => rest);
  const ids = ITEMS.filter((c) => c.is_debtor).map((c) => c.customer_id);
  assert.equal(SEL.kies(zonderVlag, vlagAan({ overzichtKlantIds: ids })).length, WANBETALERS);
  // En zonder overzicht: alles, niet niets. Een lege terugval zou de lijst
  // laten verdwijnen bij een oudere serverversie.
  assert.equal(SEL.kies(zonderVlag, vlagAan({ overzichtKlantIds: [] })).length, ITEMS.length);
});

test('een lege of onzinnige invoer geeft een lege lijst, geen uitzondering', () => {
  for (const ruw of [null, undefined, [], 'nee', 42, {}]) {
    assert.deepEqual(SEL.kies(ruw, vlagAan()), []);
  }
  assert.doesNotThrow(() => SEL.kies(ITEMS, undefined));
});

/* ── 2. een mislukte opvraging is geen lege lijst ─────────────────────────── */

test('DE OORZAAK: een null-antwoord zet een fout, en wist de lijst NIET', () => {
  assert.match(VIEW, /if \(!j \|\| j\.error\) \{/, 'een null-antwoord valt nog in de else-tak');
  assert.match(VIEW, /Kon de gesprekken niet laden/);
  // en de oude vorm mag niet terugkomen
  const blok = VIEW.slice(VIEW.indexOf('async function _fetchInboxConvs'), VIEW.indexOf('async function _fetchInboxThread'));
  assert.ok(!/if \(j && j\.error\) st\.error = j\.error;\s*\n\s*else \{/.test(blok),
    'de oude tak die een timeout als lege lijst behandelde staat er nog');
  // st.items wordt in de fouttak niet aangeraakt
  const foutTak = blok.slice(blok.indexOf('if (!j || j.error) {'), blok.indexOf('} else {'));
  assert.ok(!/st\.items\s*=/.test(foutTak), 'de fouttak wist de lijst alsnog');
});

test('het scherm zegt het als de lijst oud is', () => {
  assert.match(VIEW, /Deze lijst is misschien niet actueel/);
  assert.match(VIEW, /const verouderdBanner = \(st\.error && st\.items\.length\)/);
});

test('de browser wacht langer dan het endpoint nodig heeft', () => {
  assert.match(VIEW, /const INBOX_LIJST_WACHT_MS = 20000;/);
  assert.match(VIEW, /tryFetch\('inbox:convs',[\s\S]{0,120}?INBOX_LIJST_WACHT_MS\)/);
});

/* ── 3. het endpoint is sneller en korter ────────────────────────────────── */

test('de werkstand-opvragingen gaan naast elkaar, niet achter elkaar', () => {
  // Dit was de seriële lus die de respons over de tien seconden duwde.
  assert.match(EP, /const standBlokken = await Promise\.all\(/);
  assert.match(EP, /const \[naamBlokken, belofteBlokken\] = await Promise\.all\(\[/);
  const blok = EP.slice(EP.indexOf('if (gesprekkenV2Aan())'), EP.indexOf('// Categorie per gesprek'));
  assert.ok(!/for \(const blok of inBlokken\([\s\S]{0,80}?await supabaseAdmin/.test(blok),
    'er staat nog een await in een inBlokken-lus');
});

test('de facturen-opvraging gaat in blokken, zoals de rest van het repo', () => {
  // Dit was één .in() met tot 1000 uuid's in de URL. De rest van het repo
  // knipt zulke lijsten op bij 100 à 200, met de URL-lengte als reden.
  assert.match(EP, /inBlokken\(custIds\)\.map\(\(blok\) => supabaseAdmin/);
  assert.ok(!/\.in\('customer_id', custIds\)/.test(EP), 'de hele lijst gaat nog in één .in()');
});

/* ── de bedrading ─────────────────────────────────────────────────────────── */

test('de gedeelde selectie staat vóór de view in index.html', () => {
  const sel  = HTML.indexOf('inbox-wanbetaler-selectie.js');
  const view = HTML.indexOf('views/wanbetalers-v2.js');
  assert.ok(sel > 0, 'het script staat niet in index.html');
  assert.ok(sel < view, 'inbox-wanbetaler-selectie.js moet vóór wanbetalers-v2.js staan');
});

test('de view faalt luid als het script ontbreekt, en toont niet stil iets anders', () => {
  assert.match(VIEW, /inbox-wanbetaler-selectie\.js ontbreekt/);
  assert.match(VIEW, /const SEL = window\.INBOX_WANBETALER_SELECTIE;/);
});

test('de view heeft geen eigen kopie van de filterregels meer', () => {
  const blok = VIEW.slice(VIEW.indexOf('function _selectVisibleInboxItems'), VIEW.indexOf('function _wbxFindLastInboundMail'));
  assert.ok(!/is_debtor/.test(blok), 'de view filtert nog zelf op is_debtor');
  assert.ok(!/IC\.past/.test(blok), 'de view filtert nog zelf op categorie');
});

test('het scherm heeft een nieuw nummer', () => {
  const m = HTML.match(/views\/wanbetalers-v2\.js\?v=(\d+)/);
  assert.ok(m, 'wanbetalers-v2.js wordt zonder ?v= geladen');
  assert.ok(Number(m[1]) >= 69, `?v=${m[1]} is lager dan de 69 van deze PR`);
});
