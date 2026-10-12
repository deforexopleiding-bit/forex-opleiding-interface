// tests/iris-belrij-scherm.test.js
//
// Taak 6, deel 2 — de belrij zegt WAAROM iemand erop staat, en WIE hem belt.
//
// ── WAT ER MIS WAS ──────────────────────────────────────────────────────────
// Deel 1 maakte één rij per persoon met meerdere redenen eronder, maar het
// scherm toonde alleen `r.reden` — de reden van de zwaarst wegende bron. Wie
// om een factuur én een mentorsignaal gebeld moest worden, zag alleen het
// factuurverhaal. Dat is precies hoe iemand ophangt zonder het signaal te
// noemen.
//
// En in de kolom rechts stond `r.eigenaar`: een ruwe uuid. Dat zegt niemand
// iets, en het is een id in een schermafdruk.
//
// ── DE STILLE KANT VAN DE EIGENAARSREGEL ────────────────────────────────────
// Staat er een uuid ingesteld die niet bestaat, dan komt de rij op de lijst van
// niemand te staan: hij is niet weg, maar wel onvindbaar voor wie op "Van mij"
// filtert. Dat merkt niemand tot een klant belt. Daarom staat er op het lezen
// én op het schrijven van die instelling een strenge keuring, en daarom is de
// UI een keuzelijst met namen en geen invoerveld voor een uuid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BELRIJ_BRONNEN, STANDAARD, leesBelrijEigenaren, eigenaarVoorBron, haalInstellingen,
} from '../api/_lib/iris/instellingen.js';
import { keurWaardeGoed, TOEGESTANE_SLEUTELS } from '../api/iris-instellingen.js';
import { schrijfPersoon } from '../api/_lib/iris/belrij-vullen.js';
import { uitBeltaak, uitSignaal, voegSamen } from '../api/_lib/iris/belrij-bronnen.js';

const IRIS     = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const INDEX    = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
const ENDPOINT = readFileSync(new URL('../api/iris-belrij.js', import.meta.url), 'utf8');
const INST_EP  = readFileSync(new URL('../api/iris-instellingen.js', import.meta.url), 'utf8');

const MAXIM = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DAVE  = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const CONTACT = '11111111-1111-1111-1111-111111111111';

/* ── de instelling lezen ──────────────────────────────────────────────────── */

test('de standaard is een LEGE kaart, niet een gok wie Maxim of Dave is', () => {
  assert.deepEqual(STANDAARD.belrij_eigenaar, {});
});

test('alleen een echte uuid komt erdoor', () => {
  assert.deepEqual(leesBelrijEigenaren({ wanbetaler: MAXIM }), { wanbetaler: MAXIM });
  for (const rommel of ['maxim', '', '  ', 'aaaa', 42, null, undefined, {}, [MAXIM]]) {
    assert.deepEqual(leesBelrijEigenaren({ wanbetaler: rommel }), {}, `${JSON.stringify(rommel)} kwam erdoor`);
  }
});

test('een bron die niet bestaat valt eruit in plaats van er half in te komen', () => {
  // Een typefout in de sleutel mag niet stil een andere bron toewijzen.
  assert.deepEqual(leesBelrijEigenaren({ wanbetalers: MAXIM, mentorsignalen: DAVE }), {});
});

test('rommel in plaats van een object leest als een lege kaart', () => {
  for (const ruw of [null, undefined, 'maxim', 42, [MAXIM], true]) {
    assert.deepEqual(leesBelrijEigenaren(ruw), {});
  }
});

test('een bron zonder eigenaar geeft null, en dat is een geldig antwoord', () => {
  assert.equal(eigenaarVoorBron({}, 'wanbetaler'), null);
  assert.equal(eigenaarVoorBron({ wanbetaler: MAXIM }, 'mentorsignaal'), null);
  assert.equal(eigenaarVoorBron(null, 'wanbetaler'), null);
  assert.equal(eigenaarVoorBron({ wanbetaler: 'maxim' }, 'wanbetaler'), null);
  assert.equal(eigenaarVoorBron({ wanbetaler: MAXIM }, 'wanbetaler'), MAXIM);
});

