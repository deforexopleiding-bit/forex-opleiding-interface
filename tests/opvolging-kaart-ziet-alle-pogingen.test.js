// tests/opvolging-kaart-ziet-alle-pogingen.test.js
//
// EEN KAART DIE ZICHZELF TEGENSPREEKT.
//
// ── GEMETEN OP 11 SEPTEMBER, ±12:15 ─────────────────────────────────────
// Rony Van Hecke en Redouane Jerroudi, reden `zoom_nabellen`, kaart gemaakt om
// 10:00 UTC door de 12u-instroom. De NOTITIE op die kaart zegt 'geen reactie op
// het spraakbericht van 07:16 / 07:13'. Dezelfde kaart toont eronder de chips
// '🎤 geen spraakbericht', '☎ geen spraakbericht' en '💬 geen WhatsApp'.
// /api/opvolging-taken gaf voor allebei `pogingen: []` en `wa_totaal: 0`.
//
// Daniel Vleeshakker, `no_show_call`, kaart 07:56 UTC: alleen zijn twee calls
// van 09:58 en 09:59 hingen eraan. Het spraakbericht van 05:04 en de WhatsApp
// van 05:05 ontbraken.
//
// Diezelfde berichten stonden WEL goed in /api/opvolging-agenda, en in 'Calls
// van vandaag' als 'Spraakbericht om 07:04 — op tijd'.
//
// ── DE OORZAAK, NAGEMETEN ───────────────────────────────────────────────
// api/opvolging-whatsapp-webhook.js schrijft twee dingen:
//
//   opvolging_pogingen      de TELLING — alleen als er op dat moment een taak is
//   opvolging_wa_berichten  de gespreksregel — ALTIJD, met taak_id of NULL
//
// api/opvolging-taken.js las uitsluitend opvolging_pogingen op het eigen
// taak_id. Een bericht van vóór het bestaan van de kaart heeft daar geen rij.
//
// Eén nuance op de eerste diagnose: het is niet zo dat de berichten sinds PR 2
// 'met taak_id NULL worden opgeslagen en daardoor verdwenen'. Vóór PR 2 werden
// ze HELEMAAL niet bewaard. PR 2 heeft de data gered; wat ontbrak is dat de
// kaart die tweede bron leest.
//
// ── WAAROM DIT NIET COSMETISCH IS ───────────────────────────────────────
// De archiveerregel is 3 belpogingen op 3 verschillende dagen én 1 WhatsApp.
// Telt die WhatsApp niet mee, dan moet Dave er een tweede sturen om aan een
// regel te voldoen waar hij al aan voldeed.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  volledigeHistorie, losseRegelsVoor, regelAlsPoging, WA_REGELS_LIMIET,
} from '../api/_lib/opvolging-call-wa.js';
import { telPogingen } from '../api/_lib/opvolging-poging-telling.js';
import { bouwArchief } from '../api/opvolging-rapport.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');

const isoDag = (d) => new Date(d).toISOString().slice(0, 10);
const DAG = '2026-09-11';

// ── DE GEMETEN GEVALLEN ────────────────────────────────────────────────────

/** Daniel: spraakbericht 05:04 en WhatsApp 05:05, kaart pas om 07:56. */
const DANIEL = {
  id: 't-daniel', naam: 'Daniel Vleeshakker', telefoon: '+31612345678',
  reden: 'no_show_call', status: 'open', due: DAG,
  created_at: '2026-09-11T07:56:00.000Z',
};
const DANIEL_SPRAAK = {
  nummer: '31612345678', taak_id: null, richting: 'uit',
  media_type: 'ptt', tijdstip: '2026-09-11T05:04:00.000Z',
};
const DANIEL_WA = {
  nummer: '31612345678', taak_id: null, richting: 'uit',
  media_type: null, tijdstip: '2026-09-11T05:05:00.000Z',
};
/** De twee calls die er wél aan hingen. */
const DANIEL_CALLS = [
  { taak_id: 't-daniel', soort: 'call', richting: 'uit', resultaat: 'niet opgenomen',
    tijdstip: '2026-09-11T09:58:00.000Z', duur_sec: 12 },
  { taak_id: 't-daniel', soort: 'call', richting: 'uit', resultaat: 'niet opgenomen',
    tijdstip: '2026-09-11T09:59:00.000Z', duur_sec: 9 },
];

