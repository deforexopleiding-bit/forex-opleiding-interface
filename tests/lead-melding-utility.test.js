// tests/lead-melding-utility.test.js
//
// De lead-melding gaat met de eerste bruikbare UTILITY-template uit de keten
//   interne_nieuwe_lead_v2_nl (3 params: naam, traject, bron)
//   → interne_nieuwe_lead_nl (2) → nieuwe_lead (2, bij Meta MARKETING).
// Door naar de volgende alleen bij een templateprobleem (132xxx); bij andere
// fouten geen tweede poging. Bron = leads.bron via lead_id → body.bron →
// 'onbekend'; nooit leeg, nooit met regeleinden.
// Het vangnet zelf: tests/wa-intern.test.js (dit bestand mockt meta-whatsapp).

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

// ── nep-transport, nep-mail, nep-database ────────────────────────────────────
const sends = [];
const mails = [];
let gedrag = () => ({ wamid: 'wamid.ok' });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
  sendTemplate: async (a) => { sends.push({ t: a.templateName, v: a.variables }); return gedrag(a); },
  MetaNotConfiguredError: class MetaNotConfiguredError extends Error {},
} });
mock.module(url('api/mailer.js'), { namedExports: {
  sendWelkomMail: async (m) => { mails.push(m); return { success: true, messageId: '<m@x>' }; },
  wrapEmailHtml: (t, b) => `<h1>${t}</h1>${b}`,
} });
const LEAD_ID = '11111111-2222-4333-8444-555555555555';
let dbBron = 'kennismakingscursus-v10';
let dbFout = null;
mock.module(url('api/supabase.js'), { namedExports: {
  supabaseAdmin: {
    from: () => {
      const q = { select: () => q, eq: () => q, maybeSingle: async () => (dbFout ? { data: null, error: dbFout } : { data: dbBron == null ? null : { bron: dbBron }, error: null }) };
      return q;
    },
  },
} });
const metaFout = (code) => Object.assign(new Error(`Meta API ${code}: template`), { metaCode: code });

const LM = await import(url('api/lead-melding.js'));

async function roep(body = { naam: 'Sanne de Vries', traject: 'minicursus', lead_id: LEAD_ID }) {
  process.env.LEAD_MELDING_SECRET = 'test-geheim';
  const res = { code: 0, json: null, setHeader() {}, status(c) { this.code = c; return this; }, json(j) { this.json = j; return this; }, end() { return this; } };
  await LM.default({ method: 'POST', headers: { 'x-internal-token': 'test-geheim' }, body }, res);
  return res;
}
const reset = () => { sends.length = 0; mails.length = 0; gedrag = () => ({ wamid: 'wamid.ok' }); dbBron = 'kennismakingscursus-v10'; dbFout = null; delete process.env.LEAD_MELDING_TEMPLATE; };

test('v2 met 3 variabelen; bron uit leads.bron', async () => {
  reset();
  const r = await roep();
  assert.equal(r.code, 200);
  assert.deepEqual(sends, [{ t: 'interne_nieuwe_lead_v2_nl', v: ['Sanne de Vries', 'minicursus', 'kennismakingscursus-v10'] }]);
  assert.equal(r.json.whatsapp.template, 'interne_nieuwe_lead_v2_nl');
  assert.match(mails[0].text, /Bron: kennismakingscursus-v10/, 'bron ook in de interne mail');
});

test('keten: v2 in review → v1 (2 vars) → nieuwe_lead; andere fout → geen tweede poging', async () => {
  reset();
  gedrag = (a) => { if (a.templateName === 'interne_nieuwe_lead_v2_nl') throw metaFout(132001); return { wamid: 'wamid.2' }; };
  let r = await roep();
  assert.deepEqual(sends.map((s) => s.t), ['interne_nieuwe_lead_v2_nl', 'interne_nieuwe_lead_nl']);
  assert.deepEqual(sends[1].v, ['Sanne de Vries', 'minicursus'], 'v1 krijgt precies 2 variabelen');
  assert.equal(r.json.whatsapp.template, 'interne_nieuwe_lead_nl');

  reset();
  gedrag = (a) => { if (a.templateName !== 'nieuwe_lead') throw metaFout(132001); return { wamid: 'wamid.3' }; };
  r = await roep();
  assert.deepEqual(sends.map((s) => s.t), ['interne_nieuwe_lead_v2_nl', 'interne_nieuwe_lead_nl', 'nieuwe_lead']);
  assert.equal(r.json.whatsapp.template, 'nieuwe_lead');

  reset();
  gedrag = () => { throw metaFout(131049); };
  r = await roep();
  assert.deepEqual(sends.map((s) => s.t), ['interne_nieuwe_lead_v2_nl'], 'marketinggrens e.d. → niet doorschuiven');
  assert.equal(r.json.whatsapp.ok, false);
  assert.equal(r.code, 200, 'de mail ging wel');

  reset();
  process.env.LEAD_MELDING_TEMPLATE = 'interne_nieuwe_lead_nl';
  r = await roep();
  assert.deepEqual(sends.map((s) => s.t), ['interne_nieuwe_lead_nl'], 'env-override vooraan');
  assert.deepEqual(LM.templateKeten({ LEAD_MELDING_TEMPLATE: 'interne_nieuwe_lead_nl' }), ['interne_nieuwe_lead_nl', 'interne_nieuwe_lead_v2_nl', 'nieuwe_lead']);
  delete process.env.LEAD_MELDING_TEMPLATE;
});

test('bron nooit leeg en zonder regeleinden', async () => {
  reset();
  dbBron = null;
  await roep({ naam: 'A', traject: 'webinar', lead_id: LEAD_ID, bron: 'webinar-v1' });
  assert.equal(sends[0].v[2], 'webinar-v1', 'geen leads.bron → meegestuurde bron');

  reset();
  dbBron = null;
  await roep({ naam: 'A', traject: 'webinar' });
  assert.equal(sends[0].v[2], 'onbekend', 'niets → onbekend');

  reset();
  dbFout = { message: 'boem' };
  await roep({ naam: 'A', traject: 'webinar', lead_id: LEAD_ID, bron: 'event-1' });
  assert.equal(sends[0].v[2], 'event-1', 'leesfout → meegestuurde bron');

  reset();
  dbBron = '  training-\n22-10-26\t ';
  await roep({ naam: 'Jan\nde   Vries', traject: 'live\ttraining', lead_id: LEAD_ID });
  assert.deepEqual(sends[0].v, ['Jan de Vries', 'live training', 'training- 22-10-26']);

  assert.equal(LM.waParam('', 'onbekend'), 'onbekend');
  assert.equal(LM.waParam('   ', 'onbekend'), 'onbekend');
  assert.equal(LM.waParam('a    b'), 'a b', 'geen 4+ spaties');
  assert.equal(LM.waParam('x'.repeat(150)).length, 100);
});
