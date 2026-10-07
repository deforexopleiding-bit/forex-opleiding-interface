// tests/360-templates-upload.test.js
//
// scripts/360-templates-upload.mjs — de pure delen: categorie-keuze,
// variabele-volgorde-controle, voorbeeldwaarden, rijkeuze, argumenten, payload.
// Geen DB, geen netwerk (main() draait niet bij import).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  kiesCategorie, mappingAfwijking, verbeterVoorbeelden, kiesRij, leesArgs, bouwPayload,
  VASTE_TEMPLATES, VOORBEELD_OVERRIDES,
} from '../scripts/360-templates-upload.mjs';
import { buildComponents } from '../api/_lib/wa-template-components.js';

test('categorie: transactioneel blijft UTILITY, ook met "gratis toegang" of de naam "Masterclass"', () => {
  assert.equal(kiesCategorie({ naam: 'bevestig_toegang_a', body: 'Dan zetten we je gratis toegang open. Je opstartsessie staat gepland voor {{2}}.' }).categorie, 'UTILITY');
  assert.equal(kiesCategorie({ naam: 'annulatie_bevestigd', bronnen: ['event_automations'], body: 'je inschrijving voor de Forex Masterclass is geannuleerd' }).categorie, 'UTILITY');
  assert.equal(kiesCategorie({ naam: 'afspraak_bevestiging_v1', body: 'Je kennismakingsgesprek staat gepland.' }).categorie, 'UTILITY');
  assert.equal(kiesCategorie({ naam: 'niet_ingelogd', bronnen: ['onderhoud_sjablonen'], body: 'Je hebt nog {{2}} dagen.' }).categorie, 'UTILITY');
});

test('categorie: aansporing tot een opstartsessie/aanbod → MARKETING, met reden', () => {
  const b = kiesCategorie({ naam: 'bevestig_toegang_b', body: 'Plan hieronder ook meteen je gratis opstartsessie 👇' });
  assert.equal(b.categorie, 'MARKETING');
  assert.match(b.reden, /opstartsessie/);
  assert.equal(kiesCategorie({ naam: 'x', body: 'Vergeet je unieke kans niet' }).categorie, 'MARKETING');
  assert.equal(kiesCategorie({ naam: 'x', body: 'Nu 20% korting' }).categorie, 'MARKETING');
  assert.equal(kiesCategorie({ naam: 'x', body: 'loopt bijna af. 🎁' }).categorie, 'MARKETING');
});

test('variabele-volgorde: positionele body + opgeslagen 1..N = consistent; afwijking wordt gemeld', () => {
  const opgeslagen = { body: { 1: 'attendee.voornaam', 2: 'event.titel', 3: 'event.datum', 4: 'attendee.vervolg_link' } };
  assert.equal(mappingAfwijking(opgeslagen, null, 4), null);
  assert.ok(mappingAfwijking(opgeslagen, null, 3));
  assert.equal(mappingAfwijking(null, null, 2), null);
  assert.equal(mappingAfwijking({ body: { 1: 'klant.voornaam' } }, { body: { 1: 'klant.voornaam' } }, 1), null);
  assert.ok(mappingAfwijking({ body: { 1: 'klant.voornaam', 2: 'factuur.nummer' } }, { body: { 1: 'factuur.nummer', 2: 'klant.voornaam' } }, 2));
});

test('payload: named placeholders worden {{1}}… in dezelfde volgorde als de CRM-mapping', () => {
  const rij = { name: 't', language: 'nl', body_text: 'Hoi {{klant.voornaam}}, je factuur {{factuur.nummer}}', header_type: 'NONE' };
  const p = bouwPayload(rij, 'UTILITY');
  assert.equal(p.bodyTekst, 'Hoi {{1}}, je factuur {{2}}');
  assert.equal(p.aantalVariabelen, 2);
  assert.deepEqual(p.meta_param_mapping.body, buildComponents(rij).meta_param_mapping.body);
  assert.deepEqual(Object.keys(p.payload).sort(), ['category', 'components', 'language', 'name']);
});

test('voorbeelden: "voorbeeld" vervangen via de opgeslagen mapping; overrides passen in aantal', () => {
  const components = [{ type: 'BODY', text: 'Hoi {{1}}', example: { body_text: [['voorbeeld']] } }];
  assert.equal(verbeterVoorbeelden(components, { body: { 1: 'klant.voornaam' } }), 1);
  assert.notEqual(components[0].example.body_text[0][0], 'voorbeeld');
  assert.equal(VOORBEELD_OVERRIDES.interne_nieuwe_afspraak_nl.length, 3);
});

test('rijkeuze: APPROVED gaat voor, daarna de meest recente', () => {
  const r = kiesRij([
    { status: 'REJECTED', updated_at: '2026-10-01' },
    { status: 'APPROVED', updated_at: '2026-08-01', id: 'a' },
    { status: 'APPROVED', updated_at: '2026-09-01', id: 'b' },
  ]);
  assert.equal(r.id, 'b');
});

test('argumenten: standaard dry-run; --apply alleen expliciet; --only', () => {
  assert.deepEqual({ ...leesArgs([]), only: null }, { apply: false, dryRun: true, only: null, json: false, nummer: 'hoofdnummer' });
  assert.equal(leesArgs(['--apply']).apply, true);
  assert.equal(leesArgs(['--apply', '--dry-run']).apply, false);
  assert.deepEqual([...leesArgs(['--only=a,b']).only], ['a', 'b']);
});

test('vaste lijst = de 22 namen uit PR #1729 + event_vervolg_herinnering; geen sleutels in de code', () => {
  assert.equal(Object.values(VASTE_TEMPLATES).flat().length, 23);
  assert.ok(VASTE_TEMPLATES.events.includes('event_vervolg_herinnering'));
  const src = readFileSync(new URL('../scripts/360-templates-upload.mjs', import.meta.url), 'utf8');
  assert.match(src, /keyEnv: 'D360_API_KEY_HOOFDNUMMER'/);
  assert.match(src, /process\.env\[keyEnv\]/);
  assert.doesNotMatch(src, /eyJ[A-Za-z0-9_-]{10,}/);          // geen JWT/service-key
  assert.doesNotMatch(src, /D360-API-KEY['"]?\s*:\s*['"][A-Za-z0-9]/);
});
