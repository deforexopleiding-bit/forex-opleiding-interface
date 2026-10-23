// tests/contentmachine-social.test.js — Contentmachine fase 3 (social-rendering).
//
//   1. zip-schrijver: CRC32, geldige structuur (lokale + centrale headers, einde)
//   2. tekst-wrap/auto-grootte met een nep-canvas
//   3. endpoints: social-upload-url (pad per drop, upsert), drops 'social' (enkel eigen URL's)
//   4. bedrading: script geladen, fonts zelf-gehost met licentie

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maakFake, maakRes } from './_contentmachine-fake.js';
import { voorbeeldOutput } from './_contentmachine-voorbeeld.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const fake = maakFake();
mock.module('../api/supabase.js', {
  namedExports: {
    supabase: { from: fake.from },
    supabaseAdmin: { from: fake.from, storage: fake.storage },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
    verifyAdmin: async () => null,
    checkCronAuth: () => false,
  },
});
mock.module('../api/_lib/requirePermission.js', { namedExports: { requirePermission: async () => true } });
const A = await import('../api/contentmachine/assets.js');
const D = await import('../api/contentmachine/drops.js');
const C = await import('../api/_lib/contentmachine-core.js');

async function laadSocial() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', url: 'https://crm.test/' });
  dom.window.TextEncoder = TextEncoder;
  dom.window.eval(lees('modules/klanten-v2/views/contentmachine-social-v2.js'));
  return dom.window;
}

test('zip: CRC32 klopt en de zip is geldig (unzip -t als die er is)', async () => {
  const w = await laadSocial();
  const S = w.__cmSocial;
  assert.equal(S.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const a = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const zip = S.maakZip([{ naam: 'story-1.png', data: a }, { naam: 'teksten.txt', data: new TextEncoder().encode('héllo') }]);
  const dv = new DataView(zip.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);
  assert.equal(dv.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(dv.getUint16(zip.length - 22 + 10, true), 2, 'twee bestanden');
  const dir = mkdtempSync(join(tmpdir(), 'cmzip-'));
  writeFileSync(join(dir, 't.zip'), zip);
  try {
    const uit = execFileSync('unzip', ['-t', join(dir, 't.zip')], { encoding: 'utf8' });
    assert.match(uit, /No errors detected/);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e; // unzip niet geïnstalleerd: structuurcontrole hierboven volstaat
  }
});

test('tekst: wrap respecteert de breedte, **accent** en auto-grootte binnen maxRegels', async () => {
  const w = await laadSocial();
  const T = w.__cmSocial._templates;
  // nep-canvas: elke letter = 0,5 × fontgrootte breed
  const ctx = { font: '900 100px X', letterSpacing: '0px', fillStyle: '', textBaseline: '', calls: [],
    measureText(t) { const px = Number(/(\d+)px/.exec(this.font)[1]); return { width: t.length * px * 0.5 }; },
    fillText(t, x, y) { this.calls.push([t, this.fillStyle]); } };
  const r = T.tekstBlok(ctx, 'De dollar **draait** echt', { x: 0, y: 0, w: 600, max: 120, min: 40, maxRegels: 2 });
  assert.ok(r.regels.length <= 2);
  assert.ok(r.px <= 120 && r.px >= 40);
  assert.ok(ctx.calls.some(([t, kleur]) => t === 'draait' && kleur === '#D0A050'), 'accent in goud');
  const lang = T.tekstBlok(ctx, 'een twee drie vier vijf zes zeven acht negen tien elf twaalf dertien', { x: 0, y: 0, w: 300, max: 60, min: 40, maxRegels: 2 });
  assert.equal(lang.regels.length, 2);
  assert.match(lang.regels[1][lang.regels[1].length - 1].woord, /…$/, 'afgekapt met …');
  assert.equal(w.__cmSocial.STIJLEN.length, 3);
  assert.equal(w.__cmSocial.standaardStijl({ slug: '22-10-26' }, { social: { stijl: 2 } }), 2);
});

test('social-upload-url: pad drops/<slug>/social/<naam>.png, ongeldige naam geweigerd', async () => {
  fake.db.tabellen = { profiles: [{ id: 'u1' }], content_drops: [{ id: '99999999-9999-4999-8999-999999999999', slug: '22-10-26', status: 'gegenereerd', versie: 2, output: voorbeeldOutput() }] };
  const res = maakRes();
  await A.default({ method: 'POST', body: { actie: 'social-upload-url', drop_id: '99999999-9999-4999-8999-999999999999', naam: 'story-2' }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pad, 'drops/22-10-26/social/story-2.png');
  assert.match(res.body.publieke_url, /\/content\/drops\/22-10-26\/social\/story-2\.png$/);
  const slecht = maakRes();
  await A.default({ method: 'POST', body: { actie: 'social-upload-url', drop_id: '99999999-9999-4999-8999-999999999999', naam: '../x' }, headers: {} }, slecht);
  assert.equal(slecht.statusCode, 400);
  assert.equal(C.socialPad('22-10-26', 'post-8'), null);
});

test("drops 'social': enkel eigen Storage-URL's, geen nieuwe versie", async () => {
  const id = '99999999-9999-4999-8999-999999999999';
  fake.db.tabellen = { profiles: [{ id: 'u1' }], content_drops: [{ id, slug: '22-10-26', status: 'gepubliceerd', versie: 5, output: voorbeeldOutput() }], content_drop_versies: [] };
  const res = maakRes();
  await D.default({ method: 'POST', body: { actie: 'social', id, stijl: 4, bestanden: {
    og: { url: 'https://cdn.test/content/drops/22-10-26/social/og.png?v=1', breedte: 1200, hoogte: 630 },
    'story-1': { url: 'https://evil.test/content/drops/22-10-26/social/story-1.png' },
    hack: { url: 'https://x/content/drops/22-10-26/social/hack.png' },
  } }, headers: {} }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const d = fake.db.tabellen.content_drops[0];
  assert.deepEqual(Object.keys(d.output.social.bestanden), ['og']);
  assert.equal(d.output.social.stijl, 1);
  assert.equal(d.versie, 5);
  assert.equal(fake.db.tabellen.content_drop_versies.length, 0);
  assert.equal(d.output.pagina.hero_titel, 'De dollar draait.', 'rest van de output blijft');
});

test('bedrading fase 3: script geladen, fonts zelf-gehost + OFL', () => {
  assert.match(lees('modules/klanten-v2/index.html'), /views\/contentmachine-social-v2\.js\?v=\d+/);
  for (const w of [500, 700, 800, 900]) assert.ok(existsSync(join(ROOT, `img/contentmachine/fonts/inter-latin-${w}-normal.woff2`)), String(w));
  assert.ok(existsSync(join(ROOT, 'img/contentmachine/fonts/OFL-inter.txt')));
  const src = lees('modules/klanten-v2/views/contentmachine-social-v2.js');
  assert.ok(!/https?:\/\/(cdn|unpkg|fonts\.g)/.test(src), 'geen externe code of fonts');
});
