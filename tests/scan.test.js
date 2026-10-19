// Strategie-scan fase 1 (2026-10-15).
//   1. scoremodel (modules/scan/scan-model.js): exact de mockup-logica —
//      "Nu nog niet" alleen bij Schulden, day/swing, trajectregels, geen prijzen;
//   2. overrides: categorie/aanpak/traject sturen de teksten; tekst-overrides winnen;
//   3. api/scan.js: 401/403 (strikt scan.use), server rekent zelf, lead-koppeling,
//      prefill uit afspraak (en doorsturen naar een bestaande scan), status-regels;
//   4. bedrading: /scan-rewrite, pagina zonder CRM-navigatie, thema-toggle,
//      recht in de registry, SQL met RLS + REVOKE, Start-scan-link in het call-rapport.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ONDERDELEN, TOTAAL_VRAGEN, berekenBasis, berekenUitkomst, normaliseerAntwoorden, normaliseerOverride,
} from '../modules/scan/scan-model.js';
import { maakHandler, valideerScan, scanKolommen } from '../api/scan.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

/** Antwoorden: alle likerts op `likert`, en per MC de gegeven optie-index (default 0). */
function antwoorden({ likert = 5, mc = {} } = {}) {
  const a = {};
  ONDERDELEN.forEach((p) => p.items.forEach((it, i) => {
    const key = p.k + '_' + i;
    a[key] = it.type === 'likert' ? likert : (mc[key] ?? 0);
  }));
  return a;
}
// Optie-indexen uit de mockup.
const FIN = { stabiel: 0, redelijk: 1, krap: 2, schulden: 3 };
const TOP = { tijd_0: 3, financieel_0: FIN.stabiel, kennis_0: 3, verwachtingen_0: 3, verwachtingen_1: 0, leerstijl_0: 0, stijl_0: 0, stijl_1: 0 };

// ── 1. Scoremodel ───────────────────────────────────────────────────────────

test('model: 8 onderdelen, 30 vragen, exact de mockup-vragen', () => {
  assert.deepEqual(ONDERDELEN.map((p) => p.k), ['motivatie', 'tijd', 'stijl', 'financieel', 'kennis', 'mindset', 'verwachtingen', 'leerstijl']);
  assert.equal(TOTAAL_VRAGEN, 30);
  assert.equal(ONDERDELEN[3].items[0].opts.map((o) => o[0]).join('|'), 'Stabiel|Redelijk|Krap|Schulden');
  assert.equal(ONDERDELEN[0].items[0].t, 'Wat is je uiteindelijke doel met traden?');
});

test('model: topprofiel + 1-op-1 → Zeer geschikt, 24 maanden, Daytrading, met volgende stap', () => {
  const u = berekenUitkomst(antwoorden({ likert: 5, mc: TOP }));
  assert.equal(u.readiness, 100);
  assert.equal(u.categorie, 'Zeer geschikt'); assert.equal(u.toon, 'ok');
  assert.equal(u.traject, '24 maanden 1-op-1');
  assert.equal(u.aanpak, 'Daytrading');
  assert.equal(u.doel, 'Financiële vrijheid');
  assert.ok(u.volgendeStap && u.volgendeStap.titel === 'Jouw route: 24 maanden 1-op-1');
  assert.match(u.volgendeStap.schaars, /beperkt aantal nieuwe 1-op-1/);
});

test('model: "Nu nog niet" ALLEEN bij Schulden — dan geen aanpak, geen betaald traject, geen salesblok', () => {
  const u = berekenUitkomst(antwoorden({ likert: 5, mc: { ...TOP, financieel_0: FIN.schulden } }));
  assert.equal(u.categorie, 'Nu nog niet'); assert.equal(u.toon, 'red');
  assert.equal(u.aanpak, null);
  assert.equal(u.traject, 'Eerst de basis op orde'); assert.equal(u.trajectKop, 'Ons eerlijke advies');
  assert.equal(u.volgendeStap, null);
  assert.match(u.advies, /nu nog niet/);
  // Krap = géén "Nu nog niet" (wel een aandachtspunt); lage scores ook niet.
  const krap = berekenUitkomst(antwoorden({ likert: 5, mc: { ...TOP, financieel_0: FIN.krap } }));
  assert.notEqual(krap.categorie, 'Nu nog niet');
  assert.ok(krap.opvallend.some((x) => /financiële ruimte is wat krap/.test(x.tekst)));
  const laag = berekenUitkomst(antwoorden({ likert: 1, mc: { tijd_0: 0, kennis_0: 0 } }));
  assert.equal(laag.categorie, 'Geschikt met de juiste begeleiding');
});

