// tests/whatsapp-360dialog.test.js
//
// WhatsApp via 360dialog (2026-10-05):
//   1. nummer-registry + routering (api/_lib/wa-nummers.js): leads → hoofdnummer,
//      onboarding/finance NOOIT;
//   2. transport (api/_lib/meta-whatsapp.js): juiste endpoint/header/body,
//      templatenaam-mapping, foutvorm, phone_number_id via health_status, poort;
//   3. inkomend (api/whatsapp-360-webhook.js): auth (header/query), 503 zonder
//      geheim, normalisatie, gedeelde verwerking met bron '360dialog';
//   4. media via 360dialog (host-vervanging lookaside → waba-v2);
//   5. module-context bij meerdere modules op één nummer;
//   6. onboarding: geen WhatsApp-route, e-mail-fallback standaard UIT;
//   7. inbox-webhook: verwerking is geëxporteerd en de Meta-route gebruikt hem.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

// ── Nep-databank (alleen wat hier nodig is) ────────────────────────────────
const db = { module_config: [], uploads: [] };
function from(tabel) {
  const q = { filters: [] };
  const k = {
    select: () => k,
    eq: (c, v) => { q.filters.push([c, v]); return k; },
    limit: () => k,
    maybeSingle: () => k,
    then: (ok, nok) => Promise.resolve(run()).then(ok, nok),
  };
  function run() {
    if (tabel !== 'whatsapp_module_config') return { data: [], error: null };
    let r = db.module_config.slice();
    for (const [c, v] of q.filters) r = r.filter((x) => x[c] === v);
    return { data: r, error: null };
  }
  return k;
}
const storage = {
  from: () => ({
    upload: async (path, bytes, opts) => { db.uploads.push({ path, size: bytes.byteLength, opts }); return { error: null }; },
    getPublicUrl: (path) => ({ data: { publicUrl: 'https://bucket.test/' + path } }),
  }),
};
mock.module('../api/supabase.js', {
  namedExports: {
    supabase: { from }, supabaseAdmin: { from, storage },
    createUserClient: () => ({}), verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }),
  },
});
const verwerkt = [];
mock.module('../api/inbox-webhook.js', {
  namedExports: {
    verwerkWhatsAppWebhookBody: async (req, body, ctx) => { verwerkt.push({ body, ctx }); return { msgs_new: 1, msgs_dup: 0, statuses_updated: 0, template_status_updates: 0, errors: 0 }; },
  },
});

const N = await import('../api/_lib/wa-nummers.js');
const W = await import('../api/_lib/meta-whatsapp.js');
const R = await import('../api/whatsapp-360-webhook.js');
const MD = await import('../api/_lib/whatsapp-media-download.js');
const MC = await import('../api/_lib/module-context.js');
const OB = await import('../api/_lib/onboarding-mail-fallback.js');

const KEY = 'test-360-key';
const PNID = '111222333';
function zetEnv(extra = {}) {
  for (const k of ['D360_API_KEY_HOOFDNUMMER', 'D360_PHONE_NUMBER_ID_HOOFDNUMMER', 'D360_WEBHOOK_TOKEN_HOOFDNUMMER',
    'META_WHATSAPP_ACCESS_TOKEN', 'META_WHATSAPP_PHONE_NUMBER_ID', 'ONBOARDING_MAIL_FALLBACK']) delete process.env[k];
  Object.assign(process.env, extra);
}
const fetchLog = [];
function nepFetch(antwoorden) {
  globalThis.fetch = async (url, init = {}) => {
    fetchLog.push({ url: String(url), init });
    const a = antwoorden(String(url), init);
    return {
      ok: a.status >= 200 && a.status < 300, status: a.status,
      text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? {})),
      json: async () => a.body,
      arrayBuffer: async () => (a.bytes || new Uint8Array([1, 2, 3])).buffer,
    };
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1 · Registry + routering
// ════════════════════════════════════════════════════════════════════════════

