// tests/opvolging-leads-aparte-lijsten.test.js
//
// APARTE LIJSTEN in 'Leads bellen' (27 okt 2026): 'Lijst opladen' kan een
// eigen lijst maken met een eigen chip. Die leads staan VOLLEDIG APART (niet in
// Nu bellen of een andere algemene pot/teller), zonder dosering, en de lijst
// blijft tot iemand hem archiveert. De algemene flow blijft exact zoals hij was.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import {
  aparteLijstVan, splitsKaarten, lijstTelling, aparteStaarten, naamBezet, lijstNaam,
  lijstWeergave, tabelOntbreekt, isLijstId,
} from '../api/_lib/opvolging-leads-lijsten.js';
import { stelPottenSamen, potVoorKaart, dagInZone, UITSLUITREDENEN, kaartSamenvatting } from '../api/_lib/opvolging-leads-pot.js';
import {
  leesCsv, maakVoorvertoning, importKaart, maakAparteVoorvertoning, verhuisdeBronRef, OVERSLAAN,
} from '../api/_lib/opvolging-leads-import.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const L1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const L2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const NU = Date.parse('2026-10-27T10:00:00Z');
const VANDAAG = dagInZone(NU);

const kaart = (o = {}) => ({
  id: 'k' + Math.random().toString(36).slice(2, 8), lijst: 'leads', lead_id: null, reden: 'lead_bellen', bron: 'import',
  status: 'open', due: VANDAAG, naam: 'Piet', telefoon: '+32471000001', bron_ref: {}, created_at: '2026-10-20T08:00:00Z', ...o,
});
const inLijst = (id, o = {}) => kaart({ ...o, bron_ref: { import_label: 'X', aparte_lijst_id: id, aparte_lijst_naam: 'X' } });

// ═══════════════════════════════════════════════════════════════════════════
// PUUR
// ═══════════════════════════════════════════════════════════════════════════

test('lijst van een kaart: alleen via bron_ref.aparte_lijst_id; de rest is algemene pot', () => {
  assert.equal(aparteLijstVan(inLijst(L1)), L1);
  assert.equal(aparteLijstVan(kaart()), null);
  assert.equal(aparteLijstVan({ bron_ref: null }), null);
  const { algemeen, perLijst } = splitsKaarten([kaart(), inLijst(L1), inLijst(L1), inLijst(L2)]);
  assert.equal(algemeen.length, 1);
  assert.equal(perLijst.get(L1).length, 2);
  assert.equal(perLijst.get(L2).length, 1);
});

test('telling: open (open/wacht) en afgewerkt (ingepland/afgerond), over de hele historiek', () => {
  const t = lijstTelling([
    inLijst(L1), inLijst(L1, { status: 'wacht_inplanning' }), inLijst(L1, { status: 'ingepland' }),
    inLijst(L1, { status: 'gearchiveerd', gearchiveerd_at: '2025-01-01T00:00:00Z' }),
  ]);
  assert.deepEqual(t, { totaal: 4, open: 2, afgewerkt: 2, ingepland: 1, afgerond: 1 });
});

test('naam: getrimd, max 60, uniek onder de actieve lijsten (hoofdletterongevoelig)', () => {
  assert.equal(lijstNaam('  Webinar   sept '), 'Webinar sept');
  assert.equal(lijstNaam(''), null);
  assert.equal(lijstNaam('x'.repeat(61)), null);
  const lijsten = [{ naam: 'Webinar', status: 'actief' }, { naam: 'Oud', status: 'gearchiveerd' }];
  assert.equal(naamBezet(lijsten, 'webinar'), true);
  assert.equal(naamBezet(lijsten, 'oud'), false, 'een gearchiveerde naam mag opnieuw');
  assert.equal(isLijstId(L1), true);
  assert.equal(isLijstId("x');drop"), false);
  assert.equal(tabelOntbreekt({ code: 'PGRST205' }), true);
  assert.equal(tabelOntbreekt({ code: '42P01' }), true);
  assert.equal(tabelOntbreekt({ code: '23505' }), false);
});

test('een nieuwe lead met het nummer van een lopende kaart in een ACTIEVE lijst komt niet in Nieuw', () => {
  const { perLijst } = splitsKaarten([inLijst(L1, { telefoon: '+32471123456' }), inLijst(L2, { telefoon: '+32472000000' })]);
  const st = aparteStaarten(perLijst, [L1]);
  assert.ok(st.has('471123456'));
  assert.ok(!st.has('472000000'), 'gearchiveerde lijst houdt niemand tegen');
  const lead = {
    id: 'l1', voornaam: 'Sara', telefoon: '0471 12 34 56', traject: '7-daagse', bron: '7-daagse-v2',
    aangemaakt: new Date(NU - 86400000).toISOString(), customer_id: null,
  };
  const zonder = stelPottenSamen({ leads: [lead], nuMs: NU });
  assert.equal(zonder.potten.nieuw.length, 1);
  const met = stelPottenSamen({ leads: [lead], nuMs: NU, aparteStaarten: st });
  assert.equal(met.potten.nieuw.length, 0);
  assert.deepEqual(met.niet_getoond, [{ code: 'in_aparte_lijst', aantal: 1, tekst: UITSLUITREDENEN.in_aparte_lijst }]);
});

test('potVoorKaart zonderVenster: een lijst toont ook oude ingeplande/afgeronde kaarten; standaard ongewijzigd', () => {
  const oud = kaart({ status: 'gearchiveerd', gearchiveerd_at: '2025-01-01T00:00:00Z' });
  assert.equal(potVoorKaart(oud, VANDAAG, NU), null);
  assert.equal(potVoorKaart(oud, VANDAAG, NU, { zonderVenster: true }), 'afgerond');
  const ip = kaart({ status: 'ingepland', afspraak_gevonden_at: '2025-01-01T00:00:00Z' });
  assert.equal(potVoorKaart(ip, VANDAAG, NU), null);
  assert.equal(potVoorKaart(ip, VANDAAG, NU, { zonderVenster: true }), 'ingepland');
});

