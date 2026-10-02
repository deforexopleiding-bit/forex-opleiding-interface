// tests/opvolging-leads-endpoints.test.js
//
// De endpoints van 'Leads bellen', met een nep-databank in het geheugen. De
// handler draait echt; supabase, de rechten en de brug zijn gestubd.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const LEAD_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Een mini-postgrest in het geheugen: genoeg voor select/eq/in/insert/update.
 * `uniek` bootst de partiële unieke index op leadkaarten na.
 */
function nepDb(tabellen) {
  const log = [];
  const from = (tabel) => {
    const filters = [];
    let modus = 'select', payload = null, telKop = false;
    const pas = (r) => filters.every((f) => f(r));
    const rijen = () => (tabellen[tabel] || []).filter(pas);
    const k = {
      select: (_c, opt) => { if (opt && opt.head) telKop = true; return k; },
      eq: (c, v) => { filters.push((r) => {
        if (c.includes('.')) return true;     // embed-filter: niet nagebootst
        return String(r[c] ?? (c === 'lijst' ? 'dag' : '')) === String(v);
      }); return k; },
      neq: (c, v) => { filters.push((r) => r[c] !== v); return k; },
      in: (c, v) => { filters.push((r) => v.includes(r[c])); return k; },
      is: (c, v) => { filters.push((r) => (r[c] ?? null) === v); return k; },
      not: (c, op, v) => { filters.push((r) => (r[c] ?? null) !== v); return k; },
      gte: () => k, lte: () => k, lt: () => k, gt: () => k, or: () => k, filter: () => k,
      like: () => k, order: () => k, limit: () => k, range: () => k,
      insert: (p) => { modus = 'insert'; payload = p; return k; },
      update: (p) => { modus = 'update'; payload = p; return k; },
      maybeSingle: async () => uitvoeren(true),
      single: async () => uitvoeren(true),
      then: (ok, nok) => uitvoeren(false).then(ok, nok),
    };
    async function uitvoeren(een) {
      log.push({ tabel, modus, payload });
      if (modus === 'insert') {
        const rij = { id: 'nieuw-' + ((tabellen[tabel] || []).length + 1), created_at: new Date().toISOString(), ...payload };
        if (tabel === 'opvolging_taken' && rij.lijst === 'leads' && rij.lead_id &&
            (tabellen[tabel] || []).some((t) => t.lijst === 'leads' && t.lead_id === rij.lead_id && ['open', 'wacht_inplanning'].includes(t.status))) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "opvolging_taken_leadkaart_uniek"' } };
        }
        (tabellen[tabel] = tabellen[tabel] || []).push(rij);
        return { data: een ? rij : [rij], error: null };
      }
      if (modus === 'update') {
        const hit = rijen();
        for (const r of hit) Object.assign(r, payload);
        return { data: een ? (hit[0] || null) : hit, error: null };
      }
      const hit = rijen();
      if (telKop) return { data: null, count: hit.length, error: null };
      return { data: een ? (hit[0] || null) : hit, error: null };
    }
    return k;
  };
  return { from, _log: log, _t: tabellen };
}

function nepRes() {
  const uit = { code: null, body: null };
  return { setHeader() {}, status(c) { uit.code = c; return this; }, json(b) { uit.body = b; return this; }, _uit: uit };
}

async function laad(pad, db, { mag = true } = {}) {
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: db,
      supabase: db,
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
      checkCronAuth: () => ({ ok: true }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: { requirePermission: async () => mag, requirePermissionFailOpen: async () => mag },
  });
  mock.module(url('api/_lib/opvolging-brug-ververs.js'), {
    namedExports: { brugLeadlijstVerversen: async () => ({ ok: false, reden: 'route_ontbreekt' }) },
  });
  return (await import(url(pad) + '?t=' + Math.random())).default;
}