test('een leesfout op de instellingen geeft een lege kaart, geen halve', async () => {
  // Fail-soft: dan komt de rij zonder eigenaar op de lijst — zichtbaar onder
  // "Iedereen". Niet aan de verkeerde persoon hangen.
  const kapot = { from: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'stuk' } }) }) };
  const inst = await haalInstellingen(kapot, {});
  assert.deepEqual(inst.belrij_eigenaar, {});
  assert.equal(inst.fout, 'stuk');
});

/* ── de instelling schrijven ──────────────────────────────────────────────── */

test('de sleutel mag bestaan', () => {
  assert.ok(TOEGESTANE_SLEUTELS.has('belrij_eigenaar'));
});

test('schrijven: een onbekende bron is een fout met uitleg, geen stille skip', () => {
  const uit = keurWaardeGoed('belrij_eigenaar', { wanbetalers: MAXIM });
  assert.equal(uit.ok, false);
  assert.match(uit.fout, /onbekende bron: wanbetalers/);
  assert.match(uit.fout, /wanbetaler/, 'de fout zegt niet welke bronnen wél mogen');
});

test('schrijven: iets dat geen uuid is wordt geweigerd', () => {
  const uit = keurWaardeGoed('belrij_eigenaar', { wanbetaler: 'Maxim' });
  assert.equal(uit.ok, false);
  assert.match(uit.fout, /profiel-uuid/);
});

test('schrijven: leeg of null betekent "niemand" en is geldig', () => {
  for (const leeg of [null, undefined, '']) {
    const uit = keurWaardeGoed('belrij_eigenaar', { wanbetaler: leeg });
    assert.equal(uit.ok, true);
    assert.deepEqual(uit.waarde, {});
  }
  assert.deepEqual(keurWaardeGoed('belrij_eigenaar', null).waarde, {});
  assert.deepEqual(keurWaardeGoed('belrij_eigenaar', {}).waarde, {});
});

test('schrijven: een lijst of tekst is geen kaart', () => {
  assert.equal(keurWaardeGoed('belrij_eigenaar', [MAXIM]).ok, false);
  assert.equal(keurWaardeGoed('belrij_eigenaar', 'maxim').ok, false);
});

test('schrijven: de uuid komt genormaliseerd terug', () => {
  const uit = keurWaardeGoed('belrij_eigenaar', { wanbetaler: `  ${MAXIM.toUpperCase()}  ` });
  assert.equal(uit.ok, true);
  assert.deepEqual(uit.waarde, { wanbetaler: MAXIM });
});

test('elke bron van de belrij is instelbaar', () => {
  const alles = Object.fromEntries(BELRIJ_BRONNEN.map((b) => [b, MAXIM]));
  const uit = keurWaardeGoed('belrij_eigenaar', alles);
  assert.equal(uit.ok, true);
  assert.deepEqual(Object.keys(uit.waarde).sort(), [...BELRIJ_BRONNEN].sort());
});

/* ── de regel in de vuller ────────────────────────────────────────────────── */

