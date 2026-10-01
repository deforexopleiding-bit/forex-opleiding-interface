// tests/setter-calls.test.js
//
// ROMY'S CALLS — wat er van haar geboekte calls geworden is.
//
// Bewaakt:
//   1. de categorie komt uit de centrale mapping, nooit uit een eigen tabel;
//   2. opvolgers van haar boekingen zonder eigen setter tellen mee (keten),
//      een opvolger met een ándere setter niet, testrijen nooit;
//   3. de startdatum: Amsterdam-dag, oude calls zonder uitkomst krijgen geen
//      'nog niet vastgelegd'-oordeel en tellen niet mee;
//   4. het sale-bedrag: koppeling op e-mail of laatste 9 cijfers, ook 'niet
//      gevonden', en gearchiveerde/afgewezen deals tellen niet;
//   5. het endpoint: een setter ziet nooit de calls van een andere setter, en
//      de notitie van de closer gaat niet over de lijn.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CATEGORIEEN, categorieInfo, categorieVoorAfspraak,
} from '../api/_lib/call-uitkomst-categorie.js';
import {
  CALL_RAPPORTAGE_START_KEY, STANDAARD_STARTDATUM, parseStartdatum, leesCallRapportageStart,
} from '../api/_lib/call-rapportage-start.js';
import {
  bouwCallsOverzicht, bouwCallRegel, rijenVanSetter, matchSaleDeal, nlDatumTijd, telefoon9, isKomend,
  TOELICHTING_NIET_VASTGELEGD, TOELICHTING_VOOR_START,
} from '../api/_lib/setter-calls.js';

const ROMY = 'e5006a5f-463a-46c8-ba04-467503ab8cc7';
const ANDER = '99999999-9999-4999-8999-999999999999';
const NU = Date.parse('2026-10-10T10:00:00Z');
const START = '2026-10-02';

let _n = 0;
const appt = (x = {}) => ({
  id: 'a' + (++_n),
  lead_name: 'Lead ' + _n,
  lead_email: null, lead_phone: null,
  scheduled_at: '2026-10-05T12:00:00Z', duration_minutes: 30,
  status: 'scheduled', uitkomst: null,
  parent_appointment_id: null, setter_user_id: ROMY, is_test: false,
  ...x,
});
const overzicht = (rijen, extra = {}) => bouwCallsOverzicht({
  rijen, setterId: ROMY, dealsMetKlant: [], nuMs: NU, startdatum: START, ...extra,
});
const alle = (o) => [...o.komend, ...o.gedaan, ...o.eerder];

// ═══════════════════════════════════════════════════════════════════════════
// 1. Categorie uit de mapping
// ═══════════════════════════════════════════════════════════════════════════

test('elke uitkomst krijgt precies de categorie (key, label, kleur) van de mapping', () => {
  const gevallen = [
    [{ uitkomst: 'sale', status: 'completed' }, 'sale'],
    [{ uitkomst: 'gesprek_gehad', status: 'completed' }, 'opvolgen'],
    [{ uitkomst: 'terugbel', status: 'completed' }, 'opvolgen'],
    [{ uitkomst: 'wilt_niet_meer', status: 'completed' }, 'geen_interesse'],
    [{ uitkomst: 'niet_geschikt', status: 'completed' }, 'niet_gekwalificeerd'],
    [{ uitkomst: 'no_show', status: 'no_show' }, 'no_show'],
    [{ uitkomst: 'geen_geld', status: 'completed' }, 'geen_geld'],
    [{ uitkomst: 'onbereikbaar', status: 'no_show' }, 'onbereikbaar'],
    [{ status: 'cancelled' }, 'geannuleerd'],
    [{ status: 'verplaatst' }, 'nieuw_moment'],
    [{ status: 'wacht_op_reschedule' }, 'wacht_op_nieuw_moment'],
    [{ status: 'scheduled' }, 'nog_niet_vastgelegd'],
    [{ status: 'raar_ding' }, 'onbekend'],
    [{ uitkomst: 'iets_nieuws', status: 'completed' }, 'onbekend'],
  ];
  for (const [x, verwacht] of gevallen) {
    const a = appt(x);
    const r = bouwCallRegel(a, { nuMs: NU, startdatum: START, dealsMetKlant: [] });
    assert.equal(categorieVoorAfspraak(a, { nuMs: NU }), verwacht, JSON.stringify(x));
    const info = categorieInfo(verwacht);
    assert.deepEqual(r.categorie, { key: info.key, label: info.label, kleur: info.kleur }, JSON.stringify(x));
  }
});

