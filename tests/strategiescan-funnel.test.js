// tests/strategiescan-funnel.test.js
//
// De Strategie-scan als eigen funnel (2026-10-19) en de Lab-landingen:
//   · scan-boeking: Dave eigenaar, titel 'Strategie-scan · …', scan-rij in concept;
//   · een Lab-strategiesessie (bron 'the-lab') krijgt GEEN scan-rij;
//   · labLandingLabel / labSleutel voor Leadsonderhoud > The Lab.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

let inserts; let bestaand;
const nepDb = {
  from(tabel) {
    const k = {
      select: () => k, eq: () => k, limit: async () => ({ data: bestaand, error: null }),
      insert: (rij) => { inserts.push({ tabel, rij }); return { select: () => ({ single: async () => ({ data: { id: 'scan-1' }, error: null }) }) }; },
    };
    return k;
  },
};
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: nepDb } });
mock.module(url('api/_lib/lab-gastheer.js'), { namedExports: {
  leesLabGastheer: async () => ({ id: 'dave-profiel', naam: 'Dave Heylen', voornaam: 'Dave' }),
} });

const S = await import(url('api/_lib/strategiescan-boeking.js'));
const L = await import(url('api/_lib/lab-config.js'));

beforeEach(() => { inserts = []; bestaand = []; });

test('isScanBron: alleen strategiescan — the-lab en webinar niet', () => {
  assert.equal(S.isScanBron('strategiescan'), true);
  assert.equal(S.isScanBron(' Strategiescan '), true);
  assert.equal(S.isScanBron('the-lab'), false);
  assert.equal(S.isScanBron('webinar'), false);
  assert.equal(S.isScanBron('strategiescan-v1'), false, 'de variant is de lead-bron, niet de agendabron');
});

test('scanGhlTitel + scanConceptRij', () => {
  assert.equal(S.scanGhlTitel('Jonas Peeters'), 'Strategie-scan · Jonas Peeters');
  const r = S.scanConceptRij({ leadId: 'L1', afspraakId: 'A1', assessorId: 'dave', naam: ' Jonas ', email: 'J@X.be', telefoon: '+32472223752' });
  assert.deepEqual(r, {
    lead_id: 'L1', afspraak_id: 'A1', assessor_id: 'dave', status: 'concept',
    deelnemer_naam: 'Jonas', deelnemer_email: 'j@x.be', deelnemer_telefoon: '+32472223752',
  });
});

test('maakScanConcept: insert in concept; idempotent per afspraak', async () => {
  const a = await S.maakScanConcept({ leadId: 'L1', afspraakId: 'A1', assessorId: 'dave-profiel', naam: 'Jonas' });
  assert.equal(a.ok, true);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].tabel, 'scans');
  assert.equal(inserts[0].rij.status, 'concept');
  assert.equal(inserts[0].rij.assessor_id, 'dave-profiel');
  bestaand = [{ id: 'scan-oud' }];
  const b = await S.maakScanConcept({ leadId: 'L1', afspraakId: 'A1', naam: 'Jonas' });
  assert.equal(b.al, true);
  assert.equal(inserts.length, 1, 'geen tweede scan voor dezelfde afspraak');
});

test('leesScanAssessor = Dave (zelfde bron als de Lab-gastheer)', async () => {
  assert.equal((await S.leesScanAssessor()).id, 'dave-profiel');
});

test('bedrading boek-route: scan alleen bij bron strategiescan, met Dave als eigenaar en eigen titel', () => {
  const src = lees('api/public-opstartsessie-book.js');
  assert.match(src, /const isScan = isScanBron\(source\);/);
  assert.match(src, /if \(scanAssessor\?\.id\) leadRow\.owner_id = scanAssessor\.id;/);
  assert.match(src, /ghlTitel: scanGhlTitel\(leadRow\.lead_name\)/);
  assert.match(src, /if \(isScan && result\?\.appointment_id\) \{\s+const scan = await maakScanConcept/);
  // De Lab-sessie loopt via api/lab-sessie.js en maakt nooit een scan.
  assert.doesNotMatch(lees('api/lab-sessie.js'), /maakScanConcept|from\('scans'\)/);
});

test('seed: bron strategiescan zonder setter, traject strategiescan — niet destructief', () => {
  const sql = lees('docs/sql-migrations/2026-10-19-strategiescan-funnel.sql');
  assert.match(sql, /INSERT INTO public\.booking_sources \(slug, label, actief, vragenlijst\)\s+VALUES \('strategiescan', 'Strategie-scan', true, false\)\s+ON CONFLICT \(slug\) DO NOTHING;/);
  assert.match(sql, /INSERT INTO public\.onderhoud_trajecten[\s\S]*'strategiescan'[\s\S]*ON CONFLICT \(slug\) DO NOTHING;/);
  const code = sql.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /\b(DELETE|DROP|TRUNCATE|UPDATE)\b/i);
  assert.doesNotMatch(code, /owner_user_id/);
});

test('labLandingLabel + labSleutel', () => {
  assert.equal(L.labLandingLabel('https://www.deforexopleiding.nl/the-lab-v1'), 'Funnel v1 · A');
  assert.equal(L.labLandingLabel('https://www.deforexopleiding.nl/the-lab-v2/'), 'Funnel v2 · B');
  assert.equal(L.labLandingLabel('https://lms.deforexopleiding.nl/the-lab/'), 'LMS-landing');
  assert.equal(L.labLandingLabel(null), '(onbekend)');
  assert.equal(L.labSleutel({ hook: 'H09', utm_campaign: 'c', landingspagina: 'https://www.deforexopleiding.nl/the-lab-v2' }, 'landing'), 'Funnel v2 · B');
  assert.equal(L.labSleutel({ hook: 'H09' }, 'hook'), 'H09');
  assert.equal(L.labSleutel({}, 'campagne'), '(geen campagne)');
  assert.equal(L.isLabBron('the-lab'), true);
  assert.equal(L.isLabBron('the-lab-v2'), true);
  assert.equal(L.isLabBron('strategiescan-v1'), false);
});

test('Kennismakingsgesprekken: Lab-strategiesessie en strategie-scan krijgen elk een eigen chip', () => {
  const v = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(v, /'the-lab': \{ tekst: 'Lab · strategiesessie'/);
  assert.match(v, /strategiescan: \{ tekst: 'Strategie-scan'/);
  assert.match(lees('api/leadsonderhoud-opstartsessies-list.js'), /labelBySlug\.get\(c\.booking_source\)/);
});