test('registry: één actief nummer, +31 6 57210825, channel n4BsS9CH, geen geheimen in code', () => {
  const [n] = N.actieveNummers();
  assert.equal(N.actieveNummers().length, 1);
  assert.equal(n.e164, '+31657210825');
  assert.equal(n.channel_id, 'n4BsS9CH');
  assert.equal(n.api_key_env, 'D360_API_KEY_HOOFDNUMMER');
  assert.equal(N.nummerOpTelefoon('31657210825'), n);
  const src = readFileSync(new URL('../api/_lib/wa-nummers.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /D360-API-KEY['"]?\s*:\s*['"][A-Za-z0-9]/);
});

test('routering: lead-modules → hoofdnummer; onboarding/finance/dunning nooit; geen standaardnummer', () => {
  const h = N.nummerOpSleutel('hoofdnummer');
  for (const m of ['leadsonderhoud', 'welkom', 'events', 'opvolging']) {
    assert.equal(N.nummerVoorModule(m), h, m);
    assert.equal(N.moduleMagViaNummer(m, h), true, m);
  }
  for (const m of ['onboarding', 'finance', 'dunning']) {
    assert.equal(N.nummerVoorModule(m), null, m);
    assert.equal(N.moduleMagViaNummer(m, h), false, m);
  }
  assert.equal(N.standaardNummer(), null);
});

// ════════════════════════════════════════════════════════════════════════════
// 2 · Transport
// ════════════════════════════════════════════════════════════════════════════

test('route: lijn = hoofdnummer → 360dialog; onbekende lijn of geen lijn → Meta (klant-flows lekken niet)', async () => {
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY, D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  assert.equal((await W.kiesVerzendroute({ phoneNumberId: PNID })).provider, '360dialog');
  assert.equal((await W.kiesVerzendroute({ phoneNumberId: '999' })).provider, 'meta');
  assert.equal((await W.kiesVerzendroute({})).provider, 'meta');
  assert.equal((await W.kiesVerzendroute({ module: 'leadsonderhoud' })).provider, '360dialog');
  assert.equal((await W.kiesVerzendroute({ module: 'finance', phoneNumberId: '999' })).provider, 'meta');
});

test('route: onboarding wordt ALTIJD geweigerd — ook als iemand de onboarding-lijn op het hoofdnummer zet', async () => {
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY, D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  for (const opts of [{ module: 'onboarding' }, { module: 'onboarding', phoneNumberId: PNID }, { module: 'onboarding', phoneNumberId: 'oude-meta-lijn' }]) {
    await assert.rejects(() => W.kiesVerzendroute(opts), (e) => e instanceof W.WaGeenNummerError && e.code === 'WA_GEEN_NUMMER');
  }
  await assert.rejects(() => W.kiesVerzendroute({ module: 'finance', phoneNumberId: PNID }), W.WaGeenNummerError);
});

test('sendTemplate via 360dialog: waba-v2/messages, D360-API-KEY, Cloud-API-body, wamid terug', async () => {
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY, D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  fetchLog.length = 0;
  nepFetch(() => ({ status: 200, body: { messages: [{ id: 'wamid.360' }] } }));
  const r = await W.sendTemplate({ to: '+31612345678', templateName: 'afspraak_bevestiging_v1', variables: ['Jan', 'ma 6 okt'], phoneNumberId: PNID });
  assert.equal(r.wamid, 'wamid.360');
  assert.equal(fetchLog.length, 1);
  const { url, init } = fetchLog[0];
  assert.equal(url, 'https://waba-v2.360dialog.io/messages');
  assert.equal(init.headers['D360-API-KEY'], KEY);
  assert.equal(init.headers.Authorization, undefined);
  const body = JSON.parse(init.body);
  assert.equal(body.messaging_product, 'whatsapp');
  assert.equal(body.to, '31612345678');
  assert.equal(body.template.name, 'afspraak_bevestiging_v1');
  assert.deepEqual(body.template.components[0].parameters.map((p) => p.text), ['Jan', 'ma 6 okt']);
});

