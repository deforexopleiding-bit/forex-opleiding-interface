// tests/contentmachine-social2.test.js — Contentmachine 2.0, fase 4 (social op het niveau van de IG-reeks).
//   1. controle: varianten (foto/donker/licht/data/kaart), stories hook→cta, carrousel 5-8, LinkedIn
//      zonder link/hashtag-spam, variatieregel t.o.v. de vorige 3, cijfers op data-beelden
//   2. captions per kanaal met de juiste link (src=ig-story / ig-bio / linkedin); browser = server
//   3. endpoints: schrijver-schema 2.0, post opnieuw = schrijver (+ vierkant), GET met captions,
//      goedkeuren blokkeert een verzonnen cijfer op een social-beeld, post-8 is een geldige naam
//   4. werkblad: editors met varianten + "Klaar om te posten"; scripts in de juiste volgorde

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maakFake, maakRes } from './_contentmachine-fake.js';
import { voorbeeldRegie, voorbeeldEditie, voorbeeldSocial, voorbeeldOutput, ASSETS, BEELD_FOTO, BEELD_CHART } from './_contentmachine-voorbeeld.js';

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

const S = await import('../api/_lib/contentmachine-social.js');
const RG = await import('../api/_lib/contentmachine-regie.js');
const G = await import('../api/_lib/contentmachine-generator.js');
const C = await import('../api/_lib/contentmachine-core.js');
const D = await import('../api/contentmachine/drops.js');
const GEN = await import('../api/contentmachine/genereer.js');

const ID = '99999999-9999-4999-8999-999999999999';
const editie = (over = {}) => ({ versie: 2, format_key: 'trade_ontleed', kernidee: 'k', regie: voorbeeldRegie(), ...voorbeeldEditie(), pagina: { ...voorbeeldEditie().pagina, thema: 'nacht' }, meta: { verboden_namen: [], waarschuwingen: [] }, ...over });
function reset({ status = 'gegenereerd', output = editie() } = {}) {
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
  await mod.default({ method, query, body, headers: { authorization: 'Bearer x' } }, res);
  return res;
}
const drop = () => fake.db.tabellen.content_drops[0];
const kopie = (o) => JSON.parse(JSON.stringify(o));

// ── 1. controle ─────────────────────────────────────────────────────────────
test('social 2.0: het voorbeeld is geldig; elke variant heeft zijn eigen eisen', () => {
  const o = editie();
  assert.deepEqual(S.socialFouten(o, { pagina: o.pagina, assets: ASSETS }), []);
  assert.equal(S.isSocialV2(o), true);
  assert.equal(S.isSocialV1(o), false);
  assert.equal(S.isSocialV1(voorbeeldOutput()), true, 'oude drops blijven op de v1-regels');

  const slecht = kopie(o);
  slecht.post.slides[0] = { variant: 'foto', titel: 'Zonder foto' };
  slecht.post.slides[1] = { variant: 'data', titel: 'Geen getal' };
  slecht.post.slides[2] = { variant: 'kaart', titel: 'Wijst naar het cadeau', blok_index: 6 };
  slecht.post.slides[3] = { variant: 'foto', titel: 'Een chart is geen masterclassfoto', beeld_asset_id: BEELD_CHART };
  slecht.post.slides[4] = { variant: 'neon', titel: 'Onbekend' };
  slecht.post.caption = 'Lees meer op https://training.deforexopleiding.nl/22-10-26';
  slecht.post.hashtags = ['a', 'b', 'c', 'd', 'e', 'f'];
  slecht.stories = [slecht.stories[1], slecht.stories[0], slecht.stories[3]];
  slecht.linkedin.tekst = 'Eén regel met #hashtag';
  slecht.linkedin.hashtags = ['a', 'b', 'c', 'd'];
  slecht.vierkant.titel = 'Kijk op www.deforexopleiding.nl';
  const f = S.socialFouten(slecht, { pagina: o.pagina, assets: ASSETS }).join(' | ');
  for (const deel of ['post.slides[0]: variant foto heeft een beeld', 'post.slides[1]: variant data heeft een getal', 'post.slides[2]: variant kaart', 'masterclass-/teamfoto (geen chart)', 'post.slides[4].variant',
    'post.caption: geen link', 'post.hashtags: max 5', 'stories: de eerste is de hook', 'linkedin.tekst: geen hashtags', 'hook + 3-5 korte alinea', 'linkedin.hashtags: max 3', 'vierkant.titel: geen links']) assert.ok(f.includes(deel), deel);
  // bij bewaren (geen assetlijst): enkel nagaan dat er een foto gekozen is
  assert.deepEqual(S.socialFouten(o, { pagina: o.pagina }), []);
});