test('weergave van een lijst: nu aan de beurt bovenaan, de rest per pot zonder dubbels', () => {
  const kaarten = [
    inLijst(L1, { id: 'a' }),
    inLijst(L1, { id: 'b', reden_code: 'terugbellen', due: '2026-11-03' }),
    inLijst(L1, { id: 'c', status: 'gearchiveerd', gearchiveerd_at: '2025-01-01T00:00:00Z' }),
  ];
  const uit = stelPottenSamen({ kaarten, nuMs: NU, zonderVenster: true });
  const w = lijstWeergave({ lijst: { id: L1, naam: 'Webinar', status: 'actief' }, uit, kaarten });
  assert.deepEqual(w.items.map((r) => r.kaart.taak_id), ['a']);
  assert.equal(w.items[0].sectie, 'opnieuw');
  assert.deepEqual(w.secties.bezig, [], 'a staat al in Nu aan de beurt');
  assert.deepEqual(w.secties.terugbellen.map((r) => r.kaart.taak_id), ['b']);
  assert.deepEqual(w.secties.afgerond.map((r) => r.kaart.taak_id), ['c']);
  assert.equal(w.lijst.nu, 1);
  assert.deepEqual(w.lijst.telling, { totaal: 3, open: 2, afgewerkt: 1, ingepland: 0, afgerond: 1 });
});

test('import: aparte lijst = geen dosering (alles vandaag) + koppeling in bron_ref; algemene pot ongewijzigd', () => {
  const csv = 'naam,telefoon\n' + Array.from({ length: 15 }, (_, i) => 'L' + i + ',04710000' + String(i).padStart(2, '0')).join('\n');
  const apart = maakVoorvertoning({ rijen: leesCsv(csv).rijen, vandaag: '2026-10-02', perDag: 2, alVandaag: 5, dosering: false });
  assert.ok(apart.rijen.every((r) => r.due === '2026-10-02'));
  assert.equal(apart.dosering, false);
  assert.equal(apart.per_dag, null);
  assert.equal(apart.samenvatting, 'alle 15 meteen zichtbaar in de lijst');
  const pot = maakVoorvertoning({ rijen: leesCsv(csv).rijen, vandaag: '2026-10-02', perDag: 10 });
  assert.equal(pot.per_dag, 10);
  assert.equal(pot.rijen[14].due, '2026-10-05');

  const rij = apart.rijen[0];
  const k = importKaart({ rij, label: 'Webinar', nuIso: '2026-10-02T09:00:00Z', aparteLijst: { id: L1, naam: 'Webinar' } });
  assert.equal(k.bron_ref.aparte_lijst_id, L1);
  assert.equal(k.badge_label, 'Webinar');
  assert.equal(k.lijst, 'leads');
  assert.match(k.notitie, /aparte lijst: Webinar/);
  const gewoon = importKaart({ rij, label: 'Oud', nuIso: '2026-10-02T09:00:00Z' });
  assert.deepEqual(gewoon.bron_ref, { import_label: 'Oud', import_op: '2026-10-02T09:00:00Z', product: null });
});

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINTS (nep-databank)
// ═══════════════════════════════════════════════════════════════════════════

/** Mini-postgrest: select/eq/is/insert/update/delete, json-pad 'kolom->>sleutel', ontbrekende tabel. */
function nepDb(tabellen, { ontbreekt = [] } = {}) {
  const veld = (r, c) => {
    const m = /^(\w+)->>(\w+)$/.exec(c);
    if (m) { const o = r[m[1]]; const v = o && typeof o === 'object' ? o[m[2]] : undefined; return v == null ? null : String(v); }
    return r[c];
  };
  const from = (tabel) => {
    const filters = [];
    let modus = 'select', payload = null, telKop = false;
    const rijen = () => (tabellen[tabel] || []).filter((r) => filters.every((f) => f(r)));
    const k = {
      select: (_c, opt) => { if (opt && opt.head) telKop = true; return k; },
      eq: (c, v) => { filters.push((r) => String(veld(r, c) ?? (c === 'lijst' ? 'dag' : '')) === String(v)); return k; },
      in: (c, v) => { filters.push((r) => v.includes(veld(r, c))); return k; },
      is: (c, v) => { filters.push((r) => (veld(r, c) ?? null) === v); return k; },
      not: (c, op, v) => { filters.push((r) => (veld(r, c) ?? null) !== v); return k; },
      gte: () => k, lte: () => k, or: () => k, order: () => k, limit: () => k,
      insert: (p) => { modus = 'insert'; payload = p; return k; },
      update: (p) => { modus = 'update'; payload = p; return k; },
      delete: () => { modus = 'delete'; return k; },
      maybeSingle: async () => uitvoeren(true),
      single: async () => uitvoeren(true),
      then: (ok, nok) => uitvoeren(false).then(ok, nok),
    };
    async function uitvoeren(een) {
      if (ontbreekt.includes(tabel)) return { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } };
      if (modus === 'insert') {
        const rij = { id: tabel === 'opvolging_leads_lijsten' ? L1 : 'nieuw-' + ((tabellen[tabel] || []).length + 1), created_at: new Date().toISOString(), ...payload };
        (tabellen[tabel] = tabellen[tabel] || []).push(rij);
        return { data: een ? rij : [rij], error: null };
      }
      if (modus === 'update') { const hit = rijen(); for (const r of hit) Object.assign(r, payload); return { data: een ? (hit[0] || null) : hit, error: null }; }
      if (modus === 'delete') { const hit = new Set(rijen()); tabellen[tabel] = (tabellen[tabel] || []).filter((r) => !hit.has(r)); return { data: null, error: null }; }
      const hit = rijen();
      if (telKop) return { data: null, count: hit.length, error: null };
      return { data: een ? (hit[0] || null) : hit, error: null };
    }
    return k;
  };
  return { from, _t: tabellen };
}

function nepRes() {
  const uit = { code: null, body: null };
  return { setHeader() {}, status(c) { uit.code = c; return this; }, json(b) { uit.body = b; return this; }, _uit: uit };
}

