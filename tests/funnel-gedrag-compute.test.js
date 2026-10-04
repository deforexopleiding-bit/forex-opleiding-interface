// tests/funnel-gedrag-compute.test.js
//
// GEDRAGSSIGNALEN (Leadsonderhoud → Funnels → Afhaken per vraag → Waarom
// afhaken). Pure aggregatie in api/_lib/funnel-gedrag-compute.js: tijd per
// vraag (stap_verlaten, terugval getoond → beantwoord), scrollverdeling, top
// validatiefouten, laatste veld vóór afhaken, afhaakfase en rage-hotspots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bouwGedrag, voegTijdToe, mediaan, GEDRAG_EVENT_TYPES, GEDRAG_LEES_TYPES, MAX_DUUR_MS,
} from '../api/_lib/funnel-gedrag-compute.js';

const T0 = Date.parse('2026-10-04T10:00:00Z');
const ts = (s) => new Date(T0 + s * 1000).toISOString();
const e = (sid, type, extra = {}) => ({ session_id: sid, event_type: type, stap_nr: null, quiz_versie: 'q1', ts: ts(0), ...extra });
const g = (sid, type, meta, extra = {}) => ({ ...e(sid, type, extra), meta });
const getoond = (sid, n, sec = 0) => e(sid, 'vraag_getoond', { stap_nr: n, ts: ts(sec) });

test('contract: zes gedragstypes + vraag_beantwoord/overgeslagen worden gelezen', () => {
  assert.deepEqual([...GEDRAG_EVENT_TYPES],
    ['stap_verlaten', 'scroll_diepte', 'veld_laatst', 'validatie_fout', 'rage_click', 'afhaakpunt']);
  assert.ok(GEDRAG_LEES_TYPES.includes('vraag_beantwoord') && GEDRAG_LEES_TYPES.includes('overgeslagen'));
});

test('mediaan: even/oneven, leeg = null', () => {
  assert.equal(mediaan([3, 1, 2]), 2);
  assert.equal(mediaan([4, 1, 2, 3]), 2.5);
  assert.equal(mediaan([]), null);
});

test('tijd per vraag: stap_verlaten opgeteld per sessie (tab-wissel = twee stukken)', () => {
  const r = bouwGedrag({
    events: [getoond('a', 1), getoond('b', 1), getoond('b', 2)],
    gedragEvents: [
      g('a', 'stap_verlaten', { duur_ms: 4000, einde: 'weg', stap: 'vraag' }, { stap_nr: 1 }),
      g('a', 'stap_verlaten', { duur_ms: 6000, einde: 'dicht', stap: 'vraag' }, { stap_nr: 1 }),
      g('b', 'stap_verlaten', { duur_ms: 2000, einde: 'beantwoord', stap: 'vraag' }, { stap_nr: 1 }),
    ],
  });
  const v1 = r.tijd_per_vraag.find((t) => t.stap_nr === 1);
  assert.equal(v1.tijd_n, 2);
  assert.equal(v1.gem_tijd_s, 6);           // (10 + 2) / 2
  assert.equal(v1.mediaan_tijd_s, 6);
  // Afhaker = a (zag vraag 2 niet, geen lead) → 10 s.
  assert.equal(v1.afhakers_n, 1);
  assert.equal(v1.afhakers_mediaan_s, 10);
  assert.equal(v1.bron, 'stap_verlaten');
});

test('tijd per vraag: terugval op vraag_getoond → vraag_beantwoord (oudere data), versies apart', () => {
  const r = bouwGedrag({
    events: [getoond('a', 1, 0), e('x', 'vraag_getoond', { stap_nr: 1, quiz_versie: 'q2', ts: ts(0) })],
    gedragEvents: [
      e('a', 'vraag_beantwoord', { stap_nr: 1, ts: ts(12) }),
      e('x', 'vraag_beantwoord', { stap_nr: 1, quiz_versie: 'q2', ts: ts(3) }),
    ],
  });
  const q1 = r.tijd_per_vraag.find((t) => t.quiz_versie === 'q1');
  const q2 = r.tijd_per_vraag.find((t) => t.quiz_versie === 'q2');
  assert.equal(q1.gem_tijd_s, 12);
  assert.equal(q2.gem_tijd_s, 3);
  assert.equal(q1.bron, 'getoond_beantwoord');
  // Beantwoord vóór getoond of langer dan 30 min telt niet.
  const raar = bouwGedrag({
    events: [getoond('a', 1, 100), getoond('b', 1, 0)],
    gedragEvents: [e('a', 'vraag_beantwoord', { stap_nr: 1, ts: ts(50) }), e('b', 'vraag_beantwoord', { stap_nr: 1, ts: ts(MAX_DUUR_MS / 1000 + 1) })],
  });
  assert.equal(raar.tijd_per_vraag[0].tijd_n, 0);
  assert.equal(raar.tijd_per_vraag[0].gem_tijd_s, null);
});

test('voegTijdToe: tijd landt op de juiste afhaken-rij (versie + stap)', () => {
  const afhaken = [{ quiz_versie: 'q1', vragen: [{ stap_nr: 1 }, { stap_nr: 2 }] }];
  voegTijdToe(afhaken, [{ quiz_versie: 'q1', stap_nr: 2, gem_tijd_s: 7, mediaan_tijd_s: 6, tijd_n: 3, afhakers_mediaan_s: 9 }]);
  assert.equal(afhaken[0].vragen[0].gem_tijd_s, null);
  assert.equal(afhaken[0].vragen[0].tijd_n, 0);
  assert.equal(afhaken[0].vragen[1].gem_tijd_s, 7);
  assert.equal(afhaken[0].vragen[1].afhakers_mediaan_s, 9);
});

