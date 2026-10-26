// tests/contentmachine-weekeditie.test.js — Contentmachine 2.0, fase 2 (generator 2.0 + werkblad).
//   1. bronnen: blokschema's (zelfde bestand als dfo-website), feitenbank md = js
//   2. validator + editieregels + combinatie + gebruik
//   3. cijfers enkel uit feitenbank / invoer / beelden
//   4. regisseur: regels die de code afdwingt; schrijverschema = de gekozen blokken
//   5. endpoints: blok opnieuw / toevoegen, pagina opnieuw, bewaren (regels), goedkeuren (cijfers), blokken-GET
//   6. werkblad: Weekeditie-editor + echte pagina in een iframe

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maakFake, maakRes } from './_contentmachine-fake.js';
import { voorbeeldRegie, voorbeeldEditie, ASSETS, BEELD_PAYOUT, BEELD_ZONDER, BEELD_FOTO } from './_contentmachine-voorbeeld.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const fake = maakFake();
const ai = { antwoorden: [], aanroepen: [] };
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
mock.module('../api/_lib/anthropic-client.js', {
  namedExports: {
    anthropicStructuredOutput: async (o) => {
      ai.aanroepen.push(o);
      const a = ai.antwoorden.shift();
      if (!a) throw new Error('geen nep-antwoord meer');
      return typeof a === 'function' ? a(o) : a;
    },
    anthropicMessages: async () => { throw new Error('niet gebruikt'); },
  },
});

const W = await import('../api/_lib/weekeditie.js');
const F = await import('../api/_lib/feitenbank.js');
const RG = await import('../api/_lib/contentmachine-regie.js');
const GEN = await import('../api/contentmachine/genereer.js');
const D = await import('../api/contentmachine/drops.js');

const ID = '99999999-9999-4999-8999-999999999999';
const TOKEN = 'abcdabcd-1234-4abc-8def-1234567890ab';
function reset({ status = 'gegenereerd', output = null, versie = 2, input = {} } = {}) {
  fake.db.tabellen = {
    profiles: [{ id: 'u1', email: 'm@x.nl', full_name: 'Maxim', role: 'super_admin' }],
    content_drops: [{ id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status, versie, voorbeeld_token: TOKEN,
      format_key: output ? output.format_key : null,
      input: { vimeo_id: '1238714790', vimeo_hash: '4822ada5ee', duur: 2100, start_sec: 600, wat_gebeurde: 'De DXY kantelde.', kanalen: ['pagina', 'nieuwsbrief', 'stories', 'post', 'linkedin'], ...input },
      output, aangemaakt_op: '2026-10-22T10:00:00Z' }],
    content_drop_versies: [],
    content_assets: ASSETS.map((a) => ({ ...a })),
    team_members: [{ name: 'Kjento Biebuyck', is_active: true }],
  };
  fake.db.ontbreekt = {};
  ai.antwoorden = []; ai.aanroepen = [];
}
async function roep(mod, { method = 'POST', query = {}, body = {} } = {}) {
  const res = maakRes();
  res.send = function (b) { this.body = b; return this; };
  await mod.default({ method, query, body, headers: {} }, res);
  return res;
}
const drop = () => fake.db.tabellen.content_drops[0];
const editie = () => ({ versie: 2, format_key: 'trade_ontleed', kernidee: 'k', regie: voorbeeldRegie(), ...voorbeeldEditie(), pagina: { ...voorbeeldEditie().pagina, thema: 'nacht' }, meta: { verboden_namen: [], waarschuwingen: [] } });

// ── 1. bronnen ──────────────────────────────────────────────────────────────
test('bronnen: blokschema\'s = export van dfo-website (zelfde bestand in api/_lib en docs); feitenbank md = js', () => {
  const lib = lees('api/_lib/weekeditie-blokken.json');
  assert.equal(lib, lees('docs/contentmachine/weekeditie-blokken.json'));
  const website = join(ROOT, '..', 'dfo-website', 'docs', 'weekeditie-blokken.json');
  if (existsSync(website)) assert.equal(lib, readFileSync(website, 'utf8'), 'gelijk aan dfo-website (lokaal naast elkaar)');
  const j = JSON.parse(lib);
  assert.match(j.bron, /dfo-website/);
  assert.equal(j.blokken.length, 19);
  for (const t of ['hero', 'replay-sweep-bos', 'fib-animatie', 'rr-sliders', 'funded-calculator', 'payout-muur', 'inschrijven']) assert.ok(W.BLOK_TYPES.includes(t), t);
  const md = lees('docs/contentmachine/feitenbank.md').split('<!-- FEITEN-START -->')[1].split('<!-- FEITEN-EINDE -->')[0].replace(/^\n+|\n+$/g, '');
  assert.equal(F.FEITENBANK, md);
  for (const feit of ['20.244 trades', '177 studenten', '79%', '5.947', '48,5%', '6.881', '1, 0, 71 en −27', '3,4R', '1% per trade']) assert.ok(F.FEITENBANK.includes(feit), feit);
});