test('model: onrealistische verwachtingen houden "Zeer geschikt" tegen', () => {
  const u = berekenUitkomst(antwoorden({ likert: 5, mc: { ...TOP, verwachtingen_1: 1 } }));
  assert.ok(u.readiness >= 66);
  assert.equal(u.categorie, 'Geschikt met de juiste begeleiding');
  assert.ok(u.opvallend.some((x) => /reken op maanden, niet weken/.test(x.tekst)));
});

test('model: traject — zelfstandig + sterke mindset → Zelfstudie; standaard 12 maanden', () => {
  assert.equal(berekenUitkomst(antwoorden({ likert: 5, mc: { ...TOP, leerstijl_0: 2 } })).traject, 'Zelfstudietraject');
  // Zelfstandig maar zwakke mindset → geen zelfstudie.
  const a = antwoorden({ likert: 5, mc: { ...TOP, leerstijl_0: 2 } });
  for (let i = 0; i < 4; i++) a['mindset_' + i] = 2;
  assert.equal(berekenUitkomst(a).traject, '12 maanden 1-op-1');
  // Middelmatig profiel → 12 maanden (likert 4 is al een topprofiel → 24).
  assert.equal(berekenUitkomst(antwoorden({ likert: 3, mc: { ...TOP } })).traject, '12 maanden 1-op-1');
  assert.equal(berekenUitkomst(antwoorden({ likert: 4, mc: { ...TOP } })).traject, '24 maanden 1-op-1');
});

test('model: Swingtrading alleen als dat duidelijk beter past (meer swing dan day); gelijk → Daytrading', () => {
  assert.equal(berekenUitkomst(antwoorden({ mc: { ...TOP, stijl_0: 1, stijl_1: 1 } })).aanpak, 'Swingtrading');
  assert.equal(berekenUitkomst(antwoorden({ mc: { ...TOP, stijl_0: 1, stijl_1: 0 } })).aanpak, 'Daytrading');
  const a = antwoorden({ mc: TOP }); delete a.stijl_0; delete a.stijl_1;
  assert.equal(berekenUitkomst(a).aanpak, 'Daytrading', 'niet beantwoord → voorkeur Daytrading');
});

test('model: onbeantwoord telt als neutraal (3); ongeldige antwoorden vallen weg', () => {
  assert.equal(berekenBasis({}).readiness, 60);
  assert.deepEqual(normaliseerAntwoorden({ motivatie_1: 9, motivatie_0: 99, tijd_0: '2', hack: 1, motivatie_2: 4 }), { motivatie_2: 4 });
  assert.equal(berekenUitkomst({}).beantwoord, 0);
});

test('model: geen prijzen en geen rendement-/tijdlijncijfers in de teksten', () => {
  const varianten = [
    antwoorden({ likert: 5, mc: TOP }),
    antwoorden({ likert: 5, mc: { ...TOP, financieel_0: FIN.schulden } }),
    antwoorden({ likert: 2, mc: { ...TOP, financieel_0: FIN.krap, verwachtingen_0: 0, leerstijl_0: 2 } }),
  ];
  for (const a of varianten) {
    const u = berekenUitkomst(a);
    const tekst = [u.verdict, u.aanpakUitleg, u.trajectUitleg, u.samenvatting, u.advies, ...u.opvallend.map((x) => x.tekst),
      ...(u.volgendeStap ? [u.volgendeStap.lead, ...u.volgendeStap.voordelen.flat()] : [])].join(' ');
    assert.doesNotMatch(tekst, /€|\bEUR\b|%|euro/i);
    // Trajectduur (12/24 maanden) mag; een belofte over wannéér resultaat komt niet.
    assert.doesNotMatch(tekst, /binnen\s+\d|na\s+\d+\s*(dagen|weken|maanden)|\d+\s*(procent|x)\b|winst van|rendement van/i);
  }
});

// ── 2. Overrides ────────────────────────────────────────────────────────────