test('scroll: max per sessie, verdeling in vijf emmers, mediaan apart voor wie geen lead werd', () => {
  const r = bouwGedrag({
    events: [e('c', 'lead_ingediend')],
    gedragEvents: [
      g('a', 'scroll_diepte', { pct: 20 }), g('a', 'scroll_diepte', { pct: 60 }),   // → 60
      g('b', 'scroll_diepte', { pct: 100 }),
      g('c', 'scroll_diepte', { pct: 30 }),
    ],
  });
  assert.equal(r.scroll.sessies, 3);
  assert.deepEqual(r.scroll.buckets.map((b) => b.sessies), [0, 1, 1, 0, 1]);
  assert.equal(r.scroll.mediaan_pct, 60);
  assert.equal(r.scroll.mediaan_pct_zonder_lead, 80);   // a=60, b=100
});

test('validatie: top per veld+type op sessies, onbekend type valt weg, waarde-achtige naam → overig', () => {
  const r = bouwGedrag({
    gedragEvents: [
      g('a', 'validatie_fout', { veld: 'telefoon', type: 'geen_landcode' }),
      g('b', 'validatie_fout', { veld: 'telefoon', type: 'geen_landcode' }),
      g('b', 'validatie_fout', { veld: 'email', type: 'ongeldig' }),
      g('c', 'validatie_fout', { veld: 'jan@x.nl', type: 'ongeldig' }),
      g('c', 'validatie_fout', { veld: 'email', type: 'onzin' }),
    ],
  });
  assert.deepEqual(r.validatie_top, [
    { veld: 'telefoon', type: 'geen_landcode', sessies: 2, keer: 2 },
    { veld: 'email', type: 'ongeldig', sessies: 1, keer: 1 },
    { veld: 'overig', type: 'ongeldig', sessies: 1, keer: 1 },
  ]);
  assert.ok(!JSON.stringify(r).includes('jan@x.nl'));
});

test('laatste veld + afhaakfase: alleen wie niet alsnog doorging; laatste moment telt', () => {
  const r = bouwGedrag({
    events: [e('lead', 'lead_ingediend'), e('boek', 'lead_ingediend'), e('boek', 'geboekt')],
    gedragEvents: [
      g('a', 'veld_laatst', { veld: 'email' }, { ts: ts(1) }),
      g('a', 'afhaakpunt', { fase: 'formulier', veld: 'telefoon' }, { ts: ts(2) }),   // laatste → telefoon
      g('b', 'afhaakpunt', { fase: 'quiz' }, { stap_nr: 3, ts: ts(5) }),
      g('lead', 'afhaakpunt', { fase: 'quiz', veld: 'email' }, { stap_nr: 2 }),       // kwam terug → telt niet
      g('lead', 'afhaakpunt', { fase: 'toelating' }, { ts: ts(9) }),                  // boekstap zonder boeking → telt
      g('boek', 'afhaakpunt', { fase: 'toelating' }, { ts: ts(9) }),                  // wel geboekt → telt niet
    ],
  });
  assert.deepEqual(r.laatste_veld, [{ veld: 'telefoon', sessies: 1, pct: 100 }]);
  assert.equal(r.afhakers, 3);
  assert.deepEqual(r.afhaak_fases.map((f) => [f.fase, f.sessies]), [['formulier', 1], ['quiz', 1], ['toelating', 1]]);
  assert.deepEqual(r.afhaak_quiz_stappen, [{ stap_nr: 3, sessies: 1 }]);
});

test('rage: hotspots per doel (sessies, klikken), ongeldig doel valt weg', () => {
  const r = bouwGedrag({
    gedragEvents: [
      g('a', 'rage_click', { doel: 'button#volgende', aantal: 4 }),
      g('b', 'rage_click', { doel: 'button#volgende', aantal: 6 }),
      g('b', 'rage_click', { doel: 'span.opt', aantal: 3 }),
      g('c', 'rage_click', { doel: 'Klik hier!', aantal: 9 }),
    ],
  });
  assert.deepEqual(r.rage_hotspots, [
    { doel: 'button#volgende', sessies: 2, klikken: 10 },
    { doel: 'span.opt', sessies: 1, klikken: 3 },
  ]);
});

test('formulier-tijd: per sessie opgeteld; afhakers = zonder verstuurd', () => {
  const r = bouwGedrag({
    gedragEvents: [
      g('a', 'stap_verlaten', { duur_ms: 30000, einde: 'verstuurd', stap: 'formulier' }),
      g('b', 'stap_verlaten', { duur_ms: 5000, einde: 'weg', stap: 'formulier' }),
      g('b', 'stap_verlaten', { duur_ms: 3000, einde: 'dicht', stap: 'formulier' }),
    ],
  });
  assert.equal(r.formulier_tijd.sessies, 2);
  assert.equal(r.formulier_tijd.verstuurd, 1);
  assert.equal(r.formulier_tijd.afgehaakt_mediaan_s, 8);
  assert.equal(r.formulier_tijd.gem_s, 19);
  assert.equal(r.tijd_per_vraag.length, 0);   // formulier ≠ quizvraag
});

test('leeg of kapot: beschikbaar false, nooit NaN', () => {
  const r = bouwGedrag({ gedragEvents: [null, { session_id: 'x', event_type: 'scroll_diepte', meta: 'kapot' }, e('y', 'vraag_beantwoord', { stap_nr: 1 })] });
  assert.equal(r.beschikbaar, true);   // er WAS een gedragsevent (kapot), maar het telt nergens mee
  assert.equal(r.scroll.sessies, 0);
  assert.ok(!JSON.stringify(r).includes('NaN'));
  assert.equal(bouwGedrag().beschikbaar, false);
});
