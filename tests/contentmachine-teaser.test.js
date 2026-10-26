// tests/contentmachine-teaser.test.js — Contentmachine 2.0, fase 3 (nieuwsbrief-teaser + blokframe).
//   1. teaser: controle (lengte, 3 onderwerpen, nugget, open lus, PS met cadeau, beeld-blok) en de HTML
//   2. endpoints: naar GHL enkel met het mailbeeld; social 'samenvoegen'; nieuwsbrief opnieuw = schrijver
//   3. browser: de chartmotor is exact die van de website; het blokframe kiest het juiste blok;
//      het werkblad toont de teaser-velden en het beeldpaneel

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { maakFake, maakRes } from './_contentmachine-fake.js';
import { voorbeeldRegie, voorbeeldEditie, voorbeeldTeaser, ASSETS } from './_contentmachine-voorbeeld.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const fake = maakFake();
const ai = { antwoorden: [], aanroepen: [] };
mock.module('../api/supabase.js', {
  namedExports: {
    supabase: { from: fake.from },
    supabaseAdmin: { from: fake.from, storage: fake.storage },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'maxim@x.nl' } } }) } }),
    verifyAdmin: async () => null,
    checkCronAuth: () => false,
  },
});
mock.module('../api/_lib/requirePermission.js', { namedExports: { requirePermission: async () => true } });
mock.module('../api/_lib/anthropic-client.js', {
  namedExports: {
    anthropicStructuredOutput: async (o) => { ai.aanroepen.push(o); const a = ai.antwoorden.shift(); if (!a) throw new Error('geen nep-antwoord'); return typeof a === 'function' ? a(o) : a; },
    anthropicMessages: async () => { throw new Error('niet gebruikt'); },
  },
});

const R = await import('../api/_lib/nieuwsbrief-render.js');
const C = await import('../api/_lib/contentmachine-core.js');
const NB = await import('../api/contentmachine/nieuwsbrief.js');
const D = await import('../api/contentmachine/drops.js');
const GEN = await import('../api/contentmachine/genereer.js');

const ID = '99999999-9999-4999-8999-999999999999';
const editie = (over = {}) => ({ versie: 2, format_key: 'trade_ontleed', kernidee: 'k', regie: voorbeeldRegie(), ...voorbeeldEditie(), pagina: { ...voorbeeldEditie().pagina, thema: 'nacht' }, meta: { verboden_namen: [], waarschuwingen: [] }, ...over });
function reset({ status = 'goedgekeurd', output = editie() } = {}) {
  fake.db.tabellen = {
    profiles: [{ id: 'u1', email: 'maxim@x.nl', full_name: 'Maxim', role: 'super_admin' }],
    content_drops: [{ id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status, versie: 2, voorbeeld_token: 'abcdabcd-1234-4abc-8def-1234567890ab',
      format_key: 'trade_ontleed', input: { vimeo_id: '1238714790', start_sec: 600, wat_gebeurde: 'De DXY kantelde.' }, output, aangemaakt_op: '2026-10-22T10:00:00Z' }],
    content_drop_versies: [], content_assets: ASSETS.map((a) => ({ ...a })), nieuwsbrief_verzendingen: [], team_members: [],
  };
  fake.db.ontbreekt = {}; ai.antwoorden = []; ai.aanroepen = [];
}
async function roep(mod, { method = 'POST', query = {}, body = {} } = {}) {
  const res = maakRes();
  res.send = function (b) { this.body = b; return this; };
  await mod.default({ method, query, body, headers: { authorization: 'Bearer x' } }, res);
  return res;
}
const drop = () => fake.db.tabellen.content_drops[0];

// ── 1. teaser ───────────────────────────────────────────────────────────────
test('teaser: controle op lengte, onderwerpen, nugget, open lus, PS met cadeau en het beeld-blok', () => {
  const p = editie().pagina;
  assert.deepEqual(R.teaserFouten(voorbeeldTeaser(), p), []);
  assert.ok(R.teaserWoorden(voorbeeldTeaser()) >= 150 && R.teaserWoorden(voorbeeldTeaser()) <= 220);
  const f = R.teaserFouten(voorbeeldTeaser({ onderwerpen: ['a', 'a', 'b'], ps: 'Tot volgende week.', beeld_blok_index: 6, opener: 'kort', nugget: { titel: 'x', tekst: 'y' } }), p).join(' | ');
  for (const deel of ['3 verschillende', 'noem het cadeau', 'beeld_blok_index', 'hou het kort']) assert.ok(f.includes(deel), deel);
  assert.equal(R.isTeaser(voorbeeldTeaser()), true);
  assert.equal(R.isTeaser({ blokken: [] }), false);
});

