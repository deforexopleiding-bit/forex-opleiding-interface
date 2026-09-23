// tests/deelnemer-notitie-datalaag.test.js
//
// DE BROODJESNOTITIE MOET WERKEN MET ÉN ZONDER DE MIGRATIE.
//
// `event_attendees.notitie` is nieuw. Staat de kolom er nog niet, dan faalt
// elke select of update die hem noemt met 42703 — en dat neemt de HELE query
// mee. Bij de aanwezigenlijst is dat de complete lijst; bij een bewerking is
// dat ook de naamswijziging of belstatus die in dezelfde aanroep zat.
//
// Twee dingen zijn hier het belangrijkst, en het tweede is het gevaarlijkste:
//   1. er gaat niets stuk zolang de migratie niet gedraaid is;
//   2. er wordt NOOIT stil gedaan alsof een bestelling is opgeslagen terwijl
//      dat niet zo is — dan staat er op de dag zelf een broodje te weinig.
//
// 42703 zegt WEL dat een kolom ontbreekt en NIET welke. Daarom matcht de code
// op de kolomnaam; de oude versie viel bij élke 42703 terug op één vaste
// kortere lijst, en liet daarmee `switched_to_event_id` vallen om een reden
// die er niets mee te maken had.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── De nagebootste databank ────────────────────────────────────────────────
const nu = { rijen: [], ontbreekt: [], gezien: [] };

const bouw = (tabel) => {
  const staat = { tabel, kolommen: '', patch: null };
  const uit = async () => {
    nu.gezien.push({ ...staat });
    const mist = nu.ontbreekt.find((k) => new RegExp('\\b' + k + '\\b')
      .test(staat.kolommen + ' ' + JSON.stringify(staat.patch || {})));
    if (mist) return { data: null, error: { code: '42703', message: `column "${mist}" does not exist` }, count: null };
    const rijen = (nu.rijen || []).map((r) => {
      const kopie = { ...r, ...(staat.patch || {}) };
      for (const k of nu.ontbreekt) delete kopie[k];
      return kopie;
    });
    return { data: rijen, error: null, count: rijen.length };
  };
  const q = {
    select(k) { staat.kolommen = String(k || ''); return q; },
    update(p) { staat.patch = p; return q; },
    insert() { return q; },
    eq() { return q; }, in() { return q; }, or() { return q; }, not() { return q; },
    gte() { return q; }, lt() { return q; }, order() { return q; }, range() { return q; },
    limit() { return q; },
    async maybeSingle() { const r = await uit(); return { data: (r.data || [])[0] || null, error: r.error }; },
    async single()      { const r = await uit(); return { data: (r.data || [])[0] || null, error: r.error }; },
    then(res, rej) { return uit().then(res, rej); },
  };
  return q;
};

const db = {
  from: (t) => bouw(t),
  auth: { getUser: async () => ({ data: { user: { id: 'u-1' } } }) },
};

