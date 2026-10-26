// tests/lab-opvolging.test.js
//
// De warme opvolgmotor van elke trial-lead (api/_lib/lab-opvolging.js, 26 okt 2026).
// Wat hier vastligt, mag nooit stil veranderen:
//   - zonder toestemming niets; na een boeking, afmelding of als klant niets;
//   - nooit "je bent nog niet ingelogd" aan wie al inlogde;
//   - hoogstens één bericht per 20 uur, elke stap één keer;
//   - de tijdlijn: +24u/+48u niet ingelogd, dag 3 Lab, uitnodiging, dag 5,
//     laatste dag, verlopen, verlopen +3 (niets gedaan), verlopen +7;
//   - stille uren 21u–8u (Amsterdam).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { volgendeStap, isStilUur, standaardMail, linkDoel, kiesVariant, vulLabSjabloon, STAPPEN, WA_STAPPEN, belofteKort, dagenOver } from '../api/_lib/lab-opvolging.js';

const UUR = 3600 * 1000;
const DAG = 24 * UUR;
const T0 = Date.parse('2026-10-15T09:00:00Z');
const basis = (over = {}) => ({
  aangemeldOp: T0, toestemming: true, toegangTot: new Date(T0 + 7 * DAG).toISOString(),
  geboekt: false, ingelogd: false, gestart: false, afgerond: false, videos: 0, gehad: new Set(), laatsteBericht: null, ...over,
});

const met = (...stappen) => new Set(stappen);

test('niet ingelogd: +24u de eerste duw, +48u de tweede, eerder niets', () => {
  assert.equal(volgendeStap(basis(), T0 + 23 * UUR), null);
  assert.equal(volgendeStap(basis(), T0 + 25 * UUR), 'niet-ingelogd-24u');
  assert.equal(volgendeStap(basis({ gehad: met('niet-ingelogd-24u') }), T0 + 40 * UUR), null);
  assert.equal(volgendeStap(basis({ gehad: met('niet-ingelogd-24u') }), T0 + 49 * UUR), 'niet-ingelogd-48u');
  assert.equal(volgendeStap(basis(), T0 + 49 * UUR), 'niet-ingelogd-48u', 'de 24u gemist → meteen de 48u, niet beide');
  assert.equal(volgendeStap(basis({ gehad: met('niet-ingelogd-24u', 'niet-ingelogd-48u') }), T0 + 3 * DAG + UUR), null);
});

test('wie inlogde krijgt NOOIT een niet-ingelogd-bericht', () => {
  const s = basis({ ingelogd: true });
  for (let u = 1; u < 7 * 24; u += 3) assert.ok(!String(volgendeStap(s, T0 + u * UUR)).startsWith('niet-ingelogd'));
});

test('dag 3: ingelogd maar The Lab niet gestart → nu de praktijk; gestart → niet', () => {
  assert.equal(volgendeStap(basis({ ingelogd: true }), T0 + 2 * DAG + 23 * UUR), null);
  assert.equal(volgendeStap(basis({ ingelogd: true }), T0 + 3 * DAG + UUR), 'dag3-lab');
  assert.equal(volgendeStap(basis({ ingelogd: true, gestart: true }), T0 + 3 * DAG + UUR), null);
});

test('warm: Lab afgewerkt of ≥ 2 video\'s → uitnodiging strategiesessie (één keer)', () => {
  assert.equal(volgendeStap(basis({ ingelogd: true, videos: 1 }), T0 + 2 * UUR), null);
  assert.equal(volgendeStap(basis({ ingelogd: true, videos: 2 }), T0 + 2 * UUR), 'uitnodiging-sessie');
  assert.equal(volgendeStap(basis({ ingelogd: true, gestart: true, afgerond: true }), T0 + 2 * UUR), 'uitnodiging-sessie');
  assert.equal(volgendeStap(basis({ ingelogd: true, videos: 3, gehad: met('uitnodiging-sessie') }), T0 + 2 * DAG), null);
});

test('einde: dag 5 (2 dagen voor), laatste dag, verlopen', () => {
  const s = basis({ ingelogd: true, gehad: met('dag3-lab') });
  assert.equal(volgendeStap(s, T0 + 5 * DAG + UUR), 'dag5');
  assert.equal(volgendeStap({ ...s, gehad: met('dag3-lab', 'dag5') }, T0 + 6 * DAG + UUR), 'laatste-dag');
  assert.equal(volgendeStap({ ...s, gehad: met('dag3-lab') }, T0 + 6 * DAG + UUR), 'laatste-dag', 'laatste dag wint van een gemiste dag 5');
  assert.equal(volgendeStap({ ...s, gehad: met('dag3-lab', 'dag5', 'laatste-dag') }, T0 + 7 * DAG + UUR), 'verlopen');
});

test('na het einde: +3 alleen als er niets mee gedaan is, +7 als laatste bericht, daarna niets', () => {
  const g = met('verlopen');
  assert.equal(volgendeStap(basis({ gehad: g }), T0 + 10 * DAG + UUR), 'verlopen-3', 'nooit ingelogd = niets gedaan');
  assert.equal(volgendeStap(basis({ ingelogd: true, gehad: g }), T0 + 10 * DAG + UUR), 'verlopen-3', 'ingelogd, maar geen video en geen Lab');
  assert.equal(volgendeStap(basis({ ingelogd: true, videos: 1, gehad: g }), T0 + 10 * DAG + UUR), null, 'wel iets gedaan → geen consistentie-preek');
  assert.equal(volgendeStap(basis({ gehad: met('verlopen', 'verlopen-3') }), T0 + 14 * DAG + UUR), 'verlopen-7');
  assert.equal(volgendeStap(basis({ gehad: met('verlopen', 'verlopen-3', 'verlopen-7') }), T0 + 20 * DAG), null);
});

