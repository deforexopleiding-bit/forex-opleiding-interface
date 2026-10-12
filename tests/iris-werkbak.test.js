// tests/iris-werkbak.test.js
//
// "Wacht op ons" wachtte niet op ons.
//
// ── GEMETEN, 12 OKTOBER, forex-command-center ───────────────────────────────
// 569 gesprekken in de werkbak. Op basis van het laatste bericht in
// iris_berichten: 225 eindigen inkomend (de bal ligt echt bij ons), 344
// eindigen met een bericht van ONS — een automatische herinnering ("Hoi
// Hanneke! Morgen is alweer je laatste dag…"), een systeemmelding ("Nieuwe
// afspraak ingeboekt. Naam: Lex Beekman…"), leveranciersmail (360dialog
// Support).
//
// Een bakje dat voor 60% uit afgehandelde dingen bestaat, is een bakje waar je
// niet meer in kijkt. En dan mis je ook die 225.
//
// ── EN DE KOLOM WAS LEEG ────────────────────────────────────────────────────
// `iris_gesprekken.laatste_outbound` werd alléén gezet door iris-verstuur.js —
// het verzendpad van Iris zelf, dat nauwelijks gedraaid heeft. In NUL van alle
// rijen was hij gevuld. De regel "er kwam iets binnen ná ons laatste bericht"
// had dus niets om mee te vergelijken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { balBijOns, kiesWerkbak, MAX_KANDIDATEN, ONINGEDEELD } from '../api/_lib/iris/werkbak.js';
import { leesSysteemafzenders, isSysteemafzender, STANDAARD } from '../api/_lib/iris/instellingen.js';

// ── de regel ────────────────────────────────────────────────────────────────

test('niets van de klant gehoord: dan wacht er niemand op ons', () => {
  // Een gesprek dat alleen uit onze eigen berichten bestaat — een automatische
  // herinnering naar iemand die nooit antwoordde — hoort niet in de werkbak.
  assert.equal(balBijOns({}), false);
  assert.equal(balBijOns({ laatste_outbound: '2026-10-02T10:00:00Z' }), false);
});

test('wel inkomend, nooit iets terug: dan wacht het op ons', () => {
  assert.equal(balBijOns({ laatste_inbound: '2026-10-01T10:00:00Z' }), true);
});

test('ons bericht was het laatste: dan ligt de bal bij de klant', () => {
  // Dit zijn de 344. Ze verdwijnen niet — ze staan onder "Wacht op klant".
  assert.equal(balBijOns({
    laatste_inbound: '2026-10-01T10:00:00Z',
    laatste_outbound: '2026-10-02T10:00:00Z',
  }), false);
});

test('de klant antwoordde ná ons: dan wacht het weer op ons', () => {
  assert.equal(balBijOns({
    laatste_inbound: '2026-10-03T10:00:00Z',
    laatste_outbound: '2026-10-02T10:00:00Z',
  }), true);
});

test('gelijktijdig telt als afgehandeld, niet als wachtend', () => {
  // Bij exact dezelfde tijdstempel weet je de volgorde niet. Dan liever niet
  // in de werkbak: een gesprek dat er onterecht niet in staat kost één
  // gemiste reactie, een bakje dat volloopt met twijfelgevallen kost het
  // vertrouwen in het hele bakje.
  const t = '2026-10-02T10:00:00Z';
  assert.equal(balBijOns({ laatste_inbound: t, laatste_outbound: t }), false);
});

// ── filteren vóór pagineren ─────────────────────────────────────────────────

test('de regel gaat over de VOLLEDIGE lijst, niet over een bladzijde', () => {
  // Andersom zou betekenen dat je er vijftig ophaalt waarvan er dertig
  // wegvallen. Dan klopt het aantal niet, springt de cursor, en zie je bij het
  // doorladen gesprekken dubbel of helemaal niet.
  const k = [
    { id: 'a', laatste_inbound: '2026-10-05' },                                  // wacht
    { id: 'b', laatste_inbound: '2026-10-02', laatste_outbound: '2026-10-04' },  // afgehandeld
    { id: 'c', laatste_inbound: '2026-10-04', laatste_outbound: '2026-10-03' },  // wacht
    { id: 'd', laatste_outbound: '2026-10-03' },                                 // nooit iets gehoord
    { id: 'e', laatste_inbound: '2026-10-01' },                                  // wacht
  ];
  const eerste = kiesWerkbak(k, { vanaf: 0, limiet: 2 });
  assert.deepEqual(eerste.ids, ['a', 'c'], 'de bladzijde komt uit de GEFILTERDE lijst');
  assert.equal(eerste.totaal, 3, 'het totaal is wat er na de regel over is, niet de 5 kandidaten');

  const tweede = kiesWerkbak(k, { vanaf: 2, limiet: 2 });
  assert.deepEqual(tweede.ids, ['e'], 'en de volgende bladzijde sluit daarop aan');
  assert.equal(tweede.totaal, 3);
});