async function laad(pad, db) {
  return (await laadAlle([pad], db))[0];
}
async function laadAlle(paden, db) {
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: db, supabase: db,
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
      checkCronAuth: () => ({ ok: true }), ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: { requirePermission: async () => true, requirePermissionFailOpen: async () => true },
  });
  mock.module(url('api/_lib/opvolging-brug-ververs.js'), {
    namedExports: { brugLeadlijstVerversen: async () => ({ ok: false, reden: 'route_ontbreekt' }) },
  });
  const uit = [];
  for (const pad of paden) uit.push((await import(url(pad) + '?t=' + Math.random())).default);
  return uit;
}

const basisDb = (extra = {}, opties) => nepDb({
  leads: [], opvolging_taken: [], opvolging_pogingen: [], opvolging_wa_berichten: [], trial_warmte: [],
  follow_up_appointments: [], opvolging_leads_lijsten: [], ...extra,
}, opties);
const CSV = 'naam,telefoon\n' + Array.from({ length: 12 }, (_, i) => 'L' + i + ',04720000' + String(i).padStart(2, '0')).join('\n');

test('import aparte lijst zonder migratie: 503, er wordt niets geschreven; algemene pot werkt gewoon', async (t) => {
  t.after(() => mock.reset());
  const db = basisDb({}, { ontbreekt: ['opvolging_leads_lijsten'] });
  const h = await laad('api/opvolging-leads-import.js', db);
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv: CSV, modus: 'aparte_lijst', lijst_naam: 'Webinar', bevestig: true } }, r);
  assert.equal(r._uit.code, 503);
  assert.equal(r._uit.body.code, 'APARTE_LIJSTEN_NIET_ACTIEF');
  assert.equal(db._t.opvolging_taken.length, 0);

  const r2 = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv: CSV, label: 'Oud', per_dag: 5, bevestig: true } }, r2);
  assert.equal(r2._uit.code, 200);
  assert.equal(r2._uit.body.gemaakt, 12);
  assert.ok(db._t.opvolging_taken.every((k) => !k.bron_ref.aparte_lijst_id));
  assert.ok(db._t.opvolging_taken.some((k) => k.due !== db._t.opvolging_taken[0].due), 'gedoseerd zoals altijd');
});

test('import aparte lijst: voorvertoning schrijft niets, bevestigen maakt lijst + kaarten (alles vandaag)', async (t) => {
  t.after(() => mock.reset());
  const db = basisDb();
  const h = await laad('api/opvolging-leads-import.js', db);
  const r0 = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv: CSV, modus: 'aparte_lijst', lijst_naam: '' } }, r0);
  assert.equal(r0._uit.code, 400);

  const r1 = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv: CSV, modus: 'aparte_lijst', lijst_naam: 'Webinar sept', per_dag: 2 } }, r1);
  assert.equal(r1._uit.code, 200);
  assert.equal(r1._uit.body.voorvertoning, true);
  assert.equal(r1._uit.body.dosering, false);
  assert.equal(db._t.opvolging_taken.length, 0);
  assert.equal(db._t.opvolging_leads_lijsten.length, 0);

  const r2 = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv: CSV, modus: 'aparte_lijst', lijst_naam: 'Webinar sept', per_dag: 2, bevestig: true } }, r2);
  assert.equal(r2._uit.code, 200);
  assert.equal(r2._uit.body.gemaakt, 12);
  assert.deepEqual(r2._uit.body.lijst, { id: L1, naam: 'Webinar sept', status: 'actief', aangemaakt_door: 'u1', created_at: r2._uit.body.lijst.created_at });
  const ks = db._t.opvolging_taken;
  assert.equal(new Set(ks.map((k) => k.due)).size, 1, 'geen dosering');
  assert.ok(ks.every((k) => k.bron_ref.aparte_lijst_id === L1 && k.lijst === 'leads' && k.bron === 'import'));

  // Zelfde naam nog eens: 409, niets erbij.
  const r3 = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv: 'naam,telefoon\nZ,0479999999', modus: 'aparte_lijst', lijst_naam: 'webinar SEPT', bevestig: true } }, r3);
  assert.equal(r3._uit.code, 409);
  assert.equal(db._t.opvolging_leads_lijsten.length, 1);

  // Een algemene import daarna: de lijstkaarten van vandaag eten de dagquota niet op.
  const r4 = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv: 'naam,telefoon\nZ,0479999999', label: 'Oud', per_dag: 1 } }, r4);
  assert.equal(r4._uit.body.rijen[0].due, ks[0].due);
});