test('sendText/markAsRead via 360dialog; fout houdt de Cloud-API-velden (131047) + provider', async () => {
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY, D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  nepFetch((url, init) => {
    const b = JSON.parse(init.body);
    if (b.status === 'read') return { status: 200, body: { success: true } };
    return { status: 400, body: { error: { code: 131047, message: 'Re-engagement message', error_data: { details: 'buiten 24u' } } } };
  });
  assert.deepEqual(await W.markAsRead({ wamid: 'wamid.in', phoneNumberId: PNID }), { success: true });
  await assert.rejects(() => W.sendText({ to: '31612345678', body: 'hoi', phoneNumberId: PNID }), (e) =>
    e.metaCode === 131047 && e.provider === '360dialog' && e.httpStatus === 400 && /buiten 24u/.test(e.message));
});

test('zonder API-key: MetaNotConfiguredError met de env-naam (callers vangen die al af)', async () => {
  zetEnv({ D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  // Lijn is bekend via env, key ontbreekt → transport kiest 360dialog en meldt welke env mist.
  await assert.rejects(() => W.sendText({ to: '316', body: 'x', phoneNumberId: PNID }), (e) =>
    e instanceof W.MetaNotConfiguredError && e.missing.includes('D360_API_KEY_HOOFDNUMMER'));
});

test('phone_number_id zonder env: één keer opgevraagd via /health_status?fields=id, daarna onthouden', async () => {
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY });
  fetchLog.length = 0;
  nepFetch((url) => (url.endsWith('/health_status?fields=id') ? { status: 200, body: { id: '555666' } } : { status: 404, body: {} }));
  assert.equal((await W.d360NummerVoorPhoneNumberId('555666'))?.sleutel, 'hoofdnummer');
  assert.equal(await W.d360NummerVoorPhoneNumberId('777'), null);
  assert.equal(fetchLog.filter((f) => f.url.includes('health_status')).length, 1);
});

test('getConfigStatus: een 360dialog-key telt als geconfigureerd (poort in o.a. inbox-send)', () => {
  zetEnv({});
  assert.equal(W.getConfigStatus().configured, false);
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY });
  const s = W.getConfigStatus();
  assert.equal(s.configured, true);
  assert.equal(s.d360.configured, true);
  assert.equal(s.meta.configured, false);
  assert.ok(!JSON.stringify(s).includes(KEY));
});

// ════════════════════════════════════════════════════════════════════════════
// 3 · Inkomende webhook
// ════════════════════════════════════════════════════════════════════════════

function nepReq({ method = 'POST', query = {}, headers = {}, body = '' } = {}) {
  const req = new EventEmitter();
  Object.assign(req, { method, query, headers });
  process.nextTick(() => { if (body) req.emit('data', Buffer.from(body)); req.emit('end'); });
  return req;
}
function nepRes() {
  const r = { statusCode: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const cloudBody = (field) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ ...(field ? { field } : {}), value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '31657210825', phone_number_id: PNID },
    statuses: [{ id: 'wamid.x', status: 'delivered' }],
  } }] }],
});

test('webhook: 503 zonder geheim, 401 bij fout token, 404 bij onbekend nummer', async () => {
  zetEnv({});
  let res = nepRes(); await R.default(nepReq({ query: { nummer: 'hoofdnummer' }, body: cloudBody('messages') }), res);
  assert.equal(res.statusCode, 503);
  zetEnv({ D360_WEBHOOK_TOKEN_HOOFDNUMMER: 'geheim-123' });
  res = nepRes(); await R.default(nepReq({ query: { nummer: 'hoofdnummer' }, headers: { 'x-d360-webhook-token': 'fout' }, body: cloudBody('messages') }), res);
  assert.equal(res.statusCode, 401);
  res = nepRes(); await R.default(nepReq({ query: { nummer: 'bestaat-niet' }, body: cloudBody('messages') }), res);
  assert.equal(res.statusCode, 404);
});

