// tests/contentmachine-lancering.test.js — Contentmachine 2.0, fase 5 ("Keur goed en lanceer").
//   1. GHL-hulp: wie mag getagd worden (DND/uitgeschreven/geen e-mail/had de tag al), zoeken per tag
//      met paginering, 429 → opnieuw
//   2. lancering: verwachte beelden, titelcontrole van de pagina (ISR/DNS), voorwaarden
//   3. taggen: elk contact hoogstens één keer, ook na een onderbreking; tellers; klaar
//   4. endpoint: super_admin, testmail verplicht (enkel naar de ingelogde gebruiker), workflow
//      verplicht, nu (template + onderwerp + tags) en ingepland (cron), annuleren, GHL instellen
//   5. data: top-3 blokken en cijfers per drop; bedrading

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maakFake, maakRes } from './_contentmachine-fake.js';
import { voorbeeldRegie, voorbeeldEditie, ASSETS } from './_contentmachine-voorbeeld.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const fake = maakFake();
mock.module('../api/supabase.js', {
  namedExports: {
    supabase: { from: fake.from },
    supabaseAdmin: { from: fake.from, storage: fake.storage },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'maxim@x.nl' } } }) } }),
    verifyAdmin: async () => null,
    checkCronAuth: (req) => (req.headers.authorization === 'Bearer cron' ? { ok: true } : { ok: false, status: 401, body: { error: 'Unauthorized' } }),
  },
});
mock.module('../api/_lib/requirePermission.js', { namedExports: { requirePermission: async () => true } });

process.env.GHL_PIT_TOKEN = 'tok';
process.env.GHL_LOCATION_ID = 'loc1';

const GW = await import('../api/_lib/ghl-weekeditie.js');
const WL = await import('../api/_lib/weekeditie-lancering.js');
const WD = await import('../api/_lib/weekeditie-data.js');
const LANCEER = await import('../api/contentmachine/lanceer.js');
const CRON = await import('../api/cron-weekeditie-lancering.js');
const G = await import('../api/_lib/contentmachine-generator.js');