test('stop: boeking, afmelding, klant of geen toestemming = nooit iets', () => {
  for (const over of [{ geboekt: true }, { afgemeld: true }, { klant: true }, { toestemming: false }]) {
    for (let u = 0; u < 16 * 24; u += 5) assert.equal(volgendeStap(basis(over), T0 + u * UUR), null, JSON.stringify(over));
  }
});

test('hoogstens één bericht per 20 uur', () => {
  const s = basis({ laatsteBericht: T0 + 20 * UUR });
  assert.equal(volgendeStap(s, T0 + 25 * UUR), null);
  assert.equal(volgendeStap(s, T0 + 41 * UUR), 'niet-ingelogd-24u');
});

test('stille uren 21u–8u Amsterdam', () => {
  assert.equal(isStilUur(Date.parse('2026-10-15T19:30:00Z')), true);  // 21:30 CEST
  assert.equal(isStilUur(Date.parse('2026-10-15T05:30:00Z')), true);  // 07:30
  assert.equal(isStilUur(Date.parse('2026-10-15T10:00:00Z')), false); // 12:00
});

test('elke stap heeft een tekst met één knop, en de juiste bestemming; nooit het oude platform', () => {
  const knop = (href, t) => `[${t}](${href})`;
  for (const s of STAPPEN) {
    for (const product of ['minicursus', '7-daagse', 'webinar', 'website', 'the-lab']) {
      const m = standaardMail(s, { voornaam: 'Lien', link: 'L', knop, product, eersteVideoMin: 6 });
      assert.ok(m.onderwerp && m.html.includes('Lien') && (m.html.match(/\]\(L\)/g) || []).length === 1, `${s}/${product}`);
      assert.doesNotMatch(m.html, /deforexopleiding\.nl\/lms/);
    }
  }
  assert.equal(linkDoel('niet-ingelogd-24u'), 'start');
  assert.equal(linkDoel('niet-ingelogd-48u'), 'start');
  assert.equal(linkDoel('dag3-lab'), 'lab');
  for (const s of ['uitnodiging-sessie', 'dag5', 'laatste-dag', 'verlopen', 'verlopen-3', 'verlopen-7']) assert.equal(linkDoel(s), 'sessie');
  const k = (u, t) => `<a href="${u}">${t}</a>`;
  assert.match(standaardMail('niet-ingelogd-24u', { voornaam: 'x', link: 'L', knop: k, eersteVideoMin: 6, product: 'minicursus' }).html, /je minicursus.*6 minuten/s);
  assert.match(standaardMail('niet-ingelogd-24u', { voornaam: 'x', link: 'L', knop: k }).html, /maar een paar minuten/);
  assert.match(standaardMail('niet-ingelogd-48u', { voornaam: 'x', link: 'L', knop: k }).html, /7 dagen/);
  assert.match(standaardMail('uitnodiging-sessie', { voornaam: 'x', link: 'L', knop: k }).html, /€100.*gratis.*1-op-1/s);
  assert.match(standaardMail('verlopen-3', { voornaam: 'x', link: 'L', knop: k }).html, /business.*consistentie.*1-op-1/s);
  assert.equal(belofteKort('7-daagse'), 'je 7 dagen meekijken');
  assert.equal(belofteKort('eerste-trade'), 'je leeromgeving');
});

test('WhatsApp alleen op de bedoelde stappen', () => {
  assert.deepEqual([...WA_STAPPEN].sort(), ['laatste-dag', 'niet-ingelogd-48u', 'uitnodiging-sessie', 'verlopen']);
});

test('sjablonen: variant per warmte en invulling', () => {
  const rijen = [{ id: 'koud', score_min: null, score_max: 15 }, { id: 'warm', score_min: 15, score_max: null }];
  assert.equal(kiesVariant(rijen, 30).id, 'warm');
  assert.equal(kiesVariant(rijen, 3).id, 'koud');
  assert.equal(vulLabSjabloon('Hey {voornaam}, {belofte} — nog {dagen_over} dagen: {loginlink} ({onbekend})', { voornaam: 'Lien', belofte: 'je minicursus', dagen_over: '3', loginlink: 'L' }), 'Hey Lien, je minicursus — nog 3 dagen: L ({onbekend})');
  assert.equal(dagenOver(new Date(T0 + 2.5 * DAG).toISOString(), T0), '3');
  assert.equal(dagenOver(new Date(T0 - DAG).toISOString(), T0), '0');
});

test('bedrading: cron elk kwartier, live-schakelaar standaard uit, noodstop', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron-lab-opvolging' && c.schedule === '*/15 * * * *'));
  const src = readFileSync(new URL('../api/cron-lab-opvolging.js', import.meta.url), 'utf8');
  assert.match(src, /'lab_opvolging_live'/);
  assert.match(src, /LEADSONDERHOUD_UIT/);
  assert.match(src, /if \(!verslag\.live\) \{ verslag\.droog\.push/);
});