test('de volgorde van de kandidaten blijft staan', () => {
  // De hoofdopvraging haalt daarna op `.in('id', ids)` en sorteert op
  // dezelfde kolom. Zou het filter de volgorde omgooien, dan zou de bladzijde
  // niet aansluiten op de vorige.
  const k = ['x', 'y', 'z'].map((id, i) => ({ id, laatste_inbound: `2026-10-0${3 - i}` }));
  assert.deepEqual(kiesWerkbak(k, { vanaf: 0, limiet: 3 }).ids, ['x', 'y', 'z']);
});

test('een afgekapte lijst zegt dat hij afgekapt is', () => {
  // Vanaf de grens is de lijst niet compleet, en dat mag je niet stilletjes
  // niet merken.
  const vol = Array.from({ length: MAX_KANDIDATEN }, (_, i) => ({ id: 'g' + i, laatste_inbound: '2026-10-01' }));
  assert.equal(kiesWerkbak(vol, { vanaf: 0, limiet: 50 }).afgekapt, true);
  assert.equal(kiesWerkbak(vol.slice(0, 10), { vanaf: 0, limiet: 50 }).afgekapt, false);
});

test('rommel erin geeft een lege bladzijde, geen uitzondering', () => {
  for (const rommel of [null, undefined, 'nee', 42]) {
    const u = kiesWerkbak(rommel, { vanaf: 0, limiet: 10 });
    assert.deepEqual(u.ids, []);
    assert.equal(u.totaal, 0);
  }
});

// ── systeemafzenders ────────────────────────────────────────────────────────

test('de lijst begint leeg, en dat is met opzet', () => {
  // Wie hier staat verdwijnt uit de werkbak. Zo'n lijst mag niet door code
  // bedacht worden; Maxim vult hem in Instellingen.
  assert.deepEqual([...STANDAARD.systeemafzenders], []);
});

test('alleen adressen en @domeinen komen erin', () => {
  // Een los woord zou als deelstring gaan werken, en dan valt een echte
  // klantvraag weg zonder dat iemand het merkt.
  assert.deepEqual(
    leesSysteemafzenders(['  NoReply@DFO.nl ', '@dfo.nl', '', 'info', null, 42, '@dfo.nl']),
    ['noreply@dfo.nl', '@dfo.nl'],
  );
  assert.deepEqual(leesSysteemafzenders('nee'), []);
});

test('een @domein geldt voor het hele domein, een los woord voor niets', () => {
  assert.equal(isSysteemafzender('wie-dan-ook@dfo.nl', ['@dfo.nl']), true);
  assert.equal(isSysteemafzender('noreply@dfo.nl', ['noreply@dfo.nl']), true);
  // Dit is het geval waar het om gaat: 'info' mag klant-info@gmail.com NIET
  // raken. Daarom wordt een los woord niet eens opgeslagen.
  assert.equal(isSysteemafzender('klant-info@gmail.com', ['@dfo.nl']), false);
  assert.equal(isSysteemafzender('andy@dl-interieur.be', []), false);
  assert.equal(isSysteemafzender('', ['@dfo.nl']), false);
});

// ── en de bedrading ────────────────────────────────────────────────────────