/** Rony: zoom_nabellen-kaart om 10:00, spraakbericht om 07:16. */
const RONY = {
  id: 't-rony', naam: 'Rony Van Hecke', telefoon: '0470112233',
  reden: 'zoom_nabellen', status: 'open', due: DAG,
  notitie: 'Geen reactie op het spraakbericht van 07:16.',
};
const RONY_SPRAAK = {
  nummer: '32470112233', taak_id: null, richting: 'uit',
  media_type: 'audio', tijdstip: '2026-09-11T05:16:00.000Z',
};

// ═══════════════════════════════════════════════════════════════════════════
// 1 · HET GEMETEN GEVAL
// ═══════════════════════════════════════════════════════════════════════════

test('spraakbericht 05:04 zonder taak → de no-show-kaart van 07:56 ziet het', () => {
  const hist = volledigeHistorie(DANIEL_CALLS, [DANIEL_SPRAAK, DANIEL_WA], DANIEL);
  const t = telPogingen(hist, DAG, isoDag);

  // Vóór de reparatie: wa_totaal 0 en alleen de twee calls.
  assert.equal(t.wa_totaal, 2, 'het spraakbericht én de WhatsApp tellen mee');
  assert.equal(t.wa_vandaag, 2);
  assert.equal(t.bel_totaal, 2, 'en de calls blijven gewoon staan');
  assert.equal(t.pogingen_totaal, 4);

  // Op tijd gesorteerd, zodat 'laatst' klopt en de vensters de eerste van de
  // dag vinden in plaats van een willekeurige.
  const tijden = hist.map((p) => p.tijdstip);
  assert.deepEqual(tijden, [...tijden].sort());
  assert.equal(t.laatste_poging, '2026-09-11T09:59:00.000Z');
});

test('de archiveerregel telt die WhatsApp nu mee', () => {
  // 3 belpogingen op 3 verschillende dagen én 1 WhatsApp. Zonder deze
  // reparatie moest Dave een tweede bericht sturen om aan een regel te voldoen
  // waar hij al aan voldeed.
  const drieDagen = [
    { taak_id: 't-daniel', soort: 'call', richting: 'uit', resultaat: 'niet opgenomen', tijdstip: '2026-09-09T09:00:00.000Z' },
    { taak_id: 't-daniel', soort: 'call', richting: 'uit', resultaat: 'niet opgenomen', tijdstip: '2026-09-10T09:00:00.000Z' },
    { taak_id: 't-daniel', soort: 'call', richting: 'uit', resultaat: 'niet opgenomen', tijdstip: '2026-09-11T09:00:00.000Z' },
  ];
  const zonder = telPogingen(drieDagen, DAG, isoDag);
  assert.equal(zonder.bel_dagen, 3);
  assert.equal(zonder.wa_totaal, 0, 'hier haalde hij de regel niet');

  const met = telPogingen(volledigeHistorie(drieDagen, [DANIEL_WA], DANIEL), DAG, isoDag);
  assert.equal(met.bel_dagen, 3);
  assert.equal(met.wa_totaal, 1, 'en nu wel');
});

