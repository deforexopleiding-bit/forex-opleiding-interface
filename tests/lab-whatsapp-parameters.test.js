// tests/lab-whatsapp-parameters.test.js
//
// De trial-templates eindigen met een vaste afsluitregel ná {{2}} (Meta laat
// geen variabele op het einde toe). Die regel is tekst, geen parameter: de
// motor stuurt per bericht PRECIES twee parameters mee — voornaam en loginlink —
// in de volgorde van variabele_volgorde.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakFakeDb } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const verstuurd = [];
const crm = maakFakeDb({ onderhoud_sjablonen: [{
  id: 's1', traject_slug: 'the-lab', soort: 'niet-ingelogd-48u', kanaal: 'whatsapp', actief: true,
  meta_template: 'trial_niet_ingelogd_48u', variabele_volgorde: ['voornaam', 'loginlink'],
  tekst: 'Hey {{1}}, … één klik en je zit erin: {{2}}\n\nTot zo, het team van De Forex Opleiding',
}], berichten_log: [] });

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: crm } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async () => ({ ok: true }) } });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), { namedExports: {
  haalLijn: async () => ({ phoneNumberId: 'pn-1' }), mailAfzender: () => 'welkom@deforexopleiding.nl',
} });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
  sendTemplate: async (a) => { verstuurd.push(a); return { wamid: 'w1' }; },
  goedgekeurdeTemplatesOpLijn: async () => ({ ok: true, templates: [{ name: 'trial_niet_ingelogd_48u', language: 'nl' }] }),
} });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });

const { stuurLabWhatsApp } = await import(url('api/_lib/lab-berichten.js'));

test('precies twee parameters: voornaam en loginlink, niets voor de afsluitregel', async () => {
  const r = await stuurLabWhatsApp({
    leadId: null, telefoon: '+32472223752', toestemming: true, soort: 'niet-ingelogd-48u',
    waarden: { voornaam: 'Lien', loginlink: 'https://lms.deforexopleiding.nl/the-lab/start/?s=abc', belofte: 'je minicursus', dagen_over: '5' },
  });
  assert.equal(r.status, 'verstuurd');
  assert.equal(verstuurd.length, 1);
  assert.deepEqual(verstuurd[0].variables, ['Lien', 'https://lms.deforexopleiding.nl/the-lab/start/?s=abc']);
  assert.equal(verstuurd[0].templateName, 'trial_niet_ingelogd_48u');
  assert.equal(verstuurd[0].languageCode, 'nl');
});