const leadRij = () => ({
  id: LEAD_ID, voornaam: 'Sara', achternaam: 'Janssens', email: 'sara@voorbeeld.be',
  telefoon: '0471 12 34 56', telefoon_e164: '+32471123456', traject: '7-daagse', bron: '7-daagse-v2',
  aangemaakt: new Date(Date.now() - 86400000).toISOString(), customer_id: null, verwijderd_op: null,
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KAART: IDEMPOTENT
// ═══════════════════════════════════════════════════════════════════════════

test('kaart: dubbelklik levert één rij op', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ leads: [leadRij()], opvolging_taken: [], trial_warmte: [], follow_up_appointments: [] });
  const h = await laad('api/opvolging-leads-kaart.js', db);
  const r1 = nepRes(), r2 = nepRes();
  await h({ method: 'POST', headers: {}, body: { lead_id: LEAD_ID } }, r1);
  await h({ method: 'POST', headers: {}, body: { lead_id: LEAD_ID } }, r2);
  assert.equal(r1._uit.code, 200);
  assert.equal(r1._uit.body.bestond, false);
  assert.equal(r2._uit.code, 200);
  assert.equal(r2._uit.body.bestond, true);
  assert.equal(r2._uit.body.taak_id, r1._uit.body.taak_id);
  const kaarten = db._t.opvolging_taken.filter((k) => k.lead_id === LEAD_ID);
  assert.equal(kaarten.length, 1);
  const k = kaarten[0];
  assert.equal(k.lijst, 'leads');
  assert.equal(k.reden, 'lead_bellen');
  assert.equal(k.bron, 'lead');
  assert.equal(k.status, 'open');
  assert.equal(k.naam, 'Sara Janssens');
  assert.equal(k.telefoon, '+32471123456');
  assert.equal(k.badge_label, '7-daagse');
  assert.deepEqual(k.bron_ref, { lead_id: LEAD_ID, product: '7-daagse', variant: 'v2', bron: '7-daagse-v2' });
  assert.match(k.notitie, /Uit Leads bellen/);
});

test('kaart: botsing op de unieke index (23505) geeft de bestaande kaart, geen 500', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ leads: [leadRij()], opvolging_taken: [], trial_warmte: [], follow_up_appointments: [] });
  // Eerste lezing ziet nog niets; daarna staat er (door 'de andere klik') al een kaart.
  const echteFrom = db.from;
  let lezingen = 0;
  db.from = (tabel) => {
    if (tabel === 'opvolging_taken') {
      lezingen += 1;
      if (lezingen === 2) {
        db._t.opvolging_taken.push({ id: 'ander', lijst: 'leads', lead_id: LEAD_ID, status: 'open', created_at: new Date().toISOString() });
      }
    }
    return echteFrom(tabel);
  };
  const h = await laad('api/opvolging-leads-kaart.js', db);
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { lead_id: LEAD_ID } }, r);
  assert.equal(r._uit.code, 200);
  assert.equal(r._uit.body.taak_id, 'ander');
  assert.equal(r._uit.body.bestond, true);
});

test('kaart: een afgeronde lead komt niet terug (409)', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ leads: [leadRij()], opvolging_taken: [
    { id: 'oud', lijst: 'leads', lead_id: LEAD_ID, status: 'gearchiveerd', created_at: '2026-09-01T00:00:00Z' },
  ] });
  const h = await laad('api/opvolging-leads-kaart.js', db);
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { lead_id: LEAD_ID } }, r);
  assert.equal(r._uit.code, 409);
  assert.equal(r._uit.body.code, 'AFGEROND');
  assert.equal(db._t.opvolging_taken.length, 1);
});

test('kaart: zonder recht 403, zonder geldige lead_id 400', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ leads: [], opvolging_taken: [] });
  const h = await laad('api/opvolging-leads-kaart.js', db, { mag: false });
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { lead_id: LEAD_ID } }, r);
  assert.equal(r._uit.code, 403);
  mock.reset();
  const h2 = await laad('api/opvolging-leads-kaart.js', db);
  const r2 = nepRes();
  await h2({ method: 'POST', headers: {}, body: { lead_id: 'x' } }, r2);
  assert.equal(r2._uit.code, 400);
});

// ═══════════════════════════════════════════════════════════════════════════
// TAAK-UPDATE OP EEN LEADKAART
// ═══════════════════════════════════════════════════════════════════════════

const leadkaart = () => ({ id: 'k1', lijst: 'leads', lead_id: LEAD_ID, status: 'open', due: '2026-10-02', reden: 'lead_bellen', uitgesteld_zonder_poging: 0 });
const morgenPlus = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

