// tests/events-send-tijdelijk.test.js
//
// Fix 1 (2026-10-07): een 429 van 360dialog ("Too many requests for one
// number") is TIJDELIJK — sendEventWhatsAppTemplate probeert het opnieuw
// (default 3 pogingen). Echte 4xx (template-fout) blijven permanent. De
// automation-engine geeft pogingen:1 mee: die plant zelf een retry.
// Fix 2: kiesVervolgTemplate kiest event_vervolg_herinnering alleen als die
// óók op de WABA van de events-lijn APPROVED is.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

// ── Nep-databank ────────────────────────────────────────────────────────────
const db = { rijen: {} };
function from(tabel) {
  const filters = [];
  const k = {
    select: () => k,
    eq: (c, v) => { filters.push([c, v]); return k; },
    insert: () => k,
    single: () => Promise.resolve({ data: { id: 'msg-1' }, error: null }),
    maybeSingle: () => Promise.resolve({
      data: (db.rijen[tabel] || []).find((r) => filters.every(([c, v]) => String(r[c]) === String(v))) || null,
      error: null,
    }),
  };
  return k;
}
const sb = { from };

// ── Nep-transport ───────────────────────────────────────────────────────────
const verzend = { fouten: [], aanroepen: 0 };
class MetaNotConfiguredError extends Error {}
const fout = (status, tekst) => Object.assign(new Error(`Meta API ${status}: ${tekst} (subcode=, fbtrace=)`), { httpStatus: status, metaCode: status });
const lijnStatus = { waarde: null };

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: sb, supabase: sb, createUserClient: () => sb } });
mock.module(url('api/_lib/meta-whatsapp.js'), {
  namedExports: {
    MetaNotConfiguredError,
    sendTemplate: async () => {
      verzend.aanroepen++;
      const f = verzend.fouten.shift();
      if (f) throw f;
      return { wamid: 'wamid.test' };
    },
    templateStatusOpLijn: async () => lijnStatus.waarde,
  },
});
mock.module(url('api/_lib/module-context.js'), { namedExports: { getModuleContextByPhoneNumberId: async () => null } });
mock.module(url('api/_lib/conv-upsert.js'), { namedExports: { upsertOutboundConversation: async () => ({ id: 'conv-1', created: false }) } });
mock.module(url('api/mailer.js'), { namedExports: { sendEventMail: async () => ({ success: true }), wrapEmailHtml: (x) => x } });
mock.module(url('api/_lib/comms-log.js'), { namedExports: { logComms: async () => {}, mapMailStatus: () => ({}), mapSendStatus: () => ({}) } });

const S = await import('../api/_lib/events-send.js');
const B = await import('../api/_lib/event-website-berichten.js');

const EVENTS_PN = '1273723375834177';
function reset() {
  verzend.fouten = []; verzend.aanroepen = 0;
  db.rijen = {
    whatsapp_module_config: [{ module: 'events', is_active: true, phone_number_id: EVENTS_PN }],
    whatsapp_meta_templates: [
      { name: 'event_vragenlijst_definitief', status: 'APPROVED', body_text: 'Hoi {{1}}', meta_param_mapping: { body: { 1: 'attendee.voornaam' } } },
      { name: 'event_vervolg_herinnering', status: 'APPROVED', body_text: 'Hoi {{1}}', meta_param_mapping: null },
    ],
  };
}
const stuur = (extra = {}) => S.sendEventWhatsAppTemplate({
  attendee: { id: 'a1', first_name: 'Claudia', phone: '+32495372682' },
  event: { id: 'e1', title: 'Forex Masterclass Gent', starts_at: '2026-10-21T16:00:00Z' },
  templateName: 'event_vragenlijst_definitief',
  wachtMs: 0,
  ...extra,
});