test('webhook: juist token (header of ?token=) → gedeelde verwerking met bron 360dialog, altijd 200', async () => {
  zetEnv({ D360_WEBHOOK_TOKEN_HOOFDNUMMER: 'geheim-123', D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  verwerkt.length = 0;
  let res = nepRes();
  await R.default(nepReq({ query: { nummer: 'hoofdnummer' }, headers: { 'x-d360-webhook-token': 'geheim-123' }, body: cloudBody('messages') }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.msgs_new, 1);
  assert.equal(verwerkt[0].ctx.bron, '360dialog');
  assert.equal(verwerkt[0].ctx.nummer.sleutel, 'hoofdnummer');
  res = nepRes();
  await R.default(nepReq({ query: { nummer: 'hoofdnummer', token: 'geheim-123' }, body: cloudBody('messages') }), res);
  assert.equal(res.statusCode, 200);
  // Kapotte JSON → 200, niets verwerkt (anders blijft 360dialog herhalen).
  const voor = verwerkt.length;
  res = nepRes();
  await R.default(nepReq({ query: { nummer: 'hoofdnummer', token: 'geheim-123' }, body: '{kapot' }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(verwerkt.length, voor);
});

test('webhook: field ontbreekt of is "statuses" → "messages" (de verwerking slaat anders alles over)', () => {
  for (const f of [undefined, 'statuses', 'messages']) {
    const b = R.normaliseer360Body(JSON.parse(cloudBody(f)));
    assert.equal(b.entry[0].changes[0].field, 'messages');
  }
  const tpl = R.normaliseer360Body({ entry: [{ changes: [{ field: 'message_template_status_update', value: { event: 'APPROVED' } }] }] });
  assert.equal(tpl.entry[0].changes[0].field, 'message_template_status_update');
  assert.equal(R.normaliseer360Body({ geen: 'entry' }), null);
});

// ════════════════════════════════════════════════════════════════════════════
// 4 · Media
// ════════════════════════════════════════════════════════════════════════════

test('media via 360dialog: metadata + download via waba-v2 (lookaside-host vervangen), opslag in bucket', async () => {
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY, D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  fetchLog.length = 0; db.uploads.length = 0;
  nepFetch((url) => (url === 'https://waba-v2.360dialog.io/MEDIA1'
    ? { status: 200, body: { url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=MEDIA1&ext=1&hash=abc', mime_type: 'image/jpeg' } }
    : { status: 200, bytes: new Uint8Array([9, 9, 9, 9]) }));
  const r = await MD.downloadAndStoreMediaVoorLijn(PNID, 'MEDIA1', 'image', { messageId: 'm1' });
  assert.equal(r.ok, true);
  assert.equal(fetchLog[1].url, 'https://waba-v2.360dialog.io/whatsapp_business/attachments/?mid=MEDIA1&ext=1&hash=abc');
  assert.equal(fetchLog[1].init.headers['D360-API-KEY'], KEY);
  assert.match(db.uploads[0].path, /^inbound\/images\/\d{4}\/\d{2}\/[0-9a-f]{32}\.jpg$/);
  // Meta-lijn → Meta-pad (zonder token: nette fout, geen 360dialog-call).
  fetchLog.length = 0;
  const m = await MD.downloadAndStoreMediaVoorLijn('meta-lijn', 'X', 'image');
  assert.equal(m.ok, false);
  assert.match(m.error, /META_WHATSAPP_ACCESS_TOKEN/);
});

// ════════════════════════════════════════════════════════════════════════════
// 5 · module-context bij een gedeeld nummer
// ════════════════════════════════════════════════════════════════════════════

test('module-context: meerdere modules op het hoofdnummer → inkomend_module (leadsonderhoud); één rij → die rij', async () => {
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY, D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  db.module_config = [
    { module: 'events', phone_number_id: PNID, is_active: true },
    { module: 'leadsonderhoud', phone_number_id: PNID, is_active: true },
    { module: 'welkom', phone_number_id: PNID, is_active: true },
    { module: 'finance', phone_number_id: 'F1', is_active: true },
  ];
  assert.equal((await MC.getModuleContextByPhoneNumberId({ from }, PNID)).module, 'leadsonderhoud');
  assert.equal((await MC.getModuleContextByPhoneNumberId({ from }, 'F1')).module, 'finance');
  assert.equal(await MC.getModuleContextByPhoneNumberId({ from }, 'onbekend'), null);
});

// ════════════════════════════════════════════════════════════════════════════
// 6 · Onboarding
// ════════════════════════════════════════════════════════════════════════════

test('onboarding: geen WhatsApp-route; e-mail-fallback standaard UIT; tekst/HTML zonder verminking', async () => {
  zetEnv({ D360_API_KEY_HOOFDNUMMER: KEY, D360_PHONE_NUMBER_ID_HOOFDNUMMER: PNID });
  assert.equal((await OB.waRouteOnboarding(PNID)).wa, false);
  assert.equal((await OB.waRouteOnboarding('oude-onboarding-lijn')).wa, false);
  assert.equal(OB.mailFallbackAan(), false);
  process.env.ONBOARDING_MAIL_FALLBACK = 'true';
  assert.equal(OB.mailFallbackAan(), true);
  assert.equal(OB.vulTemplateTekst('Hoi {{1}}, start op {{2}}.', { 1: 'Jan', 2: 'maandag' }), 'Hoi Jan, start op maandag.');
  const html = OB.waTekstNaarHtml('*Welkom* bij de opleiding <script>\nKlik: https://x.nl/a?b=1');
  assert.match(html, /<b>Welkom<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<br>/);
  assert.match(html, /<a href="https:\/\/x\.nl\/a\?b=1"/);
  assert.deepEqual(await OB.stuurOnboardingMail({ customer: { email: '' }, tekst: 'x' }), { ok: false, reason: 'geen-email' });
});

test('onboarding-callers geven module:"onboarding" mee en controleren de route vóór verzenden', () => {
  for (const f of ['api/_lib/onboarding-invite.js', 'api/_lib/onboarding-template-send.js']) {
    const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.match(src, /module\s*:\s*'onboarding'/, f);
    assert.match(src, /waRouteOnboarding\(/, f);
    assert.match(src, /reason: 'wa-geen-nummer'/, f);
  }
  assert.match(readFileSync(new URL('../api/joost-send-autonomous.js', import.meta.url), 'utf8'), /module:\s+moduleKey/);
});

// ════════════════════════════════════════════════════════════════════════════
// 7 · inbox-webhook: gedeelde verwerking
// ════════════════════════════════════════════════════════════════════════════

test('inbox-webhook exporteert verwerkWhatsAppWebhookBody en de Meta-route gebruikt hem (bron meta)', () => {
  const src = readFileSync(new URL('../api/inbox-webhook.js', import.meta.url), 'utf8');
  assert.match(src, /export async function verwerkWhatsAppWebhookBody\(req, body, ctx = \{\}\)/);
  assert.match(src, /await verwerkWhatsAppWebhookBody\(req, body, \{ bron: 'meta' \}\)/);
  assert.match(src, /ctx\.bron === '360dialog' && ctx\.nummer/);
  // Signature-check van Meta staat er nog, vóór de verwerking.
  assert.ok(src.indexOf("verifyWebhookSignature(sigHeader, rawBody)") < src.indexOf("await verwerkWhatsAppWebhookBody(req, body, { bron: 'meta' })"));
});
