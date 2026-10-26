// tests/contentmachine-generator.test.js — Contentmachine fase 2 (generator + werkblad).
//
//   1. strategiekennis: docs/ en api/_lib gelijk
//   2. formats + rotatie, schema-validatie
//   3. grenzen: verboden woorden (met ontkenning), namen zonder toestemming, Dave enkel bij het cadeau
//   4. uniciteit (gelijkenis met vorige drops)
//   5. nieuwsbrief-render: UTM, disclaimer, uitschrijflink, naam enkel met toestemming, escaping
//   6. endpoints: genereer (herstelronde, modelketen, versie, laatst_gebruikt_op), goedkeuren
//      (geblokkeerd bij grenzen), publiceer, bewaar-output (versieconflict), versie-terug, voorbeeld
//   7. werkblad rendert (jsdom)

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maakFake, maakRes } from './_contentmachine-fake.js';
import { voorbeeldOutput, voorbeeldRegie, voorbeeldEditie, ASSETS, BEELD_CHART, BEELD_PAYOUT, BEELD_ZONDER } from './_contentmachine-voorbeeld.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const fake = maakFake();
const auth = { user: { id: 'u1' }, toegestaan: true };
const ai = { antwoorden: [], aanroepen: [], modelFout: new Set() };
mock.module('../api/supabase.js', {
  namedExports: {
    supabase: { from: fake.from },
    supabaseAdmin: { from: fake.from, storage: fake.storage },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
    verifyAdmin: async () => null,
    checkCronAuth: () => false,
  },
});
mock.module('../api/_lib/requirePermission.js', { namedExports: { requirePermission: async () => auth.toegestaan } });
mock.module('../api/_lib/anthropic-client.js', {
  namedExports: {
    anthropicStructuredOutput: async (o) => {
      ai.aanroepen.push(o);
      if (ai.modelFout.has(o.model)) {
        const e = new Error('model not found'); e.code = 'ANTHROPIC_API_ERROR'; e.status = 404; throw e;
      }
      const a = ai.antwoorden.shift();
      if (!a) throw new Error('geen nep-antwoord meer');
      return typeof a === 'function' ? a(o) : a;
    },
    anthropicMessages: async () => { throw new Error('niet gebruikt'); },
  },
});

const G = await import('../api/_lib/contentmachine-generator.js');
const R = await import('../api/_lib/nieuwsbrief-render.js');
const O = await import('../api/_lib/contentmachine-opslag.js');
const K = await import('../api/_lib/dfo-strategie-kennis.js');
const GEN = await import('../api/contentmachine/genereer.js');
const D = await import('../api/contentmachine/drops.js');
const NB = await import('../api/contentmachine/nieuwsbrief.js');

const ID = '99999999-9999-4999-8999-999999999999';
function reset({ status = 'concept', output = null, versie = 1 } = {}) {
  fake.db.tabellen = {
    profiles: [{ id: 'u1', email: 'm@x.nl', full_name: 'Maxim', role: 'super_admin' }],
    content_drops: [{ id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status, versie, format_key: output ? output.format_key : null,
      input: { vimeo_id: '1238714790', vimeo_hash: '4822ada5ee', vimeo_titel: 'Live training', duur: 2100, start_sec: 600, wat_gebeurde: 'De DXY kantelde.', trade_info: { paar: 'GBPUSD', richting: 'short', uitleg: '', resultaat_r: 3.4 }, gekozen_asset_ids: [], kanalen: ['pagina', 'nieuwsbrief', 'stories', 'post', 'linkedin'] },
      output, aangemaakt_op: '2026-10-22T10:00:00Z' }],
    content_drop_versies: [],
    content_assets: ASSETS.map((a) => ({ ...a })),
    team_members: [{ name: 'Kjento Biebuyck', is_active: true }, { name: 'Dave Heylen', is_active: true }, { name: 'Maxim Delombaerde', is_active: true }, { name: 'Leslie X', is_active: true }],
  };
  fake.db.ontbreekt = {}; fake.db.log = [];
  auth.user = { id: 'u1' }; auth.toegestaan = true;
  ai.antwoorden = []; ai.aanroepen = []; ai.modelFout = new Set();
}
async function roep(mod, { method = 'POST', query = {}, body = {} } = {}) {
  const res = maakRes();
  res.send = function (b) { this.body = b; return this; };
  await mod.default({ method, query, body, headers: {} }, res);
  return res;
}
const drop = () => fake.db.tabellen.content_drops[0];