// ── 2. validator + regels ───────────────────────────────────────────────────
test('validator: de voorbeeld-editie is geldig; strikte props, varianten, regels', () => {
  const p = editie().pagina;
  assert.deepEqual(W.editieFouten(p, { metVideo: true }), []);
  assert.match(W.editieFouten(p, { metVideo: false }).join(' | '), /zonder video: geen video-poort/);
  const kapot = JSON.parse(JSON.stringify(p));
  kapot.blokken[5].props.extra = 1;                       // tip met onbekend veld
  kapot.blokken[4].props.start_winrate = 95;              // buiten bereik
  kapot.blokken.splice(6, 1);                             // cadeau weg
  const f = W.editieFouten(kapot, { metVideo: true }).join(' | ');
  for (const deel of ['onbekend veld', 'hoogstens 80', 'precies 1 cadeau']) assert.ok(f.includes(deel), deel);
  assert.deepEqual(W.beeldFouten(p, ASSETS), []);
  const zonder = JSON.parse(JSON.stringify(p)); zonder.blokken[3].props.payouts[0].asset_id = BEELD_ZONDER;
  assert.match(W.beeldFouten(zonder, ASSETS).join(), /geen payout met toestemming/);
});

test('combinatie: thema + hero + interactieve blokken nooit gelijk aan een van de vorige 3; gebruik per blok', () => {
  const p = editie().pagina;
  const c = W.combinatie(p);
  assert.equal(c.sleutel, 'nacht|video-poort|replay-sweep-bos+rr-sliders+trechter');
  const vorige = [{ slug: 'a', output: { pagina: { ...p, thema: 'goud' } } }, { slug: 'b', output: { pagina: p } }];
  assert.deepEqual(W.combinatieVrij(p, vorige), { ok: false, botsing: 'b' });
  assert.equal(W.combinatieVrij(p, [{}, {}, {}, { slug: 'oud', output: { pagina: p } }]).ok, true, 'de 4e telt niet');
  const g = W.blokGebruik(vorige);
  assert.equal(g['replay-sweep-bos'].aantal, 2);
  assert.equal(g['replay-sweep-bos'].laatst, 'a');
  assert.equal(g.quiz.aantal, 0);
});

// ── 3. cijfers ──────────────────────────────────────────────────────────────
test('cijfers: enkel uit feitenbank, invoer of beelden', () => {
  const p = editie().pagina;
  assert.deepEqual(F.controleerCijfers(p), [], '4536 (Leslie) en 48,5 × 3,17 staan in de feitenbank');
  const verzonnen = JSON.parse(JSON.stringify(p));
  verzonnen.blokken.splice(1, 0, { type: 'data', variant: 'een', props: { cijfers: [{ waarde: 93, suffix: '%', label: 'winrate', bron: 'x' }] } });
  verzonnen.blokken[4].props.payouts[0].bedrag = 99999;
  const f = F.controleerCijfers(verzonnen);
  assert.deepEqual(f.map((x) => x.waarde), [93, 99999]);
  assert.deepEqual(F.controleerCijfers(verzonnen, ['Deze week haalde een student 93% in zijn backtest', 'Payout 99.999']), []);
  assert.ok(F.getallenIn('20.244 trades, 48,5% en $24.580').has(20244));
  assert.ok(F.getallenIn('48,5%').has(48.5));
});

// ── 4. regisseur + schrijver ────────────────────────────────────────────────
test('regisseur: de code dwingt format, hero, structuur, combinatie en beelden af', () => {
  const ids = ASSETS.map((a) => a.id);
  assert.deepEqual(RG.valideerRegie(voorbeeldRegie(), { metVideo: true, toegelaten: ['trade_ontleed'], assetIds: ids }), []);
  const f = RG.valideerRegie(voorbeeldRegie({ format_key: 'het_bewijs', hero_variant: 'video-poort', beelden: [{ asset_id: 'x', waar: 'y' }] }), { metVideo: false, toegelaten: ['trade_ontleed'], assetIds: ids }).join(' | ');
  for (const deel of ['niet toegelaten', 'mag niet (geen video', 'zonder video: geen video-poort', 'beeld x bestaat niet']) assert.ok(f.includes(deel), deel);
  const vorige = [{ slug: '15-10-26', output: { pagina: editie().pagina } }];
  assert.match(RG.valideerRegie(voorbeeldRegie(), { metVideo: true, assetIds: ids, vorige }).join(), /dezelfde als 15-10-26/);
  assert.ok(!RG.heroVarianten(false).includes('video-poort'));
  const s = RG.regieSchema({ toegelaten: ['a'], metVideo: false });
  assert.deepEqual(s.properties.format_key.enum, ['a']);
  assert.ok(!s.properties.hero_variant.enum.includes('video-poort'));
});