test('overzicht: lijstkaarten staan niet in de algemene potten/badge, wel in hun eigen chip; archiveren haalt de chip weg', async (t) => {
  t.after(() => mock.reset());
  const vandaag = dagInZone(Date.now());
  const db = basisDb({
    opvolging_taken: [
      kaart({ id: 'alg', due: vandaag, telefoon: '+32471000009' }),
      inLijst(L1, { id: 'x1', due: vandaag, telefoon: '+32471000001' }),
      inLijst(L1, { id: 'x2', due: vandaag, telefoon: '+32471000002' }),
      inLijst(L1, { id: 'x3', status: 'ingepland', afspraak_gevonden_at: '2025-01-01T00:00:00Z' }),
    ],
    opvolging_leads_lijsten: [{ id: L1, naam: 'Webinar', status: 'actief', created_at: '2026-10-27T08:00:00Z' }],
  });
  const [h, ha] = await laadAlle(['api/opvolging-leads.js', 'api/opvolging-leads-lijst.js'], db);
  const h2 = h, ha2 = ha;
  const r = nepRes();
  await h({ method: 'GET', headers: {}, query: { pot: 'telling' } }, r);
  assert.equal(r._uit.code, 200);
  assert.equal(r._uit.body.aantallen.bezig, 1, 'alleen de algemene kaart');
  assert.equal(r._uit.body.aantallen.belrij, 1);
  assert.equal(r._uit.body.aantallen.ingepland, 0);
  assert.equal(r._uit.body.badge, 1);
  const chip = r._uit.body.aparte_lijsten.actief[0];
  assert.equal(chip.naam, 'Webinar');
  assert.deepEqual(chip.telling, { totaal: 3, open: 2, afgewerkt: 1, ingepland: 1, afgerond: 0 });
  assert.equal(chip.nu, 2);

  const rl = nepRes();
  await h({ method: 'GET', headers: {}, query: { pot: 'lijst', lijst: L1 } }, rl);
  assert.equal(rl._uit.code, 200);
  assert.deepEqual(rl._uit.body.items.map((x) => x.kaart.taak_id).sort(), ['x1', 'x2']);
  assert.deepEqual(rl._uit.body.secties.ingepland.map((x) => x.kaart.taak_id), ['x3']);

  const rb = nepRes();
  await h({ method: 'GET', headers: {}, query: { pot: 'lijst', lijst: 'geen-uuid' } }, rb);
  assert.equal(rb._uit.code, 400);

  // Archiveren: chip weg, kaarten ongewijzigd, nog steeds niet in de algemene pot.
  const ra = nepRes();
  await ha({ method: 'POST', headers: {}, body: { lijst_id: L1, actie: 'archiveer' } }, ra);
  assert.equal(ra._uit.code, 200);
  assert.equal(db._t.opvolging_leads_lijsten[0].status, 'gearchiveerd');
  assert.equal(db._t.opvolging_taken.length, 4);
  const r2 = nepRes();
  await h2({ method: 'GET', headers: {}, query: { pot: 'telling' } }, r2);
  assert.equal(r2._uit.body.aparte_lijsten.actief.length, 0);
  assert.equal(r2._uit.body.aparte_lijsten.archief[0].telling.totaal, 3);
  assert.equal(r2._uit.body.aantallen.bezig, 1);
  // Gearchiveerd blijft te bekijken.
  const r3 = nepRes();
  await h2({ method: 'GET', headers: {}, query: { pot: 'lijst', lijst: L1 } }, r3);
  assert.equal(r3._uit.body.lijst.status, 'gearchiveerd');
  // Terugzetten.
  const rt = nepRes();
  await ha2({ method: 'POST', headers: {}, body: { lijst_id: L1, actie: 'terugzetten' } }, rt);
  assert.equal(rt._uit.code, 200);
  assert.equal(db._t.opvolging_leads_lijsten[0].status, 'actief');
});