mock.module('../api/supabase.js', {
  namedExports: {
    supabase: db, supabaseAdmin: db,
    createUserClient: () => db,
    verifyAdmin: async () => ({ ok: true }),
    checkCronAuth: () => ({ ok: true }),
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: { requirePermission: async () => true, requirePermissionFailOpen: async () => true },
});
// De capaciteitscascade blijft buiten dit onderwerp: die hoort bij de
// belstatus en wordt hier niet aangeraakt.
mock.module('../api/_lib/event-attendee-mutations.js', {
  // ALLE exports meemocken, ook die dit onderwerp niet raken: mist er één,
  // dan faalt de import van het endpoint pas NA de tests en oogt het bestand
  // groen terwijl de helft niet gedraaid heeft.
  namedExports: {
    onAttendeePlekChange: async () => {},
    onConfirmedAttendeeMutation: async () => {},
    plekToestandGewijzigd: () => false,
    PLEK_SELECT: 'id',
  },
});

const { default: update } = await import('../api/events-attendee-update.js');
const { default: lijst }  = await import('../api/events-attendees-list.js');

const ID = '11111111-2222-3333-4444-555555555555';
const EVENT = '99999999-8888-7777-6666-555555555555';

async function roep(handler, req) {
  let uit = null;
  const res = {
    setHeader() { return res; },
    status(c) { res.__c = c; return res; },
    json(b) { uit = { code: res.__c, body: b }; return res; },
  };
  await handler(req, res);
  return uit;
}
const patch = (body, ontbreekt = []) => {
  nu.ontbreekt = ontbreekt; nu.gezien = [];
  nu.rijen = [{ id: ID, event_id: EVENT, first_name: 'Sofia', status: 'aangemeld', is_test: false }];
  return roep(update, { method: 'PATCH', query: { id: ID }, headers: {}, body });
};
const lees = (ontbreekt = []) => {
  nu.ontbreekt = ontbreekt; nu.gezien = [];
  nu.rijen = [{ id: ID, event_id: EVENT, first_name: 'Sofia', notitie: '2x kaas', is_test: false, status: 'aangemeld' }];
  return roep(lijst, { method: 'GET', query: { event_id: EVENT }, headers: {} });
};

// ═══════════════════════════════════════════════════════════════════════════
// MET DE MIGRATIE
// ═══════════════════════════════════════════════════════════════════════════

test('de notitie wordt opgeslagen', async () => {
  const r = await patch({ notitie: '2x kaas' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const schrijf = nu.gezien.find((g) => g.patch);
  assert.equal(schrijf.patch.notitie, '2x kaas');
});

test('wissen zet hem op NULL, niet op een lege string', async () => {
  // Een lege string leest in de lijst als 'er is iets ingevuld'.
  const r = await patch({ notitie: '   ' });
  assert.equal(r.code, 200);
  assert.equal(nu.gezien.find((g) => g.patch).patch.notitie, null);
});

test('en expliciet null wist hem ook', async () => {
  await patch({ notitie: null });
  assert.equal(nu.gezien.find((g) => g.patch).patch.notitie, null);
});

test('een heel lange tekst wordt afgekapt in plaats van geweigerd', async () => {
  // Weigeren zou betekenen dat de hele bewerking mislukt om een notitie.
  await patch({ notitie: 'x'.repeat(900) });
  assert.equal(nu.gezien.find((g) => g.patch).patch.notitie.length, 500);
});

test('notitie is iets ANDERS dan notes', async () => {
  // notes is de vrije aantekening in het detailpaneel. Door elkaar halen
  // betekent dat het bevestigingsvenster iemands aantekening overschrijft.
  const r = await patch({ notitie: '2x kaas', notes: 'Chesney belde om 13u41' });
  assert.equal(r.code, 200);
  const p = nu.gezien.find((g) => g.patch).patch;
  assert.equal(p.notitie, '2x kaas');
  assert.equal(p.notes, 'Chesney belde om 13u41');
});

test('de lijst geeft de notitie terug', async () => {
  const r = await lees();
  assert.equal(r.code, 200);
  assert.equal(r.body.items[0].notitie, '2x kaas');
  assert.deepEqual(r.body.ontbrekende_kolommen, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// ZONDER DE MIGRATIE — NIETS GAAT STUK, EN NIETS DOET ALSOF
// ═══════════════════════════════════════════════════════════════════════════

test('de aanwezigenlijst blijft gewoon werken', async () => {
  const r = await lees(['notitie']);
  assert.equal(r.code, 200, 'de hele lijst mag niet omvallen om één kolom');
  assert.equal(r.body.items.length, 1);
});

test('en hij MELDT dat de kolom ontbreekt', async () => {
  // Zonder deze melding toont de kolom NOTITIE een lege streep, en dat leest
  // als 'niemand heeft iets opgegeven'.
  const r = await lees(['notitie']);
  assert.ok(r.body.ontbrekende_kolommen.includes('notitie'));
});

test('een bewerking mét notitie slaat de REST wel op', async () => {
  const r = await patch({ first_name: 'Sofie', notitie: '2x kaas' }, ['notitie']);
  assert.equal(r.code, 200, 'de naamswijziging hoort gewoon te landen');
  const geslaagd = nu.gezien.filter((g) => g.patch).pop();
  assert.equal(geslaagd.patch.first_name, 'Sofie');
  assert.ok(!('notitie' in geslaagd.patch));
});

test('maar zegt erbij dat de notitie NIET is opgeslagen', async () => {
  const r = await patch({ first_name: 'Sofie', notitie: '2x kaas' }, ['notitie']);
  assert.equal(r.body.notitie_opgeslagen, false);
  assert.match(r.body.notitie_reden, /2026-09-23-event-attendees-notitie\.sql/);
});

test('alleen een notitie bewerken geeft GEEN stille 200', async () => {
  // Dit is het gevaarlijkste geval: een 200 zonder dat er iets is opgeslagen
  // betekent op de dag zelf een broodje te weinig.
  const r = await patch({ notitie: '2x kaas' }, ['notitie']);
  assert.equal(r.code, 422);
  assert.equal(r.body.code, 'NOTITIE_KOLOM_ONTBREEKT');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE TERUGVAL IS SMAL
// ═══════════════════════════════════════════════════════════════════════════

test('het ontbreken van EEN kolom zet de andere niet uit', async () => {
  // De oude lijst-code viel bij elke 42703 terug op één vaste kortere lijst en
  // liet `switched_to_event_id` vallen om een reden die er niets mee te maken
  // had. Nu valt precies de genoemde kolom af.
  const r = await lees(['notitie']);
  assert.deepEqual(r.body.ontbrekende_kolommen, ['notitie']);
});

test('ontbreken er meerdere, dan vallen die allemaal af en de rest blijft', async () => {
  const r = await lees(['notitie', 'bonus_excluded']);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.ontbrekende_kolommen.sort(), ['bonus_excluded', 'notitie']);
});

test('een 42703 op een kolom die we niet kennen wordt NIET weggepoetst', async () => {
  // Anders verbergt deze terugval elke toekomstige schema-fout.
  const r = await lees(['first_name']);
  assert.equal(r.code, 500);
});

test('een andere databankfout dan 42703 blijft gewoon een fout', async () => {
  nu.ontbreekt = []; nu.gezien = [];
  nu.rijen = [{ id: ID, event_id: EVENT, is_test: false }];
  const origineel = db.from;
  db.from = (t) => {
    const q = bouw(t);
    const echt = q.maybeSingle;
    q.maybeSingle = async () => ({ data: null, error: { code: '23505', message: 'duplicate key' } });
    q.then = (res2, rej) => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }).then(res2, rej);
    void echt;
    return q;
  };
  const r = await roep(update, { method: 'PATCH', query: { id: ID }, headers: {}, body: { notitie: '2x kaas' } });
  db.from = origineel;
  assert.notEqual(r.code, 200);
});
