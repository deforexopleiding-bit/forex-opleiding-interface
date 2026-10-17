// tests/lab-opvolging.test.js
//
// Traject "the-lab": de beslisregels van de opvolging (api/_lib/lab-opvolging.js).
// Wat hier vastligt, mag nooit stil veranderen:
//   - zonder toestemming niets, na een boeking niets;
//   - nooit "je bent nog niet gestart" aan wie gestart of klaar is;
//   - hoogstens één bericht per 20 uur, elke stap één keer;
//   - dag 6 en dag 8 rond het einde van de toegang;
//   - stille uren 21u–8u (Amsterdam).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { volgendeStap, isStilUur, standaardMail, linkDoel, kiesVariant, vulLabSjabloon, STAPPEN } from '../api/_lib/lab-opvolging.js';

const UUR = 3600 * 1000;
const DAG = 24 * UUR;
const T0 = Date.parse('2026-10-15T09:00:00Z');
const basis = (over = {}) => ({
  aangemeldOp: T0, toestemming: true, toegangTot: new Date(T0 + 7 * DAG).toISOString(),
  geboekt: false, gestart: false, afgerond: false, laatsteActiviteit: null, gehad: new Set(), laatsteBericht: null, ...over,
});

test('niet gestart na 24u → de nudge, eerder niets', () => {
  assert.equal(volgendeStap(basis(), T0 + 23 * UUR), null);
  assert.equal(volgendeStap(basis(), T0 + 25 * UUR), 'niet-gestart-24u');
});

test('wie gestart is krijgt NOOIT de niet-gestart-nudge', () => {
  const s = basis({ gestart: true, laatsteActiviteit: T0 + 2 * UUR });
  assert.equal(volgendeStap(s, T0 + 25 * UUR), null, 'nog geen 24u stil');
  assert.equal(volgendeStap(s, T0 + 27 * UUR), 'bezig-24u');
  const klaar = basis({ gestart: true, afgerond: true, laatsteActiviteit: T0 + UUR });
  for (let u = 1; u < 6 * 24; u += 5) assert.notEqual(volgendeStap(klaar, T0 + u * UUR), 'niet-gestart-24u');
});

test('afgewerkt, niet geboekt: dag +1 en daarna dag +3', () => {
  const s = basis({ gestart: true, afgerond: true, laatsteActiviteit: T0 });
  assert.equal(volgendeStap(s, T0 + 25 * UUR), 'afgewerkt-d1');
  assert.equal(volgendeStap({ ...s, gehad: new Set(['afgewerkt-d1']) }, T0 + 2 * DAG), null);
  assert.equal(volgendeStap({ ...s, gehad: new Set(['afgewerkt-d1']) }, T0 + 3 * DAG + UUR), 'afgewerkt-d3');
});

test('na een boeking: nooit meer iets', () => {
  const s = basis({ geboekt: true });
  for (let u = 0; u < 10 * 24; u += 3) assert.equal(volgendeStap(s, T0 + u * UUR), null);
});

test('zonder toestemming: nooit iets', () => {
  assert.equal(volgendeStap(basis({ toestemming: false }), T0 + 2 * DAG), null);
});

test('dag 6 (morgen dicht) en dag 8 (laatste bericht)', () => {
  const s = basis({ gehad: new Set(['niet-gestart-24u']) });
  assert.equal(volgendeStap(s, T0 + 6 * DAG + UUR), 'dag6');
  assert.equal(volgendeStap({ ...s, gehad: new Set(['niet-gestart-24u', 'dag6']) }, T0 + 7 * DAG + UUR), null, 'net verlopen: nog geen dag 8');
  assert.equal(volgendeStap({ ...s, gehad: new Set(['niet-gestart-24u', 'dag6']) }, T0 + 8 * DAG + UUR), 'dag8');
  assert.equal(volgendeStap({ ...s, gehad: new Set(['niet-gestart-24u', 'dag6', 'dag8']) }, T0 + 9 * DAG), null);
});

