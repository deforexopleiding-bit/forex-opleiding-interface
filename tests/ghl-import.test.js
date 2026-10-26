// tests/ghl-import.test.js
//
// GHL-import (2026-10-26): oude GHL-contacten als leads in weekbatches.
//   1. CSV lezen + controleren (batch, e-mail, E.164);
//   2. ontdubbelen tegen bestaande leads en binnen het bestand — nooit overschrijven;
//   3. sorteerdatum vóór de oudste lead, onderlinge volgorde op GHL-datum;
//      geen traject, geen toestemming, laatste_aanmelding = sorteerdatum;
//   4. endpoint: proefrun schrijft niets, bevestigen voegt in brokken in; admin-only;
//   5. leads-list batchfilter, massabericht (batch / uitgenodigd / standaard zonder
//      import), markeren na verzending, tellingen sluiten import uit.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const db = { leads: [], inserts: [], fout: null, admin: true };
function bouwer(tabel) {
  const st = { range: null, order: null, limit: null, not: [] };
  const k = {
    select: () => k, order: (c, o) => { st.order = [c, o?.ascending !== false]; return k; },
    not: (c, op, v) => { st.not.push([c, op, v]); return k; },
    range: (a, b) => { st.range = [a, b]; return k; },
    limit: (n) => { st.limit = n; return k; },
    insert: async (rijen) => {
      const lijst = Array.isArray(rijen) ? rijen : [rijen];
      if (db.fout) return { error: db.fout };
      db.inserts.push(...lijst);
      return { error: null };
    },
    then: (ok, nok) => {
      let rijen = db.leads.slice();
      if (st.order && st.order[0] === 'aangemaakt') rijen = rijen.filter((r) => r.aangemaakt).sort((a, b) => String(a.aangemaakt).localeCompare(String(b.aangemaakt)));
      if (st.range) rijen = rijen.slice(st.range[0], st.range[1] + 1);
      if (st.limit != null) rijen = rijen.slice(0, st.limit);
      return Promise.resolve({ data: rijen, error: null }).then(ok, nok);
    },
  };
  return k;
}
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from: bouwer },
    verifyAdmin: async () => (db.admin ? { user: { id: 'u1' }, profile: { email: 'jeffrey@x.nl', role: 'manager' } } : null),
    createUserClient: () => ({}),
  },
});

const G = await import('../api/_lib/ghl-import.js');
const handler = (await import('../api/leads-import-ghl.js')).default;
const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

const CSV = [
  'batch,voornaam,achternaam,email,telefoon,tag,created',
  '1,Jan,Jansen,Jan@Example.nl,+31612345678,facebook,2025-03-01T10:00:00Z',
  '1,Piet,,piet@x.nl,0612,webinar,2026-10-01T10:00:00Z',            // nummer ongeldig → alleen e-mail
  '2,Kees,Bakker,kees@x.nl,+32470123456,"tag, met komma",2024-01-01',
  '2,Dubbel,,jan@example.nl,,,2025-01-01',                          // dubbel in bestand
  '3,Bestaand,,oud@x.nl,,,2025-01-01',                               // bestaat al
  '100,Fout,,fout@x.nl,,,2025-01-01',                                 // batch buiten bereik (1..99)
  '4,Geen,,geen-email,,,2025-01-01',                                  // ongeldig e-mail
].join('\n');