test('variatieregel: de combinatie slide 1 | vierkant | story 1 | LinkedIn ≠ één van de vorige 3', () => {
  const o = editie();
  assert.equal(S.socialCombinatie(o), 'foto|donker|foto|licht');
  const vorige = [{ slug: 'a', output: editie({ ...voorbeeldSocial({ vierkant: { variant: 'licht', titel: 'x' } }) }) }, { slug: '15-10-26', output: editie() }];
  assert.match(S.socialVariatieFout(o, vorige), /dezelfde variant-combinatie \(foto\|donker\|foto\|licht\) als 15-10-26/);
  assert.equal(S.socialVariatieFout(o, [{ slug: 'a', output: {} }, { slug: 'b', output: {} }, { slug: 'c', output: {} }, { slug: 'd', output: editie() }]), null, 'enkel de vorige 3');
  const v = RG.valideerV2(o, { metVideo: true, assets: ASSETS, vorige: [{ slug: '15-10-26', output: editie() }], regie: voorbeeldRegie(), input: {} });
  assert.ok(v.fouten.some((x) => x.includes('variant-combinatie')));
});

test('cijfers op data-beelden: enkel uit de feitenbank/invoer (48,5 mag, 73,2 niet)', () => {
  const o = editie();
  assert.deepEqual(RG.valideerV2(o, { metVideo: true, assets: ASSETS, regie: voorbeeldRegie(), input: {} }).cijfers, []);
  const x = kopie(o); x.post.slides[4].getal.waarde = 73.2;
  const c = RG.valideerV2(x, { metVideo: true, assets: ASSETS, regie: voorbeeldRegie(), input: {} }).cijfers;
  assert.deepEqual(c, [{ pad: 'post[4].getal', waarde: 73.2 }]);
  assert.deepEqual(RG.valideerV2(x, { metVideo: true, assets: ASSETS, regie: voorbeeldRegie(), input: { wat_gebeurde: 'Winrate 73,2% deze maand' } }).cijfers, []);
  assert.deepEqual(RG.valideerV2(x, { metVideo: true, assets: ASSETS, onderdelen: ['linkedin'], input: {} }).cijfers, [], 'enkel het onderdeel dat opnieuw is');
});

