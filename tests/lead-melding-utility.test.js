// tests/lead-melding-utility.test.js
//
// 2026-10-29: de lead-melding gaat met het UTILITY-template 'interne_nieuwe_lead_nl'
// (was 'nieuwe_lead', bij Meta MARKETING). Zolang Meta het nieuwe template niet kent
// (132xxx) één keer terug naar 'nieuwe_lead'; bij andere fouten geen tweede poging.
// Het vangnet zelf: tests/wa-intern.test.js (dit bestand mockt meta-whatsapp).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── lead-melding met nep-transport ───────────────────────────────────────────
const sends = [];
let gedrag = () => ({ wamid: 'wamid.ok' });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
  sendTemplate: async (a) => { sends.push(a.templateName); return gedrag(a); },
  MetaNotConfiguredError: class MetaNotConfiguredError extends Error {},
} });
mock.module(url('api/mailer.js'), { namedExports: {
  sendWelkomMail: async () => ({ success: true, messageId: '<m@x>' }),
  wrapEmailHtml: (t, b) => `<h1>${t}</h1>${b}`,
} });
const metaFout = (code) => Object.assign(new Error(`Meta API ${code}: template`), { metaCode: code });

async function roep(body = { naam: 'Sanne de Vries', traject: 'minicursus' }) {
  process.env.LEAD_MELDING_SECRET = 'test-geheim';
  const { default: handler } = await import(url('api/lead-melding.js') + '?t=' + Math.random());
  const res = { code: 0, json: null, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { this.json = j; return this; }, end() { return this; } };
  await handler({ method: 'POST', headers: { 'x-internal-token': 'test-geheim' }, body }, res);
  return res;
}

test('lead-melding: nieuw UTILITY-template; terugval op nieuwe_lead zolang Meta het niet kent', async () => {
  sends.length = 0; gedrag = () => ({ wamid: 'wamid.1' });
  let r = await roep();
  assert.equal(r.code, 200);
  assert.deepEqual(sends, ['interne_nieuwe_lead_nl']);
  assert.equal(r.json.whatsapp.template, 'interne_nieuwe_lead_nl');

  sends.length = 0;
  gedrag = (a) => { if (a.templateName === 'interne_nieuwe_lead_nl') throw metaFout(132001); return { wamid: 'wamid.2' }; };
  r = await roep();
  assert.deepEqual(sends, ['interne_nieuwe_lead_nl', 'nieuwe_lead'], 'nog niet goedgekeurd → oude template');
  assert.equal(r.json.whatsapp.ok, true);
  assert.equal(r.json.whatsapp.template, 'nieuwe_lead');

  sends.length = 0;
  gedrag = () => { throw metaFout(131049); };
  r = await roep();
  assert.deepEqual(sends, ['interne_nieuwe_lead_nl'], 'andere fout (bv. marketinggrens) → geen tweede poging');
  assert.equal(r.json.whatsapp.ok, false);
  assert.equal(r.code, 200, 'de mail ging wel');
});