// ── 1. kennis ───────────────────────────────────────────────────────────────
test('strategiekennis: de JS-kopie is gelijk aan docs/dfo-strategie-kennis.md', () => {
  const md = lees('docs/dfo-strategie-kennis.md').split('<!-- KENNIS-START -->')[1].split('<!-- KENNIS-EINDE -->')[0].trim();
  assert.equal(K.DFO_STRATEGIE_KENNIS, md);
  assert.match(K.DFO_STRATEGIE_KENNIS, /71%/);
  assert.ok(G.systeemPrompt().includes(K.DFO_STRATEGIE_KENNIS));
});

// ── 2. formats + schema ─────────────────────────────────────────────────────
test('rotatie: nooit het format van één van de vorige 3 drops', () => {
  assert.equal(G.FORMATS.length, 8);
  const vorige = [{ format_key: 'het_bewijs' }, { format_key: 'vooruitblik' }, { format_key: 'trade_ontleed' }, { format_key: 'mythe' }, { format_key: 'een_regel_diep' }];
  const ok = G.toegelatenFormats(vorige);
  for (const k of ['het_bewijs', 'vooruitblik', 'trade_ontleed']) assert.ok(!ok.includes(k), k);
  assert.ok(ok.includes('een_regel_diep'), 'de 5e vorige telt niet');
  assert.equal(G.toegelatenFormats([]).length, 8);
});

test('schema: de voorbeeld-output is geldig; fouten worden benoemd', () => {
  const ids = ASSETS.map((a) => a.id);
  assert.deepEqual(G.valideerOutput(voorbeeldOutput(), { assetIds: ids }), { ok: true, fouten: [] });
  const fout = voorbeeldOutput();
  fout.stories = fout.stories.slice(0, 2);
  fout.nieuwsbrief.blokken[0].type = 'chart';
  fout.nieuwsbrief.onderwerpen = ['a', 'a', 'b'];
  fout.post.slides = fout.post.slides.slice(0, 3);
  fout.pagina.kaarten[0].beeld_asset_id = 'bestaat-niet';
  const v = G.valideerOutput(fout, { assetIds: ids, toegelaten: ['vooruitblik'] });
  assert.equal(v.ok, false);
  const tekst = v.fouten.join(' | ');
  for (const deel of ['stories: 3 tot 5', 'begin met opener', '3 verschillende', 'post.slides: 5 tot 7', 'onbekend beeld-id', 'niet toegelaten']) assert.ok(tekst.includes(deel), deel);
  const quiz = voorbeeldOutput();
  quiz.nieuwsbrief.blokken.push({ type: 'quiz', vraag: 'Wat zou jij doen?', opties: ['Kopen', 'Wachten'] });
  assert.match(G.valideerOutput(quiz).fouten.join(), /pagina\.quiz/);
  // het tool-schema bevat alle onderdelen
  assert.deepEqual(G.OUTPUT_SCHEMA.required, ['format_key', 'kernidee', 'pagina', 'nieuwsbrief', 'stories', 'post', 'vierkant', 'linkedin']);
  assert.deepEqual(Object.keys(G.onderdeelSchema('post').properties), ['post', 'vierkant']);
});

// ── 3. grenzen ──────────────────────────────────────────────────────────────
test('grenzen: verboden woorden worden gevonden, ontkenning ("geen beloftes over snel rijk") niet', () => {
  assert.deepEqual(G.controleerGrenzen(voorbeeldOutput()), []);
  const slecht = {
    a: 'Gegarandeerd resultaat!!', b: 'Makkelijk geld verdienen', c: 'Bouw passief inkomen op', d: 'Laatste kans op deze deal',
    e: 'Nu met korting', f: 'Onze swingtrade van de week', g: 'Haal 10% per maand', h: 'Trading zonder risico', i: 'Grote verkoop vandaag',
  };
  const regels = G.controleerGrenzen(slecht).map((x) => x.pad + ':' + x.regel);
  for (const k of Object.keys(slecht)) assert.ok(regels.some((r) => r.startsWith(k + ':')), `${k} niet gevonden: ${regels}`);
  assert.deepEqual(G.controleerGrenzen({ a: 'Geen beloftes over snel rijk worden.', b: 'Dit is geen passief inkomen.', c: 'We verkopen op de 71%-zone.' }), []);
  assert.equal(G.controleerGrenzen({ a: 'Wil je snel rijk worden?' }).length, 1);
});