test('een verzette boeking (opvolger bestaat) is "Nieuw moment ingepland", de opvolger zelf draagt de afloop', () => {
  const ouder = appt({ status: 'scheduled', scheduled_at: '2026-10-03T12:00:00Z' });
  const kind = appt({ parent_appointment_id: ouder.id, setter_user_id: null, uitkomst: 'sale', status: 'completed', scheduled_at: '2026-10-06T12:00:00Z' });
  const o = overzicht([ouder, kind]);
  const perId = new Map(alle(o).map((r) => [r.id, r]));
  assert.equal(perId.get(ouder.id).categorie.key, 'nieuw_moment');
  assert.equal(perId.get(ouder.id).heeft_opvolger, true);
  assert.equal(perId.get(kind.id).categorie.key, 'sale');
});

test('afgelopen call zonder uitkomst na de startdatum: "Nog niet vastgelegd" + de closer-toelichting', () => {
  const a = appt({ scheduled_at: '2026-10-05T12:00:00Z' });
  const o = overzicht([a]);
  assert.equal(o.gedaan.length, 1);
  assert.equal(o.gedaan[0].categorie.key, 'nog_niet_vastgelegd');
  assert.equal(o.gedaan[0].toelichting, TOELICHTING_NIET_VASTGELEGD);
  assert.match(TOELICHTING_NIET_VASTGELEGD, /door de closer/);
});

test('komend = nog niet voorbij volgens dezelfde klok als de mapping (start + duur + 15 min)', () => {
  const bezig = appt({ scheduled_at: new Date(NU - 40 * 60000).toISOString(), duration_minutes: 30 });
  const net = appt({ scheduled_at: new Date(NU - 46 * 60000).toISOString(), duration_minutes: 30 });
  const later = appt({ scheduled_at: '2026-10-12T09:00:00Z' });
  const eerst = appt({ scheduled_at: '2026-10-11T09:00:00Z' });
  assert.equal(isKomend(bezig, NU), true);
  assert.equal(isKomend(net, NU), false);
  const o = overzicht([bezig, net, later, eerst]);
  assert.deepEqual(o.komend.map((r) => r.id), [bezig.id, eerst.id, later.id], 'eerstvolgende bovenaan');
  assert.ok(o.komend.every((r) => r.categorie.key === 'gepland'));
  assert.deepEqual(o.gedaan.map((r) => r.id), [net.id]);
});

test('een geannuleerde call in de toekomst staat bij komend, met de categorie Geannuleerd', () => {
  const a = appt({ status: 'cancelled', scheduled_at: '2026-10-20T09:00:00Z' });
  const o = overzicht([a]);
  assert.equal(o.komend.length, 1);
  assert.equal(o.komend[0].categorie.key, 'geannuleerd');
});

test('telling: alle categorieën in de volgorde van de mapping, totaal = som', () => {
  const o = overzicht([
    appt({ uitkomst: 'sale', status: 'completed' }),
    appt({ uitkomst: 'no_show', status: 'no_show' }),
    appt({ uitkomst: 'no_show', status: 'no_show' }),
    appt({ scheduled_at: '2026-10-20T09:00:00Z' }),
  ]);
  assert.deepEqual(o.telling.per_categorie.map((c) => c.key), CATEGORIEEN.map((c) => c.key));
  assert.deepEqual(o.telling.per_categorie.map((c) => c.label), CATEGORIEEN.map((c) => c.label));
  const n = Object.fromEntries(o.telling.per_categorie.map((c) => [c.key, c.aantal]));
  assert.equal(n.sale, 1);
  assert.equal(n.no_show, 2);
  assert.equal(n.gepland, 1);
  assert.equal(o.telling.totaal, 4);
});