test('schrijver: schema = exact de gekozen bloktypes, vaste lengte; volgtRegie bewaakt de volgorde', () => {
  const r = voorbeeldRegie();
  const s = RG.schrijverSchema(r);
  const items = s.properties.pagina.properties.blokken;
  assert.equal(items.minItems, 7); assert.equal(items.maxItems, 7);
  assert.deepEqual(items.items.anyOf.map((x) => x.properties.type.const).sort(), ['cadeau', 'hero', 'payout-muur', 'replay-sweep-bos', 'rr-sliders', 'tip', 'trechter']);
  assert.ok(!JSON.stringify(s).includes('$schema'));
  assert.deepEqual(Object.keys(RG.schrijverSchema(r, { onderdelen: ['pagina'] }).properties), ['pagina']);
  const p = editie().pagina;
  assert.deepEqual(RG.volgtRegie(p, r), []);
  const om = { ...p, blokken: [p.blokken[0], p.blokken[2], p.blokken[1], ...p.blokken.slice(3)] };
  assert.match(RG.volgtRegie(om, r).join(), /replay-sweep-bos verwacht, kreeg trechter/);
  // prompts: regels, blokken, feitenbank en strategiekennis zitten erin
  assert.match(RG.regiePrompt(), /Combinatie thema \+ hero-variant/);
  assert.match(RG.regiePrompt(), /funded-calculator \[interactief\]/);
  assert.match(RG.schrijverPrompt(), /FEITENBANK/);
  assert.match(RG.schrijverPrompt(), /HARDE GRENZEN/, 'de v1-grenzen blijven gelden');
});