test('teaser-HTML: echt logo, donker, één hoofdknop naar de pagina (src=nieuwsbrief), beeld met link, PS, disclaimer, uitschrijven', () => {
  const out = editie({ social: { bestanden: { nieuwsbrief: { url: 'https://cdn.test/nb.png?v=1' } } } });
  const r = R.renderNieuwsbrief({ drop: { slug: '22-10-26', datum: '2026-10-22' }, output: out, onderwerpIndex: 1 });
  assert.equal(r.onderwerp, voorbeeldTeaser().onderwerpen[1]);
  assert.equal(r.beeld, true);
  assert.ok(r.html.includes(R.LOGO_WIT));
  assert.match(r.html, /name="color-scheme" content="dark"/);
  assert.equal((r.html.match(/Lees de volledige weekeditie/g) || []).length, 1, 'één hoofdknop');
  assert.match(r.html, /training\.deforexopleiding\.nl\/22-10-26\?src=nieuwsbrief&amp;utm_source=nieuwsbrief&amp;utm_medium=email&amp;utm_campaign=drop-22-10-26&amp;utm_content=knop/);
  assert.match(r.html, /utm_content=beeld/);
  assert.match(r.html, /cdn\.test\/nb\.png/);
  assert.match(r.html, /Een wick door een niveau is geen break/);
  assert.match(r.html, /<b style="color:#D0A050;">PS<\/b>/);
  assert.match(r.html, /geen financieel advies/); assert.match(r.html, /\{\{unsubscribe_link\}\}/);
  assert.match(r.tekst, /Lees de volledige weekeditie: https:\/\/training/);
  assert.doesNotMatch(r.tekst, /\*\*/);
  const zonder = R.renderNieuwsbrief({ drop: { slug: '22-10-26', datum: '2026-10-22' }, output: editie() });
  assert.equal(zonder.beeld, false);
  assert.doesNotMatch(zonder.html, /utm_content=beeld/);
});

// ── 2. endpoints ────────────────────────────────────────────────────────────
test('GHL: een teaser zonder mailbeeld gaat niet naar GHL (409); met beeld wel', async () => {
  const env = { ...process.env };
  Object.assign(process.env, { GHL_PIT_TOKEN: 'pit-x', GHL_LOCATION_ID: 'loc1' });
  const echt = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, status: 201, text: async () => JSON.stringify(/builder$/.test(new URL(url).pathname) ? { redirect: 'tpl1' } : {}) });
  try {
    reset();
    const r = await roep(NB, { body: { actie: 'naar-ghl', id: ID } });
    assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'BEELD_ONTBREEKT');
    reset({ output: editie({ social: { bestanden: { nieuwsbrief: { url: 'https://cdn.test/nb.png' } } } }) });
    const ok = await roep(NB, { body: { actie: 'naar-ghl', id: ID } });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  } finally { globalThis.fetch = echt; process.env = env; }
});

test('social: het mailbeeld mag in Storage; samenvoegen houdt de rest, een nieuwe social-set houdt het mailbeeld', async () => {
  assert.ok(C.SOCIAL_NAAM_RE.test('nieuwsbrief'));
  assert.equal(C.socialPad('22-10-26', 'nieuwsbrief'), 'drops/22-10-26/social/nieuwsbrief.png');
  reset({ output: editie({ social: { stijl: 1, bestanden: { og: { url: 'x' } } } }) });
  const url = (naam) => fake.storage.from('content').getPublicUrl(`drops/22-10-26/social/${naam}.png`).data.publicUrl;
  const a = await roep(D, { body: { actie: 'social', id: ID, samenvoegen: true, bestanden: { nieuwsbrief: { url: url('nieuwsbrief'), breedte: 1200, hoogte: 750 } } } });
  assert.equal(a.statusCode, 200, JSON.stringify(a.body));
  assert.deepEqual(Object.keys(drop().output.social.bestanden).sort(), ['nieuwsbrief', 'og']);
  assert.equal(drop().output.social.stijl, 1);
  const b = await roep(D, { body: { actie: 'social', id: ID, stijl: 2, bestanden: { vierkant: { url: url('vierkant') } } } });
  assert.equal(b.statusCode, 200);
  assert.deepEqual(Object.keys(drop().output.social.bestanden).sort(), ['nieuwsbrief', 'vierkant'], 'og (oude set) weg, mailbeeld blijft');
});

