// tests/iris-opvolging.test.js
//
// "Verwittig me als er geen reactie komt" (O-2).
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// Dit is het belangrijkste dat de audit vond, want hier deed Iris iets ANDERS
// dan waar om gevraagd werd. `taak_aanmaken` deed dit, en niets meer:
//
//     .from('pending_actions').insert({ action_type: 'MANUAL_FOLLOWUP', ... })
//
// Eén regel met een omschrijving. Geen datum, geen bewaking, geen bericht.
// Er werd om drie dingen gevraagd -- hou bij of er gereageerd wordt, verwittig
// me, als het binnen een paar dagen uitblijft -- en daarvan gebeurde er nul.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STANDAARD_DAGEN, MIN_DAGEN, MAX_DAGEN, MAX_MELD_POGINGEN, OPEN_STATUSSEN,
  leesDagen, termijn, bouwOpvolging, beoordeel,
  meldTekst, meldOnderwerp, dagenTussen, gesprekLink,
} from '../api/_lib/iris/opvolging.js';
import { WERKENDE_STAPTYPES, SYSTEEM_TEKST } from '../api/_lib/iris/opdracht.js';
import { STAP_LABELS, SNELKNOPPEN, resultaatRegels } from '../api/_lib/iris/opdracht-tekst.js';

const NU = new Date('2026-09-28T09:00:00.000Z');
const GOED = {
  gesprekId: '11111111-1111-4111-8111-111111111111',
  omschrijving: 'Opvolging mail van de advocaat',
  verwittigEmail: 'iemand@deforexopleiding.nl',
  nu: NU,
};

// ── de termijn ───────────────────────────────────────────────────────────────

test('geen of onleesbare dagen valt terug op de standaard, niet op nul', () => {
  // Nul zou betekenen dat de opvolging bij de eerstvolgende ronde al afgaat, en
  // een melding die meteen komt is geen opvolging maar ruis.
  assert.equal(leesDagen(undefined), STANDAARD_DAGEN);
  assert.equal(leesDagen('geen getal'), STANDAARD_DAGEN);
  assert.equal(leesDagen(null), STANDAARD_DAGEN);
});

test('de dagen blijven binnen de grenzen', () => {
  assert.equal(leesDagen(0), MIN_DAGEN);
  assert.equal(leesDagen(-5), MIN_DAGEN);
  assert.equal(leesDagen(9999), MAX_DAGEN);
  assert.equal(leesDagen(7), 7);
  assert.equal(leesDagen(3.9), 3, 'halve dagen worden afgekapt');
});

test('de termijn ligt precies zoveel dagen verder', () => {
  const t = termijn(3, NU);
  assert.equal(t.toISOString(), '2026-10-01T09:00:00.000Z');
});

// ── de rij bouwen ────────────────────────────────────────────────────────────

test('een opvolging legt alle drie de dingen vast', () => {
  // WAAROP, TOT WANNEER, en WIE er bericht krijgt. Precies de drie waarvan er
  // nul gebeurden.
  const r = bouwOpvolging(GOED);
  assert.equal(r.ok, true);
  assert.equal(r.rij.waarop, 'gesprek');
  assert.equal(r.rij.gesprek_id, GOED.gesprekId);
  assert.equal(r.rij.tot, '2026-10-01T09:00:00.000Z');
  assert.equal(r.rij.verwittig_email, GOED.verwittigEmail);
  assert.equal(r.rij.status, 'kijkt');
});

test('sinds is het ijkpunt en staat op het moment van maken', () => {
  // Zonder dat veld zou een bericht van vorige week de opvolging meteen
  // sluiten, en dan heeft hij nooit iets gedaan.
  assert.equal(bouwOpvolging(GOED).rij.sinds, NU.toISOString());
});

test('zonder spoor is er geen opvolging', () => {
  // Een opvolging zonder gesprek of contact kan nooit zien dat er iets
  // binnenkwam en zou dus ALTIJD afgaan -- een wekker die gegarandeerd vals
  // alarm geeft.
  const r = bouwOpvolging({ ...GOED, gesprekId: null });
  assert.equal(r.ok, false);
  assert.match(r.fout, /gesprek of een contact/);
});

test('een contact alleen mag wel', () => {
  const r = bouwOpvolging({ ...GOED, gesprekId: null, contactId: '22222222-2222-4222-8222-222222222222' });
  assert.equal(r.ok, true);
  assert.equal(r.rij.waarop, 'contact');
});

test('zonder adres is er niemand om te verwittigen', () => {
  // Een wekker die afgaat in een lege kamer.
  assert.equal(bouwOpvolging({ ...GOED, verwittigEmail: null }).ok, false);
  assert.equal(bouwOpvolging({ ...GOED, verwittigEmail: 'geen adres' }).ok, false);
});