test('de lib heeft geen eigen uitkomst-tabel of eigen labels', () => {
  const src = readFileSync(new URL('../api/_lib/setter-calls.js', import.meta.url), 'utf8')
    .split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  assert.doesNotMatch(src, /gesprek_gehad|wilt_niet_meer|'Opvolgen|'No show'|'Sale'/);
  assert.match(src, /from '\.\/call-uitkomst-categorie\.js'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Keten
// ═══════════════════════════════════════════════════════════════════════════

test('keten: opvolger zonder setter hoort bij haar, ook twee lagen diep', () => {
  const boek = appt({ status: 'verplaatst' });
  const k1 = appt({ parent_appointment_id: boek.id, setter_user_id: null, status: 'verplaatst' });
  const k2 = appt({ parent_appointment_id: k1.id, setter_user_id: null });
  const eigen = rijenVanSetter([boek, k1, k2], ROMY);
  assert.deepEqual(eigen.map((r) => r.id), [boek.id, k1.id, k2.id]);
  const o = overzicht([boek, k1, k2]);
  const k2r = alle(o).find((r) => r.id === k2.id);
  assert.equal(k2r.via_keten, true);
});

test('keten: een opvolger met een ándere setter is niet van haar (en zijn kind ook niet)', () => {
  const boek = appt({ status: 'verplaatst' });
  const ander = appt({ parent_appointment_id: boek.id, setter_user_id: ANDER });
  const kleinkind = appt({ parent_appointment_id: ander.id, setter_user_id: null });
  const ids = rijenVanSetter([boek, ander, kleinkind], ROMY).map((r) => r.id);
  assert.deepEqual(ids, [boek.id]);
});

test('keten: rijen van een andere setter, wezen en testrijen vallen eruit; een cyclus loopt niet vast', () => {
  const vreemd = appt({ setter_user_id: ANDER });
  const wees = appt({ setter_user_id: null, parent_appointment_id: 'bestaat-niet' });
  const testRij = appt({ is_test: true });
  const cyc1 = appt({ parent_appointment_id: 'a-cyc-2', setter_user_id: null, id: 'a-cyc-1' });
  const cyc2 = appt({ parent_appointment_id: 'a-cyc-1', setter_user_id: null, id: 'a-cyc-2' });
  const ids = rijenVanSetter([vreemd, wees, testRij, cyc1, cyc2], ROMY).map((r) => r.id);
  assert.deepEqual(ids, []);
});

test('keten: een test-opvolger van een echte boeking telt niet', () => {
  const boek = appt({ status: 'verplaatst' });
  const k = appt({ parent_appointment_id: boek.id, setter_user_id: null, is_test: true });
  assert.deepEqual(rijenVanSetter([boek, k], ROMY).map((r) => r.id), [boek.id]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Startdatum
// ═══════════════════════════════════════════════════════════════════════════

test('parseStartdatum: geldige datum, anders de standaard', () => {
  assert.equal(STANDAARD_STARTDATUM, '2026-10-02');
  assert.equal(CALL_RAPPORTAGE_START_KEY, 'call_rapportage_startdatum');
  assert.equal(parseStartdatum({ datum: '2026-11-01' }), '2026-11-01');
  for (const v of [null, undefined, 'x', {}, { datum: '1-10-2026' }, { datum: 20261001 }, { datum: '2026-10-1' }]) {
    assert.equal(parseStartdatum(v), STANDAARD_STARTDATUM, JSON.stringify(v));
  }
});

test('leesCallRapportageStart: rij, geen rij, fout en exception', async () => {
  const db = (antwoord) => ({
    from: (t) => {
      assert.equal(t, 'app_settings');
      const k = { select: () => k, eq: (c, v) => { assert.equal(c, 'key'); assert.equal(v, CALL_RAPPORTAGE_START_KEY); return k; }, maybeSingle: async () => antwoord() };
      return k;
    },
  });
  assert.equal(await leesCallRapportageStart(db(() => ({ data: { value: { datum: '2026-12-01' } }, error: null }))), '2026-12-01');
  assert.equal(await leesCallRapportageStart(db(() => ({ data: null, error: null }))), STANDAARD_STARTDATUM);
  assert.equal(await leesCallRapportageStart(db(() => ({ data: null, error: { message: 'x' } }))), STANDAARD_STARTDATUM);
  assert.equal(await leesCallRapportageStart(db(() => { throw new Error('weg'); })), STANDAARD_STARTDATUM);
});

test('het helperbestand is byte voor byte de gedeelde versie (eindigt op één newline)', () => {
  // CRLF → LF: een Windows-checkout met autocrlf mag de test niet laten vallen.
  const src = readFileSync(new URL('../api/_lib/call-rapportage-start.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(src.startsWith('// api/_lib/call-rapportage-start.js\n//\n// Vanaf welke Amsterdam-dag'));
  assert.ok(src.endsWith('}\n') && !src.endsWith('\n\n'));
});

test('startdatum is een Amsterdam-dag, geen UTC-dag', () => {
  // 1 okt 22:30 UTC = 2 okt 00:30 in Amsterdam (zomertijd) → telt mee.
  const net = appt({ scheduled_at: '2026-10-01T22:30:00Z' });
  // 1 okt 21:30 UTC = 1 okt 23:30 in Amsterdam → van vóór de start.
  const netNiet = appt({ scheduled_at: '2026-10-01T21:30:00Z' });
  assert.deepEqual(nlDatumTijd(net.scheduled_at), { datum: '2026-10-02', tijd: '00:30' });
  assert.deepEqual(nlDatumTijd(netNiet.scheduled_at), { datum: '2026-10-01', tijd: '23:30' });
  assert.equal(nlDatumTijd('geen datum'), null);
  const o = overzicht([net, netNiet]);
  assert.deepEqual(o.gedaan.map((r) => r.id), [net.id]);
  assert.deepEqual(o.eerder.map((r) => r.id), [netNiet.id]);
});

test('oude call zonder uitkomst: geen categorie-oordeel, neutrale toelichting, telt niet mee', () => {
  const oud = appt({ scheduled_at: '2026-09-20T12:00:00Z', status: 'scheduled' });
  const o = overzicht([oud]);
  assert.equal(o.eerder.length, 1);
  const r = o.eerder[0];
  assert.equal(r.categorie, null);
  assert.equal(r.toelichting, TOELICHTING_VOOR_START);
  assert.doesNotMatch(r.toelichting, /closer/);
  assert.equal(r.status, 'scheduled', 'de ruwe status blijft zichtbaar');
  assert.equal(r.meetellen, false);
  assert.equal(o.telling.totaal, 0);
});

test('oude call MET uitkomst houdt zijn categorie, maar telt niet mee', () => {
  const oud = appt({ scheduled_at: '2026-09-28T12:00:00Z', status: 'completed', uitkomst: 'gesprek_gehad' });
  const o = overzicht([oud]);
  assert.equal(o.eerder[0].categorie.key, 'opvolgen');
  assert.equal(o.telling.totaal, 0);
});

test('een andere startdatum verschuift de grens', () => {
  const a = appt({ scheduled_at: '2026-09-28T12:00:00Z' });
  const o = overzicht([a], { startdatum: '2026-09-01' });
  assert.equal(o.gedaan.length, 1);
  assert.equal(o.gedaan[0].categorie.key, 'nog_niet_vastgelegd');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Sale-bedrag
// ═══════════════════════════════════════════════════════════════════════════

const deal = (x = {}) => ({
  id: 'd' + (++_n), customer_id: 'c' + _n, total_amount: 7200, created_at: '2026-10-05T14:00:00Z',
  archived_at: null, tl_quotation_status: 'accepted', setter_user_id: ROMY, ...x,
});

test('telefoon9: laatste 9 cijfers, ongeacht landcode en opmaak', () => {
  assert.equal(telefoon9('+31 6 12345678'), '612345678');
  assert.equal(telefoon9('06-12345678'), '612345678');
  assert.equal(telefoon9('1234567'), null);
  assert.equal(telefoon9(null), null);
});

test('sale: gekoppeld op e-mail (hoofdletterongevoelig) → bedrag incl. btw + offertestatus', () => {
  const a = appt({ uitkomst: 'sale', status: 'completed', lead_email: 'Sal@Voorbeeld.nl ' });
  const d = deal({ total_amount: 7200.004 });
  const o = overzicht([a], { dealsMetKlant: [{ deal: d, klant: { email: 'sal@voorbeeld.NL', phone: null } }] });
  assert.deepEqual(o.gedaan[0].sale, {
    gekoppeld: true, deal_id: d.id, bedrag: 7200, offerte_status: 'accepted',
    offerte_status_label: 'geaccepteerd', in_afwachting: false,
  });
});

test('sale: gekoppeld op de laatste 9 cijfers van het telefoonnummer', () => {
  const a = appt({ uitkomst: 'sale', status: 'completed', lead_phone: '+31612345678' });
  const d = deal({ tl_quotation_status: 'sent', total_amount: 3950 });
  const r = matchSaleDeal(a, [{ deal: d, klant: { email: 'ander@x.nl', phone: '06 1234 5678' } }]);
  assert.equal(r.id, d.id);
  const o = overzicht([a], { dealsMetKlant: [{ deal: d, klant: { email: 'ander@x.nl', phone: '06 1234 5678' } }] });
  assert.equal(o.gedaan[0].sale.bedrag, 3950);
  assert.equal(o.gedaan[0].sale.in_afwachting, true);
});

test('sale zonder koppelbare deal: gekoppeld=false, geen verzonnen bedrag', () => {
  const a = appt({ uitkomst: 'sale', status: 'completed', lead_email: 'nieuw@x.nl', lead_phone: '0611111111' });
  const o = overzicht([a], { dealsMetKlant: [{ deal: deal(), klant: { email: 'iemand@x.nl', phone: '0622222222' } }] });
  assert.deepEqual(o.gedaan[0].sale, { gekoppeld: false });
  const zonderGegevens = appt({ uitkomst: 'sale', status: 'completed' });
  assert.equal(matchSaleDeal(zonderGegevens, [{ deal: deal(), klant: { email: '', phone: '' } }]), null);
});

test('sale: gearchiveerde en afgewezen deals tellen niet; bij meerdere wint de deal het dichtst bij de call', () => {
  const a = appt({ uitkomst: 'sale', status: 'completed', lead_email: 'x@x.nl', scheduled_at: '2026-10-05T12:00:00Z' });
  const klant = { email: 'x@x.nl', phone: null };
  const archief = deal({ archived_at: '2026-10-06T00:00:00Z', created_at: '2026-10-05T12:05:00Z' });
  const afgewezen = deal({ tl_quotation_status: 'declined', created_at: '2026-10-05T12:06:00Z' });
  const ver = deal({ created_at: '2026-08-01T00:00:00Z' });
  const dichtbij = deal({ created_at: '2026-10-05T15:00:00Z' });
  const r = matchSaleDeal(a, [archief, afgewezen, ver, dichtbij].map((d) => ({ deal: d, klant })));
  assert.equal(r.id, dichtbij.id);
  assert.equal(matchSaleDeal(a, [archief, afgewezen].map((d) => ({ deal: d, klant }))), null);
});

test('alleen een sale krijgt een sale-blok', () => {
  const a = appt({ uitkomst: 'gesprek_gehad', status: 'completed', lead_email: 'x@x.nl' });
  const o = overzicht([a], { dealsMetKlant: [{ deal: deal(), klant: { email: 'x@x.nl' } }] });
  assert.equal(o.gedaan[0].sale, null);
});

test('de regel bevat geen notitie, e-mail of telefoon van de lead', () => {
  const a = appt({ uitkomst: 'sale', status: 'completed', lead_email: 'x@x.nl', lead_phone: '0612345678', snelle_notitie: 'privé' });
  const r = bouwCallRegel(a, { nuMs: NU, startdatum: START, dealsMetKlant: [] });
  const tekst = JSON.stringify(r);
  assert.doesNotMatch(tekst, /privé|x@x\.nl|0612345678|snelle_notitie|lead_email|lead_phone/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Het endpoint — scoping
// ═══════════════════════════════════════════════════════════════════════════

const st = { user: ROMY, perms: new Set(['setter.ledger.view']), log: [], rijen: [], deals: [], klanten: [] };

function from(tabel) {
  const q = { tabel, select: null, filters: [] };
  const k = {
    select: (c) => { q.select = c; return k; },
    eq: (c, v) => { q.filters.push(['eq', c, v]); return k; },
    in: (c, v) => { q.filters.push(['in', c, v]); return k; },
    is: (c, v) => { q.filters.push(['is', c, v]); return k; },
    order: () => k, limit: () => k,
    insert: () => { throw new Error('insert verboden'); },
    update: () => { throw new Error('update verboden'); },
    upsert: () => { throw new Error('upsert verboden'); },
    delete: () => { throw new Error('delete verboden'); },
    maybeSingle: () => run(true),
    then: (res, rej) => run(false).then(res, rej),
  };
  async function run() {
    st.log.push(q);
    const f = (rijen) => rijen.filter((r) => q.filters.every(([op, c, v]) => (
      op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : op === 'is' ? r[c] === v : true)));
    if (tabel === 'app_settings') return { data: null, error: null };
    if (tabel === 'follow_up_appointments') return { data: f(st.rijen), error: null };
    if (tabel === 'deals') return { data: f(st.deals), error: null };
    if (tabel === 'customers') return { data: f(st.klanten), error: null };
    return { data: null, error: null };
  }
  return k;
}

mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from, rpc: () => { throw new Error('rpc verboden'); } },
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: st.user ? { id: st.user } : null } }) } }),
  },
});
mock.module('../api/_lib/requirePermission.js', {
  namedExports: { requirePermission: async (req, key) => st.perms.has(key) },
});

const { default: handler } = await import('../api/setter-calls.js');

async function get(query = {}) {
  const uit = { code: null, body: null };
  const res = { setHeader() {}, status(c) { uit.code = c; return this; }, json(b) { uit.body = b; return this; } };
  await handler({ method: 'GET', headers: {}, query }, res);
  return uit;
}

function vulDb() {
  st.log = [];
  st.rijen = [
    appt({ id: 'r-romy', lead_name: 'Romy Lead', setter_user_id: ROMY, uitkomst: 'sale', status: 'completed',
      scheduled_at: '2026-10-05T12:00:00Z', lead_email: 'sal@x.nl', snelle_notitie: 'GEHEIM' }),
    appt({ id: 'r-romy-kind', lead_name: 'Romy Kind', setter_user_id: null, parent_appointment_id: 'r-romy-ouder',
      scheduled_at: '2026-10-06T12:00:00Z' }),
    appt({ id: 'r-romy-ouder', lead_name: 'Romy Ouder', setter_user_id: ROMY, status: 'verplaatst',
      scheduled_at: '2026-10-04T12:00:00Z' }),
    appt({ id: 'r-ander', lead_name: 'Ander Lead', setter_user_id: ANDER, scheduled_at: '2026-10-05T12:00:00Z' }),
  ];
  st.deals = [{ ...deal({ id: 'd-romy', customer_id: 'c-romy' }) }];
  st.klanten = [{ id: 'c-romy', email: 'sal@x.nl', phone: null }];
}

test('endpoint: een setter ziet haar eigen calls, inclusief de opvolger via de keten', async () => {
  vulDb(); st.user = ROMY; st.perms = new Set(['setter.ledger.view']);
  const r = await get();
  assert.equal(r.code, 200);
  assert.equal(r.body.setter_user_id, ROMY);
  const ids = [...r.body.komend, ...r.body.gedaan, ...r.body.eerder].map((x) => x.id).sort();
  assert.deepEqual(ids, ['r-romy', 'r-romy-kind', 'r-romy-ouder']);
  const sale = [...r.body.komend, ...r.body.gedaan, ...r.body.eerder].find((x) => x.id === 'r-romy');
  assert.equal(sale.sale.bedrag, 7200);
  assert.equal(r.body.startdatum, STANDAARD_STARTDATUM);
  assert.doesNotMatch(JSON.stringify(r.body), /GEHEIM|sal@x\.nl|Ander Lead/);
  const eigen = st.log.find((q) => q.tabel === 'follow_up_appointments' && q.filters.some(([op, c]) => op === 'eq' && c === 'setter_user_id'));
  assert.deepEqual(eigen.filters.find(([, c]) => c === 'setter_user_id'), ['eq', 'setter_user_id', ROMY]);
  for (const q of st.log.filter((x) => x.tabel === 'follow_up_appointments')) {
    assert.doesNotMatch(q.select, /snelle_notitie/, 'de notitie wordt niet eens gelezen');
  }
});

test('endpoint: een setter kan de calls van een andere setter NIET opvragen (403, geen databank)', async () => {
  vulDb(); st.user = ROMY; st.perms = new Set(['setter.ledger.view']);
  const r = await get({ setter_user_id: ANDER });
  assert.equal(r.code, 403);
  assert.equal(st.log.length, 0, 'geen enkele query voor de weigering');
});

test('endpoint: een beheerder (setter.ledger.admin) mag een andere setter bekijken', async () => {
  vulDb(); st.user = '11111111-1111-4111-8111-111111111111';
  st.perms = new Set(['setter.ledger.view', 'setter.ledger.admin']);
  const r = await get({ setter_user_id: ROMY });
  assert.equal(r.code, 200);
  assert.equal(r.body.setter_user_id, ROMY);
  assert.ok([...r.body.komend, ...r.body.gedaan, ...r.body.eerder].every((x) => x.id.startsWith('r-romy')));
});

test('endpoint: zonder login 401, zonder setter.ledger.view 403, ongeldige uuid 400, alleen GET', async () => {
  vulDb(); st.user = null;
  assert.equal((await get()).code, 401);
  st.user = ROMY; st.perms = new Set();
  assert.equal((await get()).code, 403);
  st.perms = new Set(['setter.ledger.view', 'setter.ledger.admin']);
  assert.equal((await get({ setter_user_id: 'nope' })).code, 400);
  const uit = { code: null };
  await handler({ method: 'POST', headers: {}, query: {} }, { setHeader() {}, status(c) { uit.code = c; return this; }, json() { return this; } });
  assert.equal(uit.code, 405);
});

test('endpoint: geen sale tussen de calls → deals worden niet gelezen', async () => {
  vulDb(); st.user = ROMY; st.perms = new Set(['setter.ledger.view']);
  st.rijen = st.rijen.filter((r) => r.id !== 'r-romy');
  const r = await get();
  assert.equal(r.code, 200);
  assert.equal(st.log.some((q) => q.tabel === 'deals'), false);
});