test('nieuwsbrief opnieuw (2.0): de schrijver met dezelfde regie levert enkel de teaser', async () => {
  reset({ status: 'gegenereerd' });
  ai.antwoorden.push((o) => {
    assert.deepEqual(o.tool_input_schema.required, ['nieuwsbrief']);
    assert.ok(o.tool_input_schema.properties.nieuwsbrief.properties.open_lus, 'het teaser-schema');
    assert.match(o.system, /NIEUWSBRIEF = TEASER/);
    return { nieuwsbrief: voorbeeldTeaser({ onderwerpen: ['Nieuw A', 'Nieuw B', 'Nieuw C'] }) };
  });
  const r = await roep(GEN, { body: { id: ID, onderdeel: 'nieuwsbrief', instructie: 'scherper' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(drop().output.nieuwsbrief.onderwerpen, ['Nieuw A', 'Nieuw B', 'Nieuw C']);
  assert.deepEqual(drop().output.pagina.blokken, editie().pagina.blokken, 'pagina blijft');
});

// ── 3. browser ──────────────────────────────────────────────────────────────
test('chartmotor in het CRM = die van de website (zelfde candles, niveaus, fib)', () => {
  const w = {};
  vm.runInNewContext(lees('modules/klanten-v2/views/weekeditie-chart-v2.js'), { window: w });
  const ch = w.__weChart;
  const j = (x) => JSON.parse(JSON.stringify(x));
  // Referentiewaarden uit dfo-website lib/weekeditie-chart.ts (26 okt 2026).
  assert.deepEqual(j(ch.fragment('short', 'bos').set.D[65]), { o: 0.54018, h: 0.54048, l: 0.53788, c: 0.53858 });
  assert.equal(ch.fragment('short', 'bos').niveau, 0.53928);
  assert.equal(ch.ltfSet('long').L.l71, 0.5384352);
  assert.deepEqual(j(ch.miniReeks('long', 5, 54)[20]), { o: 0.97755, h: 0.97779, l: 0.97631, c: 0.97656 });
  assert.equal(ch.rOver100(30, 3), 20);
  assert.deepEqual(j([...ch.ACCOUNTGROOTTES]), [10000, 25000, 50000, 100000, 200000, 400000]);
  assert.match(lees('modules/klanten-v2/views/weekeditie-chart-v2.js'), /GEGENEREERD uit dfo-website lib\/weekeditie-chart\.ts/);
});

test('blokframe: kiest het aangewezen blok, anders het eerste interactieve, nooit het cadeau', () => {
  const w = {};
  vm.runInNewContext(lees('modules/klanten-v2/views/contentmachine-blokframe-v2.js'), { window: w });
  const p = editie().pagina;
  assert.equal(w.__cmBlokFrame.kiesBlok(p, 4).blok.type, 'rr-sliders');
  assert.equal(w.__cmBlokFrame.kiesBlok(p, 6).blok.type, 'replay-sweep-bos', 'cadeau → eerste interactieve');
  assert.equal(w.__cmBlokFrame.kiesBlok(p, undefined).index, 1);
  assert.equal(w.__cmBlokFrame.kiesBlok({ blokken: [{ type: 'hero' }, { type: 'citaat' }] }).blok.type, 'hero');
  assert.deepEqual([w.__cmBlokFrame.MAIL_W, w.__cmBlokFrame.MAIL_H], [1200, 750]);
});

test('werkblad: teaser-velden, woordenteller en het paneel "Beeld voor de mail"; scripts in de juiste volgorde', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><head></head><div id="content"></div>', { runScripts: 'outside-only', url: 'https://crm.test/' });
  const w = dom.window;
  const antwoorden = {
    [`/api/contentmachine/drops?id=${ID}`]: { drop: { id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status: 'gegenereerd', versie: 2, voorbeeld_token: 'abcdabcd-1234-4abc-8def-1234567890ab', input: { vimeo_id: '1' }, output: editie() }, assets: [], versies: [] },
    '/api/contentmachine/assets?bibliotheek=1': { assets: ASSETS },
    '/api/contentmachine/drops?blokken=1': { blokken: JSON.parse(lees('api/_lib/weekeditie-blokken.json')) },
  };
  w.DFO = { VIEWS: {}, render() {}, goTab() {} };
  w.KV = { authedJson: async (u) => antwoorden[u] || { html: '<p>teaser</p>', onderwerp: 'x' }, toast() {} };
  for (const f of ['contentmachine-v2', 'contentmachine-werkblad-v2', 'weekeditie-chart-v2', 'contentmachine-canvas-v2', 'contentmachine-blokframe-v2', 'contentmachine-weekeditie-v2']) w.eval(lees(`modules/klanten-v2/views/${f}.js`));
  await w.__cmWbOpen(ID);
  w.__cmWbTab('nieuwsbrief');
  const V = w.DFO.VIEWS['contentmachine/Overzicht'];
  let html = V();
  for (const t of ['Opener (Maxim)', 'De nugget', 'Open lus', 'PS (cadeau)', 'Frame van welk blok?', 'woorden', 'Lees de volledige weekeditie', 'Beeld voor de mail', 'nog geen beeld', 'Render en bewaar']) assert.ok(html.includes(t), t);
  w.__cmWeBeeldBlok('4');
  assert.equal(w.__cmWb.output.nieuwsbrief.beeld_blok_index, 4);
  assert.match(w.__cmWbAlleTeksten(), /NIEUWSBRIEF \(teaser\)/);
  const idx = lees('modules/klanten-v2/index.html');
  const pos = (n) => idx.indexOf(`views/${n}.js`);
  assert.ok(pos('contentmachine-werkblad-v2') < pos('weekeditie-chart-v2') && pos('weekeditie-chart-v2') < pos('contentmachine-canvas-v2') && pos('contentmachine-canvas-v2') < pos('contentmachine-blokframe-v2') && pos('contentmachine-blokframe-v2') < pos('contentmachine-weekeditie-v2'));
  html = V();
  assert.ok(html.includes('cm-wb-tab aan'));
});