test('override: categorie/traject/aanpak sturen de teksten; tekst-overrides winnen; onzin valt weg', () => {
  const a = antwoorden({ likert: 5, mc: TOP });
  const t = berekenUitkomst(a, { traject: '12 maanden 1-op-1', aanpak: 'Swingtrading' });
  assert.equal(t.traject, '12 maanden 1-op-1');
  assert.match(t.advies, /12 maanden 1-op-1 het beste/);
  assert.match(t.advies, /swingtrading-strategie/);
  assert.equal(t.berekend.traject, '24 maanden 1-op-1', 'de berekende uitkomst blijft bewaard');
  const n = berekenUitkomst(a, { categorie: 'Nu nog niet' });
  assert.equal(n.volgendeStap, null); assert.equal(n.aanpak, null); assert.equal(n.traject, 'Eerst de basis op orde');
  // Weg uit "Nu nog niet" (bij Schulden) → traject valt terug op 12 maanden, salesblok komt terug.
  const s = berekenUitkomst(antwoorden({ likert: 5, mc: { ...TOP, financieel_0: FIN.schulden } }), { categorie: 'Geschikt met de juiste begeleiding' });
  assert.equal(s.traject, '12 maanden 1-op-1'); assert.ok(s.volgendeStap);
  const tx = berekenUitkomst(a, { advies: 'Eigen advies', samenvatting: 'Eigen samenvatting', verdict: 'Eigen conclusie' });
  assert.equal(tx.advies, 'Eigen advies'); assert.equal(tx.samenvatting, 'Eigen samenvatting'); assert.equal(tx.verdict, 'Eigen conclusie');
  assert.deepEqual(normaliseerOverride({ categorie: 'Super', traject: '36 maanden', aanpak: 'Scalping', advies: '   ', hack: 'x' }), {});
});

// ── 3. API ──────────────────────────────────────────────────────────────────

const DAVE = 'd0000000-0000-4000-8000-00000000da7e';
const LEAD = 'l0000000-0000-4000-8000-000000000001'.replace('l', 'a');
const AFSPRAAK = 'b0000000-0000-4000-8000-000000000002';

/** Mini-PostgREST: eq / is / ilike (zonder wildcards) / order / limit / insert / update. */
function nepDb(begin) {
  const t = JSON.parse(JSON.stringify(begin)); let n = 0;
  const from = (tabel) => {
    t[tabel] = t[tabel] || [];
    const f = []; let max = null; let mut = null;
    const pas = () => {
      let r = t[tabel];
      for (const x of f) r = r.filter(x);
      return max == null ? r : r.slice(0, max);
    };
    const uit = () => {
      if (mut && mut.soort === 'update') { const r = pas(); r.forEach((x) => Object.assign(x, mut.v)); return { data: r, error: null }; }
      if (mut && mut.soort === 'insert') { const r = { id: 'e0000000-0000-4000-8000-' + String(++n).padStart(12, '0'), ...mut.v }; t[tabel].push(r); return { data: [r], error: null }; }
      return { data: pas(), error: null };
    };
    const k = {
      select: () => k,
      eq: (c, v) => { f.push((r) => r[c] === v); return k; },
      is: (c, v) => { f.push((r) => (r[c] ?? null) === v); return k; },
      ilike: (c, v) => { const w = String(v).replace(/\\(.)/g, '$1').toLowerCase(); f.push((r) => String(r[c] || '').toLowerCase() === w); return k; },
      order: () => k,
      limit: (m) => { max = m; return k; },
      insert: (v) => { mut = { soort: 'insert', v }; return k; },
      update: (v) => { mut = { soort: 'update', v }; return k; },
      maybeSingle: async () => { const r = uit(); return { data: r.data[0] || null, error: null }; },
      single: async () => { const r = uit(); return { data: r.data[0] || null, error: null }; },
      then: (res, rej) => Promise.resolve(uit()).then(res, rej),
    };
    return k;
  };
  return { from, t };
}

function maak({ user = { id: DAVE }, mag = true, tabellen = {} } = {}) {
  const db = nepDb({
    profiles: [{ id: DAVE, full_name: 'Dave Test', email: 'dave@x.nl' }],
    leads: [{ id: LEAD, naam: 'Mark de Vries', email: 'Mark@Email.nl', telefoon: '0612345678', verwijderd_op: null }],
    follow_up_appointments: [{ id: AFSPRAAK, lead_name: 'Mark de Vries', lead_email: 'mark@email.nl', lead_phone: '+31612345678', booking_source: 'webinar' }],
    scans: [],
    ...tabellen,
  });
  const h = maakHandler({ db, userVan: async () => user, magHet: async () => mag, nu: () => new Date('2026-10-15T12:00:00Z') });
  const roep = async (method, { query = {}, body } = {}) => {
    const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await h({ method, headers: {}, query, body }, res);
    return res;
  };
  return { db, roep };
}

