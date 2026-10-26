// tests/contentmachine.test.js — Contentmachine fase 1 (databank, invoer, bibliotheek).
//
//   1. core: slug, Vimeo, starttijd, invoer opschonen, beeldmaat, paden, seed-metadata
//   2. drops-endpoint: recht content.machine, maak (vrije slug), bewaar, archiveer, migratie-melding
//   3. assets-endpoint: upload-url, registreer (type aan de bytes), bijwerken, seed (idempotent)
//   4. bedrading: menu-item, allowlist, script-tag, vercel includeFiles, migratie

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maakFake, maakRes } from './_contentmachine-fake.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const fake = maakFake();
const auth = { user: { id: 'u1' }, toegestaan: true, gevraagd: [] };
mock.module('../api/supabase.js', {
  namedExports: {
    supabase: { from: fake.from },
    supabaseAdmin: { from: fake.from, storage: fake.storage },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
    verifyAdmin: async () => null,
    checkCronAuth: () => false,
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: { requirePermission: async (req, sleutel) => { auth.gevraagd.push(sleutel); return auth.toegestaan; } },
});

const C = await import('../api/_lib/contentmachine-core.js');
const D = await import('../api/contentmachine/drops.js');
const A = await import('../api/contentmachine/assets.js');

function reset() {
  fake.db.tabellen = { profiles: [{ id: 'u1', email: 'm@x.nl', full_name: 'Maxim', role: 'super_admin' }] };
  fake.db.ontbreekt = {}; fake.db.storage = {}; fake.db.log = [];
  auth.user = { id: 'u1' }; auth.toegestaan = true; auth.gevraagd = [];
}
async function roep(mod, { method = 'POST', query = {}, body = {} } = {}) {
  const res = maakRes();
  await mod.default({ method, query, body, headers: {} }, res);
  return res;
}

// ── 1. core ─────────────────────────────────────────────────────────────────
test('slug: dd-mm-jj, ongeldige datum = null, vrije slug telt op', () => {
  assert.equal(C.slugVanDatum('2026-10-22'), '22-10-26');
  assert.equal(C.slugVanDatum('2026-02-30'), null);
  assert.equal(C.slugVanDatum('22-10-2026'), null);
  assert.equal(C.datumVanSlug('22-10-26-2'), '2026-10-22');
  assert.equal(C.vrijeSlug('22-10-26', []), '22-10-26');
  assert.equal(C.vrijeSlug('22-10-26', ['22-10-26', '22-10-26-2']), '22-10-26-3');
  assert.ok(C.SLUG_RE.test('22-10-26-demo'));
  assert.ok(!C.SLUG_RE.test('22-10-2026'));
});

test('Vimeo: player-link met hash, vimeo.com/id/hash, kale id, geen vimeo', () => {
  assert.deepEqual(C.parseVimeo('https://player.vimeo.com/video/1238714790?h=4822ada5ee'),
    { vimeo_id: '1238714790', vimeo_hash: '4822ada5ee', vimeo_url: 'https://player.vimeo.com/video/1238714790?h=4822ada5ee' });
  assert.equal(C.parseVimeo('vimeo.com/123456/abcdef12').vimeo_hash, 'abcdef12');
  assert.equal(C.parseVimeo('https://vimeo.com/123456').vimeo_hash, null);
  assert.equal(C.parseVimeo('https://youtube.com/watch?v=1'), null);
  assert.equal(C.parseVimeo(''), null);
});

test('starttijd: mm:ss, h:mm:ss, seconden, onzin', () => {
  assert.equal(C.parseStart('10:00'), 600);
  assert.equal(C.parseStart('1:02:03'), 3723);
  assert.equal(C.parseStart('600'), 600);
  assert.equal(C.parseStart('10:75'), null);
  assert.equal(C.fmtStart(600), '10:00');
});

test('invoer opschonen: soort volgt de video, kanalen en trade begrensd', () => {
  const i = C.normaliseerInput({ vimeo_url: 'https://player.vimeo.com/video/1?h=abcdef12', start: '10:00', wat_gebeurde: '  x  ',
    trade_info: { paar: 'eurusd', richting: 'long', resultaat_r: '3,4' }, kanalen: ['pagina', 'hack'], gekozen_asset_ids: ['nee'], vreemd: 1 });
  assert.equal(i.vimeo_id, '1'); assert.equal(i.start_sec, 600); assert.equal(i.wat_gebeurde, 'x');
  assert.deepEqual(i.trade_info, { paar: 'EURUSD', richting: 'long', uitleg: '', resultaat_r: 3.4 });
  assert.deepEqual(i.kanalen, ['pagina']); assert.deepEqual(i.gekozen_asset_ids, []);
  assert.equal(i.vreemd, undefined);
  assert.equal(C.soortVanInput(i), 'training');
  const zonder = C.normaliseerInput({ wat_gebeurde: 'payout' });
  assert.equal(C.soortVanInput(zonder), 'update');
  assert.equal(zonder.start_sec, null);
  assert.deepEqual(zonder.kanalen, C.KANALEN);
  assert.equal(C.heeftTrade(zonder), false);
});

test('beeldmaat + type aan de bytes (alle seed-beelden)', () => {
  const map = join(ROOT, 'img/contentmachine/bibliotheek-seed');
  const bestanden = readdirSync(map);
  assert.equal(bestanden.length, 31);
  for (const f of bestanden) {
    const b = readFileSync(join(map, f));
    const m = C.beeldMaat(b);
    assert.ok(m && m.breedte > 100 && m.hoogte > 100, f);
    assert.equal(C.typeUitBytes(b), f.endsWith('.png') ? 'image/png' : 'image/jpeg', f);
  }
  assert.equal(C.typeUitBytes(Buffer.from('<svg></svg>')), null);
});

test('paden: drop vs bibliotheek, enkel eigen paden registreerbaar', () => {
  const u = '11111111-2222-3333-4444-555555555555';
  assert.equal(C.assetPad({ slug: '22-10-26', ext: 'png', uuid: u }), `drops/22-10-26/uploads/${u}.png`);
  assert.match(C.assetPad({ slug: null, ext: 'jpg', uuid: u, nu: new Date('2026-10-23T10:00:00Z') }), /^bibliotheek\/2026\/10\//);
  assert.ok(C.isEigenPad(`drops/22-10-26/uploads/${u}.png`));
  assert.ok(C.isEigenPad(`bibliotheek/2026/10/${u}.jpg`));
  assert.ok(!C.isEigenPad(`drops/../secret/${u}.png`));
  assert.ok(!C.isEigenPad('bibliotheek/seed/karl.png'));
});

test('seed-metadata: payout + persoon + toestemming voor Shani, Leslie, Karl, Luc, Maxim', () => {
  const k = C.seedMetadata('karl-alpha-24580.png');
  assert.equal(k.soort, 'payout'); assert.equal(k.persoon_naam, 'Karl'); assert.equal(k.toestemming_publiek, true);
  assert.match(k.bijschrift, /Alpha Capital · 24\.580/);
  assert.equal(C.seedMetadata('maxim-fundednext-2024-lijst.png').bijschrift.includes('2.024'), false, '2024 is een jaar, geen bedrag');
  assert.equal(C.seedMetadata('luc-discord-ftmo.png').persoon_naam, 'Luc');
  assert.equal(C.seedMetadata('team-lachend.jpg').soort, 'team');
  assert.equal(C.seedMetadata('mentor-student.jpg').soort, 'team');
  assert.equal(C.seedMetadata('zaal-certificaten.jpg').soort, 'masterclass');
  assert.equal(C.seedMetadata('chart-uitleg.jpg').soort, 'chart');
  for (const naam of ['shani', 'leslie', 'karl', 'luc', 'maxim']) assert.ok(C.TOESTEMMING_NAMEN.includes(naam));
  assert.equal(C.magPubliek({ persoon_naam: 'Jan', toestemming_publiek: false }), false);
  assert.equal(C.magPubliek({ persoon_naam: null }), true);
});

test('asset-patch: alleen toegelaten velden, tags genormaliseerd', () => {
  assert.deepEqual(C.normaliseerAssetPatch({ soort: 'payout', tags: 'FTMO, payout,ftmo', storage_path: 'x', toestemming_publiek: 'ja' }),
    { soort: 'payout', tags: ['ftmo', 'payout'], toestemming_publiek: false });
  assert.deepEqual(C.normaliseerAssetPatch({ soort: 'hack' }), {});
});

// ── 2. drops ────────────────────────────────────────────────────────────────
test('drops: recht content.machine, 403 zonder, 401 zonder login', async () => {
  reset();
  auth.toegestaan = false;
  assert.equal((await roep(D, { method: 'GET' })).statusCode, 403);
  assert.deepEqual(auth.gevraagd, ['content.machine']);
  auth.user = null;
  assert.equal((await roep(D, { method: 'GET' })).statusCode, 401);
});

test('drops: maak → concept met slug, tweede op dezelfde dag krijgt -2, lijst nieuwste eerst', async () => {
  reset();
  const r1 = await roep(D, { body: { actie: 'maak', datum: '2026-10-22', input: { wat_gebeurde: 'payout' } } });
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.body.drop.slug, '22-10-26'); assert.equal(r1.body.drop.status, 'concept'); assert.equal(r1.body.drop.soort, 'update');
  const r2 = await roep(D, { body: { actie: 'maak', datum: '2026-10-22', input: { vimeo_url: 'https://vimeo.com/5' } } });
  assert.equal(r2.body.drop.slug, '22-10-26-2'); assert.equal(r2.body.drop.soort, 'training');
  await roep(D, { body: { actie: 'maak', datum: '2026-10-29' } });
  const l = await roep(D, { method: 'GET' });
  assert.equal(l.statusCode, 200);
  assert.equal(l.body.drops[0].slug, '29-10-26');
  assert.equal((await roep(D, { body: { actie: 'maak', datum: 'gisteren' } })).statusCode, 400);
});

test('drops: bewaar werkt invoer en datum bij; gepubliceerd = vergrendeld; archiveer/herstel', async () => {
  reset();
  const { body: { drop } } = await roep(D, { body: { actie: 'maak', datum: '2026-10-22' } });
  const b = await roep(D, { body: { actie: 'bewaar', id: drop.id, datum: '2026-10-23', input: { wat_gebeurde: 'nieuw', trade_info: { paar: 'xauusd' } } } });
  assert.equal(b.statusCode, 200);
  assert.equal(b.body.drop.slug, '23-10-26'); assert.equal(b.body.drop.input.trade_info.paar, 'XAUUSD');
  const det = await roep(D, { method: 'GET', query: { id: drop.id } });
  assert.equal(det.body.drop.input.wat_gebeurde, 'nieuw'); assert.deepEqual(det.body.assets, []);
  const a = await roep(D, { body: { actie: 'archiveer', id: drop.id } });
  assert.equal(a.body.drop.status, 'gearchiveerd');
  assert.equal((await roep(D, { body: { actie: 'bewaar', id: drop.id, input: {} } })).statusCode, 409);
  const h = await roep(D, { body: { actie: 'herstel', id: drop.id } });
  assert.equal(h.body.drop.status, 'concept');
  fake.db.tabellen.content_drops[0].status = 'gepubliceerd';
  assert.equal((await roep(D, { body: { actie: 'bewaar', id: drop.id, input: {} } })).statusCode, 409);
});

test('drops: ontbrekende tabel → 409 MIGRATIE_NODIG', async () => {
  reset();
  fake.db.ontbreekt.content_drops = true;
  const r = await roep(D, { method: 'GET' });
  assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'MIGRATIE_NODIG');
});