test('zonder omschrijving zegt de opvolging later niets', () => {
  assert.equal(bouwOpvolging({ ...GOED, omschrijving: '   ' }).ok, false);
});

// ── beoordelen ───────────────────────────────────────────────────────────────

const LOOPT = {
  status: 'kijkt',
  sinds: '2026-09-25T09:00:00.000Z',
  tot: '2026-09-28T09:00:00.000Z',
  meld_pogingen: 0,
};

test('een reactie sluit de opvolging', () => {
  const r = beoordeel(LOOPT, {
    reactie: { id: 'b1', ontvangen_op: '2026-09-26T10:00:00.000Z' },
    nu: new Date('2026-09-27T09:00:00.000Z'),
  });
  assert.equal(r.doe, 'reactie');
});

test('EEN REACTIE WINT VAN EEN VERSTREKEN TERMIJN', () => {
  // Allebei waar: er is geantwoord én de termijn is om. Wie op de valreep
  // antwoordde en dan toch een "er is niet gereageerd"-mail krijgt, gelooft de
  // volgende melding niet meer.
  const r = beoordeel(LOOPT, {
    reactie: { id: 'b1', ontvangen_op: '2026-09-27T23:00:00.000Z' },
    nu: new Date('2026-09-29T09:00:00.000Z'),
  });
  assert.equal(r.doe, 'reactie');
});

test('een bericht van VOOR het ijkpunt telt niet als reactie', () => {
  // Dit is de val. Zonder de vergelijking met `sinds` sluit een bericht van
  // vorige week de opvolging meteen.
  const r = beoordeel(LOOPT, {
    reactie: { id: 'oud', ontvangen_op: '2026-09-20T10:00:00.000Z' },
    nu: new Date('2026-09-29T09:00:00.000Z'),
  });
  assert.equal(r.doe, 'melden');
});

test('binnen de termijn gebeurt er niets', () => {
  const r = beoordeel(LOOPT, { nu: new Date('2026-09-27T09:00:00.000Z') });
  assert.equal(r.doe, 'wacht');
});

test('termijn om en niets binnen: melden', () => {
  const r = beoordeel(LOOPT, { nu: new Date('2026-09-28T09:00:01.000Z') });
  assert.equal(r.doe, 'melden');
});

test('een onleesbare termijn meldt NIET', () => {
  // Melden bij twijfel is hier de dure kant: dat is een mail naar een mens
  // over niets.
  const r = beoordeel({ ...LOOPT, tot: 'onzin' }, { nu: new Date('2026-12-01T09:00:00.000Z') });
  assert.equal(r.doe, 'wacht');
});

test('na te veel mislukte pogingen geven we het op in plaats van door te mailen', () => {
  // De afspraak-reminders stuurden ooit 95 mails op een dag omdat elke
  // mislukte poging opnieuw alarm sloeg (CLAUDE.md).
  const r = beoordeel({ ...LOOPT, status: 'verlopen', meld_pogingen: MAX_MELD_POGINGEN },
    { nu: new Date('2026-10-05T09:00:00.000Z') });
  assert.equal(r.doe, 'opgeven');
});

test('een afgeronde of afgebroken opvolging vraagt niets meer', () => {
  for (const status of ['reactie', 'gemeld', 'afgebroken']) {
    assert.equal(beoordeel({ ...LOOPT, status }, { nu: new Date('2026-12-01T09:00:00.000Z') }).doe, 'wacht');
  }
  // En de twee die wel nog iets moeten, staan in OPEN_STATUSSEN.
  assert.deepEqual([...OPEN_STATUSSEN], ['kijkt', 'verlopen']);
});

// ── het bericht ──────────────────────────────────────────────────────────────

test('het bericht zegt waarover het gaat en hoe lang er gewacht is', () => {
  const t = meldTekst({ ...LOOPT, omschrijving: 'Mail van de advocaat' });
  assert.match(t, /Mail van de advocaat/);
  assert.match(t, /3 dagen/);
});