test('api: 401 zonder login, 403 zonder scan.use (strikt), 405 op andere methodes', async () => {
  assert.equal((await maak({ user: null }).roep('GET')).code, 401);
  const r = await maak({ mag: false }).roep('GET');
  assert.equal(r.code, 403); assert.equal(r.body.code, 'GEEN_TOEGANG');
  assert.equal((await maak().roep('DELETE')).code, 405);
  const ok = await maak().roep('GET');
  assert.equal(ok.code, 200); assert.equal(ok.body.gebruiker.naam, 'Dave Test');
});

test('api: prefill uit een webinar-afspraak (met lead-koppeling op e-mail) en uit een lead', async () => {
  const { roep } = maak();
  const r = await roep('GET', { query: { afspraak: AFSPRAAK } });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.prefill, { naam: 'Mark de Vries', email: 'mark@email.nl', telefoon: '+31612345678', afspraak_id: AFSPRAAK, lead_id: LEAD });
  const l = await roep('GET', { query: { lead: LEAD } });
  assert.equal(l.body.prefill.naam, 'Mark de Vries'); assert.equal(l.body.prefill.lead_id, LEAD);
  assert.equal((await roep('GET', { query: { afspraak: 'kapot' } })).code, 400);
  assert.equal((await roep('GET', { query: { afspraak: 'c0000000-0000-4000-8000-000000000009' } })).code, 404);
});

test('api: opslaan rekent ZELF (client-score telt niet), koppelt lead + afspraak, zet assessor', async () => {
  const { roep, db } = maak();
  const a = antwoorden({ likert: 5, mc: TOP });
  const r = await roep('POST', { body: {
    afspraak_id: AFSPRAAK, deelnemer: { naam: ' Mark de Vries ', email: 'MARK@email.nl', telefoon: '0612345678' },
    antwoorden: a, status: 'concept', readiness_score: 1, categorie: 'Nu nog niet', uitkomst: { readiness: 1 },
  } });
  assert.equal(r.code, 200);
  const s = r.body.scan;
  assert.equal(s.readiness_score, 100); assert.equal(s.categorie, 'Zeer geschikt');
  assert.equal(s.aanbevolen_aanpak, 'Daytrading'); assert.equal(s.aanbevolen_traject, '24 maanden 1-op-1');
  assert.equal(s.doel, 'Financiële vrijheid');
  assert.equal(s.uitkomst.readiness, 100);
  assert.equal(s.lead_id, LEAD); assert.equal(s.afspraak_id, AFSPRAAK);
  assert.equal(s.assessor_id, DAVE); assert.equal(s.status, 'concept');
  assert.equal(s.deelnemer_naam, 'Mark de Vries'); assert.equal(s.deelnemer_email, 'mark@email.nl');
  assert.equal(db.t.scans.length, 1);
  // Een tweede bezoek aan dezelfde afspraak gaat naar deze scan, niet een nieuwe.
  const p = await roep('GET', { query: { afspraak: AFSPRAAK } });
  assert.equal(p.body.bestaande_id, s.id);
});