test('plan: controleren, ontdubbelen, nooit overschrijven, sorteerdatum achteraan', () => {
  const { rijen, fout } = G.leesGhlCsv(CSV, 'mail');
  assert.equal(fout, null);
  const p = G.maakImportPlan(rijen, {
    bestaandeEmails: new Set(['oud@x.nl']), oudsteAangemaakt: '2025-06-01T00:00:00.000Z', soort: 'mail',
  });
  assert.deepEqual(p.nieuw.map((r) => r.email), ['piet@x.nl', 'jan@example.nl', 'kees@x.nl'], 'nieuwste GHL-datum eerst');
  assert.equal(p.bestaand.length, 1);
  assert.equal(p.bestaand[0].email, 'oud@x.nl');
  assert.equal(p.dubbel_in_bestand, 1);
  assert.deepEqual(p.ongeldig.map((o) => o.regel), [7, 8]);
  assert.equal(p.telefoon_ongeldig, 1);
  // Sorteerdatum: 1 dag vóór de oudste lead, daarna 1 s per rij — onderlinge volgorde behouden.
  assert.deepEqual(p.nieuw.map((r) => r.aangemaakt), ['2025-05-31T00:00:00.000Z', '2025-05-30T23:59:59.000Z', '2025-05-30T23:59:58.000Z']);
  for (const r of p.nieuw) {
    assert.equal(r.bron, 'Import');
    assert.equal(r.traject, null, 'geen funnel-traject');
    assert.equal(r.toestemming, false);
    assert.equal(r.laatste_aanmelding, r.aangemaakt, 'niet als heraanmelding van vandaag tellen');
    assert.ok(!('advertentie_toestemming' in r), 'geen advertentie-toestemming');
  }
  assert.equal(p.nieuw[0].telefoon, null, 'ongeldig nummer valt weg, de lead blijft');
  assert.equal(p.nieuw[1].ghl_tag, 'facebook');
  assert.equal(p.nieuw[1].ghl_created, '2025-03-01T10:00:00.000Z');
  assert.equal(p.nieuw[2].ghl_tag, 'tag, met komma');
  assert.equal(p.nieuw[2].import_batch, 2);
  assert.deepEqual(p.per_batch['1'], { nieuw: 2, bestaand: 0 });
  assert.deepEqual(p.per_batch['3'], { nieuw: 0, bestaand: 1 });
});

test('telefoon-only: bron Import-telefoon, ontdubbelen op nummer, e-mail leeg', () => {
  const csv = 'voornaam,telefoon,tag,created\nAnna,+31611111111,sms,2025-02-02\nBen,+31622222222,,\nCor,06-123,,';
  const { rijen } = G.leesGhlCsv(csv, 'telefoon');
  const p = G.maakImportPlan(rijen, { bestaandeTelefoons: new Set(['+31622222222']), soort: 'telefoon', nuMs: Date.parse('2026-10-26T12:00:00Z') });
  assert.equal(p.nieuw.length, 1);
  assert.equal(p.nieuw[0].bron, 'Import-telefoon');
  assert.equal(p.nieuw[0].email, null);
  assert.equal(p.nieuw[0].import_batch, null);
  assert.equal(p.bestaand.length, 1);
  assert.equal(p.ongeldig.length, 1);
  assert.equal(G.leesGhlCsv('naam,email\nx,y@z.nl', 'telefoon').fout, 'Geen kolom telefoon in de kopregel.');
  assert.equal(G.leesGhlCsv('voornaam,email\nx,y@z.nl', 'mail').fout, 'Geen kolom batch in de kopregel.');
});

async function call(body) {
  const res = { statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'POST', headers: {}, body }, res);
  return res;
}

test('endpoint: alleen admin; proefrun schrijft niets; bevestigen voegt in, bestaande blijven', async () => {
  db.leads = [{ email: 'oud@x.nl', telefoon_e164: null, aangemaakt: '2025-06-01T00:00:00.000Z' }];
  db.inserts = []; db.fout = null;
  db.admin = false;
  assert.equal((await call({ csv: CSV })).statusCode, 403);
  db.admin = true;
  const proef = await call({ csv: CSV, soort: 'mail' });
  assert.equal(proef.statusCode, 200);
  assert.equal(proef.body.proefrun, true);
  assert.equal(proef.body.nieuw, 3);
  assert.equal(proef.body.bestaand, 1);
  assert.equal(proef.body.bestaand_lijst[0].email, 'oud@x.nl');
  assert.equal(db.inserts.length, 0, 'proefrun schrijft niets');
  const echt = await call({ csv: CSV, soort: 'mail', bevestig: true });
  assert.equal(echt.statusCode, 200);
  assert.equal(echt.body.ingevoegd, 3);
  assert.equal(db.inserts.length, 3);
  assert.ok(db.inserts.every((r) => r.bron === 'Import' && r.traject === null));
  assert.ok(!db.inserts.some((r) => r.email === 'oud@x.nl'), 'bestaande lead nooit overschreven of opnieuw ingevoegd');
  // Migratie niet gedraaid → duidelijke melding.
  db.inserts = []; db.fout = { code: '42703', message: 'column "import_batch" does not exist' };
  const zonder = await call({ csv: CSV, soort: 'mail', bevestig: true });
  assert.equal(zonder.statusCode, 500);
  assert.match(zonder.body.error, /2026-10-26-leads-ghl-import\.sql/);
  db.fout = null;
});