test('later terugbellen: zonder notitie 400, met notitie reden_code terugbellen', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ opvolging_taken: [leadkaart()], opvolging_pogingen: [] });
  const h = await laad('api/opvolging-taak-update.js', db);
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1', actie: 'verplaats', due: morgenPlus(3) } }, r);
  assert.equal(r._uit.code, 400);
  assert.equal(db._t.opvolging_taken[0].due, '2026-10-02', 'niets veranderd');

  const r2 = nepRes();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1', actie: 'verplaats', due: morgenPlus(3), terugbel_notitie: 'Belt terug na zijn vakantie' } }, r2);
  assert.equal(r2._uit.code, 200);
  const k = db._t.opvolging_taken[0];
  assert.equal(k.reden_code, 'terugbellen');
  assert.equal(k.terugbel_notitie, 'Belt terug na zijn vakantie');
  assert.equal(k.due, morgenPlus(3));
});

test('later terugbellen: vandaag kiezen mag niet (dat is "later vandaag")', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ opvolging_taken: [leadkaart()], opvolging_pogingen: [] });
  const h = await laad('api/opvolging-taak-update.js', db);
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1', actie: 'verplaats', due: morgenPlus(-1), terugbel_notitie: 'x' } }, r);
  assert.equal(r._uit.code, 400);
});

test('afronden van een leadkaart: categorie + notitie verplicht', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ opvolging_taken: [leadkaart()] });
  const h = await laad('api/opvolging-taak-update.js', db);
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1', actie: 'archiveer', archief_reden: 'Wil echt niet verder, zegt hij.' } }, r);
  assert.equal(r._uit.code, 400, 'zonder categorie');
  const r2 = nepRes();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1', actie: 'archiveer', archief_categorie: 'geen_interesse', archief_reden: 'kort' } }, r2);
  assert.equal(r2._uit.code, 400, 'te korte notitie');
  assert.equal(db._t.opvolging_taken[0].status, 'open');
  const r3 = nepRes();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1', actie: 'archiveer', archief_categorie: 'geen_interesse', archief_reden: 'Wil echt niet verder, zegt hij.' } }, r3);
  assert.equal(r3._uit.code, 200);
  assert.equal(db._t.opvolging_taken[0].status, 'gearchiveerd');
  assert.equal(db._t.opvolging_taken[0].archief_categorie, 'geen_interesse');
});

test('een daglijstkaart archiveren werkt zoals altijd (geen categorie nodig)', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ opvolging_taken: [{ id: 'd1', lijst: 'dag', status: 'open', due: '2026-10-02' }] });
  const h = await laad('api/opvolging-taak-update.js', db);
  const r = nepRes();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'd1', actie: 'archiveer', archief_reden: 'x' } }, r);
  assert.equal(r._uit.code, 200);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BRUG-NUMMERS
// ═══════════════════════════════════════════════════════════════════════════

test('brug-nummers: leadkaarten (open/wacht) zitten erin, de berekende pot niet', async (t) => {
  t.after(() => mock.reset());
  process.env.WHATSAPP_BRUG_SECRET = 'geheim';
  const db = nepDb({
    opvolging_taken: [
      { id: 'a', lijst: 'leads', status: 'open', telefoon: '+32470000001' },
      { id: 'b', lijst: 'leads', status: 'wacht_inplanning', telefoon: '+32470000002' },
      { id: 'c', lijst: 'leads', status: 'gearchiveerd', telefoon: '+32470000003' },
      { id: 'd', lijst: 'dag', status: 'open', telefoon: '+32470000004' },
    ],
    follow_up_appointments: [],
    // Een lead zonder kaart: zit in de pot, maar mag de brug niet kennen.
    leads: [{ id: 'x', telefoon_e164: '+32470000009', traject: 'minicursus' }],
  });
  const h = await laad('api/opvolging-whatsapp-nummers.js', db);
  const r = nepRes();
  await h({ method: 'GET', headers: { 'x-brug-secret': 'geheim' }, query: {} }, r);
  assert.equal(r._uit.code, 200);
  const n = new Set(r._uit.body.nummers);
  assert.ok(n.has('32470000001'));
  assert.ok(n.has('32470000002'));
  assert.ok(n.has('32470000004'));
  assert.ok(!n.has('32470000003'));
  assert.ok(!n.has('32470000009'), 'de pot zonder kaart hoort niet op de privacylijst');
  assert.ok(!db._log.some((l) => l.tabel === 'leads'), 'de brug-nummers lezen de leads-tabel niet');
});
