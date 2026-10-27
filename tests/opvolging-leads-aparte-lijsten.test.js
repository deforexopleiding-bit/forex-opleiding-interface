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
import { stelPottenSamen, potVoorKaart, dagInZone, UITSLUITREDENEN } from '../api/_lib/opvolging-leads-pot.js';
import { leesCsv, maakVoorvertoning, importKaart } from '../api/_lib/opvolging-leads-import.js';

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