test('hoogstens één bericht per 20 uur', () => {
  const s = basis({ laatsteBericht: T0 + 20 * UUR });
  assert.equal(volgendeStap(s, T0 + 25 * UUR), null);
  assert.equal(volgendeStap(s, T0 + 41 * UUR), 'niet-gestart-24u');
});

test('stille uren 21u–8u Amsterdam', () => {
  assert.equal(isStilUur(Date.parse('2026-10-15T19:30:00Z')), true);  // 21:30 CEST
  assert.equal(isStilUur(Date.parse('2026-10-15T05:30:00Z')), true);  // 07:30
  assert.equal(isStilUur(Date.parse('2026-10-15T10:00:00Z')), false); // 12:00
});

test('elke stap heeft een tekst met één knop, en de juiste bestemming', () => {
  const knop = (href, t) => `[${t}](${href})`;
  for (const s of STAPPEN) {
    const m = standaardMail(s, { voornaam: 'Lien', link: 'L', stap: 5, stappen: 25, knop });
    assert.ok(m.onderwerp && m.html.includes('Lien') && (m.html.match(/\]\(L\)/g) || []).length === 1, s);
  }
  // Jouw route (okt 2026): niet gestart → het actieplan, niet rechtstreeks The Lab.
  assert.equal(linkDoel('niet-gestart-24u'), 'start');
  assert.equal(linkDoel('bezig-24u'), 'lab');
  assert.equal(linkDoel('afgewerkt-d1'), 'sessie');
  assert.equal(linkDoel('dag8'), 'sessie');
  assert.match(standaardMail('afgewerkt-d1', { voornaam: 'x', link: 'L', knop }).html, /78,7%.*48,5%/s);
});

test('sjablonen: variant per warmte en invulling', () => {
  const rijen = [{ id: 'koud', score_min: null, score_max: 15 }, { id: 'warm', score_min: 15, score_max: null }];
  assert.equal(kiesVariant(rijen, 30).id, 'warm');
  assert.equal(kiesVariant(rijen, 3).id, 'koud');
  assert.equal(vulLabSjabloon('Hey {voornaam}, stap {stap}/{stappen}: {loginlink}', { voornaam: 'Lien', stap: 4, stappen: 25, loginlink: 'L' }), 'Hey Lien, stap 4/25: L');
});

test('bedrading: cron elk kwartier, live-schakelaar standaard uit, noodstop', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron-lab-opvolging' && c.schedule === '*/15 * * * *'));
  const src = readFileSync(new URL('../api/cron-lab-opvolging.js', import.meta.url), 'utf8');
  assert.match(src, /'lab_opvolging_live'/);
  assert.match(src, /LEADSONDERHOUD_UIT/);
  assert.match(src, /if \(!verslag\.live\) \{ verslag\.droog\.push/);
});

test('JOUW ROUTE: video gezien → na een dag "video-geen-lab"; nooit na boeking; link naar het actieplan', () => {
  const s = basis({ videoBekeken: true, videoOp: T0 + 2 * UUR });
  assert.equal(volgendeStap(s, T0 + 25 * UUR), null, 'nog geen dag na de video');
  assert.equal(volgendeStap(s, T0 + 27 * UUR), 'video-geen-lab');
  assert.equal(volgendeStap({ ...s, gehad: new Set(['video-geen-lab']) }, T0 + 30 * UUR), null);
  assert.equal(volgendeStap({ ...s, geboekt: true }, T0 + 27 * UUR), null);
  assert.equal(volgendeStap({ ...s, gestart: true, laatsteActiviteit: T0 + 3 * UUR }, T0 + 28 * UUR), 'bezig-24u');
  assert.equal(linkDoel('niet-gestart-24u'), 'start');
  assert.equal(linkDoel('video-geen-lab'), 'start');
  assert.equal(linkDoel('bezig-24u'), 'lab');
  assert.equal(linkDoel('afgewerkt-d1'), 'sessie');
  const m = standaardMail('video-geen-lab', { voornaam: 'Lien', link: 'https://x', knop: (u, t) => `<a href="${u}">${t}</a>` });
  assert.match(m.html, /startvideo/);
  assert.match(m.html, /30 minuten met Dave/);
  assert.ok(STAPPEN.includes('video-geen-lab'));
});