test('een zoom_nabellen-kaart ziet het spraakbericht van die ochtend', () => {
  // Rony's nummer staat lokaal op de kaart (0470…) en met landcode in het
  // bericht (32470…). Dat is precies de match die zonder de laatste-negen-regel
  // stukloopt — zie CLAUDE.md lesson 18.
  const t = telPogingen(volledigeHistorie([], [RONY_SPRAAK], RONY), DAG, isoDag);
  assert.equal(t.wa_totaal, 1);
  assert.equal(t.pogingen.length, 1);
  assert.equal(t.pogingen[0].soort, 'spraakbericht');
  assert.equal(t.pogingen[0].bron, 'wa_bericht', 'herkenbaar als niet-uit-pogingen');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · NIETS TELT DUBBEL
// ═══════════════════════════════════════════════════════════════════════════

test('een regel die al aan deze kaart hangt telt één keer, niet twee', () => {
  // De webhook schrijft poging én gespreksregel in één adem. Zou de kaart de
  // regel óók nog als losse poging oppikken, dan staat elk bericht dubbel.
  const gekoppeld = { ...DANIEL_WA, taak_id: 't-daniel' };
  const poging = { taak_id: 't-daniel', soort: 'whatsapp', richting: 'uit',
    tijdstip: DANIEL_WA.tijdstip };
  const t = telPogingen(volledigeHistorie([poging], [gekoppeld], DANIEL), DAG, isoDag);
  assert.equal(t.wa_totaal, 1);
});

test('een regel die aan een ÁNDERE kaart hangt blijft erbuiten', () => {
  // Anders bloedt de moeite van een oude kaart door in een nieuwe, en telt
  // iemand het werk van vorige maand mee voor de regel van vandaag.
  const vanOudeKaart = { ...DANIEL_WA, taak_id: 't-oud' };
  const t = telPogingen(volledigeHistorie([], [vanOudeKaart], DANIEL), DAG, isoDag);
  assert.equal(t.wa_totaal, 0);
});

test('losseRegelsVoor houdt alleen wat van niemand is', () => {
  const regels = [
    { taak_id: null }, { taak_id: undefined }, { taak_id: 't-daniel' }, { taak_id: 't-oud' },
  ];
  assert.equal(losseRegelsVoor(regels, 't-daniel').length, 2);
});

test('een bericht van een ander nummer komt er niet bij', () => {
  const vreemde = { nummer: '31699998888', taak_id: null, richting: 'uit',
    media_type: 'ptt', tijdstip: '2026-09-11T05:04:00.000Z' };
  const t = telPogingen(volledigeHistorie([], [vreemde], DANIEL), DAG, isoDag);
  assert.equal(t.wa_totaal, 0);
});

test('een kaart zonder telefoonnummer verandert niets', () => {
  const zonderTel = { ...DANIEL, telefoon: null };
  const hist = volledigeHistorie(DANIEL_CALLS, [DANIEL_SPRAAK], zonderTel);
  assert.equal(hist.length, 2, 'alleen de eigen pogingen');
  assert.equal(hist, DANIEL_CALLS, 'en dan zelfs dezelfde lijst, zonder kopie');
});

test('zonder regels is het exact de oude berekening', () => {
  // Valt de tweede bron weg, dan blijft de kaart werken op alleen de pogingen.
  for (const regels of [null, undefined, []]) {
    const hist = volledigeHistorie(DANIEL_CALLS, regels, DANIEL);
    assert.deepEqual(hist.map((p) => p.tijdstip), DANIEL_CALLS.map((p) => p.tijdstip));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · EEN ANTWOORD VAN DE LEAD BLIJFT GEEN MOEITE
// ═══════════════════════════════════════════════════════════════════════════

test('een binnenkomend bericht telt als contact, niet als poging', () => {
  // De regel uit opvolging-poging-telling.js mag hier niet door een tweede
  // bron omzeild worden: wa_totaal gaat over de moeite die Dave doet.
  const antwoord = { ...DANIEL_WA, richting: 'in', tijdstip: '2026-09-11T06:00:00.000Z' };
  const t = telPogingen(volledigeHistorie([], [antwoord], DANIEL), DAG, isoDag);
  assert.equal(t.wa_totaal, 0, 'geen moeite');
  assert.equal(t.inkomend, 1, 'wel zichtbaar');
  assert.equal(regelAlsPoging(antwoord).richting, 'in');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HET ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

/** Een supabase-dubbelganger waarin elke ketting awaitbaar is. */
function nepAdmin(rijen = {}, { waFout = null, waVeel = false } = {}) {
  const gezien = [];
  const maak = (tabel) => {
    let data = rijen[tabel] || [];
    if (tabel === 'opvolging_wa_berichten') {
      if (waFout) {
        const k = { select: () => k, gte: () => k, order: () => k, limit: () => k,
          then: (r) => Promise.resolve({ data: null, error: { message: waFout } }).then(r) };
        return k;
      }
      if (waVeel) data = Array.from({ length: WA_REGELS_LIMIET }, () => DANIEL_SPRAAK);
    }
    const k = {
      select: () => k, eq: () => k, lte: () => k, gte: () => k, lt: () => k,
      in: (c, v) => { gezien.push([tabel, c, v]); return k; },
      filter: () => k, order: () => k, limit: () => k, not: () => k,
      maybeSingle: async () => ({ data: data[0] || null, error: null }),
      single: async () => ({ data: data[0] || null, error: null }),
      then: (r) => Promise.resolve({ data, error: null }).then(r),
    };
    return k;
  };
  return { from: maak, _gezien: gezien };
}

function nepRes() {
  const uit = { code: null, body: null, headers: {} };
  return {
    setHeader: (k, v) => { uit.headers[k] = v; },
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
    _uit: uit,
  };
}

async function laadTaken(rijen, opzet) {
  const admin = nepAdmin(rijen, opzet);
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin,
      supabase: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } },
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } }),
      checkCronAuth: () => ({ ok: true }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: {
      requirePermission: async () => true,
      requirePermissionFailOpen: async () => true,
      checkPermissionOrDeny: async () => true,
    },
  });
  const mod = await import(url('api/opvolging-taken.js') + '?t=' + Math.random());
  return { handler: mod.default, admin };
}

const get = (query = {}) => ({ method: 'GET', headers: { authorization: 'Bearer x' }, query });

test('/api/opvolging-taken geeft Daniel nu wa_totaal 2 in plaats van 0', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadTaken({
    opvolging_taken: [DANIEL],
    opvolging_pogingen: DANIEL_CALLS,
    opvolging_wa_berichten: [DANIEL_SPRAAK, DANIEL_WA],
  });
  const res = nepRes();
  await handler(get(), res);

  assert.equal(res._uit.code, 200, JSON.stringify(res._uit.body));
  const kaart = res._uit.body.taken.find((x) => x.id === 't-daniel');
  assert.ok(kaart, 'de kaart hoort er te staan');
  assert.equal(kaart.wa_totaal, 2, 'dit was 0');
  assert.equal(kaart.bel_totaal, 2);
  assert.equal(kaart.pogingen.length, 4);
});