test('massabericht: batch- en uitgenodigd-filter, standaard zonder import, markeren na verzending', async () => {
  const M = await import('../api/_lib/massa-mail.js');
  const f = M.normaliseerFilter({ import_batch: ['3', 'x', '120'], uitgenodigd: 'nee' });
  assert.deepEqual(f.import_batch, [3]);
  assert.equal(f.uitgenodigd, 'nee');
  const basis = { id: 'L', status: 'nieuw', bron: 'Import', tags: [], massa_campagnes: [] };
  assert.equal(M.leadVoldoet({ ...basis, import_batch: 3, uitgenodigd_op: null }, f), true);
  assert.equal(M.leadVoldoet({ ...basis, import_batch: 3, uitgenodigd_op: '2026-10-20T10:00:00Z' }, f), false, 'al uitgenodigd → niet nog eens');
  assert.equal(M.leadVoldoet({ ...basis, import_batch: 4, uitgenodigd_op: null }, f), false);
  const src = lees('api/_lib/massa-mail.js');
  assert.match(src, /if \(!importBron\) q = q\.or\('bron\.is\.null,bron\.not\.in\.\(' \+ IMPORT_BRONNEN\.join\(','\) \+ '\)'\);/, 'standaard zonder import-leads (NULL-bron blijft)');
  assert.match(src, /select\(LEAD_VELDEN \+ ', import_batch, uitgenodigd_op'\)\.in\('import_batch', batches\)/);
  assert.match(src, /status: 'sent'[^\n]*\n\s+await markeerUitgenodigd\(sb, lead\.id, c\.id, nu\(\)\);/);
  // markeerUitgenodigd: alleen import-leads, alleen de eerste keer.
  const log = [];
  const sb = { from: () => { const k = { update: (v) => { log.push(['update', v]); return k; }, eq: (c, v) => { log.push(['eq', c, v]); return k; }, not: (c, o, v) => { log.push(['not', c, o, v]); return k; }, is: (c, v) => { log.push(['is', c, v]); return Promise.resolve({ error: null }); } }; return k; } };
  await M.markeerUitgenodigd(sb, 'L1', 'C1', new Date('2026-10-26T09:00:00Z'));
  assert.deepEqual(log, [['update', { uitgenodigd_op: '2026-10-26T09:00:00.000Z', uitgenodigd_campagne: 'C1' }], ['eq', 'id', 'L1'], ['not', 'import_batch', 'is', null], ['is', 'uitgenodigd_op', null]]);
});

test('bedrading: leads-list, leads-v2, popup, tellingen, SQL, vercel.json', () => {
  const ll = lees('api/leads-list.js');
  assert.match(ll, /if \(importBatch != null\) \{\s+return res\.status\(200\)\.json\(await importBatchLijst/);
  assert.match(ll, /\.eq\('import_batch', importBatch\)/);
  const lv = lees('modules/klanten-v2/views/leads-v2.js');
  assert.match(lv, /DFO\.setF\('lead-batch', this\.value\)/);
  assert.match(lv, /p\.set\('import_batch', batch\)/);
  assert.match(lv, /import_batch: F\('lead-batch', ''\)/);
  assert.match(lv, /__leadGhlImport\(\)/);
  assert.equal((lv.match(/^\s+datumCel\(l\),$/gm) || []).length, 2);
  const mb = lees('modules/klanten-v2/views/_massa-bericht.js');
  assert.match(mb, /if \(f\.import_batch\) uit\.import_batch = \[Number\(f\.import_batch\)\];/);
  assert.match(mb, /Import-leads hebben geen toestemmingsvinkje/);
  assert.match(lees('modules/klanten-v2/index.html'), /views\/leads-v2\.js\?v=36"/);
  assert.match(lees('api/_lib/leads-per-traject-compute.js'), /if \(row && \(row\.bron === 'Import' \|\| row\.bron === 'Import-telefoon'\)\) continue;/);
  assert.match(lees('api/_lib/aanmeldingen-per-funnel.js'), /l\.bron !== 'Import' && l\.bron !== 'Import-telefoon'/);
  const sql = lees('docs/sql-migrations/2026-10-26-leads-ghl-import.sql');
  for (const k of ['import_batch smallint', 'ghl_tag text', 'ghl_created timestamptz', 'uitgenodigd_op timestamptz', 'uitgenodigd_campagne uuid']) {
    assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS ' + k), k);
  }
  assert.doesNotMatch(sql, /^\s*(UPDATE|DELETE|DROP TABLE)/im);
  assert.equal(JSON.parse(lees('vercel.json')).functions['api/leads-import-ghl.js'].maxDuration, 300);
});