test('overzicht zonder migratie: alles werkt zoals voorheen, geen chips', async (t) => {
  t.after(() => mock.reset());
  const db = basisDb({ opvolging_taken: [kaart({ id: 'alg', due: dagInZone(Date.now()) })] }, { ontbreekt: ['opvolging_leads_lijsten'] });
  const h = await laad('api/opvolging-leads.js', db);
  const r = nepRes();
  await h({ method: 'GET', headers: {}, query: { pot: 'telling' } }, r);
  assert.equal(r._uit.code, 200);
  assert.equal(r._uit.body.aantallen.bezig, 1);
  assert.deepEqual(r._uit.body.aparte_lijsten, { beschikbaar: false, actief: [], archief: [] });
  assert.deepEqual(r._uit.body.meldingen, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET SCHERM
// ═══════════════════════════════════════════════════════════════════════════

const VIEW = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-leads-v2.js'), 'utf8');
function laadView() {
  const posts = [];
  const window = {
    DFO: { VIEWS: {}, render() {}, goTab() {} },
    KV: { authedJson: async (u, o) => { posts.push({ u, body: o && JSON.parse(o.body) }); return { gemaakt: 1, samenvatting: 'x', lijst: { id: L1 } }; } },
    __opvGedeeld: {
      render() {}, stijl() {}, straks: () => {}, opvToast() {},
      waLamp: () => '', modalHtml: () => '', waPaneelHtml: () => '', gesprekPaneelHtml: () => '', doorstuurPaneelHtml: () => '', openModal() {},
    },
  };
  window.window = window;
  const ctx = createContext({
    window, document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    console, queueMicrotask: () => {}, setTimeout, Date, Math, Number, String, JSON, Intl, Set, Map, Array, Object,
    encodeURIComponent, alert() {}, confirm: () => true,
  });
  runInContext(VIEW, ctx, { filename: 'opvolging-leads-v2.js' });
  return { window, posts };
}

test('scherm: eigen chip per actieve lijst (naam + open), en de lijst toont alleen zijn eigen leads', () => {
  const { window } = laadView();
  const st = window.__opvLeadsState;
  const aparte = { beschikbaar: true, actief: [{ id: L1, naam: '<Webinar>', status: 'actief', telling: { open: 7, afgewerkt: 2, totaal: 9 }, nu: 3 }], archief: [] };
  st.telling.data = { aantallen: { belrij: 0 }, belrij: { dringend: 0 }, aparte_lijsten: aparte };
  st.pot = 'belrij';
  st.potten.belrij = { data: { items: [], belrij: {} } };
  let html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.match(html, /class="lb-pot lb-lijst"[^>]*kiesPot\('lijst:aaaaaaaa-1111-4111-8111-111111111111'\)">&#128203; &lt;Webinar&gt;<span class="n">7<\/span>/);
  assert.doesNotMatch(html, /<Webinar>/);

  const r = { lead_id: null, naam: 'Piet', kaart: { taak_id: 't9', status: 'open', bel_totaal: 0, bel_dagen: 0, wa_totaal: 0, plan: { rondes: 0 } }, sectie: 'opnieuw', pot: 'bezig', waarom: 'Ronde 1 van 5' };
  st.pot = 'lijst:' + L1;
  st.potten[st.pot] = { data: { lijst: { ...aparte.actief[0], telling: { open: 7, afgewerkt: 2, totaal: 9, ingepland: 2, afgerond: 0 } }, items: [r], secties: {}, lijst_belrij: {} } };
  st.rijen.set('t:t9', r);
  html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.match(html, /lb-pot lb-lijst on/);
  assert.match(html, /aparte lijst/);
  assert.match(html, /Archiveer lijst/);
  assert.match(html, /window\.__opvLb\.bel\('t:t9'\)/);
  assert.match(html, /window\.__opvLb\.watNu\('t:t9'\)/);
  assert.match(html, /Start belronde/);
});

test('scherm: Lijst opladen kiest tussen algemene pot (met dosering) en nieuwe aparte lijst (zonder)', async () => {
  const { window, posts } = laadView();
  const st = window.__opvLeadsState;
  st.telling.data = { aantallen: {} };
  window.__opvLb.import();
  let html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.match(html, /Toevoegen aan algemene pot \(zoals nu\)/);
  assert.match(html, /Nieuwe aparte lijst/);
  assert.match(html, /Maximaal per werkdag/);
  window.__opvLb.impModus('aparte_lijst');
  html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.doesNotMatch(html, /Maximaal per werkdag/);
  assert.match(html, /Naam van de lijst \(verplicht\)/);

  window.__opvLb.impVeld('csv', 'naam,telefoon\nA,0471111111');
  await window.__opvLb.impVoor();
  assert.match(st.modal.fout, /naam/);
  window.__opvLb.impVeld('lijstNaam', 'Webinar');
  await window.__opvLb.impVoor();
  assert.deepEqual(posts.at(-1).body, { csv: 'naam,telefoon\nA,0471111111', modus: 'aparte_lijst', lijst_naam: 'Webinar', bevestig: false });
  await window.__opvLb.impBevestig();
  assert.equal(posts.at(-1).body.bevestig, true);
  assert.equal(st.pot, 'lijst:' + L1, 'na bevestigen meteen in de nieuwe lijst');

  window.__opvLb.import();
  window.__opvLb.impVeld('label', 'Oud');
  window.__opvLb.impVeld('csv', 'naam,telefoon\nA,0471111111');
  await window.__opvLb.impVoor();
  assert.deepEqual(posts.at(-1).body, { csv: 'naam,telefoon\nA,0471111111', label: 'Oud', per_dag: 10, bevestig: false });
});

// ═══════════════════════════════════════════════════════════════════════════
// VERHUIZEN UIT DE ALGEMENE POT (bug 27 okt: 41/41 'dubbel', vast)
// ═══════════════════════════════════════════════════════════════════════════

test('aparte voorvertoning: open kaart in de pot = verhuis; de rest nieuw of overgeslagen met reden', () => {
  const csv = 'naam,telefoon\n' + [
    'Pot,0471000001', 'LeadKaart,0471000002', 'AndereLijst,0471000003', 'Wacht,0471000004', 'OudeLijst,0471000005',
    'Ingepland,0471000006', 'Afgerond,0471000007', 'Dag,0471000008', 'UitNieuw,0471000009', 'Vers,0471000010',
    'Fout,123', 'Pot2,0471000001',
  ].join('\n');
  const kaarten = [
    kaart({ id: 'pot', telefoon: '+32471000001', badge_label: 'Webiar 26/10', bron_ref: { import_label: 'Webiar 26/10' } }),
    // Leadkaart zonder nummer: gevonden via de lead uit de berekende pot.
    kaart({ id: 'lk', telefoon: null, lead_id: 'lead2', bron: 'lead' }),
    inLijst(L2, { id: 'al', telefoon: '+32471000003' }),
    kaart({ id: 'w', telefoon: '+32471000004', status: 'wacht_inplanning' }),
    inLijst('dddddddd-1111-4111-8111-111111111111', { id: 'oud', telefoon: '+32471000005' }),
    kaart({ id: 'ip', telefoon: '+32471000006', status: 'ingepland' }),
    kaart({ id: 'af', telefoon: '+32471000007', status: 'gearchiveerd' }),
  ];
  const kandidaten = [
    { id: 'lead2', telefoon_e164: '+32471000002' },
    { id: 'lead9', telefoon_e164: '+32471000009' },
  ];
  const vv = maakAparteVoorvertoning({
    rijen: leesCsv(csv).rijen, kaarten, kandidaten, daglijstTelefoons: ['+32471000008'],
    actieveLijstIds: [L2], vandaag: '2026-10-27',
  });
  const per = Object.fromEntries(vv.rijen.map((r) => [r.naam, r]));
  assert.equal(per.Pot.status, 'verhuis');
  assert.deepEqual(per.Pot.verhuis_ids, ['pot']);
  assert.equal(per.Pot.kaart.badge_label, 'Webiar 26/10');
  assert.equal(per.LeadKaart.status, 'verhuis');
  assert.deepEqual(per.LeadKaart.verhuis_ids, ['lk']);
  assert.equal(per.AndereLijst.soort, 'andere_lijst');
  assert.equal(per.Wacht.soort, 'wacht');
  assert.equal(per.OudeLijst.soort, 'gearchiveerde_lijst');
  assert.equal(per.Ingepland.soort, 'ingepland');
  assert.equal(per.Afgerond.soort, 'afgerond');
  assert.equal(per.Dag.soort, 'daglijst');
  assert.equal(per.UitNieuw.status, 'geldig');
  assert.equal(per.UitNieuw.lead_id, 'lead9', 'lead uit Nieuw: de kaart krijgt zijn lead_id');
  assert.equal(per.Vers.status, 'geldig');
  assert.equal(per.Vers.lead_id, null);
  assert.equal(per.Vers.due, '2026-10-27');
  assert.equal(per.Fout.soort, 'ongeldig');
  assert.equal(per.Pot2.soort, 'dubbel_in_lijst');
  assert.deepEqual(vv.aantallen, { geldig: 2, verhuis: 2, overgeslagen: 8 });
  assert.equal(vv.overgeslagen_redenen.reduce((n, x) => n + x.aantal, 0), 8);
  for (const x of vv.overgeslagen_redenen) assert.equal(x.tekst, OVERSLAAN[x.soort]);
  assert.equal(vv.samenvatting, '2 nieuw + 2 verhuisd uit de pot, alles meteen zichtbaar in de lijst');
});

test('geen dosering in een lijst: een verhuisde gedoseerde kaart (due later) staat meteen klaar; terugbellen blijft op zijn dag', () => {
  const later = kaart({ due: '2026-10-30' });
  assert.equal(potVoorKaart(later, VANDAAG, NU), 'later', 'in de algemene pot blijft de dosering');
  assert.equal(potVoorKaart(later, VANDAAG, NU, { zonderDosering: true }), 'bezig');
  const terug = kaart({ due: '2026-10-30', reden_code: 'terugbellen' });
  assert.equal(potVoorKaart(terug, VANDAAG, NU, { zonderDosering: true }), 'terugbellen');
  const kaarten = [inLijst(L1, { id: 'g', due: '2026-10-30' })];
  const uit = stelPottenSamen({ kaarten, nuMs: NU, zonderVenster: true, zonderDosering: true });
  assert.deepEqual(uit.potten.belrij.map((r) => r.kaart.taak_id), ['g']);
  assert.equal(uit.potten.belrij[0].kaart.due, '2026-10-30', 'de due zelf blijft ongewijzigd');
});

test('verhuizen: bron_ref krijgt enkel de lijst erbij, bestaande sleutels blijven', () => {
  const ref = { import_label: 'Webiar 26/10', import_op: '2026-10-26T10:00:00Z', product: null, lead_id: 'x' };
  const nieuw = verhuisdeBronRef(ref, { id: L1, naam: 'Webinar 26/10' }, '2026-10-27T09:00:00Z');
  assert.deepEqual(nieuw, { ...ref, aparte_lijst_id: L1, aparte_lijst_naam: 'Webinar 26/10', aparte_lijst_verhuisd_op: '2026-10-27T09:00:00Z' });
  assert.deepEqual(ref.aparte_lijst_id, undefined, 'het origineel blijft onaangeroerd');
  assert.equal(verhuisdeBronRef(null, { id: L1, naam: 'X' }, 'nu').aparte_lijst_id, L1);
});

test('Nieuw: een lead wiens kaart in een aparte lijst staat (ook gearchiveerd) komt niet terug in de algemene pot', () => {
  const lead = {
    id: 'l1', voornaam: 'Sara', telefoon: '0471 12 34 56', traject: '7-daagse', bron: '7-daagse-v2',
    aangemaakt: new Date(NU - 86400000).toISOString(), customer_id: null,
  };
  const met = stelPottenSamen({ leads: [lead], nuMs: NU, aparteLeadIds: new Set(['l1']) });
  assert.equal(met.potten.nieuw.length, 0);
  assert.equal(met.niet_getoond[0].code, 'in_aparte_lijst');
});

test('import aparte lijst met kaarten die al in de pot staan: verhuizen i.p.v. weigeren, geen tweede kaart', async (t) => {
  t.after(() => mock.reset());
  const vandaag = dagInZone(Date.now());
  const pogingVoor = { id: 'p1', taak_id: 'w1', soort: 'call', tijdstip: '2026-10-26T10:00:00Z', resultaat: 'geen gehoor' };
  const db = basisDb({
    opvolging_taken: [
      kaart({ id: 'w1', telefoon: '+32471000001', badge_label: 'Webiar 26/10', due: vandaag, notitie: 'oud',
        reden_code: 'terugbellen', terugbel_notitie: 'na 18u', bron_ref: { import_label: 'Webiar 26/10', import_op: 'x', product: null } }),
      kaart({ id: 'w2', telefoon: '+32471000002', badge_label: 'Webiar 26/10', due: '2099-01-01', bron_ref: { import_label: 'Webiar 26/10' } }),
      kaart({ id: 'lk', telefoon: '+32471000003', lead_id: 'lead3', bron: 'lead', badge_label: '7-daagse', due: vandaag, bron_ref: { lead_id: 'lead3', product: '7-daagse' } }),
      kaart({ id: 'af', telefoon: '+32471000004', status: 'gearchiveerd', gearchiveerd_at: '2026-10-20T10:00:00Z' }),
    ],
    opvolging_pogingen: [pogingVoor],
  });
  const [h, ho] = await laadAlle(['api/opvolging-leads-import.js', 'api/opvolging-leads.js'], db);
  const csv = 'naam,telefoon\nA,0471000001\nB,0471000002\nC,0471000003\nD,0471000004\nE,0471000005';

  const r1 = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv, modus: 'aparte_lijst', lijst_naam: 'Webinar 26/10' } }, r1);
  assert.equal(r1._uit.code, 200);
  assert.deepEqual(r1._uit.body.aantallen, { geldig: 1, verhuis: 3, overgeslagen: 1 });
  assert.equal(db._t.opvolging_leads_lijsten.length, 0, 'voorvertoning schrijft niets');
  assert.ok(db._t.opvolging_taken.every((k) => !k.bron_ref.aparte_lijst_id));

  const voor = JSON.parse(JSON.stringify(db._t.opvolging_taken.find((k) => k.id === 'w1')));
  const r2 = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv, modus: 'aparte_lijst', lijst_naam: 'Webinar 26/10', bevestig: true } }, r2);
  assert.equal(r2._uit.code, 200);
  assert.equal(r2._uit.body.gemaakt, 1);
  assert.equal(r2._uit.body.verhuisd, 3);
  assert.equal(r2._uit.body.lijst.id, L1);
  assert.equal(db._t.opvolging_taken.length, 5, 'één nieuwe kaart, geen kopieën voor de verhuisde');

  const na = db._t.opvolging_taken.find((k) => k.id === 'w1');
  const { bron_ref: refNa, ...restNa } = na;
  const { bron_ref: refVoor, ...restVoor } = voor;
  assert.deepEqual(restNa, restVoor, 'niets anders aan de kaart veranderd (terugbelafspraak, notitie, due, label)');
  assert.deepEqual(refNa, { ...refVoor, aparte_lijst_id: L1, aparte_lijst_naam: 'Webinar 26/10', aparte_lijst_verhuisd_op: refNa.aparte_lijst_verhuisd_op });
  assert.equal(db._t.opvolging_taken.find((k) => k.id === 'lk').bron_ref.product, '7-daagse');
  assert.equal(db._t.opvolging_taken.find((k) => k.id === 'af').bron_ref.aparte_lijst_id, undefined, 'afgerond blijft waar hij was');
  assert.equal(db._t.opvolging_pogingen.length, 1, 'pogingen onaangeroerd');

  // Uit de algemene pot, in de chip.
  const rt = nepRes();
  await ho({ method: 'GET', headers: {}, query: { pot: 'telling' } }, rt);
  assert.equal(rt._uit.body.aantallen.belrij, 0);
  assert.equal(rt._uit.body.aantallen.terugbellen + rt._uit.body.aantallen.bezig, 0);
  assert.equal(rt._uit.body.aparte_lijsten.actief[0].telling.open, 4);
  const rl = nepRes();
  await ho({ method: 'GET', headers: {}, query: { pot: 'lijst', lijst: L1 } }, rl);
  const ids = [...rl._uit.body.items, ...Object.values(rl._uit.body.secties).flat()].map((x) => x.kaart.taak_id);
  assert.ok(['w1', 'w2', 'lk'].every((id) => ids.includes(id)));
  const w1 = [...rl._uit.body.items, ...Object.values(rl._uit.body.secties).flat()].find((x) => x.kaart.taak_id === 'w1');
  assert.equal(w1.kaart.reden_code, 'terugbellen', 'de terugbelafspraak reist mee');
  assert.equal(w1.kaart.bel_totaal, 1, 'de pogingen reizen mee');
  assert.ok(rl._uit.body.items.some((x) => x.kaart.taak_id === 'w2'), 'gedoseerde kaart staat meteen in Nu aan de beurt');
  assert.equal(db._t.opvolging_taken.find((k) => k.id === 'w2').due, '2099-01-01', 'zonder zijn due te wijzigen');
});