const POST = readFileSync(new URL('../api/iris-post.js', import.meta.url), 'utf8');
const CRON = readFileSync(new URL('../api/cron-iris-werk.js', import.meta.url), 'utf8');
const ENDPOINT = readFileSync(new URL('../api/iris-instellingen.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
const BACKFILL = readFileSync(new URL('../docs/sql-migrations/2026-10-12-iris-laatste-outbound-backfill.sql', import.meta.url), 'utf8');

test("'nieuw' zit niet meer in de werkbak", () => {
  // Nog niet ingedeeld is niet hetzelfde als op ons wachtend. Dat is waarom
  // leveranciersmail tussen het werk stond.
  // De stand zit in de kandidaat-opvraging, niet meer in de hoofdopvraging.
  const kand = POST.slice(POST.indexOf('async function haalWerkbakKandidaten'), POST.indexOf('function zonderSysteemafzenders'));
  assert.match(kand, /\.eq\('status', 'wacht_op_ons'\)/);
  assert.doesNotMatch(POST, /\.in\('status', \['nieuw', 'wacht_op_ons'\]\)/,
    "'nieuw' hoort nergens meer samen met wacht_op_ons gefilterd te worden");
  assert.match(POST, /'nog_in_te_delen',/, 'er hoort een eigen filter voor te zijn');
  assert.match(POST, /vraag\.eq\('status', ONINGEDEELD\)/);
  assert.equal(ONINGEDEELD, 'nieuw');
});

test('de teller gebruikt EXACT dezelfde weg als de lijst', () => {
  // Zou de teller een andere regel gebruiken, dan zegt de badge 569 en toont
  // de lijst 225 — en dan vertrouw je geen van de twee meer. Daarom lopen ze
  // allebei door haalWerkbakKandidaten + kiesWerkbak.
  const teller = POST.slice(POST.indexOf('const inst = await haalInstellingen(supabaseAdmin);'), POST.indexOf('return res.status(200).json({ tellingen,'));
  assert.match(teller, /haalWerkbakKandidaten\(/);
  assert.match(teller, /kiesWerkbak\(kandidaten, \{ vanaf: 0, limiet: 1 \}\)\.totaal/);
  const lijst = POST.slice(POST.indexOf("if (filter === 'wacht_op_ons')"), POST.indexOf("} else if (filter === 'nog_in_te_delen')"));
  assert.match(lijst, /haalWerkbakKandidaten\(/);
  assert.match(lijst, /kiesWerkbak\(kandidaten, \{ vanaf, limiet \}\)/);
});

test('de drie sloten zitten in de kandidaat-opvraging', () => {
  const kand = POST.slice(POST.indexOf('async function haalWerkbakKandidaten'), POST.indexOf('function zonderSysteemafzenders'));
  assert.match(kand, /\.eq\('status', 'wacht_op_ons'\)/, 'de stand');
  assert.match(kand, /\.or\(werkbakCategorieFilter\(\)\)/, 'de categorie');
  assert.match(kand, /zonderSysteemafzenders\(vraag, systeemafzenders\)/, 'de afzenders');
  assert.match(kand, /\.limit\(MAX_KANDIDATEN\)/, 'en een grens');
  assert.match(kand, /console\.warn\('\[iris-post\] werkbak afgekapt op'/, 'die luid is als hij geraakt wordt');
});

test('er wordt GEEN .range() bovenop de gekozen ids gezet', () => {
  // Dat zou een bladzijde uit een bladzijde nemen.
  assert.match(POST, /werkbakTotaal === null\s*\n?\s*\? await vraag\.range\(/);
  assert.match(POST, /const totaal = werkbakTotaal !== null \? werkbakTotaal : \(count \?\? hoofdAantal\)/);
  assert.match(POST, /meer: totaal > vanaf \+ hoofdAantal/);
});

test('zoeken binnen de werkbak beperkt ook de kandidaten', () => {
  // Anders krijg je een bladzijde uit de ONgefilterde kandidaten en kloppen de
  // aantallen bij zoeken niet.
  assert.match(POST, /let zoekContactIds = null;/);
  assert.match(POST, /contactIds: zoekContactIds,/);
  assert.match(POST, /if \(zoekContactIds && filter !== 'wacht_op_ons'\) vraag = vraag\.in\('contact_id', zoekContactIds\)/);
  // En het oude zoek-blok staat niet meer ná de filterkeuze.
  assert.ok(POST.indexOf('let zoekContactIds') < POST.indexOf("if (filter === 'wacht_op_ons')"),
    'de zoekterm hoort VÓÓR de filterkeuze opgelost te worden');
});

test('elk uitgaand bericht zet nu laatste_outbound', () => {
  // Dit was het echte gat: de kolom bestond, maar werd alleen door
  // iris-verstuur.js gezet — en dat pad heeft nauwelijks gedraaid.
  assert.match(CRON, /async function stempelOutbound\(gesprekId, wanneer\)/);
  const stempels = (CRON.match(/if \(vorm\.richting === 'out'\) await stempelOutbound\(/g) || []).length;
  assert.equal(stempels, 2, 'WhatsApp én mail horen te stempelen');
  // Alleen vooruit: de synchronisatie leest met een terugblik, dus berichten
  // komen niet gegarandeerd in volgorde langs.
  assert.match(CRON, /if \(data\?\.laatste_outbound && data\.laatste_outbound >= wanneer\) return;/);
});

test('er is GEEN generated column, en dat is met opzet', () => {
  // ADD COLUMN ... GENERATED ALWAYS AS ... STORED herschrijft de hele tabel
  // onder een ACCESS EXCLUSIVE lock. Op iris_gesprekken tijdens werkuren is dat
  // niet acceptabel. Daarom staat de regel in de code en gaat er precies één
  // gewone kolom de databank in.
  const actief = BACKFILL.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(actief, /GENERATED/i);
  assert.doesNotMatch(actief, /\bDELETE\b|\bDROP\b|TRUNCATE/i);
  // De ENIGE ALTER die er mag staan is RLS aanzetten op het spoor-tabelletje
  // dat dit bestand zelf aanmaakt. Geen ALTER op iris_gesprekken — dat is
  // precies de tabelherschrijving die we vermijden.
  const alters = actief.match(/ALTER TABLE[^;]*/gi) || [];
  assert.equal(alters.length, 1, 'precies één ALTER: RLS op het spoor');
  assert.match(alters[0], /iris_outbound_backfill_20261012 ENABLE ROW LEVEL SECURITY/);
  assert.doesNotMatch(actief, /ALTER TABLE public\.iris_gesprekken/i);
});

test('de backfill doet één batch per run en zegt hoeveel', () => {
  // Een DO-lus zou alle rijlocks tot het eind vasthouden; dan is "in batches"
  // alleen een woord. Losse runs zijn losse transacties.
  const actief = BACKFILL.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(actief, /DO \$\$/, 'geen DO-lus — die houdt de locks vast');
  assert.match(actief, /LIMIT 500/);
  assert.match(actief, /AS deze_batch/, 'elke run hoort te melden hoeveel rijen hij raakte');
  assert.match(actief, /AND g\.laatste_outbound IS NULL/, 'alleen waar hij leeg is — dus idempotent');
  assert.match(actief, /SET laatste_outbound = l\.op/);
  // Eén kolom, en niets anders.
  const sets = [...actief.matchAll(/SET\s+(\w+)\s*=/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(sets)], ['laatste_outbound']);
});

test('er is een terugweg, met het spoor erbij', () => {
  // Een rollback die je moet samenstellen terwijl er iets misgaat, is geen
  // rollback.
  assert.match(BACKFILL, /CREATE TABLE IF NOT EXISTS public\.iris_outbound_backfill_20261012/);
  assert.match(BACKFILL, /INSERT INTO public\.iris_outbound_backfill_20261012/);
  assert.match(BACKFILL, /-- UPDATE public\.iris_gesprekken g\n-- SET laatste_outbound = NULL/);
  // En de terugweg wist niet wat de code sindsdien zelf schreef.
  assert.match(BACKFILL, /--   AND g\.laatste_outbound = s\.gezet_op;/);
});

test('de lijst is in Instellingen te beheren en wordt daar nagekeken', () => {
  assert.match(ENDPOINT, /'systeemafzenders',/);
  assert.match(ENDPOINT, /case 'systeemafzenders': \{/);
  assert.match(ENDPOINT, /is geen adres of @domein/);
  assert.match(SCHERM, /function systeemafzendersBlok\(inst\)/);
  assert.match(SCHERM, /window\.__irisAfzenderBij = async/);
  assert.match(SCHERM, /window\.__irisAfzenderWeg = async/);
  // Eén bron: de lijst komt terug van de server, niet uit een eigen kopie die
  // na één bewerking afwijkt.
  assert.match(SCHERM, /function huidigeAfzenders\(\)/);
  assert.match(SCHERM, /S\.instellingen\?\.data\?\.instellingen\?\.systeemafzenders/);
});

test('het scherm heeft een nieuw nummer', () => {
  // Een getal vastpinnen maakt van deze toets een hek voor élke latere PR die
  // iris.js aanraakt: hij eist een bump en valt dan om op precies die bump.
  // H3 zette hem op 22; vanaf hier is alleen "niet lager dan 22" de eis.
  const m = INDEX.match(/\.\.\/iris\/iris\.js\?v=(\d+)/);
  assert.ok(m, 'iris.js wordt zonder ?v= geladen');
  assert.ok(Number(m[1]) >= 22, `?v=${m[1]} is lager dan de 22 van H3`);
});