test('en de gespreksregels worden echt uit de tweede tabel gelezen', async (t) => {
  t.after(() => mock.reset());
  const { handler, admin } = await laadTaken({
    opvolging_taken: [DANIEL], opvolging_pogingen: [], opvolging_wa_berichten: [],
  });
  await handler(get(), nepRes());
  const bron = readFileSync(join(ROOT, 'api/opvolging-taken.js'), 'utf8');
  assert.match(bron, /haalWaRegelsVanaf/);
  assert.match(bron, /volledigeHistorie\(/);
  // En niet stilletjes op het nummer gefilterd in SQL: die nummers staan
  // genormaliseerd in de ene tabel en met landcode in de andere.
  assert.ok(!admin._gezien.some(([tabel, kolom]) => tabel === 'opvolging_wa_berichten' && kolom === 'nummer'));
});

test('valt de tweede bron weg, dan zegt het antwoord dat erbij', async (t) => {
  // Fail-soft, maar nooit stil: een telling die te laag kan zijn mag niet als
  // volledige meting lezen. Dat is de fout die deze PR juist repareert.
  t.after(() => mock.reset());
  const { handler } = await laadTaken({
    opvolging_taken: [DANIEL], opvolging_pogingen: DANIEL_CALLS,
  }, { waFout: 'relation does not exist' });
  const res = nepRes();
  await handler(get(), res);
  assert.equal(res._uit.code, 200, 'de lijst blijft werken');
  assert.match(res._uit.body.wa_melding, /niet te lezen/i);
  assert.equal(res._uit.body.taken[0].bel_totaal, 2, 'de pogingen tellen gewoon door');
});

test('en een afgekapte lezing meldt zich ook', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadTaken({
    opvolging_taken: [DANIEL], opvolging_pogingen: [],
  }, { waVeel: true });
  const res = nepRes();
  await handler(get(), res);
  assert.match(res._uit.body.wa_melding, /oudste tellen mogelijk niet mee/i);
});