test('api: afronden met override + notitie; verstuurd blijft verstuurd; validatie', async () => {
  const { roep, db } = maak();
  const a = antwoorden({ likert: 5, mc: TOP });
  const r1 = await roep('POST', { body: { deelnemer: { naam: 'Anna' }, antwoorden: a, status: 'concept' } });
  const id = r1.body.scan.id;
  const r2 = await roep('POST', { body: { id, deelnemer: { naam: 'Anna' }, antwoorden: a, status: 'afgerond',
    override: { traject: '12 maanden 1-op-1', advies: 'Start klein.' }, dave_notitie: 'Twijfelt nog over timing' } });
  assert.equal(r2.code, 200);
  assert.equal(r2.body.scan.status, 'afgerond');
  assert.ok(r2.body.scan.afgerond_op);
  assert.equal(r2.body.scan.aanbevolen_traject, '12 maanden 1-op-1');
  assert.equal(r2.body.scan.uitkomst.advies, 'Start klein.');
  assert.equal(r2.body.scan.uitkomst.berekend.traject, '24 maanden 1-op-1');
  assert.equal(r2.body.scan.dave_notitie, 'Twijfelt nog over timing');
  assert.equal(r2.body.scan.lead_id, null, 'geen e-mail → geen lead');
  db.t.scans[0].status = 'verstuurd';
  const r3 = await roep('POST', { body: { id, deelnemer: { naam: 'Anna' }, antwoorden: a, status: 'concept' } });
  assert.equal(r3.body.scan.status, 'verstuurd');
  assert.equal((await roep('POST', { body: { deelnemer: { naam: '' }, antwoorden: a } })).code, 400);
  assert.equal((await roep('POST', { body: { deelnemer: { naam: 'X', email: 'geen-mail' } } })).code, 400);
  assert.equal((await roep('POST', { body: { id: 'c0000000-0000-4000-8000-000000000009', deelnemer: { naam: 'X' } } })).code, 404);
  assert.equal(valideerScan({ deelnemer: { naam: 'X' }, lead_id: 'nee' }).ok, false);
  assert.equal(scanKolommen({}, {}).readiness_score, 60);
});

// ── 4. Bedrading ────────────────────────────────────────────────────────────

test('bedrading: /scan-rewrite, pagina zonder CRM-navigatie met auth + thema-toggle, gedeeld model', () => {
  const vercel = JSON.parse(lees('vercel.json'));
  assert.ok(vercel.rewrites.some((r) => r.source === '/scan' && r.destination === '/modules/scan/index.html'));
  const html = lees('modules/scan/index.html');
  assert.match(html, /<script src="\/modules\/shared\/supabase-client\.js"><\/script>/);
  assert.doesNotMatch(html, /sidebar|crm-guard|app-shell|agent-shared/, 'geen CRM-navigatie eromheen');
  assert.match(html, /<script type="module" src="\/modules\/scan\/scan-app\.js\?v=\d+"><\/script>/);
  assert.match(html, /id="tgl"/);
  const app = lees('modules/scan/scan-app.js');
  assert.match(app, /from '\.\/scan-model\.js\?v=\d+'/);
  assert.match(app, /localStorage\.setItem\('dfo-scan-theme'/);
  assert.match(app, /window\.AuthShared\.requireAuth\(\)/);
  assert.match(lees('api/scan.js'), /from '\.\.\/modules\/scan\/scan-model\.js'/);
  const css = lees('modules/scan/scan.css');
  assert.match(css, /:root\[data-theme="light"\]\{/);
});

test('bedrading: recht scan.use in registry + SQL (RLS, REVOKE, Dave + admins, sales-rol niet)', () => {
  assert.match(lees('modules/shared/rbac/registry.js'), /key:'scan\.use'/);
  const sql = lees('docs/sql-migrations/2026-10-15-scan-fase1.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.scans/);
  assert.match(sql, /ALTER TABLE public\.scans ENABLE ROW LEVEL SECURITY;/);
  assert.match(sql, /REVOKE ALL ON public\.scans FROM anon, authenticated;/);
  assert.match(sql, /SELECT 'admin', 'scan\.use', true/);
  assert.match(sql, /SELECT 'manager', 'scan\.use', true/);
  assert.match(sql, /SELECT 'sales', 'scan\.use', false/);
  assert.match(sql, /INSERT INTO public\.user_permissions[\s\S]*full_name ILIKE 'dave%'/);
  assert.match(sql, /status IN \('concept', 'afgerond', 'verstuurd'\)/);
});

test('bedrading: call-rapport toont "Strategie-scan" bij webinar-calls voor wie scan.use heeft', () => {
  const v = lees('modules/klanten-v2/views/call-rapport-v2.js');
  assert.match(v, /window\.RBAC\.canSync\('scan\.use'\)/);
  assert.match(v, /\['webinar', 'strategiescan'\]\.includes\(r\.booking_source\)/);
  assert.match(v, /href="\/scan\?afspraak=' \+ encodeURIComponent\(r\.appointment_id\)/);
  assert.match(lees('api/call-rapport.js'), /booking_source: a\.booking_source \|\| null,/);
  assert.match(lees('modules/klanten-v2/index.html'), /views\/call-rapport-v2\.js\?v=3/);
});