// ── 1. Indeling ─────────────────────────────────────────────────────────────
test('soortSendFout: 429 / 5xx / throughput = tijdelijk; template- en andere 4xx-fouten = permanent', () => {
  assert.equal(S.soortSendFout(fout(429, '{"error":"Too many requests for one number"}')), 'tijdelijk');
  assert.equal(S.soortSendFout(new Error('Meta API 429: Too many requests for one number')), 'tijdelijk');
  assert.equal(S.soortSendFout(fout(503, 'unavailable')), 'tijdelijk');
  assert.equal(S.soortSendFout(Object.assign(new Error('Meta API 131056: pair rate limit'), { httpStatus: 400, metaCode: 131056 })), 'tijdelijk');
  assert.equal(S.soortSendFout(Object.assign(new Error('Meta API 132001: (#132001) Template name does not exist'), { httpStatus: 404, metaCode: 132001 })), 'permanent');
  assert.equal(S.soortSendFout(Object.assign(new Error('Meta API 190: Authentication Error'), { httpStatus: 401, metaCode: 190 })), 'permanent');
  assert.equal(S.soortSendFout(new Error('fetch failed')), 'onbekend');
});

// ── 2. Retry ────────────────────────────────────────────────────────────────
test('429 twee keer, dan gelukt → ok na 3 pogingen', async () => {
  reset();
  verzend.fouten = [fout(429, 'Too many requests for one number'), fout(429, 'Too many requests for one number')];
  const r = await stuur();
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(verzend.aanroepen, 3);
});

test('429 blijft → na 3 pogingen opgeven, NIET permanent (engine mag later opnieuw)', async () => {
  reset();
  verzend.fouten = [fout(429, 'x'), fout(429, 'x'), fout(429, 'x'), fout(429, 'x')];
  const r = await stuur();
  assert.equal(r.ok, false);
  assert.equal(r.permanent, undefined);
  assert.equal(r.tijdelijk, true);
  assert.equal(verzend.aanroepen, 3);
  assert.match(r.error, /tijdelijk, 3x geprobeerd/);
});

test('template-fout (132001) → één poging, permanent', async () => {
  reset();
  verzend.fouten = [Object.assign(new Error('Meta API 132001: Template name does not exist'), { httpStatus: 404, metaCode: 132001 })];
  const r = await stuur();
  assert.equal(r.permanent, true);
  assert.equal(verzend.aanroepen, 1);
});

test('pogingen:1 (engine) → één poging bij 429, tijdelijk terug', async () => {
  reset();
  verzend.fouten = [fout(429, 'x')];
  const r = await stuur({ pogingen: 1 });
  assert.equal(verzend.aanroepen, 1);
  assert.equal(r.tijdelijk, true);
  assert.equal(r.permanent, undefined);
});

test('de engine geeft pogingen: 1 mee aan sendEventWhatsAppTemplate', () => {
  const src = readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8');
  assert.match(src, /sendEventWhatsAppTemplate\(\{[\s\S]{0,900}?pogingen: 1,/);
});

// ── 3. Vervolg-template ─────────────────────────────────────────────────────
test('kiesVervolgTemplate: alleen event_vervolg_herinnering als die op de events-lijn APPROVED is', async () => {
  reset();
  lijnStatus.waarde = 'ONTBREEKT';
  assert.equal((await B.kiesVervolgTemplate()).template, 'event_vragenlijst_definitief');
  lijnStatus.waarde = 'PENDING';
  assert.equal((await B.kiesVervolgTemplate()).template, 'event_vragenlijst_definitief');
  lijnStatus.waarde = 'ONBEKEND';
  assert.equal((await B.kiesVervolgTemplate()).template, 'event_vragenlijst_definitief');
  lijnStatus.waarde = 'APPROVED';
  assert.equal((await B.kiesVervolgTemplate()).template, 'event_vervolg_herinnering');
  lijnStatus.waarde = null; // geen 360dialog-lijn: CRM-tabel beslist, zoals vroeger
  assert.equal((await B.kiesVervolgTemplate()).template, 'event_vervolg_herinnering');
  db.rijen.whatsapp_meta_templates = db.rijen.whatsapp_meta_templates.filter((t) => t.name !== 'event_vervolg_herinnering');
  lijnStatus.waarde = 'APPROVED';
  assert.equal((await B.kiesVervolgTemplate()).template, 'event_vragenlijst_definitief');
});