function nepDb(tabellen = {}) {
  const data = {};
  for (const [t, r] of Object.entries(tabellen)) data[t] = r.map((x) => ({ ...x }));
  let n = 0;
  const from = (tabel) => {
    data[tabel] = data[tabel] || [];
    const f = [];
    const pas = () => data[tabel].filter((r) => f.every((x) =>
      x.op === 'eq' ? r[x.k] === x.v
      : x.op === 'in' ? x.v.includes(r[x.k])
      : x.op === 'is' ? (r[x.k] ?? null) === x.v
      : true));
    const klaar = (rijen) => ({
      select: () => klaar(rijen),
      single: async () => ({ data: rijen[0] || null, error: null }),
      maybeSingle: async () => ({ data: rijen[0] || null, error: null }),
      eq: (k, v) => { f.push({ op: 'eq', k, v }); return klaar(rijen); },
      in: (k, v) => { f.push({ op: 'in', k, v }); return klaar(rijen); },
      then: (res) => Promise.resolve({ data: rijen, error: null }).then(res),
    });
    const k = {
      select: () => k,
      eq: (kol, v) => { f.push({ op: 'eq', k: kol, v }); return k; },
      in: (kol, v) => { f.push({ op: 'in', k: kol, v }); return k; },
      is: (kol, v) => { f.push({ op: 'is', k: kol, v }); return k; },
      not: () => k, filter: () => k, order: () => k, limit: () => k,
      maybeSingle: async () => ({ data: pas()[0] || null, error: null }),
      single: async () => ({ data: pas()[0] || null, error: null }),
      insert: (r) => { const nw = { id: `${tabel}-${++n}`, ...r }; data[tabel].push(nw); return klaar([nw]); },
      update: (v) => { const raak = pas(); for (const r of raak) Object.assign(r, v); return klaar(raak); },
      upsert: (rijen, { onConflict } = {}) => {
        const sl = String(onConflict || '').split(',').map((x) => x.trim()).filter(Boolean);
        const uit = [];
        for (const r of (Array.isArray(rijen) ? rijen : [rijen])) {
          const b = sl.length ? data[tabel].find((x) => sl.every((q) => x[q] === r[q])) : null;
          if (b) { Object.assign(b, r); uit.push(b); } else { const nw = { id: `${tabel}-${++n}`, ...r }; data[tabel].push(nw); uit.push(nw); }
        }
        return klaar(uit);
      },
      then: (res) => Promise.resolve({ data: pas(), error: null }).then(res),
    };
    return k;
  };
  return { from, _data: data };
}

const beltaak = (id, klant) => ({ id, customer_id: klant, payload: { kind: 'call', title: 'Bel klant' } });

test('een nieuwe rij krijgt de eigenaar van zijn zwaarste bron', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];
  await schrijfPersoon(db, rij, { eigenaren: { wanbetaler: MAXIM, mentorsignaal: DAVE } });
  assert.equal(db._data.iris_belrij[0].eigenaar, MAXIM);
});

test('zonder regel voor die bron blijft de eigenaar leeg, niet de eerste de beste', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const rij = voegSamen([uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' })])[0];
  await schrijfPersoon(db, rij, { eigenaren: { wanbetaler: MAXIM } });
  assert.equal(db._data.iris_belrij[0].eigenaar, null);
});

test('een eigenaar die er al staat blijft staan, ook als de regel iemand anders aanwijst', async () => {
  // Wie een rij heeft opgepakt, raakt hem niet kwijt doordat er een tweede
  // reden bij komt uit een bron met een andere eigenaar.
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 50, bron: 'mentorsignaal', eigenaar: DAVE }],
    iris_belrij_redenen: [],
  });
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];
  await schrijfPersoon(db, rij, { eigenaren: { wanbetaler: MAXIM } });
  assert.equal(db._data.iris_belrij[0].eigenaar, DAVE);
});

test('een bestaande rij ZONDER eigenaar krijgt hem wel', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 50, bron: 'wanbetaler', eigenaar: null }],
    iris_belrij_redenen: [],
  });
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];
  await schrijfPersoon(db, rij, { eigenaren: { wanbetaler: MAXIM } });
  assert.equal(db._data.iris_belrij[0].eigenaar, MAXIM);
});

/* ── het endpoint ─────────────────────────────────────────────────────────── */

test('de lijst geeft alle onverwerkte redenen terug, met hun bron-link', () => {
  assert.match(ENDPOINT, /from\('iris_belrij_redenen'\)/);
  assert.match(ENDPOINT, /\.is\('verwerkt_op', null\)/);
  assert.match(ENDPOINT, /redenen: \(redenen\.get\(r\.id\) \|\| \[\]\)/);
  assert.match(ENDPOINT, /link: d\.bron_link/);
});