test('grenzen: namen zonder toestemming (hoofdlettergevoelig) en Dave enkel bij het cadeau', () => {
  const namen = O.verbodenNamenUit({ teamNamen: ['Kjento Biebuyck', 'Dave Heylen', 'Maxim D', 'Leslie X', 'events@x.nl'], beelden: ASSETS });
  assert.deepEqual(namen, ['Jeroen', 'Kjento'], 'Dave, Maxim en Leslie (toestemming) mogen');
  const r = G.controleerGrenzen({ a: 'Kjento legde het uit.', b: 'Op 3 jan zagen we het.', c: 'Jeroen haalde zijn payout.' }, { verbodenNamen: namen });
  assert.deepEqual(r.map((x) => x.pad), ['a', 'c']);
  assert.equal(G.controleerGrenzen({ a: 'Dave legde de trade uit.' }).length, 1);
  assert.equal(G.controleerGrenzen({ a: 'Gratis strategiesessie met Dave, t.w.v. €100, nu €0.' }).length, 0);
});

// ── 4. uniciteit ────────────────────────────────────────────────────────────
test('uniciteit: bijna dezelfde onderwerpregel/hook wordt gevonden, een andere niet', () => {
  assert.ok(G.gelijkenis('De dollar draait. Wij zagen het live.', 'De dollar draait — wij zagen het live') > 0.8);
  assert.ok(G.gelijkenis('De dollar draait', 'Waarom 71% enkel locatie is') < 0.3);
  const vorige = [{ slug: '15-10-26', output: voorbeeldOutput() }];
  const nu = voorbeeldOutput();
  const g = G.teGelijk(nu, vorige);
  assert.ok(g.some((x) => x.onderdeel === 'nieuwsbrief'));
  assert.ok(g.some((x) => x.onderdeel === 'pagina'));
  const anders = voorbeeldOutput({
    pagina: { ...nu.pagina, hero_titel: 'Waarom wij wachten', hero_accent: 'tot de 15M bevestigt' },
    nieuwsbrief: { ...nu.nieuwsbrief, onderwerpen: ['Eén regel: 71% is locatie', 'Wat een wick-break je niet vertelt', 'De stop hoort onder het 1-level'] },
    stories: nu.stories.map((s, i) => (i ? s : { ...s, titel: 'Geduld is een setup' })),
    post: { ...nu.post, slides: nu.post.slides.map((s, i) => (i ? s : { ...s, titel: 'Drie regels voor je entry' })) },
    linkedin: { ...nu.linkedin, tekst: 'Een vraag van een student deze week.\nOnze uitleg.' },
  });
  assert.deepEqual(G.teGelijk(anders, vorige), []);
});

test('bibliotheek-keuze: minst recent gebruikt, payouts enkel met toestemming', () => {
  const k = G.kiesBibliotheek(ASSETS, 4);
  assert.ok(k.some((a) => a.id === BEELD_PAYOUT));
  assert.equal(k[0].id, BEELD_PAYOUT, 'payout met toestemming eerst');
  assert.deepEqual(G.gebruikteAssetIds(voorbeeldOutput()).sort(), [BEELD_CHART, BEELD_PAYOUT].sort());
});

// ── 5. nieuwsbrief-render ───────────────────────────────────────────────────
test('nieuwsbrief: 600px, UTM per blok, disclaimer, uitschrijflink, naam enkel met toestemming', () => {
  const d = { slug: '22-10-26', datum: '2026-10-22', soort: 'training', input: { vimeo_id: '1', vimeo_thumbnail: 'https://i.vimeocdn.com/t.jpg', duur: 2100 } };
  const o = voorbeeldOutput();
  o.nieuwsbrief.blokken.splice(1, 0, { type: 'video', titel: 'De opname <live>', tekst: 'Kijk mee.' });
  const r = R.renderNieuwsbrief({ drop: d, output: o, assets: ASSETS, onderwerpIndex: 1 });
  assert.equal(r.onderwerp, o.nieuwsbrief.onderwerpen[1]);
  assert.match(r.html, /width="600"/);
  assert.match(r.html, /utm_source=nieuwsbrief&amp;utm_medium=email&amp;utm_campaign=drop-22-10-26&amp;utm_content=chart/);
  assert.match(r.html, /src=nieuwsbrief/);
  assert.match(r.html, /utm_content=video/);
  assert.match(r.html, /geen financieel advies/);
  assert.ok(r.html.includes(R.UITSCHRIJF_TAG));
  assert.match(r.html, /De opname &lt;live&gt;/, 'escaping');
  assert.match(r.html, /Leslie · Payout FTMO/, 'naam met toestemming');
  assert.match(r.html, /<b style="color:#FFFFFF;">We zagen het live\.<\/b>/, '**vet**');
  assert.match(r.html, /nu €0/);
  assert.match(r.tekst, /Uitschrijven:/);
  // zonder toestemming: geen naam
  const o2 = voorbeeldOutput();
  o2.nieuwsbrief.blokken[3].beeld_asset_id = BEELD_ZONDER;
  const r2 = R.renderNieuwsbrief({ drop: d, output: o2, assets: ASSETS });
  assert.ok(!r2.html.includes('Jeroen'));
  // zonder video: video-blok valt weg
  const r3 = R.renderNieuwsbrief({ drop: { ...d, input: {} }, output: o, assets: ASSETS });
  assert.ok(!r3.html.includes('utm_content=video'));
  // alle bloktypes hebben een renderer
  for (const t of G.BLOK_TYPES) assert.equal(typeof R.BLOKKEN[t], 'function', t);
});