test('genereer: verzonnen cijfer → herstelronde; regie die botst → herstelronde', async () => {
  reset({ status: 'concept', versie: 1 });
  fake.db.tabellen.content_drops.push({ id: 'oud', slug: '15-10-26', datum: '2026-10-15', status: 'gepubliceerd', format_key: 'het_bewijs', output: { ...editie(), format_key: 'het_bewijs' }, aangemaakt_op: '2026-10-15T10:00:00Z' });
  const verzonnen = voorbeeldEditie(); verzonnen.pagina = JSON.parse(JSON.stringify(verzonnen.pagina));
  verzonnen.pagina.blokken[3].props.payouts[0].bedrag = 12345;
  ai.antwoorden.push(voorbeeldRegie(), voorbeeldRegie({ thema: 'data' }), verzonnen, voorbeeldEditie());
  const r = await roep(GEN, { body: { id: ID } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(ai.aanroepen.length, 4);
  assert.match(JSON.stringify(ai.aanroepen[1].messages), /dezelfde als 15-10-26/);
  assert.match(JSON.stringify(ai.aanroepen[3].messages), /12345 staat niet in de feitenbank/);
  assert.equal(drop().output.pagina.thema, 'data');
  assert.equal(drop().output.regie.thema, 'data');
});

// ── 5. endpoints ────────────────────────────────────────────────────────────
test('blok opnieuw schrijven: enkel dat blok, nieuwe versie; ongeldig blok → 422 en niets bewaard', async () => {
  reset({ output: editie() });
  ai.antwoorden.push((o) => {
    assert.equal(o.tool_name, 'lever_blok');
    assert.equal(o.tool_input_schema.properties.blok.properties.type.const, 'tip');
    assert.match(JSON.stringify(o.messages), /Instructie van Maxim: korter/);
    return { blok: { type: 'tip', props: { voorkant: 'Nieuwe tip.', achterkant: 'Waarom.' } } };
  });
  const r = await roep(GEN, { body: { id: ID, blok: { index: 5, instructie: 'korter' } } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(drop().versie, 3);
  assert.equal(drop().output.pagina.blokken[5].props.voorkant, 'Nieuwe tip.');
  assert.equal(drop().output.pagina.blokken[0].props.titel, editie().pagina.blokken[0].props.titel, 'rest blijft');
  assert.match(fake.db.tabellen.content_drop_versies.at(-1).reden, /Blok 6 \(tip\) opnieuw geschreven — korter/);
  // twee keer een ongeldig blok → 422
  ai.antwoorden.push({ blok: { type: 'tip', props: { voorkant: '' } } }, { blok: { type: 'tip', props: { voorkant: 'x', achterkant: 'y', extra: 1 } } });
  const slecht = await roep(GEN, { body: { id: ID, blok: { index: 5 } } });
  assert.equal(slecht.statusCode, 422);
  assert.equal(drop().versie, 3, 'niets bewaard');
});

test('blok toevoegen: nieuw type op de gekozen plek; onbekend type → 400; v1-drop → 409', async () => {
  reset({ output: editie() });
  ai.antwoorden.push({ blok: { type: 'quiz', props: { vraag: 'Neem je de short?', opties: ['Ja', 'Nee, wacht op een body close'], antwoord_index: 1, uitleg: 'Wick-only is geen BOS.' } } });
  const r = await roep(GEN, { body: { id: ID, blok: { index: 2, type: 'quiz' } } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.deepEqual(drop().output.pagina.blokken.map((b) => b.type).slice(0, 4), ['hero', 'replay-sweep-bos', 'quiz', 'trechter']);
  assert.match(fake.db.tabellen.content_drop_versies.at(-1).reden, /Blok quiz toegevoegd/);
  assert.equal((await roep(GEN, { body: { id: ID, blok: { index: 2, type: 'bestaat-niet' } } })).statusCode, 400);
  reset({ output: { format_key: 'x', pagina: { hero_titel: 'v1' } } });
  assert.equal((await roep(GEN, { body: { id: ID, blok: { index: 1 } } })).statusCode, 409);
});

test('pagina opnieuw (2.0): de schrijver met dezelfde regie, enkel de pagina', async () => {
  reset({ output: editie() });
  ai.antwoorden.push((o) => {
    assert.deepEqual(o.tool_input_schema.required, ['pagina']);
    const e = voorbeeldEditie();
    e.pagina.blokken[0] = { ...e.pagina.blokken[0], props: { ...e.pagina.blokken[0].props, titel: 'Nieuwe kop. **Zelfde week.**' } };
    return { pagina: e.pagina };
  });
  const r = await roep(GEN, { body: { id: ID, onderdeel: 'pagina', instructie: 'andere kop' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(drop().output.titel, 'Nieuwe kop. Zelfde week.');
  assert.deepEqual(drop().output.linkedin, editie().linkedin, 'andere kanalen blijven');
});

test('bewaren: de editieregels gelden (cadeau weg = 400); regie en versie blijven van de server', async () => {
  reset({ output: editie() });
  const o = JSON.parse(JSON.stringify(drop().output));
  o.pagina.blokken = o.pagina.blokken.filter((b) => b.type !== 'cadeau');
  const r = await roep(D, { body: { actie: 'bewaar-output', id: ID, versie: drop().versie, output: o } });
  assert.equal(r.statusCode, 400); assert.match(r.body.error, /precies 1 cadeau/);
  const ok = JSON.parse(JSON.stringify(drop().output));
  ok.pagina.blokken[1].props.uitleg = 'Aangepast.'; ok.regie = { gehackt: true }; delete ok.versie;
  const r2 = await roep(D, { body: { actie: 'bewaar-output', id: ID, versie: drop().versie, output: ok } });
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.body));
  assert.equal(drop().output.regie.thema, 'nacht'); assert.equal(drop().output.versie, 2);
  assert.equal(drop().output.titel, 'De dollar draait. Wij zagen het live.');
});

test('goedkeuren: een verzonnen cijfer blokkeert (ook na bewerken); blokken-GET levert de schema\'s', async () => {
  const o = editie(); o.pagina.blokken[3].props.payouts[0].bedrag = 31337;
  reset({ output: o });
  const g = await roep(D, { body: { actie: 'goedkeuren', id: ID } });
  assert.equal(g.statusCode, 409); assert.match(g.body.error, /31337/);
  drop().output.pagina.blokken[3].props.payouts[0].bedrag = 4536;
  assert.equal((await roep(D, { body: { actie: 'goedkeuren', id: ID } })).statusCode, 200);
  const b = await roep(D, { method: 'GET', query: { blokken: '1' } });
  assert.equal(b.statusCode, 200); assert.equal(b.body.blokken.blokken.length, 19);
});

// ── 6. werkblad ─────────────────────────────────────────────────────────────
test('werkblad: Weekeditie-editor (blokken uit het schema) + de echte pagina in een iframe', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><head></head><div id="content"></div>', { runScripts: 'outside-only', url: 'https://crm.test/' });
  const w = dom.window;
  const blokken = JSON.parse(lees('api/_lib/weekeditie-blokken.json'));
  const o = editie();
  const geposte = [];
  const antwoorden = {
    [`/api/contentmachine/drops?id=${ID}`]: { drop: { id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status: 'gegenereerd', versie: 2, voorbeeld_token: TOKEN, input: { vimeo_id: '1' }, output: o }, assets: [], versies: [] },
    '/api/contentmachine/assets?bibliotheek=1': { assets: ASSETS },
    '/api/contentmachine/drops?blokken=1': { blokken },
  };
  w.DFO = { VIEWS: {}, render() {}, goTab() {} };
  w.KV = { authedJson: async (u, init) => { if (init && init.method === 'POST') { geposte.push(JSON.parse(init.body)); return { drop: antwoorden[`/api/contentmachine/drops?id=${ID}`].drop }; } return antwoorden[u] || { html: '', onderwerp: '' }; }, toast() {} };
  w.eval(lees('modules/klanten-v2/views/contentmachine-v2.js'));
  w.eval(lees('modules/klanten-v2/views/contentmachine-werkblad-v2.js'));
  w.eval(lees('modules/klanten-v2/views/contentmachine-weekeditie-v2.js'));
  await w.__cmWbOpen(ID);
  const V = w.DFO.VIEWS['contentmachine/Overzicht'];
  V(); await new Promise((r) => setTimeout(r, 10));
  let html = V();
  for (const t of ['Regie', 'Rode draad', 'Waarom zo (regisseur)', 'Replay: sweep of break?', 'Payout-muur', 'Blok toevoegen', 'Laat de machine het schrijven', `training/voorbeeld/${TOKEN}`, 'Gsm', 'interactief']) assert.ok(html.includes(t), t);
  // een blok openen → velden uit het schema
  w.__cmWeOpen(1); html = V();
  for (const t of ['richting', 'scenario', 'uitleg', 'Opnieuw schrijven']) assert.ok(html.includes(t), t);
  w.__cmWeOpen(3); html = V();
  assert.ok(html.includes('payouts') && html.includes('ander beeld kiezen'), 'payout-lijst met beeldkiezer');
  // bewerken + verplaatsen markeert dirty; het voorbeeld zegt dat het de bewaarde versie toont
  w.__cmWeTekstVeld('pagina.blokken.1.props.uitleg', 'Nieuw');
  assert.equal(w.__cmWb.output.pagina.blokken[1].props.uitleg, 'Nieuw');
  w.__cmWeVerplaats(2, 1);
  assert.equal(w.__cmWb.output.pagina.blokken[3].type, 'trechter');
  w.__cmWeVerplaats(1, -1);
  assert.equal(w.__cmWb.output.pagina.blokken[0].type, 'hero', 'de hero blijft eerst');
  assert.match(V(), /toont de <b>bewaarde<\/b> versie/);
  w.__cmWeGetal('pagina.blokken.4.props.start_winrate', '');
  assert.equal('start_winrate' in w.__cmWb.output.pagina.blokken[4].props, false, 'leeg = weg');
  // kopieer-tekst kent de blokken
  assert.match(w.__cmWbAlleTeksten(), /Weekeditie · thema nacht/);
  // toevoegen post een blok-opdracht
  w.__cmWb.dirty = false;
  w.__cmWeToevoegType('quiz'); w.__cmWeToevoegPlek('2');
  await w.__cmWeToevoegen();
  assert.deepEqual(geposte.at(-1).blok, { index: 2, type: 'quiz', instructie: '' });
});

test('bedrading: script geladen na het werkblad, CSP laat de website-preview toe, seed bevat de masterclassfoto\'s', () => {
  const html = lees('modules/klanten-v2/index.html');
  assert.ok(html.indexOf('contentmachine-werkblad-v2.js') < html.indexOf('contentmachine-weekeditie-v2.js'));
  assert.match(lees('vercel.json'), /frame-src [^"]*https:\/\/www\.deforexopleiding\.nl/);
  assert.ok(existsSync(join(ROOT, 'img/contentmachine/bibliotheek-seed/masterclass-2531.jpg')));
  assert.equal(BEELD_FOTO.length, 36);
  assert.ok(RG.cijferBronnen({}, [{ bijschrift: '€138.695 aan uitbetalingen' }])[0].includes('138.695'));
  void BEELD_PAYOUT;
});