test('het bericht verzint geen link als die er niet is', () => {
  // Een url die we hopen dat klopt, kost een klik en levert niets op.
  const t = meldTekst({ ...LOOPT, waarop: 'contact', gesprek_id: null, omschrijving: 'x' });
  assert.doesNotMatch(t, /https?:\/\//);
  assert.equal(gesprekLink({ waarop: 'contact', contact_id: 'c1' }, 'https://x.nl'), null);
});

test('zonder basis-url staat er geen halve link in', () => {
  assert.equal(gesprekLink({ waarop: 'gesprek', gesprek_id: 'g1' }, ''), null);
});

test('met een gesprek en een basis komt de link er wel in', () => {
  const link = gesprekLink({ waarop: 'gesprek', gesprek_id: 'g1' }, 'https://x.nl/');
  assert.match(link, /v2preview=iris/);
  assert.match(link, /gesprek=g1/);
  assert.doesNotMatch(link, /\/\/modules/, 'de slash aan het eind hoort weg te vallen');
});

test('het onderwerp zegt al genoeg in de inbox', () => {
  assert.match(meldOnderwerp({ omschrijving: 'Mail van de advocaat' }), /Geen reactie: Mail van de advocaat/);
});

test('dagenTussen geeft null bij rommel en nooit nul', () => {
  assert.equal(dagenTussen('onzin', '2026-09-28T09:00:00Z'), null);
  assert.equal(dagenTussen('2026-09-28T09:00:00Z', '2026-09-20T09:00:00Z'), null, 'achterstevoren is geen duur');
  assert.equal(dagenTussen('2026-09-28T09:00:00Z', '2026-09-28T20:00:00Z'), 1, 'minder dan een dag leest als een dag');
});

// ── het staptype ─────────────────────────────────────────────────────────────

test('opvolging_instellen is een stap die Iris mag voorstellen', () => {
  assert.ok(WERKENDE_STAPTYPES.includes('opvolging_instellen'));
  assert.ok(STAP_LABELS.opvolging_instellen);
  assert.ok(SNELKNOPPEN.some((k) => k.staptype === 'opvolging_instellen'));
});

test('de instructie stuurt "verwittig me" naar opvolging_instellen en niet naar taak_aanmaken', () => {
  // Dit was de hele fout: de vraag kwam uit op taak_aanmaken, en dat maakt een
  // regel in een lijstje in plaats van iets dat kijkt.
  assert.match(SYSTEEM_TEKST, /opvolging_instellen en NIET taak_aanmaken/);
});

test('het resultaat noemt de datum, niet alleen dat er iets ingesteld is', () => {
  // "Opvolging ingesteld" zonder tot wanneer is net zo weinig waard als de
  // taakregel die O-2 verving.
  const r = resultaatRegels('opvolging_instellen', { opvolging_id: 'o1', tot: '2026-10-01T09:00:00.000Z' });
  assert.equal(r.length, 1);
  assert.match(r[0].tekst, /2026-10-01/);
});

// ── de bedrading ─────────────────────────────────────────────────────────────

const ACTIE = readFileSync(new URL('../api/iris-actie.js', import.meta.url), 'utf8');
const CRON = readFileSync(new URL('../api/cron-iris-opvolging.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const VERCEL = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const MIGRATIE = readFileSync(new URL('../docs/sql-migrations/2026-09-28-iris-opvolgingen.sql', import.meta.url), 'utf8');

test('de stap legt het adres vast bij het MAKEN', () => {
  // Niet bij het melden opzoeken: wie de opvolging vroeg, krijgt het bericht --
  // ook als zijn rol intussen veranderd is.
  const i = ACTIE.indexOf("case 'opvolging_instellen'");
  assert.ok(i > 0, 'het staptype hoort een case te hebben');
  const blok = ACTIE.slice(i, ACTIE.indexOf("\n    // Verzenden", i));
  assert.match(blok, /verwittigEmail: profiel\?\.email/);
  assert.match(blok, /from\('iris_opvolgingen'\)/);
});

test('het staptype heeft een recht', () => {
  assert.match(ACTIE, /opvolging_instellen: 'iris\.post\.beantwoorden'/);
});

test('de cron telt alleen INKOMENDE berichten als reactie', () => {
  // Een herinnering van Iris die haar eigen opvolging sluit, is de zekerste
  // manier om nooit meer bericht te krijgen.
  const i = CRON.indexOf('async function zoekReactie');
  const blok = CRON.slice(i, CRON.indexOf('\n}', i));
  assert.match(blok, /\.eq\('richting', 'in'\)/);
  assert.match(blok, /\.gt\('ontvangen_op', o\.sinds\)/);
});

test('de cron claimt vóór hij mailt', () => {
  // Twee overlappende ronden mogen niet allebei dezelfde melding sturen.
  const i = CRON.indexOf('async function meld(');
  const blok = CRON.slice(i, i + 1600);
  const claim = blok.indexOf('.update({ status: \'verlopen\'');
  const mail = blok.indexOf('sendEmailViaSmtp');
  assert.ok(claim > 0 && mail > claim, 'de claim hoort vóór de mail te staan');
  assert.match(blok, /\.eq\('meld_pogingen'/, 'de claim hoort voorwaardelijk te zijn');
});

test('een mislukte melding blijft NIET als gemeld staan', () => {
  // Een opgegeven melding die er afgehandeld uitziet, is een verdwenen melding.
  const i = CRON.indexOf('async function meld(');
  const blok = CRON.slice(i, i + 2600);
  const fout = blok.indexOf('meld_fout:');
  const gemeld = blok.indexOf("status: 'gemeld'");
  assert.ok(fout > 0 && gemeld > fout, 'de faaltak hoort vóór de succestak af te breken');
  assert.match(blok.slice(fout, gemeld), /return;/);
});

test('de cron valt zacht als de migratie nog niet gedraaid is', () => {
  // Een cron die elk etmaal rood in Vercel staat omdat een tabel ontbreekt,
  // leert je crons te negeren.
  assert.match(CRON, /42P01/);
  assert.match(CRON, /migratie 2026-09-28 draaien/);
});

test('de cron staat in vercel.json en draait één keer per dag', () => {
  const rij = (VERCEL.crons || []).find((c) => c.path === '/api/cron-iris-opvolging');
  assert.ok(rij, 'de cron hoort in vercel.json te staan');
  // Vijf velden, en niet elke minuut of elk uur: een opvolging hoeft maar één
  // keer per dag bekeken te worden.
  const velden = rij.schedule.trim().split(/\s+/);
  assert.equal(velden.length, 5);
  assert.doesNotMatch(rij.schedule, /^\*/, 'elke minuut is geen dagelijkse controle');
  assert.doesNotMatch(velden[1], /\*/, 'het uur hoort vast te staan');
});

test('het scherm toont wat er loopt, en kan het stoppen', () => {
  assert.match(SCHERM, /function opvolgingenBlok\(\)/);
  assert.match(SCHERM, /\$\{opvolgingenBlok\(\)\}/, 'het blok hoort ook echt in de tab te staan');
  assert.match(SCHERM, /window\.__irisOpvolgingAfbreken = async/);
});

test('het scherm zegt het als de migratie nog moet draaien', () => {
  // Anders staat er gewoon niets, en is "Iris houdt het in de gaten" een
  // belofte die stil niet waargemaakt wordt.
  const i = SCHERM.indexOf('function opvolgingenBlok()');
  const blok = SCHERM.slice(i, i + 900);
  assert.match(blok, /nogNietGemigreerd/);
});

// ── de migratie ──────────────────────────────────────────────────────────────

test('de migratie zegt bovenaan dat hij blokkerend is', () => {
  // Les uit CLAUDE.md: een kolom- of CHECK-migratie die de code bij naam noemt
  // is blokkerend, en dat hoort prominent te staan.
  assert.match(MIGRATIE.slice(0, 1200), /BLOKKEREND/);
  assert.match(MIGRATIE.slice(0, 1600), /opvolging_instellen/);
});

test('de migratie heeft een controle vooraf en achteraf', () => {
  assert.match(MIGRATIE, /CONTROLE VOORAF/);
  assert.match(MIGRATIE, /CONTROLE ACHTERAF/);
  // En allebei tellen ze iris_acties, zodat te zien is dat er geen rij
  // aangeraakt is.
  const tellingen = MIGRATIE.match(/count\(\*\) FROM public\.iris_acties/g) || [];
  assert.equal(tellingen.length, 2, 'vooraf en achteraf hetzelfde getal');
});

test('de migratie gebruikt geen TEMP-tabel en geen tweede DO-blok', () => {
  // De Supabase SQL-editor knipt op statement-grenzen en draait elk statement
  // in een eigen transactie (CLAUDE.md). Een TEMP-tabel is weg vóór het
  // volgende statement hem nodig heeft.
  assert.doesNotMatch(MIGRATIE, /CREATE TEMP TABLE/i);
  assert.equal((MIGRATIE.match(/^DO \$\$/gm) || []).length, 1);
});

test('de CHECK wordt vervangen en niet opengezet', () => {
  // Wat er niet in staat kan Iris niet, ook niet per ongeluk. Blokkeren en
  // toegang intrekken horen te blijven ontbreken.
  const i = MIGRATIE.indexOf('ADD CONSTRAINT iris_acties_type_check');
  assert.ok(i > 0);
  const blok = MIGRATIE.slice(i, i + 500);
  assert.match(blok, /'opvolging_instellen'/);
  assert.doesNotMatch(blok, /klant_blokkeren|toegang_intrekken/);
  for (const t of WERKENDE_STAPTYPES) {
    assert.ok(blok.includes(`'${t}'`), `${t} ontbreekt in de nieuwe CHECK`);
  }
});

test('de nieuwe tabel staat onder RLS', () => {
  assert.match(MIGRATIE, /ALTER TABLE public\.iris_opvolgingen ENABLE ROW LEVEL SECURITY/);
  assert.match(MIGRATIE, /is_crm_staff\(\)/);
});

test('de cron krijgt een index om op te zoeken', () => {
  // Zonder deze index leest de dagelijkse ronde de hele tabel.
  assert.match(MIGRATIE, /idx_iris_opvolgingen_open[\s\S]{0,120}WHERE status = 'kijkt'/);
});