test('import aparte lijst: alles overgeslagen → geen lijst, geen chip', async (t) => {
  t.after(() => mock.reset());
  const db = basisDb({
    opvolging_taken: [inLijst(L2, { id: 'x', telefoon: '+32471000001' })],
    opvolging_leads_lijsten: [{ id: L2, naam: 'Andere', status: 'actief', created_at: '2026-10-27T08:00:00Z' }],
  });
  const h = await laad('api/opvolging-leads-import.js', db);
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { csv: 'naam,telefoon\nA,0471000001', modus: 'aparte_lijst', lijst_naam: 'Nieuw', bevestig: true } }, r);
  assert.equal(r._uit.code, 200);
  assert.equal(r._uit.body.lijst, null);
  assert.equal(r._uit.body.overgeslagen_redenen[0].soort, 'andere_lijst');
  assert.equal(db._t.opvolging_leads_lijsten.length, 1);
});

test('algemene pot: een dubbel blijft geweigerd zoals altijd, er verhuist niets', async (t) => {
  t.after(() => mock.reset());
  const db2 = basisDb({ opvolging_taken: [kaart({ id: 'p', telefoon: '+32471000001' })] });
  const h2 = await laad('api/opvolging-leads-import.js', db2);
  const r2 = nepRes();
  await h2({ method: 'POST', headers: {}, body: { csv: 'naam,telefoon\nA,0471000001', label: 'Oud', bevestig: true } }, r2);
  assert.equal(r2._uit.body.rijen[0].status, 'dubbel');
  assert.equal(r2._uit.body.gemaakt, 0);
  assert.equal(db2._t.opvolging_taken[0].bron_ref.aparte_lijst_id, undefined);
});

