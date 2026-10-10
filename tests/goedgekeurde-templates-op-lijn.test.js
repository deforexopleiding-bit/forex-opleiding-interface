// tests/goedgekeurde-templates-op-lijn.test.js
//
// goedgekeurdeTemplatesOpLijn (2026-10-09, "Stuur bericht"): de ECHT
// goedgekeurde templates van de WABA achter de lead-lijn — live bij 360dialog,
// niet uit whatsapp_meta_templates (die kent alleen de oude WABA). Met het
// WABA-id erbij, zodat de UI kan tonen waar de lijst vandaan komt.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const sb = { from: () => ({}) };
mock.module('../api/supabase.js', { namedExports: { supabaseAdmin: sb, supabase: sb, createUserClient: () => sb } });

const HOOFD = '1273723375834177';
process.env.D360_API_KEY_HOOFDNUMMER = 'test-key';
process.env.D360_PHONE_NUMBER_ID_HOOFDNUMMER = HOOFD;
delete process.env.D360_API_KEY_KLANTNUMMER;

const W = await import('../api/_lib/meta-whatsapp.js');
const echteFetch = globalThis.fetch;

const TEMPLATES = [
  { name: 'vraag_6_agenda', language: 'nl', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Super! Kijk hier is mijn agenda https://x.nl' }] },
  { name: 'followup_2_druk', language: 'nl', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hey {{1}}, ik denk dat je erg druk bent 😊' }] },
  { name: 'webinar_reminder_dag', language: 'nl', status: 'PENDING', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hoi {{1}} {{2}} {{3}} {{4}} x' }] },
  { name: 'met_foto', language: 'nl', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Kijk {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Ja' }] }] },
];

test('alleen APPROVED, met body + aantal variabelen + WABA-id van de lijn', async () => {
  W._resetTemplateCache();
  const urls = [];
  globalThis.fetch = async (u, init) => {
    urls.push(String(u));
    assert.equal(init.headers['D360-API-KEY'], 'test-key');
    if (/health_status/.test(String(u))) {
      return new Response(JSON.stringify({ health_status: { entities: [{ entity_type: 'PHONE_NUMBER', id: HOOFD }, { entity_type: 'WABA', id: '2579784712469452' }] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ waba_templates: TEMPLATES }), { status: 200 });
  };
  try {
    const r = await W.goedgekeurdeTemplatesOpLijn(HOOFD);
    assert.equal(r.ok, true);
    assert.equal(r.waba_id, '2579784712469452');
    assert.deepEqual(r.templates.map((t) => t.name), ['followup_2_druk', 'met_foto', 'vraag_6_agenda']);
    const f = r.templates.find((t) => t.name === 'followup_2_druk');
    assert.equal(f.aantal_vars, 1);
    assert.match(f.body, /^Hey \{\{1\}\}/);
    assert.equal(r.templates.find((t) => t.name === 'vraag_6_agenda').aantal_vars, 0);
    const foto = r.templates.find((t) => t.name === 'met_foto');
    assert.equal(foto.header_format, 'IMAGE');
    assert.deepEqual(foto.knoppen, [{ type: 'QUICK_REPLY', text: 'Ja' }]);
    // Status-functie en lijst delen dezelfde cache (één templatelijst-ophaling).
    assert.equal(await W.templateStatusOpLijn(HOOFD, 'webinar_reminder_dag'), 'PENDING');
    assert.equal(urls.filter((u) => /message_templates/.test(u)).length, 1);
  } finally {
    globalThis.fetch = echteFetch;
  }
});

test('geen 360dialog-lijn of lijst niet op te halen → ok:false met reden', async () => {
  W._resetTemplateCache();
  assert.deepEqual(await W.goedgekeurdeTemplatesOpLijn('999999'), { ok: false, reden: 'GEEN_360_LIJN' });
  globalThis.fetch = async () => new Response('kapot', { status: 500 });
  try {
    assert.deepEqual(await W.goedgekeurdeTemplatesOpLijn(HOOFD), { ok: false, reden: 'LIJST_NIET_OP_TE_HALEN' });
  } finally {
    globalThis.fetch = echteFetch;
  }
});