// ── nep-GHL ─────────────────────────────────────────────────────────────────
const ghl = {};
function resetGhl(over = {}) {
  Object.assign(ghl, {
    contacten: [
      { id: 'c1', email: 'a@x.nl', tags: ['nieuwsbrief'] },
      { id: 'c2', email: 'b@x.nl', tags: ['nieuwsbrief'], dnd: true },
      { id: 'c3', email: 'c@x.nl', tags: ['nieuwsbrief'], dndSettings: { Email: { status: 'active' } } },
      { id: 'c4', email: '', tags: ['nieuwsbrief'] },
      { id: 'c5', email: 'e@x.nl', tags: ['nieuwsbrief', 'weekeditie-verzenden'] },
      { id: 'c6', email: 'f@x.nl', tags: ['nieuwsbrief'], dndSettings: { Email: { status: 'inactive' } } },
      { id: 'c7', email: 'g@x.nl', tags: ['nieuwsbrief'] },
      { id: 'x1', email: 'z@x.nl', tags: ['klant'] },
    ],
    getagd: [], templates: {}, cv: [], workflows: [{ id: 'wf1', name: 'DFO Weekeditie versturen', status: 'published' }],
    testmails: [], zoekopdrachten: [], fout429: 0, pagina: { status: 200, titel: null },
    ...over,
  });
}
resetGhl();
globalThis.fetch = async (url, opt = {}) => {
  const u = new URL(url);
  const m = opt.method || 'GET';
  const body = opt.body ? JSON.parse(opt.body) : null;
  const json = (j, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(j) });
  if (u.hostname === 'training.deforexopleiding.nl' || u.hostname === 'www.deforexopleiding.nl') {
    if (ghl.pagina.dns && u.hostname === 'training.deforexopleiding.nl') throw new Error('getaddrinfo ENOTFOUND');
    return { ok: ghl.pagina.status === 200, status: ghl.pagina.status, text: async () => `<html><head><title>${ghl.pagina.titel || ''}</title></head></html>` };
  }
  const p = u.pathname;
  if (p === '/contacts/search' && m === 'POST') {
    if (ghl.fout429 > 0) { ghl.fout429--; return json({ message: 'Too many requests' }, 429); }
    ghl.zoekopdrachten.push(body);
    const tag = body.filters[0].value;
    const lijst = ghl.contacten.filter((c) => c.tags.includes(tag));
    const start = body.searchAfter ? body.searchAfter[0] : 0;
    const pagina = lijst.slice(start, start + body.pageLimit).map((c, i) => ({ ...c, searchAfter: [start + i + 1] }));
    return json({ contacts: pagina, total: lijst.length });
  }
  let r = /^\/contacts\/([^/]+)\/tags$/.exec(p);
  if (r && m === 'POST') { ghl.getagd.push(r[1]); return json({ tags: body.tags }); }
  if (p === '/workflows/') return json({ workflows: ghl.workflows });
  r = /^\/locations\/loc1\/customValues(?:\/(.+))?$/.exec(p);
  if (r) {
    if (m === 'GET') return json({ customValues: ghl.cv });
    if (m === 'POST') { const cv = { id: 'cv1', name: body.name, value: body.value, fieldKey: '{{ custom_values.weekeditie_onderwerp }}' }; ghl.cv.push(cv); return json({ customValue: cv }); }
    if (m === 'PUT') { const cv = ghl.cv.find((x) => x.id === r[1]); Object.assign(cv, body); return json({ customValue: cv }); }
  }
  if (p === '/locations/loc1/tags') return json({ tags: [{ name: 'nieuwsbrief' }, { name: 'klant' }, { name: 'marktanalyse' }, { name: 'weekeditie-verzenden' }] });
  if (p === '/emails/builder' && m === 'POST') { ghl.templates.tpl1 = { naam: body.name }; return json({ redirect: 'tpl1' }); }
  if (p === '/emails/builder/data' && m === 'POST') { ghl.templates[body.templateId] = { ...(ghl.templates[body.templateId] || {}), html: body.html, preview: body.previewText }; return json({ ok: true }); }
  if (p === '/contacts/search/duplicate') return json({ contact: { id: 'me' } });
  if (p === '/conversations/messages' && m === 'POST') { ghl.testmails.push(body); return json({ messageId: 'm1' }); }
  return json({ message: 'onbekend ' + m + ' ' + p }, 404);
};