test('het archieftabblad rekent op dezelfde historie', async (t) => {
  // Afgerond is het bewijsscherm. Een kaart die daar 'te weinig moeite' krijgt
  // terwijl er 's ochtends een spraakbericht ging is een verwijt op een halve
  // meting.
  t.after(() => mock.reset());
  const { handler } = await laadTaken({
    opvolging_taken: [{ ...DANIEL, status: 'gearchiveerd', gearchiveerd_at: '2026-09-11T18:00:00.000Z' }],
    opvolging_pogingen: DANIEL_CALLS,
    opvolging_wa_berichten: [DANIEL_SPRAAK, DANIEL_WA],
  });
  const res = nepRes();
  await handler(get({ view: 'archief' }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.archief[0].wa_totaal, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · HET RAPPORT
// ═══════════════════════════════════════════════════════════════════════════

test('sectie 5 van het rapport telt het losse bericht mee', () => {
  const hist = new Map([['t-daniel', DANIEL_CALLS]]);
  const zonder = bouwArchief({
    gearchiveerd: [{ ...DANIEL, gearchiveerd_at: '2026-09-11T18:00:00.000Z' }],
    histPerTaak: hist,
  });
  assert.equal(zonder[0].wa_totaal, 0, 'dit was de stand vóór de reparatie');

  const met = bouwArchief({
    gearchiveerd: [{ ...DANIEL, gearchiveerd_at: '2026-09-11T18:00:00.000Z' }],
    histPerTaak: hist,
    waRegels: [DANIEL_SPRAAK, DANIEL_WA],
  });
  assert.equal(met[0].wa_totaal, 2);
  assert.equal(met[0].bel_totaal, 2, 'en de calls blijven staan');
});

test('zonder waRegels blijft sectie 5 exact zoals hij was', () => {
  // Achterwaarts compatibel: bestaande aanroepers die het veld niet meesturen
  // krijgen dezelfde uitkomst als voorheen.
  const hist = new Map([['t-daniel', DANIEL_CALLS]]);
  const a = bouwArchief({ gearchiveerd: [DANIEL], histPerTaak: hist });
  const b = bouwArchief({ gearchiveerd: [DANIEL], histPerTaak: hist, waRegels: null });
  assert.deepEqual(a, b);
});

test('de lezing voor sectie 5 dekt de levensloop, niet alleen de periode', () => {
  // `moeite_over: 'levensloop'` belooft de hele levensloop van de kaart. Een
  // kaart die vandaag dichtgaat kan vorige week zijn begonnen, dus het venster
  // van de periode volstaat daar niet voor.
  const bron = readFileSync(join(ROOT, 'api/opvolging-rapport.js'), 'utf8');
  assert.match(bron, /ARCHIEF_WA_TERUG_DAGEN = 60/);
  assert.match(bron, /Math\.min\([\s\S]{0,120}ARCHIEF_WA_TERUG_DAGEN/);
  // En een mislukte of afgekapte lezing wordt een blinde vlek, geen nul.
  assert.match(bron, /sectie: 'archief'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · DE CHIP DIE OVER NABELLEN GAAT
// ═══════════════════════════════════════════════════════════════════════════

test("de nabel-chip zegt niets meer over het spraakbericht alleen", () => {
  // '☎ geen spraakbericht' was de kale REDEN waarom nabellen niet nodig was,
  // onder een telefoon-icoon, pal naast de spraak-chip die hetzelfde al zei.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function vensterBadges(');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 2200);
  assert.doesNotMatch(blok, /&#9742; ' \+ esc\(o\.nabel\.reden/, 'de kale reden hoort er niet meer te staan');
  assert.match(blok, /nabellen niet nodig/);
  assert.match(blok, /NABEL_REDEN/);
});

test('en de reden staat in mensentaal, met de sleutels van beoordeelNabel', () => {
  const bron = readFileSync(VIEW, 'utf8');
  // De twee redenen die beoordeelNabel teruggeeft.
  for (const reden of ['geen spraakbericht', 'heeft geantwoord']) {
    assert.match(bron, new RegExp("return \\{ staat: 'niet_nodig', reden: '" + reden + "'"), reden);
    assert.match(bron, new RegExp("'" + reden + "'\\s*:"), reden + ' hoort een nette zin te krijgen');
  }
  // Een onbekende reden vervalt niet stil.
  assert.ok(bron.indexOf('const NABEL_REDEN') > 0, 'de vertaaltabel hoort te bestaan');
  assert.match(bron, /NABEL_REDEN\[o\.nabel\.reden\] \|\| o\.nabel\.reden/);
});

test('een zoom_nabellen-kaart toont de vensters altijd', () => {
  // Die kaart wordt om 12:00 gemaakt júist omdat er een zoomcall van vandaag
  // is. Hem laten afhangen van een tweede lezing (_calls, van de agenda) liet
  // de vensters stil weg op precies de kaart die erover gaat.
  const bron = readFileSync(VIEW, 'utf8');
  assert.match(bron, /const isNabelKaart = \(t\) => !!t && t\.reden === 'zoom_nabellen';/);
  const i = bron.indexOf('function vensterBadges(');
  const blok = bron.slice(i, i + 1600);
  assert.match(blok, /if \(!isNabelKaart\(t\) && !heeftCallOpDag\(t, dag\)\) return '';/);
  // De brug-voorwaarde blijft: zonder zicht op uitgaande berichten is
  // 'geen spraakbericht' een bewering die we niet kunnen doen.
  assert.match(blok, /if \(!brugZietUitgaand\(\)\) return '';/);
});

test('de view is opgehoogd', () => {
  const html = readFileSync(join(ROOT, 'modules/klanten-v2/index.html'), 'utf8');
  const m = html.match(/views\/opvolging-v2\.js\?v=(\d+)/);
  assert.ok(m);
  assert.ok(Number(m[1]) >= 64, 'PR 11 hoort hem op minstens 64 te zetten');
});
