// tests/wa-templates-scan-v2.test.js
//
// NIEUWE WhatsApp-templates (2026-11-02, Maxim):
//   - afspraak_scan_*_v1: de vijf afspraakmomenten met "strategie-scan" voor
//     bron webinar/strategiescan — zelfde variabelen als de v1 die ze vervangen;
//   - webinar_opvolging_1_v2 / _2_v2: zonder "90 dagen", "maar een paar
//     plekken", "bijna vol", "laatste kans";
//   - de oude templates blijven ongewijzigd (terugval, nooit overschreven);
//   - de code stuurt de nieuwe pas als 360dialog ze APPROVED meldt;
//   - het indienscript kent ze (vaste lijst + code-definitie), juiste categorie.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: {} } });
const S = await import(url('api/_lib/afspraak-scan-templates.js'));
const T = await import(url('api/_lib/webinar-templates.js'));
const B = await import(url('api/_lib/afspraak-berichten.js'));
const U = await import(url('scripts/360-templates-upload.mjs'));

const varsIn = (body) => [...new Set([...String(body).matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
const VERBODEN = /kennismaking|90 dagen|90-dagen|winst|paar (scan-)?plekken|plekken|bijna vol|laatste kans|dave|heylen|tradet je/i;

test('SCAN-TEMPLATES: één per moment, nieuwe naam, zelfde variabelen + knoppen als de v1, "strategie-scan", geen claims', () => {
  const v1 = Object.fromEntries(B.MOMENTEN.map((m) => [m.waTemplate, m]));
  assert.deepEqual(Object.keys(S.SCAN_WA_VOOR).sort(), Object.keys(v1).sort(), 'elk moment heeft een scan-versie');
  for (const t of Object.values(S.SCAN_WA_TEMPLATES)) {
    assert.match(t.name, /^afspraak_scan_/, 'nieuwe naam, de v1 wordt niet overschreven');
    assert.notEqual(t.name, t.vervangt);
    assert.match(t.body_text, /strategie-scan/);
    assert.doesNotMatch(t.body_text, VERBODEN, t.name);
    assert.doesNotMatch(t.body_text, /\{\{\d+\}\}\s*$/, 'Meta weigert een body die op een variabele eindigt');
    // Zelfde variabelen als de v1: de cron geeft dezelfde waVars mee.
    const m = v1[t.vervangt];
    const n = m.waVars({ lead_name: 'A', scheduled_at: '2026-11-04T18:00:00Z' }, { voornaam: 'A', momentNL: 'x', tijdNL: 'y', zoom: 'z', selfUrl: 's' }).length;
    assert.deepEqual(varsIn(t.body_text), Array.from({ length: n }, (_, i) => i + 1), t.name);
    assert.equal(Object.keys(t.body_examples).length, n);
  }
  assert.equal(S.SCAN_WA_TEMPLATES.afspraak_scan_reminder_2u_v1.buttons[0].text, 'Ik ben erbij', 'quick-reply zoals de v1 (zet bevestigd_at)');
  assert.equal(S.SCAN_WA_TEMPLATES.afspraak_scan_reminder_30m_v1.buttons[0].text, 'Ik ben erbij');
  assert.match(S.SCAN_WA_TEMPLATES.afspraak_scan_bevestiging_v1.body_text, /20 minuten via Zoom met ons team/);
  assert.match(S.SCAN_WA_TEMPLATES.afspraak_scan_bevestiging_v1.body_text, /persoonlijk actieplan/);
  assert.match(S.SCAN_WA_TEMPLATES.afspraak_scan_bevestiging_v1.body_text, /Trade je al\?.*Trade je nog niet\?/s);
});

test('KEUZE: scan + APPROVED → nieuwe; anders (of bij twijfel) de huidige v1', async () => {
  const st = (s) => async () => s;
  assert.equal(await S.kiesWaTemplate({ v1: 'afspraak_bevestiging_v1', isScan: true, statusVan: st('APPROVED') }), 'afspraak_scan_bevestiging_v1');
  for (const s of ['PENDING', 'REJECTED', 'ONTBREEKT', 'ONBEKEND', null]) {
    assert.equal(await S.kiesWaTemplate({ v1: 'afspraak_bevestiging_v1', isScan: true, statusVan: st(s) }), 'afspraak_bevestiging_v1', String(s));
  }
  assert.equal(await S.kiesWaTemplate({ v1: 'afspraak_bevestiging_v1', isScan: true, statusVan: async () => { throw new Error('netwerk'); } }), 'afspraak_bevestiging_v1');
  let gevraagd = 0;
  assert.equal(await S.kiesWaTemplate({ v1: 'afspraak_bevestiging_v1', isScan: false, statusVan: async () => { gevraagd++; return 'APPROVED'; } }), 'afspraak_bevestiging_v1', 'andere bronnen: altijd v1');
  assert.equal(gevraagd, 0);
  assert.equal(await S.kiesWaTemplate({ v1: 'onbekend', isScan: true, statusVan: st('APPROVED') }), 'onbekend');
});

test('CRON: beide WhatsApp-paden (bevestiging + herinneringen) kiezen via waTemplateVoor; v1-momenten ongewijzigd', () => {
  const src = lees('api/cron-afspraak-reminders.js');
  assert.equal((src.match(/const tpl = await waTemplateVoor\(appt, moment, welkomPhoneId\);/g) || []).length, 2);
  assert.match(src, /isScan: isScanAfspraak\(appt\)/);
  assert.match(src, /statusVan: \(naam\) => templateStatusOpLijn\(phoneId, naam\)/);
  assert.deepEqual(B.MOMENTEN.map((m) => m.waTemplate), ['afspraak_bevestiging_v1', 'afspraak_reminder_24u_v1', 'afspraak_reminder_2u_v1', 'afspraak_reminder_30m_v1', 'afspraak_zoom_5min_v1']);
});

test('OPVOLGING V2: nieuwe namen, zelfde knop + variabele, zonder claims; de goedgekeurde _1/_2 ongewijzigd', () => {
  for (const [oud, nieuw] of Object.entries(T.OPVOLG_V2_VOOR)) {
    const t = T.OPVOLG_TEMPLATES_V2[nieuw];
    assert.ok(t && T.OPVOLG_TEMPLATES[oud]);
    assert.equal(t.category, 'MARKETING');
    assert.deepEqual(t.buttons, T.OPVOLG_TEMPLATES[oud].buttons);
    assert.deepEqual(t.vars, ['voornaam']);
    assert.doesNotMatch(t.body_text, VERBODEN, nieuw);
    assert.match(t.body_text, /gratis strategie-scan/);
    assert.match(t.body_text, /20 minuten via Zoom met ons team/);
    assert.match(t.body_text, /persoonlijk actieplan/);
    assert.equal(T.renderTemplateTekst(nieuw, { voornaam: 'Jeffrey' }).startsWith('Hoi Jeffrey'), true);
  }
  // De oude teksten blijven exact (Meta): niets overschreven.
  assert.match(T.OPVOLG_TEMPLATES.webinar_opvolging_1.body_text, /binnen 90 dagen/);
  assert.match(T.OPVOLG_TEMPLATES.webinar_opvolging_2.body_text, /bijna vol/);
  // De opvolging geeft de v2 mee als nieuwere naam; verstuurWa stuurt die enkel bij APPROVED.
  assert.match(lees('api/_lib/webinar-opvolging.js'), /nieuwereNaam: OPVOLG_V2_VOOR\[opv\.template\] \|\| null/);
  const w = lees('api/_lib/webinar.js');
  assert.match(w, /if \(String\(st \|\| ''\)\.toUpperCase\(\) === 'APPROVED'\) templateNaam = nieuwereNaam;/);
});

test('INDIENSCRIPT: kent de nieuwe templates (vaste lijst + code), categorie UTILITY resp. MARKETING, geldige payload', () => {
  const alle = Object.values(U.VASTE_TEMPLATES).flat();
  for (const n of [...S.SCAN_WA_NAMEN, ...Object.keys(T.OPVOLG_TEMPLATES_V2)]) {
    assert.ok(alle.includes(n), n + ' in de vaste lijst');
    const { varianten, uitCode } = U.variantenVoor(n, []);
    assert.equal(uitCode, true);
    const rij = varianten[0];
    const cat = U.kiesCategorie({ naam: n, bronnen: ['vast:x', 'code'], body: rij.body_text, dbCategorie: rij.category });
    assert.equal(cat.categorie, n.startsWith('afspraak_') ? 'UTILITY' : 'MARKETING', n + ': ' + cat.reden);
    const p = U.bouwPayload(rij, cat.categorie);
    assert.equal(p.payload.name, n);
    assert.equal(p.payload.language, 'nl');
    const body = p.payload.components.find((c) => c.type === 'BODY');
    assert.ok(body && body.text.includes('{{1}}'));
    assert.equal(body.example.body_text[0].length, p.aantalVariabelen);
  }
  // Oude namen staan nog in de lijst (worden overgeslagen als ze al bestaan; nooit overschreven).
  assert.ok(alle.includes('afspraak_bevestiging_v1'));
});