// ── drop ────────────────────────────────────────────────────────────────────
const ID = '99999999-9999-4999-8999-999999999999';
const BEELDEN = ['story-1', 'story-2', 'story-3', 'story-4', 'post-1', 'post-2', 'post-3', 'post-4', 'post-5', 'post-6', 'vierkant', 'linkedin', 'og', 'nieuwsbrief'];
const editie = (over = {}) => ({
  versie: 2, format_key: 'trade_ontleed', kernidee: 'k', regie: voorbeeldRegie(), ...voorbeeldEditie(), pagina: { ...voorbeeldEditie().pagina, thema: 'nacht' },
  meta: { verboden_namen: [], waarschuwingen: [] },
  social: { bestanden: Object.fromEntries(BEELDEN.map((n) => [n, { url: `https://cdn.test/${n}.png` }])), opgeslagen_op: '2026-10-26T10:00:00Z' },
  ...over,
});
function reset({ status = 'gegenereerd', output = editie(), rol = 'super_admin', input = {} } = {}) {
  const d = { id: ID, slug: '22-10-26', datum: '2026-10-22', soort: 'training', status, versie: 2, input: { vimeo_id: '1238714790', start_sec: 600, wat_gebeurde: 'De DXY kantelde.', ...input }, aangemaakt_op: '2026-10-22T10:00:00Z' };
  d.output = G.metVasteTeksten(output, { drop: d }); // zoals de generator (werkAf) het aflevert
  fake.db.tabellen = {
    profiles: [{ id: 'u1', email: 'maxim@x.nl', full_name: 'Maxim', role: rol }],
    content_drops: [d],
    content_drop_versies: [], content_assets: ASSETS.map((a) => ({ ...a })), nieuwsbrief_verzendingen: [], team_members: [],
    app_settings: [], weekeditie_testmails: [], weekeditie_lanceringen: [], weekeditie_lancering_contacten: [],
  };
  fake.db.uniek = {
    weekeditie_lancering_contacten: [[['lancering_id', 'contact_id']]],
    weekeditie_lanceringen: [[['drop_id'], (r) => ['ingepland', 'taggen'].includes(r.status)]],
  };
  fake.db.ontbreekt = {};
}
async function roep(mod, { method = 'POST', query = {}, body = {}, headers = { authorization: 'Bearer x' } } = {}) {
  const res = maakRes();
  await mod.default({ method, query, body, headers }, res);
  return res;
}
const drop = () => fake.db.tabellen.content_drops[0];
const lanceringen = () => fake.db.tabellen.weekeditie_lanceringen;
async function instellen() {
  const r = await roep(LANCEER, { body: { actie: 'ghl-instellen' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  return r;
}

// ── 1. GHL-hulp ─────────────────────────────────────────────────────────────
test('magTaggen: DND, uitgeschreven, geen e-mail en "had de tag al" worden overgeslagen', () => {
  const r = Object.fromEntries(ghl.contacten.map((c) => [c.id, GW.magTaggen(c).ok ? 'ok' : GW.magTaggen(c).reden]));
  assert.deepEqual(r, { c1: 'ok', c2: 'DND', c3: 'uitgeschreven (DND e-mail)', c4: 'geen e-mailadres', c5: 'had de verzendtag al', c6: 'ok', c7: 'ok', x1: 'ok' });
  assert.deepEqual(GW.nieuwsbriefKandidaten(['nieuwsbrief', 'Newsletter 2024', 'klant', 'weekeditie-verzenden', 'marktanalyse']), ['nieuwsbrief', 'Newsletter 2024', 'marktanalyse']);
});

test('zoeken per tag: filter "tags contains", pagina\'s via searchAfter; 429 → even wachten en opnieuw', async () => {
  resetGhl({ fout429: 1 });
  const cfg = { token: 'tok', locationId: 'loc1' };
  const p1 = await GW.zoekContactenMetTag(cfg, { tag: 'nieuwsbrief', limiet: 3 });
  assert.deepEqual(p1.contacten.map((c) => c.id), ['c1', 'c2', 'c3']);
  assert.equal(p1.totaal, 7);
  assert.deepEqual(ghl.zoekopdrachten[0].filters, [{ field: 'tags', operator: 'contains', value: 'nieuwsbrief' }]);
  const p3 = await GW.zoekContactenMetTag(cfg, { tag: 'nieuwsbrief', limiet: 3, searchAfter: [6] });
  assert.deepEqual(p3.contacten.map((c) => c.id), ['c7']);
  assert.equal(p3.volgende, null, 'laatste pagina');
});

// ── 2. lancering-hulp ───────────────────────────────────────────────────────
test('beelden, paginatitel en voorwaarden', async () => {
  const o = editie();
  assert.deepEqual(WL.verwachteBeelden(o), BEELDEN.filter((n) => n !== 'nieuwsbrief').concat('nieuwsbrief').sort((a, b) => BEELDEN.indexOf(a) - BEELDEN.indexOf(b)));
  assert.equal(WL.beeldenCheck(o, WL.kanalenVan({ input: {} })).ok, true);
  const zonder = editie(); delete zonder.social.bestanden.og;
  assert.deepEqual(WL.beeldenCheck(zonder, WL.kanalenVan({})).ontbreekt, ['og']);
  assert.deepEqual(WL.verwachteBeelden(o, new Set(['pagina'])), ['og'], 'enkel de aangezette kanalen');
  assert.equal(WL.titelUit('<title>De dollar draait &amp; wij &#x27;zagen&#39; het</title>'), "De dollar draait & wij 'zagen' het");
  // ISR: eerst 404, dan de juiste titel
  resetGhl({ pagina: { status: 404 } });
  let n = 0;
  const p = await WL.paginaCheck({ slug: '22-10-26', verwacht: 'Titel X', interval: 1, maxMs: 1000, slaap: async () => { n++; if (n === 2) Object.assign(ghl.pagina, { status: 200, titel: 'Titel X' }); } });
  assert.equal(p.ok, true); assert.equal(p.pogingen, 3);
  resetGhl({ pagina: { status: 200, titel: 'Andere' } });
  const f = await WL.paginaCheck({ slug: '22-10-26', verwacht: 'Titel X', interval: 1, maxMs: 1, slaap: async () => {} });
  assert.equal(f.ok, false); assert.match(f.fout, /titel is "Andere", verwacht "Titel X"/);
  resetGhl({ pagina: { status: 200, titel: 'Titel X', dns: true } });
  const s = await WL.paginaCheck({ slug: '22-10-26', verwacht: 'Titel X', maxMs: 1, slaap: async () => {} });
  assert.equal(s.ok, true); assert.equal(s.via, 'site'); assert.match(s.live_fout, /ENOTFOUND/);
  const v = WL.voorwaarden({ drop: { status: 'gegenereerd', output: o, versie: 2 }, problemen: [], test: null, cfg: { ok: true, ontbreekt: [] }, instellingen: { ...GW.STANDAARD }, beelden: WL.beeldenCheck(o), kanalen: WL.kanalenVan({}), rol: 'manager' });
  assert.deepEqual(v.filter((x) => x.blokkeert).map((x) => x.sleutel), ['rol', 'template', 'test']);
});

// ── 3. taggen ───────────────────────────────────────────────────────────────
const lancering = (id) => ({ id, drop_id: ID, drop_versie: 2, status: 'taggen', doelgroep_tag: 'nieuwsbrief', verzend_tag: 'weekeditie-verzenden', getagd: 0, overgeslagen: 0, mislukt: 0, cursor: null, totaal: null });
const DB = async () => (await import('../api/supabase.js')).supabaseAdmin;
const CFG = { token: 'tok', locationId: 'loc1' };

test('taggen: wie mag krijgt de tag, de rest wordt overgeslagen met reden; nog eens draaien tagt niemand opnieuw', async () => {
  reset(); resetGhl();
  lanceringen().push(lancering('L1'));
  await WL.verwerkLancering(await DB(), CFG, lancering('L1'), { deadline: Date.now() + 60000, pauze: 0 });
  assert.deepEqual([...ghl.getagd].sort(), ['c1', 'c6', 'c7']);
  const na = lanceringen()[0];
  assert.equal(na.status, 'klaar'); assert.equal(na.getagd, 3); assert.equal(na.overgeslagen, 4); assert.equal(na.totaal, 7);
  const redenen = Object.fromEntries(fake.db.tabellen.weekeditie_lancering_contacten.map((x) => [x.contact_id, x.reden || x.status]));
  assert.deepEqual(redenen, { c1: 'getagd', c2: 'DND', c3: 'uitgeschreven (DND e-mail)', c4: 'geen e-mailadres', c5: 'had de verzendtag al', c6: 'getagd', c7: 'getagd' });
  await WL.verwerkLancering(await DB(), CFG, { ...na, status: 'taggen', cursor: null }, { deadline: Date.now() + 60000, pauze: 0 });
  assert.equal(ghl.getagd.length, 3, 'geen tweede tag = geen tweede mail');
});

test('taggen: tijd op midden in een pagina → de volgende run gaat verder zonder dubbels', async () => {
  reset(); resetGhl();
  lanceringen().push(lancering('L2'));
  const tussen = await WL.verwerkLancering(await DB(), CFG, lancering('L2'), { deadline: () => ghl.getagd.length >= 1, pauze: 0 });
  assert.equal(tussen.status, 'taggen'); assert.equal(ghl.getagd.length, 1); assert.equal(tussen.cursor, null, 'cursor blijft op de onvolledige pagina');
  const klaar = await WL.verwerkLancering(await DB(), CFG, tussen, { deadline: Date.now() + 60000, pauze: 0 });
  assert.equal(klaar.status, 'klaar');
  assert.deepEqual([...ghl.getagd].sort(), ['c1', 'c6', 'c7']);
  assert.equal(klaar.getagd, 3); assert.equal(klaar.overgeslagen, 4);
});

// ── 4. endpoint ─────────────────────────────────────────────────────────────
test('lanceer: enkel super_admin; GHL instellen maakt de vaste template + het onderwerp en meldt de lijst-tags', async () => {
  reset({ rol: 'manager' }); resetGhl();
  assert.equal((await roep(LANCEER, { body: { actie: 'lanceer', id: ID } })).statusCode, 403);
  assert.equal((await roep(LANCEER, { body: { actie: 'ghl-instellen' } })).statusCode, 403);
  const st = await roep(LANCEER, { method: 'GET', query: { id: ID } });
  assert.equal(st.statusCode, 200); assert.equal(st.body.super_admin, false);
  assert.ok(st.body.voorwaarden.find((v) => v.sleutel === 'rol' && v.blokkeert));
  reset(); resetGhl();
  const r = await instellen();
  assert.equal(r.body.rapport.instellingen.template_id, 'tpl1');
  assert.equal(ghl.templates.tpl1.naam, 'DFO Weekeditie (actueel)');
  assert.equal(r.body.rapport.instellingen.custom_value_sleutel, '{{ custom_values.weekeditie_onderwerp }}');
  assert.deepEqual(r.body.rapport.workflow, { id: 'wf1', naam: 'DFO Weekeditie versturen', status: 'published' });
  assert.deepEqual(r.body.rapport.tags.kandidaten.map((k) => [k.tag, k.contacten]), [['nieuwsbrief', 7], ['marktanalyse', 0]]);
  assert.equal(ghl.getagd.length, 0, 'instellen tagt niemand');
  // tweede keer: geen nieuwe template
  await instellen();
  assert.equal(Object.keys(ghl.templates).length, 1);
});

test('lanceer nu: testmail verplicht (enkel naar mij), workflow verplicht; daarna pagina online, template + onderwerp + tags', async () => {
  reset(); resetGhl();
  await instellen();
  let r = await roep(LANCEER, { body: { actie: 'lanceer', id: ID, modus: 'nu', onderwerp: 1 } });
  assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'GEEN_TEST');
  const t = await roep(LANCEER, { body: { actie: 'test', id: ID, onderwerp: 1 } });
  assert.equal(t.statusCode, 200, JSON.stringify(t.body));
  assert.equal(ghl.testmails.length, 1); assert.equal(ghl.testmails[0].emailTo, 'maxim@x.nl'); assert.match(ghl.testmails[0].subject, /^\[TEST\] /);
  assert.equal(ghl.getagd.length, 0, 'een test tagt niemand');
  ghl.workflows = [];
  r = await roep(LANCEER, { body: { actie: 'lanceer', id: ID, modus: 'nu', onderwerp: 1 } });
  assert.equal(r.statusCode, 409); assert.equal(r.body.code, 'GEEN_WORKFLOW');
  assert.equal(drop().status, 'gegenereerd', 'niets veranderd');
  ghl.workflows = [{ id: 'wf1', name: 'DFO Weekeditie versturen', status: 'published' }];
  r = await roep(LANCEER, { body: { actie: 'lanceer', id: ID, modus: 'nu', onderwerp: 1 } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(drop().status, 'gepubliceerd'); assert.ok(drop().gepubliceerd_op && drop().goedgekeurd_op);
  assert.match(ghl.templates.tpl1.html, /Lees de volledige weekeditie/);
  assert.equal(ghl.cv[0].value, voorbeeldEditie().nieuwsbrief.onderwerpen[1]);
  assert.deepEqual([...ghl.getagd].sort(), ['c1', 'c6', 'c7']);
  assert.equal(r.body.lancering.status, 'klaar'); assert.equal(r.body.lancering.getagd, 3); assert.equal(r.body.lancering.totaal, 7);
  // nog eens lanceren → al verstuurd
  const opnieuw = await roep(LANCEER, { body: { actie: 'lanceer', id: ID, modus: 'nu' } });
  assert.equal(opnieuw.statusCode, 409);
  assert.equal(ghl.getagd.length, 3);
  // paginacontrole
  Object.assign(ghl.pagina, { status: 200, titel: voorbeeldEditie().pagina.seo_titel });
  const pc = await roep(LANCEER, { body: { actie: 'controleer-pagina', id: ID } });
  assert.equal(pc.body.check.ok, true);
  assert.equal(lanceringen()[0].pagina_check.ok, true);
});

test('een nieuwe versie maakt de testmail ongeldig; grensfout blokkeert; ontbrekende beelden blokkeren', async () => {
  reset(); resetGhl();
  await instellen();
  await roep(LANCEER, { body: { actie: 'test', id: ID } });
  drop().versie = 3;
  assert.equal((await roep(LANCEER, { body: { actie: 'lanceer', id: ID } })).body.code, 'GEEN_TEST');
  reset({ output: { ...editie(), linkedin: { ...editie().linkedin, tekst: 'Gegarandeerd winst.\n\na\n\nb' } } }); resetGhl();
  assert.equal((await roep(LANCEER, { body: { actie: 'lanceer', id: ID } })).body.code, 'GRENZEN');
  const o = editie(); delete o.social.bestanden['story-2'];
  reset({ output: o }); resetGhl();
  const r = await roep(LANCEER, { body: { actie: 'lanceer', id: ID } });
  assert.equal(r.body.code, 'BEELDEN_ONTBREKEN'); assert.deepEqual(r.body.beelden.ontbreekt, ['story-2']);
});

test('ingepland: pagina meteen online, de cron tagt op het tijdstip; gewijzigde drop → geannuleerd; annuleren', async () => {
  reset(); resetGhl();
  await instellen();
  await roep(LANCEER, { body: { actie: 'test', id: ID } });
  const tijd = new Date(Date.now() + 3600e3).toISOString();
  const r = await roep(LANCEER, { body: { actie: 'lanceer', id: ID, modus: 'ingepland', ingepland_op: tijd } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(drop().status, 'gepubliceerd');
  assert.equal(lanceringen()[0].status, 'ingepland'); assert.equal(ghl.getagd.length, 0);
  assert.equal(ghl.templates.tpl1.html, undefined, 'de template wordt pas op het tijdstip bijgewerkt');
  assert.equal((await roep(CRON, { method: 'GET', headers: {} })).statusCode, 401);
  let c = await roep(CRON, { method: 'GET', headers: { authorization: 'Bearer cron' } });
  assert.equal(c.body.niets, true, 'nog niet aan de beurt');
  lanceringen()[0].ingepland_op = new Date(Date.now() - 1000).toISOString();
  c = await roep(CRON, { method: 'GET', headers: { authorization: 'Bearer cron' } });
  assert.equal(c.statusCode, 200, JSON.stringify(c.body));
  assert.equal(c.body.lancering.status, 'klaar');
  assert.deepEqual([...ghl.getagd].sort(), ['c1', 'c6', 'c7']);
  assert.match(ghl.templates.tpl1.html, /Lees de volledige weekeditie/);
  // gewijzigde drop na inplannen
  reset({ status: 'gepubliceerd' }); resetGhl();
  await instellen();
  lanceringen().push({ id: 'L9', drop_id: ID, drop_versie: 1, status: 'ingepland', modus: 'ingepland', ingepland_op: new Date(Date.now() - 1000).toISOString(), doelgroep_tag: 'nieuwsbrief', verzend_tag: 'weekeditie-verzenden', getagd: 0, overgeslagen: 0, mislukt: 0, onderwerp_index: 0 });
  c = await roep(CRON, { method: 'GET', headers: { authorization: 'Bearer cron' } });
  assert.equal(c.body.geannuleerd, 'L9'); assert.equal(lanceringen()[0].status, 'geannuleerd'); assert.equal(ghl.getagd.length, 0);
  // annuleren
  lanceringen()[0].status = 'ingepland';
  const a = await roep(LANCEER, { body: { actie: 'annuleer', id: ID } });
  assert.equal(a.statusCode, 200); assert.equal(lanceringen()[0].status, 'geannuleerd');
});

test('instellingen: tags valideren, doelgroep ≠ verzendtag', async () => {
  reset(); resetGhl();
  assert.equal((await roep(LANCEER, { body: { actie: 'instellingen', doelgroep_tag: 'x;drop' } })).statusCode, 400);
  assert.equal((await roep(LANCEER, { body: { actie: 'instellingen', doelgroep_tag: 'zelfde', verzend_tag: 'zelfde' } })).statusCode, 400);
  const r = await roep(LANCEER, { body: { actie: 'instellingen', doelgroep_tag: 'weekeditie-test' } });
  assert.equal(r.body.instellingen.doelgroep_tag, 'weekeditie-test');
  assert.equal((await WL.leesInstellingen((await import('../api/supabase.js')).supabaseAdmin)).verzend_tag, 'weekeditie-verzenden');
});

// ── 5. data + bedrading ─────────────────────────────────────────────────────
test('data: top-3 blokken (gebruik, dan gezien) en cijfers per drop', () => {
  const ev = [
    { session_id: 's1', event_type: 'blok_bekeken', vraag_id: 'hero', variant: 'training-22-10-26' },
    { session_id: 's2', event_type: 'blok_bekeken', vraag_id: 'hero', variant: 'training-22-10-26' },
    { session_id: 's1', event_type: 'replay_gestart', vraag_id: 'replay-sweep-bos', variant: 'training-22-10-26' },
    { session_id: 's2', event_type: 'replay_gestart', vraag_id: 'replay-sweep-bos', variant: 'training-22-10-26' },
    { session_id: 's1', event_type: 'slider_gebruikt', vraag_id: 'rr-sliders', variant: 'training-22-10-26' },
    { session_id: 's1', event_type: 'slider_gebruikt', vraag_id: 'rr-sliders', variant: 'training-22-10-26' },
    { session_id: 's3', event_type: 'quiz_antwoord', vraag_id: 'quiz', variant: 'drop-29-10-26' },
  ];
  assert.deepEqual(WD.topBlokken(ev.filter((e) => e.variant === 'training-22-10-26')), [
    { type: 'replay-sweep-bos', bekeken: 2, gebruikt: 2, pct: 100 },
    { type: 'rr-sliders', bekeken: 1, gebruikt: 1, pct: 100 },
    { type: 'hero', bekeken: 2, gebruikt: 0, pct: 0 },
  ]);
  const d = WD.dataPerDrop([{ variant: 'training-22-10-26', bezoekers: 40, leads: 6, calls: 2, calls_gehouden: 1, kanalen: [{ kanaal: 'ig-story', label: 'IG-story', bezoekers: 30, leads: 5, calls: 2 }] }], ev);
  assert.equal(d['22-10-26'].conversie_pct, 15);
  assert.equal(d['22-10-26'].kanalen[0].kanaal, 'ig-story');
  assert.equal(d['29-10-26'].top_blokken[0].type, 'quiz');
  assert.equal(WD.slugVanVariant('drop-29-10-26-2'), '29-10-26-2');
});

test('bedrading: cron in vercel.json, scripts in de juiste volgorde, Trainingdrops leest via de gedeelde lib', () => {
  const v = JSON.parse(lees('vercel.json'));
  assert.ok(v.crons.some((c) => c.path === '/api/cron-weekeditie-lancering' && c.schedule === '*/2 * * * *'));
  assert.equal(v.functions['api/contentmachine/lanceer.js'].maxDuration, 60);
  const idx = lees('modules/klanten-v2/index.html');
  const pos = (n) => idx.indexOf(`views/${n}.js`);
  assert.ok(pos('contentmachine-werkblad-v2') < pos('contentmachine-lanceer-v2') && pos('contentmachine-social-v2') < pos('contentmachine-lanceer-v2'));
  assert.match(lees('api/trainingdrops.js'), /laadTrainingdrops\(supabaseAdmin\)/);
  assert.match(lees('modules/klanten-v2/views/contentmachine-v2.js'), /\/api\/contentmachine\/data/);
  // het CRM verstuurt NOOIT zelf naar de lijst: enkel tags + testmail naar de ingelogde gebruiker
  const src = lees('api/_lib/ghl-weekeditie.js') + lees('api/_lib/weekeditie-lancering.js') + lees('api/contentmachine/lanceer.js') + lees('api/cron-weekeditie-lancering.js');
  assert.doesNotMatch(src, /conversations\/messages|emails\/schedule'|campaign/i);
});

test('werkblad: knop "Keur goed en lanceer" (super_admin), bevestigingsscherm, statusbord en Klaar om te posten', async () => {
  reset(); resetGhl();
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><head></head><div id="content"></div>', { runScripts: 'outside-only', url: 'https://crm.test/' });
  const w = dom.window;
  const st = await roep(LANCEER, { method: 'GET', query: { id: ID } });
  const status = { ...st.body };
  const antwoorden = {
    [`/api/contentmachine/drops?id=${ID}`]: { drop: drop(), assets: [], versies: [] },
    '/api/contentmachine/assets?bibliotheek=1': { assets: ASSETS },
    '/api/contentmachine/drops?blokken=1': { blokken: JSON.parse(lees('api/_lib/weekeditie-blokken.json')) },
    [`/api/contentmachine/lanceer?id=${ID}`]: status,
    '/api/contentmachine/data': { drops: { '22-10-26': { bezoekers: 40, leads: 6, conversie_pct: 15, calls: 2, calls_gehouden: 1, kanalen: [{ kanaal: 'ig-story', label: 'IG-story', bezoekers: 30, leads: 5, calls: 2 }], top_blokken: [{ type: 'replay-sweep-bos', bekeken: 20, gebruikt: 12, pct: 60 }] } } },
  };
  w.DFO = { VIEWS: {}, render() {}, goTab() {} };
  w.KV = { authedJson: async (u) => antwoorden[u] || { html: '<p>x</p>', onderwerp: 'x' }, toast() {} };
  for (const f of ['contentmachine-v2', 'contentmachine-werkblad-v2', 'weekeditie-chart-v2', 'contentmachine-canvas-v2', 'contentmachine-blokframe-v2', 'contentmachine-social2-v2', 'contentmachine-weekeditie-v2', 'contentmachine-lanceer-v2']) w.eval(lees(`modules/klanten-v2/views/${f}.js`));
  await w.__cmWbOpen(ID);
  const V = w.DFO.VIEWS['contentmachine/Overzicht'];
  V();
  await new Promise((ok) => setTimeout(ok, 20));
  let html = V();
  assert.ok(html.includes('🚀 Keur goed en lanceer'));
  assert.ok(!html.includes('✓ Goedkeuren'), 'super_admin: één flow in plaats van losse knoppen');
  w.__cmLzOpen();
  await new Promise((ok) => setTimeout(ok, 20));
  html = V();
  for (const t of ['Wat er gebeurt', 'training.deforexopleiding.nl/22-10-26', 'DFO Weekeditie (actueel)', 'weekeditie-verzenden', 'Stuur testmail naar mij', 'Nu versturen', 'Inplannen op', 'Eerst: template, test']) assert.ok(html.includes(t), t);
  // na een lancering: statusbord
  antwoorden[`/api/contentmachine/lanceer?id=${ID}`] = { ...status, lancering: { status: 'klaar', getagd: 3, totaal: 7, overgeslagen: 4, mislukt: 0, klaar_op: '2026-10-26T12:00:00Z', pagina_check: { ok: true } } };
  drop().status = 'gepubliceerd';
  w.__cmWb.drop.status = 'gepubliceerd';
  w.__cmLz.open = false; w.__cmLz.dropId = null;
  V(); await new Promise((ok) => setTimeout(ok, 30));
  html = V();
  for (const t of ['Statusbord', 'Pagina live', '200 · juiste titel', '3 contacten getagd van 7', '4 overgeslagen', 'Leads tot nu toe', '<b>6</b>', 'Calls tot nu toe', 'replay-sweep-bos (12× gebruikt', 'Klaar om te posten', 'src=ig-story', 'src=linkedin']) assert.ok(html.includes(t), t);
  // niet-super_admin: geen lanceerknop, wel goedkeuren
  antwoorden[`/api/contentmachine/lanceer?id=${ID}`] = { ...status, super_admin: false, lancering: null };
  w.__cmWb.drop.status = 'gegenereerd'; w.__cmLz.dropId = null;
  V(); await new Promise((ok) => setTimeout(ok, 20));
  html = V();
  assert.ok(!html.includes('🚀 Keur goed en lanceer'));
  assert.ok(html.includes('✓ Goedkeuren') && html.includes('Lanceren: super_admin'));
});