// ── 2. captions ─────────────────────────────────────────────────────────────
test('captions: juiste link per kanaal, "link in bio", LinkedIn met link en max 3 hashtags', async () => {
  const c = S.captions(editie(), '22-10-26');
  assert.match(c.instagram_story_link, /^https:\/\/training\.deforexopleiding\.nl\/22-10-26\?src=ig-story&utm_source=instagram&utm_medium=social&utm_campaign=drop-22-10-26$/);
  assert.match(c.instagram_bio_link, /\?src=ig-bio&/);
  assert.match(c.instagram_post, /link in bio\n\n#forex #trading #deforexopleiding$/);
  assert.doesNotMatch(c.instagram_post, /https?:/);
  assert.match(c.linkedin, /👉 https:\/\/training\.deforexopleiding\.nl\/22-10-26\?src=linkedin&utm_source=linkedin/);
  assert.match(c.linkedin, /#trading #forex$/);
  assert.equal(c.instagram_story_sticker, 'Lees de weekeditie');
  assert.equal(S.korteUrl('22-10-26'), 'training.deforexopleiding.nl/22-10-26');

  // de browser rekent exact hetzelfde
  const w = await browser();
  w.eval(lees('modules/klanten-v2/views/contentmachine-social2-v2.js'));
  assert.deepEqual(JSON.parse(JSON.stringify(w.__cmSocial2.captions(editie(), '22-10-26'))), c);
  assert.equal(w.__cmSocial2.isV2(editie()), true);
  assert.equal(w.__cmSocial2.isV2(voorbeeldOutput()), false);
});

// ── 3. endpoints ────────────────────────────────────────────────────────────
test('schrijver-schema 2.0: varianten voor elk beeld; post bevat het vierkant; post-8 is een geldige naam', () => {
  const s = RG.schrijverSchema(voorbeeldRegie());
  assert.deepEqual(s.properties.stories.items.properties.variant.enum, S.VARIANTEN);
  assert.equal(s.properties.post.properties.slides.maxItems, 8);
  assert.deepEqual(s.properties.vierkant.properties.variant.enum, S.VARIANTEN);
  assert.equal(s.properties.linkedin.properties.hashtags.maxItems, 3);
  assert.deepEqual(Object.keys(RG.schrijverSchema(voorbeeldRegie(), { onderdelen: ['post'] }).properties), ['post', 'vierkant']);
  assert.match(RG.schrijverPrompt(), /SOCIAL = de stijl van de Instagram-reeks/);
  assert.ok(C.SOCIAL_NAAM_RE.test('post-8') && !C.SOCIAL_NAAM_RE.test('post-9'));
  assert.equal(G.valideerOutput(editie(), { assets: ASSETS, onderdelen: ['stories', 'post', 'linkedin'] }).ok, true);
});

test('genereer { onderdeel: "post" } in een Weekeditie = de schrijver met de regie (carrousel + vierkant)', async () => {
  reset();
  const nieuw = voorbeeldSocial();
  nieuw.post.slides[1] = { ...nieuw.post.slides[1], titel: 'Eerst **de grote lijn.**' };
  nieuw.vierkant = { variant: 'licht', eyebrow: 'Weekeditie', titel: 'Een wick is **geen break.**' };
  ai.antwoorden.push({ post: nieuw.post, vierkant: nieuw.vierkant });
  const r = await roep(GEN, { body: { id: ID, onderdeel: 'post', instructie: 'meer data' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ai.aanroepen.length, 1);
  assert.match(JSON.stringify(ai.aanroepen[0].messages), /Schrijf ENKEL: post\. Instructie van Maxim: meer data/);
  assert.deepEqual(Object.keys(ai.aanroepen[0].tool_input_schema.properties).sort(), ['post', 'vierkant']);
  assert.equal(drop().output.post.slides[1].titel, 'Eerst **de grote lijn.**');
  assert.equal(drop().output.vierkant.variant, 'licht');
  assert.equal(drop().output.stories.length, 4, 'de rest blijft');
});

test('GET ?id geeft de captions mee; goedkeuren blokkeert een verzonnen cijfer op een social-beeld', async () => {
  reset();
  const g = await roep(D, { method: 'GET', query: { id: ID } });
  assert.equal(g.statusCode, 200);
  assert.match(g.body.captions.instagram_story_link, /src=ig-story/);
  const x = editie(); x.post.slides[4].getal.waarde = 73.2;
  reset({ output: x });
  const k = await roep(D, { body: { actie: 'goedkeuren', id: ID } });
  assert.equal(k.statusCode, 409);
  assert.match(JSON.stringify(k.body), /social\.post\[4\]\.getal/);
  reset({ output: editie({ ...voorbeeldOutput(), versie: undefined, regie: undefined, pagina: voorbeeldOutput().pagina }) });
  const v1 = await roep(D, { method: 'GET', query: { id: ID } });
  assert.equal(v1.body.captions, undefined, 'oude drops: geen captions 2.0');
});

test('bewaren: social 2.0 wordt gecontroleerd (variant data zonder getal = 400)', async () => {
  reset();
  const o = kopie(drop().output); o.post.slides[4] = { variant: 'data', titel: 'x' };
  const b = await roep(D, { body: { actie: 'bewaar-output', id: ID, versie: 2, output: o } });
  assert.equal(b.statusCode, 400);
  assert.match(b.body.error, /variant data heeft een getal/);
  const ok = kopie(drop().output); ok.post.slides[1].titel = 'Eerst **de H4.**';
  assert.equal((await roep(D, { body: { actie: 'bewaar-output', id: ID, versie: 2, output: ok } })).statusCode, 200);
});

// ── 4. browser ──────────────────────────────────────────────────────────────
async function browser(extra = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><head></head><div id="content"></div>', { runScripts: 'outside-only', url: 'https://crm.test/' });
  const w = dom.window;
  Object.assign(w, extra);
  return w;
}

test('werkblad: editors met varianten en "Klaar om te posten" per kanaal; oude drops houden de oude editor', async () => {
  const w = await browser();
  const antwoorden = {
    [`/api/contentmachine/drops?id=${ID}`]: { drop: { id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status: 'gegenereerd', versie: 2, voorbeeld_token: 'abcdabcd-1234-4abc-8def-1234567890ab', input: { vimeo_id: '1' }, output: editie() }, assets: [], versies: [] },
    '/api/contentmachine/assets?bibliotheek=1': { assets: ASSETS },
    '/api/contentmachine/drops?blokken=1': { blokken: JSON.parse(lees('api/_lib/weekeditie-blokken.json')) },
  };
  w.DFO = { VIEWS: {}, render() {}, goTab() {} };
  w.KV = { authedJson: async (u) => antwoorden[u] || { html: '<p>x</p>', onderwerp: 'x' }, toast() {} };
  for (const f of ['contentmachine-v2', 'contentmachine-werkblad-v2', 'weekeditie-chart-v2', 'contentmachine-canvas-v2', 'contentmachine-blokframe-v2', 'contentmachine-social2-v2', 'contentmachine-weekeditie-v2']) w.eval(lees(`modules/klanten-v2/views/${f}.js`));
  await w.__cmWbOpen(ID);
  const V = w.DFO.VIEWS['contentmachine/Overzicht'];
  w.__cmWbTab('post');
  let html = V();
  for (const t of ['Slide 1 / 6', 'Variant', 'Data (groot getal)', 'Blok van de pagina', 'Getal', 'Vierkant 1080×1080', 'Klaar om te posten', 'Instagram-caption', 'Link in bio (deze week)', 'src=ig-bio']) assert.ok(html.includes(t), t);
  w.__cmWbTab('stories');
  html = V();
  for (const t of ['Story 4 · Naar de weekeditie', 'Tekst op de linksticker', 'Link voor de linksticker', 'src=ig-story']) assert.ok(html.includes(t), t);
  w.__cmWbTab('linkedin');
  html = V();
  for (const t of ['LinkedIn-beeld 1080×1350', 'Hashtags (max 3)', 'LinkedIn-post (met link)', 'src=linkedin']) assert.ok(html.includes(t), t);
  // variant wisselen naar data zet een leeg getal klaar
  w.__cmS2Variant('vierkant', 'data');
  assert.equal(w.__cmWb.output.vierkant.variant, 'data');
  assert.deepEqual(JSON.parse(JSON.stringify(w.__cmWb.output.vierkant.getal)), { waarde: null, label: '' });
  w.__cmS2Variant('linkedin.beeld', 'kaart');
  assert.equal(w.__cmWb.output.linkedin.beeld.blok_index, 1, 'eerste interactieve blok');
  assert.match(w.__cmWbAlleTeksten(), /Linksticker \(Lees de weekeditie\): https:\/\/training\.deforexopleiding\.nl\/22-10-26\?src=ig-story/);

  const idx = lees('modules/klanten-v2/index.html');
  const pos = (n) => idx.indexOf(`views/${n}.js`);
  assert.ok(pos('contentmachine-blokframe-v2') < pos('contentmachine-social2-v2') && pos('contentmachine-social2-v2') < pos('contentmachine-social-v2'));
});

test('renderer: formaten en namen; de oude renderer geeft v2-drops door aan social2', async () => {
  const w = await browser();
  w.eval(lees('modules/klanten-v2/views/contentmachine-social2-v2.js'));
  assert.deepEqual(JSON.parse(JSON.stringify(w.__cmSocial2.FORMATEN)), { story: [1080, 1920], post: [1080, 1350], vierkant: [1080, 1080], linkedin: [1080, 1350], og: [1200, 630] });
  const bron = lees('modules/klanten-v2/views/contentmachine-social-v2.js');
  assert.match(bron, /window\.__cmSocial2\.isV2\(output\)/);
  const s2 = lees('modules/klanten-v2/views/contentmachine-social2-v2.js');
  for (const t of ['SWIPE →', 'LINK IN BIO →', '@deforexopleiding.nl', 'story-${i + 1}', 'post-${i + 1}']) assert.ok(s2.includes(t), t);
  void BEELD_FOTO;
});