// ── 6. endpoints ────────────────────────────────────────────────────────────
test('genereer (2.0): regie → schrijver → Weekeditie als versie 2, beelden gemarkeerd, rotatie in de prompt', async () => {
  reset();
  fake.db.tabellen.content_drops.push({ id: 'oud', slug: '15-10-26', datum: '2026-10-15', status: 'gepubliceerd', format_key: 'het_bewijs', output: { format_key: 'het_bewijs', kernidee: 'x', nieuwsbrief: { onderwerpen: ['Een payout van 25.016'] } }, aangemaakt_op: '2026-10-15T10:00:00Z' });
  ai.antwoorden.push(voorbeeldRegie(), voorbeeldEditie());
  const r = await roep(GEN, { body: { id: ID } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(drop().status, 'gegenereerd'); assert.equal(drop().versie, 2); assert.equal(drop().format_key, 'trade_ontleed');
  assert.equal(fake.db.tabellen.content_drop_versies.length, 1);
  const o = drop().output;
  assert.equal(o.versie, 2);
  assert.equal(o.pagina.thema, 'nacht');
  assert.equal(o.titel, 'De dollar draait. Wij zagen het live.');
  assert.equal(o.regie.hero_variant, 'video-poort');
  assert.deepEqual(r.body.waarschuwingen.filter((w) => ['schema', 'cijfer', 'grens', 'regie'].includes(w.soort)), []);
  assert.deepEqual(o.meta.toegelaten_formats.includes('het_bewijs'), false);
  assert.ok(o.meta.verboden_namen.includes('Kjento'));
  assert.ok(fake.db.tabellen.content_assets.find((a) => a.id === BEELD_PAYOUT).laatst_gebruikt_op > '2026-10-02', 'payout uit de muur gemarkeerd');
  assert.deepEqual(ai.aanroepen.map((a) => a.tool_name), ['lever_regie', 'lever_editie']);
  const prompt = JSON.stringify(ai.aanroepen[0].messages);
  assert.match(prompt, /TOEGELATEN FORMATS/); assert.match(prompt, /15-10-26 · format het_bewijs/);
  assert.match(prompt, /"type":"image","source":\{"type":"url"/);
  assert.match(ai.aanroepen[0].system, /FEITENBANK/); assert.match(ai.aanroepen[0].system, /replay-sweep-bos/);
  assert.match(JSON.stringify(ai.aanroepen[1].messages), /REGIE \(volg die exact\)/);
  assert.equal(o.pagina.formulier_titel, 'Ontgrendel de volledige training', 'vaste formulierteksten');
});

test('genereer: grensfout → één herstelronde; nog fout → waarschuwing, goedkeuren geblokkeerd', async () => {
  reset();
  const slecht = voorbeeldEditie(); slecht.linkedin = { ...slecht.linkedin, tekst: 'Gegarandeerd winst!! Kjento legt uit.' };
  ai.antwoorden.push(voorbeeldRegie(), slecht, slecht);
  const r = await roep(GEN, { body: { id: ID } });
  assert.equal(r.statusCode, 200);
  assert.equal(ai.aanroepen.length, 3, 'regie + schrijver + herstelronde');
  assert.match(JSON.stringify(ai.aanroepen[2].messages), /VERBETERDE versie/);
  assert.ok(r.body.waarschuwingen.some((w) => w.soort === 'grens'));
  const g = await roep(D, { body: { actie: 'goedkeuren', id: ID } });
  assert.equal(g.statusCode, 409); assert.equal(g.body.code, 'GRENZEN');
  // Maxim past de tekst aan → bewaar-output → goedkeuren → publiceren
  const o = JSON.parse(JSON.stringify(drop().output)); o.linkedin.tekst = 'De dollar draait. Zo zagen we het live.';
  const b = await roep(D, { body: { actie: 'bewaar-output', id: ID, versie: drop().versie, output: o } });
  assert.equal(b.statusCode, 200, JSON.stringify(b.body));
  assert.equal(drop().output.meta.waarschuwingen.filter((w) => w.soort === 'grens').length, 0);
  assert.equal((await roep(D, { body: { actie: 'publiceer', id: ID } })).statusCode, 409, 'eerst goedkeuren');
  assert.equal((await roep(D, { body: { actie: 'goedkeuren', id: ID } })).statusCode, 200);
  const p = await roep(D, { body: { actie: 'publiceer', id: ID } });
  assert.equal(p.body.drop.status, 'gepubliceerd'); assert.ok(p.body.drop.gepubliceerd_op);
  assert.equal((await roep(GEN, { body: { id: ID } })).statusCode, 409, 'gepubliceerd = niet opnieuw genereren');
  assert.equal((await roep(D, { body: { actie: 'depubliceer', id: ID } })).body.drop.status, 'goedgekeurd');
});

test('genereer: onbekend model → volgende in de keten; schema-herstel', async () => {
  reset();
  ai.modelFout.add('claude-sonnet-5-5');
  const kapot = voorbeeldEditie(); kapot.stories = kapot.stories.slice(0, 1);
  ai.antwoorden.push(voorbeeldRegie(), kapot, voorbeeldEditie());
  const r = await roep(GEN, { body: { id: ID } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.model, 'claude-sonnet-4-6');
  assert.deepEqual(ai.aanroepen.map((a) => a.model), ['claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-6'], 'onbekend model wordt onthouden');
  assert.equal(drop().output.stories.length, 3);
});

test('genereer: één onderdeel opnieuw met instructie; rest blijft', async () => {
  reset({ status: 'goedgekeurd', output: { ...voorbeeldOutput(), meta: { verboden_namen: [], waarschuwingen: [] } }, versie: 3 });
  ai.antwoorden.push((o) => {
    assert.match(JSON.stringify(o.messages), /Instructie van Maxim: korter/);
    assert.deepEqual(o.tool_input_schema.required, ['linkedin']);
    return { linkedin: { tekst: 'Korter. De dollar draait.', beeld: 'slide1' } };
  });
  const r = await roep(GEN, { body: { id: ID, onderdeel: 'linkedin', instructie: 'korter' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(drop().output.linkedin.tekst, 'Korter. De dollar draait.');
  assert.equal(drop().output.pagina.hero_titel, 'De dollar draait.');
  assert.equal(drop().status, 'gegenereerd', 'opnieuw goedkeuren nodig'); assert.equal(drop().versie, 4);
  assert.match(fake.db.tabellen.content_drop_versies[0].reden, /linkedin opnieuw gegenereerd — korter/);
  assert.equal((await roep(GEN, { body: { id: ID, onderdeel: 'hack' } })).statusCode, 400);
});

test('bewaar-output: versieconflict, structuur blijft bewaakt; versie-terug', async () => {
  reset({ status: 'gegenereerd', output: { ...voorbeeldOutput(), meta: { verboden_namen: [] } }, versie: 2 });
  fake.db.tabellen.content_drop_versies.push({ drop_id: ID, versie: 2, output: voorbeeldOutput({ kernidee: 'oude versie' }) });
  assert.equal((await roep(D, { body: { actie: 'bewaar-output', id: ID, versie: 1, output: voorbeeldOutput() } })).statusCode, 409);
  const kapot = voorbeeldOutput(); kapot.stories = [];
  assert.equal((await roep(D, { body: { actie: 'bewaar-output', id: ID, versie: 2, output: kapot } })).statusCode, 400);
  const ok = await roep(D, { body: { actie: 'bewaar-output', id: ID, versie: 2, output: voorbeeldOutput({ kernidee: 'nieuw', format_key: 'vooruitblik' }) } });
  assert.equal(ok.statusCode, 200);
  assert.equal(drop().output.kernidee, 'nieuw'); assert.equal(drop().output.format_key, 'trade_ontleed', 'format komt van de server');
  const t = await roep(D, { body: { actie: 'versie-terug', id: ID, versie: 2 } });
  assert.equal(t.statusCode, 200);
  assert.equal(drop().output.kernidee, 'oude versie'); assert.equal(drop().versie, 4);
  const v = await roep(D, { method: 'GET', query: { id: ID, versie: '2' } });
  assert.equal(v.body.versie.versie, 2);
});

test('nieuwsbrief-endpoint: HTML (GET) en live voorbeeld van niet-bewaarde output (POST)', async () => {
  reset({ status: 'gegenereerd', output: voorbeeldOutput() });
  const g = await roep(NB, { method: 'GET', query: { id: ID, onderwerp: '2' } });
  assert.equal(g.statusCode, 200);
  assert.match(g.body, /<title>Waarom we niet op 71% alleen instappen<\/title>/);
  const o = voorbeeldOutput(); o.nieuwsbrief.preheader = 'Nieuwe preheader';
  const p = await roep(NB, { body: { actie: 'voorbeeld', id: ID, output: o } });
  assert.equal(p.statusCode, 200); assert.equal(p.body.preheader, 'Nieuwe preheader');
  assert.equal(drop().output.nieuwsbrief.preheader, voorbeeldOutput().nieuwsbrief.preheader, 'niets opgeslagen');
  reset();
  assert.equal((await roep(NB, { method: 'GET', query: { id: ID } })).statusCode, 409);
});

// ── 7. werkblad rendert ─────────────────────────────────────────────────────
test('werkblad: tabs, acties, waarschuwingen en editors renderen', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><div id="content"></div>', { runScripts: 'outside-only', url: 'https://crm.test/' });
  const w = dom.window;
  const o = { ...voorbeeldOutput(), meta: { model: 'claude-x', waarschuwingen: [{ soort: 'grens', tekst: 'linkedin.tekst: garantie', fragment: 'Gegarandeerd' }, { soort: 'uniek', tekst: 'lijkt op 15-10-26' }] } };
  const antwoorden = {
    [`/api/contentmachine/drops?id=${ID}`]: { drop: { id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status: 'gegenereerd', versie: 2, input: {}, output: o }, assets: [], versies: [{ versie: 1, reden: 'eerste', aangemaakt_op: '2026-10-22T10:00:00Z' }] },
    '/api/contentmachine/assets?bibliotheek=1': { assets: ASSETS },
  };
  w.DFO = { VIEWS: {}, render() {}, goTab() {} };
  w.KV = { authedJson: async (u) => { if (!(u in antwoorden)) return { html: '<p>nb</p>', onderwerp: 'x' }; return antwoorden[u]; }, toast() {} };
  w.eval(lees('modules/klanten-v2/views/contentmachine-v2.js'));
  w.eval(lees('modules/klanten-v2/views/contentmachine-werkblad-v2.js'));
  await w.__cmWbOpen(ID);
  const V = w.DFO.VIEWS['contentmachine/Overzicht'];
  let html = V();
  for (const t of ['Goedkeuren', 'Kopieer teksten', 'Niet goedkeurbaar', 'Aandachtspunten', 'De trade ontleed', 'Opnieuw genereren', 'De dollar draait.']) assert.ok(html.includes(t), t);
  for (const tab of ['nieuwsbrief', 'stories', 'post', 'linkedin']) {
    w.__cmWbTab(tab);
    html = V();
    assert.ok(html.includes('cm-wb-tab aan'), tab);
  }
  w.__cmWbTab('stories');
  assert.match(V(), /utm_campaign=drop-22-10-26/);
  w.__cmWbVeld('linkedin.tekst', 'Nieuw');
  assert.equal(w.__cmWerkblad.output.linkedin.tekst, 'Nieuw');
  assert.equal(w.__cmWerkblad.dirty, true);
});

test('bedrading fase 2: werkblad-script geladen, genereer maxDuration 300', () => {
  assert.match(lees('modules/klanten-v2/index.html'), /views\/contentmachine-werkblad-v2\.js\?v=\d+/);
  assert.equal(JSON.parse(lees('vercel.json')).functions['api/contentmachine/genereer.js'].maxDuration, 300);
});

// ── 7. correcties na de nameting (26 okt): vaste formulierteksten + echte trainingsdatum ──
const C = await import('../api/_lib/contentmachine-core.js');

test('datum training: uit het veld of de Vimeo-titel; weekdag wordt berekend, nooit geraden', () => {
  const v = new Date('2026-10-26T10:00:00Z');
  assert.equal(C.datumUitTitel('Live training 22/10/26', v), '2026-10-22');
  assert.equal(C.datumUitTitel('Live training 22/10', v), '2026-10-22');
  assert.equal(C.datumUitTitel('22 oktober 2026 — DXY', v), '2026-10-22');
  assert.equal(C.datumUitTitel('Live 12-12', v), '2025-12-12', 'ver in de toekomst = vorig jaar');
  assert.equal(C.datumUitTitel('Training 2026', v), null);
  assert.equal(C.datumUitTitel('31/02', v), null);
  assert.equal(C.weekdagVan('2026-10-22'), 'donderdag');
  assert.equal(C.trainingDatum({ training_datum: '2026-10-22', vimeo_titel: 'Live 15/10/26' }), '2026-10-22', 'het veld wint');
  assert.equal(C.trainingDatum({ vimeo_titel: 'Live training 22-10-2026' }), '2026-10-22');
  assert.equal(C.trainingDatum({}), null);
  const vimeo = 'https://player.vimeo.com/video/1238714790?h=4822ada5ee';
  assert.equal(C.normaliseerInput({ vimeo_url: vimeo, training_datum: '2026-10-22' }).training_datum, '2026-10-22');
  assert.equal(C.normaliseerInput({ vimeo_url: vimeo, training_datum: '2026-02-31' }).training_datum, null);
  assert.equal(C.normaliseerInput({ training_datum: '2026-10-22' }).training_datum, null, 'zonder video geen training');
});

test('prompt: de echte trainingsdatum gaat mee; zonder datum het verbod op een weekdag', () => {
  const basis = { drop: { slug: '26-10-26', datum: '2026-10-26', soort: 'training' }, vorige: [], toegelaten: ['trade_ontleed'], paginaUrl: 'x' };
  const met = JSON.stringify(G.gebruikersBericht({ ...basis, input: { vimeo_id: '1', training_datum: '2026-10-22' } }));
  assert.match(met, /DATUM TRAINING: donderdag 22 oktober 2026 \(kort: 22\/10\)/);
  assert.match(met, /aangemaakt op 2026-10-26/);
  assert.match(JSON.stringify(G.gebruikersBericht({ ...basis, input: { vimeo_id: '1' } })), /DATUM TRAINING: onbekend/);
  assert.match(G.systeemPrompt(), /Raad nooit een weekdag/);
  assert.match(G.systeemPrompt(), /naam, e-mail en gsm-nummer/);
});

test('grenzen: een andere weekdag dan die van de training is fout; een link mailen ook', () => {
  const o = { nieuwsbrief: { blokken: [{ type: 'opener', tekst: 'In de live training van maandag zagen we het.' }] } };
  assert.equal(G.controleerGrenzen(o, {}).length, 0, 'zonder weekdag-optie geen check');
  assert.match(G.controleerGrenzen(o, { weekdag: 'donderdag' })[0].regel, /training was op donderdag/);
  assert.match(G.controleerGrenzen(o, { weekdag: null })[0].regel, /weekdag geraden/);
  assert.equal(G.controleerGrenzen({ x: 'Elke donderdag live, ook donderdags.' }, { weekdag: 'donderdag' }).length, 0);
  assert.equal(G.controleerGrenzen({ x: 'De dollar maandag-ochtend.' }, { weekdag: 'donderdag' }).length, 1);
  assert.match(G.controleerGrenzen({ x: 'Vul je e-mailadres in en we sturen je direct de link.' })[0].regel, /verkeerde flow/);
  assert.deepEqual(G.grensOpties({ training_datum: '2026-10-22' }, ['Kjento']), { verbodenNamen: ['Kjento'], weekdag: 'donderdag' });
});

test('formulier: vaste teksten per soort; het model schrijft ze niet', () => {
  assert.ok(!('formulier_titel' in G.OUTPUT_SCHEMA.properties.pagina.properties));
  for (const k of G.FORMULIER_VELDEN) assert.ok(!G.OUTPUT_SCHEMA.properties.pagina.required.includes(k), k);
  const t = G.vasteFormulierTeksten({ soort: 'training', startSec: 600 });
  assert.match(t.formulier_sub, /naam, e-mail en gsm-nummer/); assert.match(t.formulier_sub, /video start meteen/);
  assert.match(t.ontgrendeld_tekst, /\*\*10:00\*\*/);
  assert.doesNotMatch(JSON.stringify(t), /link/);
  assert.match(G.vasteFormulierTeksten({ soort: 'update' }).knop, /Schrijf je in/);
  const fout = voorbeeldOutput({ pagina: { ...voorbeeldOutput().pagina, formulier_sub: 'Vul je e-mailadres in en we sturen je direct de link.' } });
  const goed = G.metVasteTeksten(fout, { drop: { soort: 'training' }, input: { start_sec: 600 } });
  assert.equal(goed.pagina.formulier_sub, t.formulier_sub);
  assert.equal(goed.pagina.hero_titel, fout.pagina.hero_titel, 'de rest blijft');
  assert.equal(G.metVasteTeksten({ linkedin: {} }, { drop: { soort: 'training' } }).pagina, undefined);
});

test('genereer: vaste formulierteksten erin; weekdag uit de invoer bewaakt', async () => {
  reset();
  drop().input.training_datum = '2026-10-22';
  const o = voorbeeldEditie();
  o.pagina.formulier_sub = 'we sturen je de link';
  o.nieuwsbrief = { ...o.nieuwsbrief, opener: o.nieuwsbrief.opener + ' De live training van donderdag. **We zagen het live.**' };
  ai.antwoorden.push(voorbeeldRegie(), o);
  const r = await roep(GEN, { body: { id: ID } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ai.aanroepen.length, 2, 'donderdag klopt: geen herstelronde');
  assert.equal(drop().output.pagina.formulier_titel, 'Ontgrendel de volledige training');
  assert.equal(drop().output.pagina.formulier_sub, 'Vul je naam, e-mail en gsm-nummer in. De video start meteen hier op de pagina.');
  assert.match(drop().output.pagina.ontgrendeld_tekst, /10:00/);
  assert.match(JSON.stringify(ai.aanroepen[0].messages), /DATUM TRAINING: donderdag 22 oktober 2026/);
});

test('goedkeuren: weekdag die niet klopt blokkeert; een oudere drop krijgt de vaste teksten als nieuwe versie', async () => {
  const oud = voorbeeldOutput(); oud.pagina.formulier_sub = 'Vul je e-mailadres in.';
  oud.nieuwsbrief.blokken[0].tekst = 'In de live training van maandag kantelde de dollar.';
  reset({ status: 'gegenereerd', output: { ...oud, meta: { verboden_namen: [] } }, versie: 2 });
  drop().input.training_datum = '2026-10-22';
  const g = await roep(D, { body: { actie: 'goedkeuren', id: ID } });
  assert.equal(g.statusCode, 409); assert.match(g.body.error, /training was op donderdag/);
  drop().output.nieuwsbrief.blokken[0].tekst = 'In de live training van donderdag kantelde de dollar.';
  const ok = await roep(D, { body: { actie: 'goedkeuren', id: ID } });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  assert.equal(drop().status, 'goedgekeurd'); assert.equal(drop().versie, 3);
  assert.match(drop().output.pagina.formulier_sub, /gsm-nummer/);
  assert.match(fake.db.tabellen.content_drop_versies.at(-1).reden, /Vaste formulierteksten/);
});

test('bedrading: invoer heeft "Datum training"; werkblad toont het formulier als vast', () => {
  const inv = lees('modules/klanten-v2/views/contentmachine-v2.js');
  assert.match(inv, /Datum training/); assert.match(inv, /training_datum: f\.training_datum/);
  const wb = lees('modules/klanten-v2/views/contentmachine-werkblad-v2.js');
  assert.match(wb, /Formulier \(vast\)/); assert.doesNotMatch(wb, /veld\('pagina\.formulier_titel'/);
  assert.match(lees('api/contentmachine/drops.js'), /training_datum: datumUitTitel\(j\.title\)/);
});

test('carrousel: geen nummer voor de slidetitel (generator én rendering)', () => {
  for (const [in_, uit] of [['1. Eerst de 4-uur', 'Eerst de 4-uur'], ['4-5. Locatie en reden', 'Locatie en reden'], ['6) Risk free', 'Risk free'], ['71% is locatie', '71% is locatie'], ['2026 was goed', '2026 was goed'], ['Eén trade, zes stappen', 'Eén trade, zes stappen']]) {
    assert.equal(G.zonderSlideNummer(in_), uit, in_);
  }
  const o = voorbeeldOutput(); o.post.slides[1].titel = '1. Eerst de 4-uur'; o.post.slides[3].titel = '4-5. Locatie';
  const n = G.nabewerk(o, { drop: { soort: 'training' }, input: { start_sec: 600 } });
  assert.deepEqual([n.post.slides[1].titel, n.post.slides[3].titel], ['Eerst de 4-uur', 'Locatie']);
  assert.match(n.pagina.formulier_sub, /gsm-nummer/, 'vaste teksten blijven');
  assert.match(G.systeemPrompt(), /GEEN nummer voor de titel/);
  const social = lees('modules/klanten-v2/views/contentmachine-social-v2.js');
  assert.match(social, /sl = \{ \.\.\.sl, titel: zonderNummer\(sl\.titel\) \}/);
  const vm = { window: {} };
  new Function('window', social.match(/const zonderNummer = [^\n]+\n\s+window\.__cmZonderNummer = zonderNummer;/)[0])(vm.window);
  assert.equal(vm.window.__cmZonderNummer('4-5. Locatie'), 'Locatie');
});