test('scherm: aparte voorvertoning toont nieuw / verhuisd / overgeslagen, bevestigen ook met enkel verhuisde', () => {
  const { window } = laadView();
  const st = window.__opvLeadsState;
  st.telling.data = { aantallen: {} };
  window.__opvLb.import();
  window.__opvLb.impModus('aparte_lijst');
  window.__opvLb.impVeld('lijstNaam', 'Webinar 26/10');
  st.modal.vv = {
    aantallen: { geldig: 0, verhuis: 41, overgeslagen: 2 }, samenvatting: '41 verhuisd uit de pot, alles meteen zichtbaar in de lijst',
    overgeslagen_redenen: [{ soort: 'ingepland', aantal: 2, tekst: 'al ingepland' }],
    rijen: [{ regel: 2, naam: 'An', telefoon: '+32471', status: 'verhuis', kaart: { badge_label: 'Webiar 26/10' } },
      { regel: 3, naam: 'Bo', telefoon: '+32472', status: 'overgeslagen', soort: 'ingepland', reden: 'al ingepland' }],
  };
  const html = window.DFO.VIEWS['opvolging/Leads bellen']();
  assert.match(html, /<b>0<\/b> nieuw/);
  assert.match(html, /<b>41<\/b> verhuisd uit de pot/);
  assert.match(html, /<b>2<\/b> overgeslagen/);
  assert.match(html, /2 al ingepland/);
  assert.match(html, /&#8618; verhuisd uit de pot <span class="zacht">\(Webiar 26\/10\)/);
  assert.match(html, /overgeslagen — al ingepland/);
  assert.match(html, /Bevestigen: lijst &ldquo;Webinar 26\/10&rdquo; met 41 verhuisd/);

  st.modal.vv = { ...st.modal.vv, aantallen: { geldig: 0, verhuis: 0, overgeslagen: 2 } };
  assert.doesNotMatch(window.DFO.VIEWS['opvolging/Leads bellen'](), /Bevestigen:/);
});

// ═══════════════════════════════════════════════════════════════════════════
// LIJSTTAG OP DE RIJ (verhuisde kaarten houden hun oude badge)
// ═══════════════════════════════════════════════════════════════════════════

test('kaartSamenvatting geeft de naam van de aparte lijst mee (enkel met een lijst-id)', () => {
  assert.equal(kaartSamenvatting(kaart({ bron_ref: { import_label: 'Webiar 26/10', aparte_lijst_id: L1, aparte_lijst_naam: 'Webinar 26/10' } }), null, NU).aparte_lijst_naam, 'Webinar 26/10');
  assert.equal(kaartSamenvatting(kaart(), null, NU).aparte_lijst_naam, null);
  assert.equal(kaartSamenvatting(kaart({ bron_ref: { aparte_lijst_naam: 'X' } }), null, NU).aparte_lijst_naam, null, 'zonder id geen tag');
  assert.equal(kaartSamenvatting(kaart({ bron_ref: null }), null, NU).aparte_lijst_naam, null);
});

test('scherm: lijsttag naast de oude badge, niet dubbel als de badge al de lijstnaam is', () => {
  const { window } = laadView();
  const st = window.__opvLeadsState;
  const rijMet = (id, naam, badge, lijst) => ({
    lead_id: 'l' + id, naam, product_label: badge, score: 0, label: null, chips: [], opener: '', sectie: 'opnieuw', pot: 'bezig',
    kaart: { taak_id: id, status: 'open', badge_label: badge, aparte_lijst_naam: lijst, bel_totaal: 0, bel_dagen: 0, wa_totaal: 0, plan: { rondes: 0 } },
  });
  const items = [
    rijMet('t1', 'Mats Van de Wynkele', 'Minicursus', 'Webinar 26/10'),
    rijMet('t2', 'Klaas Verboom', 'Webinar 26/10', 'Webinar 26/10'),
    rijMet('t3', 'Tanja Jong', '7-daagse', null),
    rijMet('t4', 'Mike Denys', '7-daagse', '<b>x</b>'),
  ];
  st.telling.data = { aantallen: {}, belrij: {} };
  st.pot = 'lijst:' + L1;
  st.potten[st.pot] = { data: { lijst: { id: L1, naam: 'Webinar 26/10', status: 'actief', telling: {} }, items, secties: {}, lijst_belrij: {} } };
  const html = window.DFO.VIEWS['opvolging/Leads bellen']();
  const rijHtml = (naam) => html.slice(html.indexOf(naam), html.indexOf('</div>', html.indexOf(naam)));
  assert.match(rijHtml('Mats Van de Wynkele'), /tag t-grey">Minicursus<\/span> <span class="tag lb-lijsttag"[^>]*>&#128203; Webinar 26\/10<\/span>/);
  assert.doesNotMatch(rijHtml('Klaas Verboom'), /lb-lijsttag/, 'badge is al de lijstnaam');
  assert.doesNotMatch(rijHtml('Tanja Jong'), /lb-lijsttag/, 'niet in een lijst');
  assert.match(rijHtml('Mike Denys'), /&#128203; &lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>x<\/b>/);
});

test('echt API-pad: GET ?pot=lijst → scherm. Badge = lijstnaam (Mieke) geeft GEEN dubbele tag; verhuisde leadkaart wel', async (t) => {
  t.after(() => mock.reset());
  const LIJST = 'c2b64d93-d543-4fd0-b939-3af731642423';
  const vandaag = dagInZone(Date.now());
  // Mieke: de rij zoals ze op 29 okt in productie staat (badge + import_label gecorrigeerd).
  const mieke = {
    id: '81617df1-8e21-46f7-886e-a43674f2eef5', naam: 'Mieke', email: 'info@voorbeeld.be', telefoon: '+32485558080',
    reden: 'lead_bellen', reden_code: null, bron: 'import', lijst: 'leads', lead_id: null, status: 'open', due: vandaag,
    badge_label: 'Webinar 26/10', notitie: '2026-10-27 · Opgeladen in Leads bellen (Webiar 26/10).',
    bron_ref: { product: null, import_op: '2026-10-27T12:42:55.759Z', import_label: 'Webinar 26/10',
      aparte_lijst_id: LIJST, aparte_lijst_naam: 'Webinar 26/10', aparte_lijst_verhuisd_op: '2026-10-27T16:45:39.320Z' },
    created_at: '2026-10-27T12:42:56.467759+00:00', uitkomst_log: [],
  };
  // Zelfde naam met een harde spatie en andere hoofdletters: telt ook als dezelfde.
  const nbsp = { ...mieke, id: 'k-nbsp', naam: 'Nina', telefoon: '+32485558081', badge_label: ' webinar 26/10 ' };
  // Verhuisde leadkaart zonder lead in de pot: badge 'Minicursus' → tag erbij.
  const mats = { ...mieke, id: 'k-mats', naam: 'Mats Van de Wynkele', telefoon: '+32485558082', bron: 'lead', badge_label: 'Minicursus',
    bron_ref: { lead_id: null, product: 'Minicursus', aparte_lijst_id: LIJST, aparte_lijst_naam: 'Webinar 26/10' } };
  const db = basisDb({
    opvolging_taken: [mieke, nbsp, mats],
    opvolging_leads_lijsten: [{ id: LIJST, naam: 'Webinar 26/10', status: 'actief', created_at: '2026-10-27T12:42:00Z' }],
  });
  const h = await laad('api/opvolging-leads.js', db);
  const r = nepRes();
  await h({ method: 'GET', headers: {}, query: { pot: 'lijst', lijst: LIJST } }, r);
  assert.equal(r._uit.code, 200);
  const rijen = [...r._uit.body.items, ...Object.values(r._uit.body.secties).flat()];
  const m = rijen.find((x) => x.naam === 'Mieke');
  // Wat de grijze badge toont, en waarmee vergeleken wordt.
  assert.equal(m.product_label, 'Webinar 26/10');
  assert.equal(m.kaart.aparte_lijst_naam, 'Webinar 26/10');

  // De JSON zoals de browser hem krijgt, door het echte scherm.
  const { window } = laadView();
  const st = window.__opvLeadsState;
  const data = JSON.parse(JSON.stringify(r._uit.body));
  st.telling.data = data;
  st.pot = 'lijst:' + LIJST;
  st.potten[st.pot] = { data };
  const html = window.DFO.VIEWS['opvolging/Leads bellen']();
  const rij = (naam) => { const i = html.indexOf('<div class="nm">' + naam); return html.slice(i, html.indexOf('</div>', i)); };
  assert.match(rij('Mieke'), /tag t-grey">Webinar 26\/10<\/span>/);
  assert.doesNotMatch(rij('Mieke'), /lb-lijsttag/, 'geen dubbele tag als de badge al de lijstnaam is');
  assert.doesNotMatch(rij('Nina'), /lb-lijsttag/, 'ook niet met harde spatie / andere hoofdletters');
  assert.match(rij('Mats Van de Wynkele'), /tag t-grey">Minicursus<\/span> <span class="tag lb-lijsttag"[^>]*>&#128203; Webinar 26\/10/);
});