test('zonder de migratie valt de lijst terug in plaats van een 500 te geven', () => {
  // De hele belrij onbruikbaar maken om een tabel die nog niet bestaat, is een
  // slechtere uitkomst dan één kaart met één reden.
  assert.match(ENDPOINT, /\[iris-belrij\] redenen lezen/);
  assert.match(ENDPOINT, /console\.warn[\s\S]{0,200}?return kaart;/);
});

test('de uuid van de eigenaar gaat niet meer als enige naar het scherm', () => {
  assert.match(ENDPOINT, /eigenaar_naam: r\.eigenaar \?/);
  assert.match(ENDPOINT, /from\('profiles'\)/);
});

test('de instellingen geven de medewerkers mee, zodat de UI namen kan tonen', () => {
  assert.match(INST_EP, /medewerkers,/);
  assert.match(INST_EP, /belrij_bronnen: BELRIJ_BRONNEN/);
  assert.match(INST_EP, /\.eq\('is_active', true\)/);
});

/* ── het scherm ───────────────────────────────────────────────────────────── */

test('het scherm toont ALLE redenen, niet alleen de bovenste', () => {
  assert.match(IRIS, /const lijst = Array\.isArray\(r\.redenen\) \? r\.redenen : \[\]/);
  assert.match(IRIS, /lijst\.map\(\(d\) =>/);
});

test('een rij zonder redenen valt terug op wat er altijd al stond', () => {
  // Rijen van vóór de migratie, en rijen die een mens zelf heeft gezet.
  assert.match(IRIS, /: `<div style="font-size:11\.5px;color:var\(--text-2\);margin-top:2px">\$\{esc\(r\.reden \|\| ''\)\}/);
});

test('de ruwe uuid staat niet meer in de rij', () => {
  const code = IRIS.split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');
  assert.ok(
    !/esc\(r\.eigenaar \|\| ''\)/.test(code),
    'de rij toont nog steeds de ruwe uuid van de eigenaar'
  );
  assert.match(code, /esc\(r\.eigenaar_naam\)/);
});

test('een rij zonder eigenaar zegt dat, in plaats van een lege kolom', () => {
  assert.match(IRIS, /niemand toegewezen/);
});

test('de eigenaarsregel is een keuzelijst met namen, geen invoerveld voor een uuid', () => {
  assert.match(IRIS, /function belrijEigenaarBlok\(inst\)/);
  assert.match(IRIS, /__irisBelrijEigenaarZet/);
  assert.match(IRIS, /— niemand —/);
  // Geen <input> voor de eigenaar: een uuid intypen gaat stil fout.
  const blok = IRIS.slice(IRIS.indexOf('function belrijEigenaarBlok'), IRIS.indexOf('window.__irisBelrijEigenaarZet'));
  assert.ok(!/<input/.test(blok), 'er staat een invoerveld in het eigenaarsblok');
  assert.match(blok, /<select/);
});

test('het blok staat in Instellingen', () => {
  assert.match(IRIS, /\$\{belrijEigenaarBlok\(inst\)\}/);
});

test('de hele kaart gaat als één waarde terug, zodat het endpoint hem keurt', () => {
  const fn = IRIS.slice(IRIS.indexOf('window.__irisBelrijEigenaarZet'), IRIS.indexOf('function systeemafzendersBlok'));
  assert.match(fn, /sleutel: 'belrij_eigenaar', waarde: nieuw/);
  assert.match(fn, /S\.belrij\.opgehaald = false/, 'de belrij wordt niet opnieuw opgehaald na een wijziging');
});

test('het scherm heeft een nieuw nummer', () => {
  const m = INDEX.match(/\.\.\/iris\/iris\.js\?v=(\d+)/);
  assert.ok(m, 'iris.js wordt zonder ?v= geladen');
  assert.ok(Number(m[1]) >= 25, `?v=${m[1]} is lager dan de 25 van deze PR`);
});
