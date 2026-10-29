// tests/wa-intern.test.js
//
// 2026-10-29: vangnet — interne nummers (meldingsnummer van het team) krijgen
// alleen interne templates.
//   1. wa-intern (puur): interne nummers, toegestane templates, env-uitbreiding;
//   2. sendTemplate weigert een lead-template naar het meldingsnummer vóór Meta;
//   3. template-endpoint (UTILITY-payload), admin-knop, opruim-SQL.
// De lead-melding met nep-transport: tests/lead-melding-utility.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const I = await import(url('api/_lib/wa-intern.js'));

test('wa-intern: alleen interne templates naar interne nummers', () => {
  const env = {};
  assert.equal(I.isInternNummer('+31655270212', env), true);
  assert.equal(I.isInternNummer('0655270212', env), true, 'nationaal formaat');
  assert.equal(I.isInternNummer('31655270212', env), true);
  assert.equal(I.isInternNummer('+31612345678', env), false);
  assert.equal(I.isInternNummer('', env), false);
  for (const t of ['interne_nieuwe_lead_v2_nl', 'interne_nieuwe_lead_nl', 'nieuwe_lead', 'interne_nieuwe_afspraak_nl', 'dfo_dagrapport']) {
    assert.deepEqual(I.magTemplateNaar('+31655270212', t, env), { ok: true }, t);
  }
  const nee = I.magTemplateNaar('+31655270212', 'toegang_bevestiging_v3', env);
  assert.equal(nee.ok, false);
  assert.match(nee.reden, /toegang_bevestiging_v3/);
  assert.deepEqual(I.magTemplateNaar('+31612345678', 'toegang_bevestiging_v3', env), { ok: true }, 'gewone lead: ongewijzigd');
  // Uitbreiden via env.
  const env2 = { INTERNE_WA_NUMMERS: '+31 6 11112222, 0633334444', INTERNE_WA_TEMPLATES: 'mijn_dagrapport', LEAD_MELDING_NUMMER: '+31699998888' };
  assert.equal(I.isInternNummer('+31611112222', env2), true);
  assert.equal(I.isInternNummer('+31633334444', env2), true);
  assert.equal(I.isInternNummer('+31699998888', env2), true, 'meldingsnummer uit env telt mee');
  assert.equal(I.isInternNummer('+31655270212', env2), true, 'standaardnummer blijft intern');
  assert.equal(I.magTemplateNaar('+31611112222', 'mijn_dagrapport', env2).ok, true);
  assert.equal(I.magTemplateNaar('+31611112222', 'massa_aanbod', env2).ok, false);
});

test('sendTemplate: lead-template naar het meldingsnummer → geweigerd vóór Meta', async () => {
  const M = await import(url('api/_lib/meta-whatsapp.js'));
  const echt = globalThis.fetch;
  let gehaald = 0;
  globalThis.fetch = async () => { gehaald++; throw new Error('mag niet aangeroepen worden'); };
  try {
    await assert.rejects(
      M.sendTemplate({ to: '+31655270212', templateName: 'massa_aanbod', variables: ['Jeffrey'] }),
      (e) => e.code === 'WA_INTERN_NUMMER' && /massa_aanbod/.test(e.message),
    );
    assert.equal(gehaald, 0, 'geen netwerkverzoek');
  } finally {
    globalThis.fetch = echt;
  }
});

test('template-endpoint, admin-knop en opruim-SQL', async () => {
  const T = await import(url('api/admin-lead-melding-template.js'));
  // Standaard v2: leesbaar Naam / Traject / Bron, 3 variabelen met voorbeelden.
  const p = T.bouwPayload();
  assert.equal(p.name, 'interne_nieuwe_lead_v2_nl');
  assert.equal(p.category, 'UTILITY');
  assert.equal(p.language, 'nl');
  const body = p.components.find((c) => c.type === 'BODY');
  assert.equal(body.text, 'Er is een nieuwe aanmelding binnengekomen.\nNaam: {{1}}\nTraject: {{2}}\nBron: {{3}}\n\nOpen Leadsonderhoud om de lead op te volgen.');
  assert.deepEqual(body.example.body_text, [['Rudy Jansen', 'webinar', 'webinar-v1']], 'voorbeelden mee, anders weigert Meta');
  assert.equal(p.components.find((c) => c.type === 'FOOTER').text, 'De Forex Opleiding · interne melding');
  // De eerste versie blijft ongewijzigd (goedgekeurd; nooit de body muteren).
  const v1 = T.bouwPayload('interne_nieuwe_lead_nl');
  assert.equal(v1.components[0].text, 'Nieuwe aanmelding in het CRM: {{1}}, via {{2}}. Open Leadsonderhoud om de lead op te volgen.');
  assert.equal(T.bouwPayload('massa_aanbod'), null, 'alleen bekende templates');
  for (const t of [p, v1]) {
    const tekst = t.components.map((c) => c.text).join(' ');
    assert.doesNotMatch(tekst, /gratis|korting|aanbod|actie|cadeau|whop|!/i, 'transactioneel, geen marketing- of juichtaal');
  }
  assert.match(lees('api/lead-melding.js'), /TEMPLATE_KETEN = Object\.freeze\(\['interne_nieuwe_lead_v2_nl', 'interne_nieuwe_lead_nl', 'nieuwe_lead'\]\)/);
  const admin = lees('modules/admin.html');
  assert.match(admin, /id="card-lead-melding"/);
  assert.match(admin, /apiRequest\('POST', '\/api\/admin-lead-melding-template'\)/);
  const sql = lees('docs/sql-migrations/2026-10-29-intern-nummer-uit-leadflow.sql');
  assert.match(sql, /UPDATE public\.toegang_aanvragen\s+SET status = 'vervallen'/);
  assert.match(sql, /WHERE status = 'wachtend'/);
  assert.match(sql, /SET wa_nu_niet_op = now\(\)/);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  // Lead-modal en massa tonen het interne template niet (bestaande filter interne_).
  const L = await import(url('api/_lib/lead-bericht.js'));
  assert.equal(L.isLeadTemplate('interne_nieuwe_lead_nl'), false);
  assert.equal(L.isLeadTemplate('interne_nieuwe_lead_v2_nl'), false);
});
