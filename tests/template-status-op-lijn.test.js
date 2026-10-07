// tests/template-status-op-lijn.test.js
//
// templateStatusOpLijn (2026-10-07): status van een template op de WABA van
// de 360dialog-lijn zelf — de CRM-tabel kent alleen de oude WABA.

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
let aanroepen = 0;
function zetFetch(antwoord) {
  aanroepen = 0;
  globalThis.fetch = async (u, init) => {
    aanroepen++;
    assert.match(String(u), /\/message_templates/);
    assert.equal(init.headers['D360-API-KEY'], 'test-key');
    return antwoord();
  };
}

test('APPROVED / PENDING / ONTBREEKT van de lijn zelf; één ophaling dankzij de cache', async () => {
  W._resetTemplateCache();
  zetFetch(() => new Response(JSON.stringify({ waba_templates: [
    { name: 'event_vragenlijst_definitief', language: 'nl', status: 'approved' },
    { name: 'event_vervolg_herinnering', language: 'nl', status: 'PENDING' },
  ] }), { status: 200 }));
  assert.equal(await W.templateStatusOpLijn(HOOFD, 'event_vragenlijst_definitief'), 'APPROVED');
  assert.equal(await W.templateStatusOpLijn(HOOFD, 'event_vervolg_herinnering'), 'PENDING');
  assert.equal(await W.templateStatusOpLijn(HOOFD, 'bestaat_niet'), 'ONTBREEKT');
  assert.equal(await W.templateStatusOpLijn(HOOFD, 'event_vragenlijst_definitief', 'en'), 'ONTBREEKT');
  assert.equal(aanroepen, 1);
  globalThis.fetch = echteFetch;
});

test('lijst niet op te halen → ONBEKEND; geen 360dialog-lijn → null', async () => {
  W._resetTemplateCache();
  zetFetch(() => new Response('kapot', { status: 500 }));
  assert.equal(await W.templateStatusOpLijn(HOOFD, 'x'), 'ONBEKEND');
  globalThis.fetch = echteFetch;
  assert.equal(await W.templateStatusOpLijn('999999', 'x'), null);
  assert.equal(await W.templateStatusOpLijn('1399327383258229', 'x'), null); // klantnummer zonder key
});