test('drops: vimeo oEmbed (privé-link via vimeo.com/id/hash), fout = waarschuwing', async () => {
  let gevraagd = null;
  const ok = await D.vimeoInfo('https://player.vimeo.com/video/1238714790?h=4822ada5ee', async (u) => {
    gevraagd = u; return { ok: true, json: async () => ({ title: 'Live training', duration: 5400, thumbnail_url: 'https://i.vimeocdn.com/x.jpg' }) };
  });
  assert.match(decodeURIComponent(gevraagd), /vimeo\.com\/1238714790\/4822ada5ee/);
  assert.deepEqual([ok.titel, ok.duur, ok.vimeo_id], ['Live training', 5400, '1238714790']);
  const nok = await D.vimeoInfo('https://vimeo.com/1', async () => ({ ok: false, status: 403 }));
  assert.equal(nok.ok, true); assert.match(nok.waarschuwing, /403/);
  assert.equal((await D.vimeoInfo('https://example.com')).ok, false);
});

// ── 3. assets ───────────────────────────────────────────────────────────────
test('assets: upload-url enkel voor beelden, pad onder de drop', async () => {
  reset();
  const r = await roep(A, { body: { actie: 'upload-url', content_type: 'image/png', slug: '22-10-26' } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body.pad, /^drops\/22-10-26\/uploads\/[0-9a-f-]{36}\.png$/);
  assert.ok(r.body.token);
  assert.equal((await roep(A, { body: { actie: 'upload-url', content_type: 'application/pdf' } })).statusCode, 400);
});

test('assets: registreer controleert de bytes, leest de maat; geen beeld = weg', async () => {
  reset();
  const png = readFileSync(join(ROOT, 'img/contentmachine/bibliotheek-seed/karl-alpha-24580.png'));
  const pad = 'bibliotheek/2026/10/11111111-2222-3333-4444-555555555555.png';
  fake.db.storage[pad] = { bytes: png };
  const r = await roep(A, { body: { actie: 'registreer', pad, soort: 'payout', persoon_naam: 'Karl', toestemming_publiek: true } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.asset.breedte, r.body.asset.hoogte, r.body.asset.soort, r.body.asset.drop_id], [1410, 940, 'payout', null]);
  assert.match(r.body.asset.publieke_url, /\/content\/bibliotheek\//);
  const slecht = 'bibliotheek/2026/10/22222222-2222-3333-4444-555555555555.png';
  fake.db.storage[slecht] = { bytes: Buffer.from('<html>niet echt</html>') };
  const r2 = await roep(A, { body: { actie: 'registreer', pad: slecht } });
  assert.equal(r2.statusCode, 400);
  assert.equal(fake.db.storage[slecht], undefined, 'onecht bestand wordt verwijderd');
  assert.equal((await roep(A, { body: { actie: 'registreer', pad: '../x.png' } })).statusCode, 400);
  // bijwerken + lijst
  const b = await roep(A, { body: { actie: 'bijwerken', id: r.body.asset.id, bijschrift: 'Payout Karl', tags: 'alpha' } });
  assert.equal(b.body.asset.bijschrift, 'Payout Karl');
  const l = await roep(A, { method: 'GET', query: { bibliotheek: '1', soort: 'payout' } });
  assert.equal(l.body.assets.length, 1);
  await roep(A, { body: { actie: 'verwijder', id: r.body.asset.id } });
  assert.equal((await roep(A, { method: 'GET', query: { bibliotheek: '1' } })).body.assets.length, 0);
});

test('assets: seed laadt 31 beelden naar bibliotheek/seed/ en is idempotent', async () => {
  reset();
  const r = await roep(A, { body: { actie: 'seed' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.totaal, r.body.nieuw, r.body.al_aanwezig, r.body.fouten.length], [31, 31, 0, 0]);
  const rijen = fake.db.tabellen.content_assets;
  assert.ok(rijen.every((x) => x.storage_path.startsWith('bibliotheek/seed/') && x.drop_id === null && x.breedte > 0));
  const metToestemming = rijen.filter((x) => x.toestemming_publiek && x.persoon_naam).map((x) => x.persoon_naam);
  // Contentmachine 2.0: 12 masterclassfoto's met toestemming publiek, zonder namen.
  const mc = rijen.filter((x) => x.storage_path.startsWith('bibliotheek/seed/masterclass-'));
  assert.equal(mc.length, 12);
  assert.ok(mc.every((x) => x.soort === 'masterclass' && x.toestemming_publiek === true && x.persoon_naam === null && /Masterclass op kantoor/.test(x.bijschrift)));
  assert.deepEqual([...new Set(metToestemming)].sort(), ['Karl', 'Leslie', 'Luc', 'Maxim', 'Shani']);
  assert.equal(rijen.filter((x) => x.soort === 'payout').length, 13);
  assert.equal(Object.keys(fake.db.storage).length, 31);
  const nog = await roep(A, { body: { actie: 'seed' } });
  assert.deepEqual([nog.body.nieuw, nog.body.al_aanwezig], [0, 31]);
});

// ── 4. bedrading ────────────────────────────────────────────────────────────
test('bedrading: menu boven Trainingdrops, permKey, allowlist, script-tag, includeFiles', () => {
  const shell = lees('modules/shared/design-system/app-shell.js');
  const iCm = shell.indexOf("id: 'contentmachine'");
  assert.ok(iCm > 0 && iCm < shell.indexOf("id: 'trainingdrops'"));
  assert.match(shell, /id: 'contentmachine'.*permKey: 'content\.machine'.*tabs: \['Overzicht', 'Nieuwe drop', 'Bibliotheek'\]/);
  assert.match(lees('modules/klanten-v2/klanten-v2.js'), /'trainingdrops', 'contentmachine'/);
  assert.match(lees('modules/klanten-v2/index.html'), /views\/contentmachine-v2\.js\?v=\d+/);
  const v = JSON.parse(lees('vercel.json'));
  assert.equal(v.functions['api/contentmachine/assets.js'].includeFiles, 'img/contentmachine/bibliotheek-seed/**');
  const view = lees('modules/klanten-v2/views/contentmachine-v2.js');
  for (const t of ['Overzicht', 'Nieuwe drop', 'Bibliotheek']) assert.ok(view.includes(`VIEWS['contentmachine/${t}']`));
});

test('migratie: additief, RLS aan, geen publieke policy, bucket content', () => {
  const sql = lees('docs/sql-migrations/2026-10-23-contentmachine-fase1.sql').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/\bDROP\b|\bALTER TABLE public\.(?!content_|nieuwsbrief_)/i.test(sql));
  for (const t of ['content_drops', 'content_drop_versies', 'content_assets', 'nieuwsbrief_verzendingen']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON public\\.${t} FROM anon, authenticated`));
  }
  assert.ok(!/CREATE POLICY/i.test(sql));
  assert.match(sql, /VALUES \('content', 'content', true/);
});

// ── 5. de module rendert (jsdom) ────────────────────────────────────────────
test('view: Overzicht, Nieuwe drop en Bibliotheek renderen met data', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><div id="content"></div>', { runScripts: 'outside-only', url: 'https://crm.test/modules/klanten-v2/' });
  const w = dom.window;
  const antwoorden = {
    '/api/contentmachine/drops': { drops: [{ id: 'd1', slug: '22-10-26', datum: '2026-10-22', soort: 'training', status: 'gegenereerd', format_key: 'trade_ontleed', titel: 'Van H4 tot target', gewijzigd_op: '2026-10-23T10:00:00Z' }] },
    '/api/contentmachine/assets?bibliotheek=1': { assets: [{ id: 'a1', soort: 'payout', publieke_url: 'https://cdn/x.png', persoon_naam: 'Karl', toestemming_publiek: true, bijschrift: 'Payout <Karl>', tags: ['seed'], storage_path: 'bibliotheek/seed/x.png' }] },
  };
  w.DFO = { VIEWS: {}, render() {}, goTab() {} };
  w.KV = { authedJson: async (u) => antwoorden[u], toast() {} };
  w.eval(lees('modules/klanten-v2/views/contentmachine-v2.js'));
  const V = w.DFO.VIEWS;
  w.DFO.render = () => {};
  V['contentmachine/Overzicht']();
  await new Promise((r) => setTimeout(r, 10));
  const ov = V['contentmachine/Overzicht']();
  assert.match(ov, /22-10-26/); assert.match(ov, /De trade ontleed/); assert.match(ov, /Gegenereerd/);
  const nd = V['contentmachine/Nieuwe drop']();
  assert.match(nd, /Wat is er deze week gebeurd\?/); assert.match(nd, /Genereer alles/);
  await new Promise((r) => setTimeout(r, 10));
  const bib = V['contentmachine/Bibliotheek']();
  assert.match(bib, /Payout &lt;Karl&gt;/, 'bijschrift wordt ge-escaped');
  assert.match(bib, /Masterclass-beelden aanvullen/);
});
