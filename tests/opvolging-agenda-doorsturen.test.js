// tests/opvolging-agenda-doorsturen.test.js
//
// 'Agenda doorsturen' verstuurt echt — fail-closed zonder link, nooit een
// bericht zonder link, en de kaart verandert pas na een geslaagde verzending.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  leesInstelling, valideerInstelling, bouwAgendaBericht, beslisDoorsturen,
  vertaalBrugFout, kiesGhlAfspraak, waMeLink, STANDAARD_BERICHT,
} from '../api/_lib/opvolging-agenda-doorsturen.js';
import { magGhlVragen } from '../api/opvolging-wacht-check-nu.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const NU = Date.parse('2026-10-02T12:00:00Z');
const LINK = 'https://agenda.voorbeeld.nl/dave';

// ═══════════════════════════════════════════════════════════════════════════
// PUUR
// ═══════════════════════════════════════════════════════════════════════════

test('instelling: alleen een https-link telt', () => {
  assert.equal(leesInstelling({ agenda_link: null }).agenda_link, null);
  assert.equal(leesInstelling({ agenda_link: 'http://x.nl' }).agenda_link, null);
  assert.equal(leesInstelling({ agenda_link: LINK }).agenda_link, LINK);
  assert.equal(leesInstelling({}).bericht, STANDAARD_BERICHT);
});

test('instelling bewaren: https en {link} in elke tekst', () => {
  assert.match(valideerInstelling({ agenda_link: 'http://x', bericht: '{link}', herinnering: '{link}' }), /https/);
  assert.match(valideerInstelling({ agenda_link: LINK, bericht: 'zonder', herinnering: '{link}' }), /\{link\}/);
  assert.match(valideerInstelling({ agenda_link: LINK, bericht: '{link}', herinnering: 'zonder' }), /herinnering/i);
  assert.equal(valideerInstelling({ agenda_link: LINK, bericht: 'a {link}', herinnering: 'b {link}' }), null);
});

test('bericht: {voornaam} en {link} ingevuld', () => {
  const t = bouwAgendaBericht({ sjabloon: 'Hey {voornaam}, kies hier: {link}', naam: 'Sara Janssens', link: LINK });
  assert.equal(t, 'Hey Sara, kies hier: ' + LINK);
});

test('een eigen tekst zonder link krijgt de link onderaan — nooit een bericht zonder link', () => {
  const t = bouwAgendaBericht({ sjabloon: 'x {link}', tekst: 'Hoi Sara, hier is hij', naam: 'Sara', link: LINK });
  assert.ok(t.endsWith(LINK));
  assert.ok(t.startsWith('Hoi Sara, hier is hij'));
});

test('zonder voornaam geen "Hey ,"', () => {
  assert.equal(bouwAgendaBericht({ sjabloon: 'Hey {voornaam}, {link}', naam: '', link: LINK }), 'Hey, ' + LINK);
});

test('beslissing: geen link → 409 GEEN_AGENDALINK, nog vóór iets anders', () => {
  const b = beslisDoorsturen({ taak: { status: 'open', telefoon: '+32470' }, soort: 'eerste', instelling: leesInstelling({}), nuMs: NU });
  assert.deepEqual([b.ok, b.status, b.code], [false, 409, 'GEEN_AGENDALINK']);
});

test('beslissing: eerste alleen op open; herinnering alleen op wacht, max 1 per 24u', () => {
  const inst = leesInstelling({ agenda_link: LINK });
  const t = (status) => ({ status, telefoon: '+32470111222' });
  assert.equal(beslisDoorsturen({ taak: t('open'), soort: 'eerste', instelling: inst, nuMs: NU }).ok, true);
  assert.equal(beslisDoorsturen({ taak: t('wacht_inplanning'), soort: 'eerste', instelling: inst, nuMs: NU }).code, 'STATUS');
  assert.equal(beslisDoorsturen({ taak: t('open'), soort: 'herinnering', instelling: inst, nuMs: NU }).code, 'NIET_WACHTEND');
  assert.equal(beslisDoorsturen({ taak: t('wacht_inplanning'), soort: 'herinnering', instelling: inst, nuMs: NU,
    laatsteHerinnering: new Date(NU - 23 * 3600000).toISOString() }).code, 'HERINNERING_TE_VROEG');
  assert.equal(beslisDoorsturen({ taak: t('wacht_inplanning'), soort: 'herinnering', instelling: inst, nuMs: NU,
    laatsteHerinnering: new Date(NU - 25 * 3600000).toISOString() }).ok, true);
  assert.equal(beslisDoorsturen({ taak: t('wacht_inplanning'), soort: 'herinnering', instelling: inst, nuMs: NU }).ok, true);
});

test('brugfout: NIET_TOEGESTAAN op een jonge kaart = de brug leert het nummer (202)', () => {
  const e = { code: 'BRUG_FOUT', status: 403 };
  assert.equal(vertaalBrugFout(e, { taakAangemaaktMs: NU - 60000, nuMs: NU }).body.code, 'BRUG_KENT_NUMMER_NOG_NIET');
  assert.equal(vertaalBrugFout(e, { taakAangemaaktMs: NU - 60000, nuMs: NU }).status, 202);
  assert.equal(vertaalBrugFout(e, { taakAangemaaktMs: NU - 7 * 60000, nuMs: NU }).body.code, 'NIET_TOEGESTAAN');
  assert.equal(vertaalBrugFout({ code: 'BRUG_FOUT', status: 503 }, { nuMs: NU }).body.code, 'NIET_VERBONDEN');
  assert.equal(vertaalBrugFout({ code: 'BRUG_FOUT', status: 400, data: { code: 'LANDCODE_ONBEKEND' }, message: 'x' }, { nuMs: NU }).body.code, 'LANDCODE_ONBEKEND');
});

test('wa.me-terugval draagt de tekst mee', () => {
  assert.equal(waMeLink('+32 470 11', 'a b'), 'https://wa.me/3247011?text=a%20b');
});

test('GHL: alleen een afspraak aangemaakt ná het doorsturen telt', () => {
  const gestuurd = new Date(NU - 3600000).toISOString();
  assert.equal(kiesGhlAfspraak([{ id: 'oud', dateAdded: new Date(NU - 2 * 3600000).toISOString(), startTime: '2026-10-08T12:00:00Z' }], gestuurd), null);
  assert.equal(kiesGhlAfspraak([{ id: 'x', appointmentStatus: 'cancelled', dateAdded: new Date(NU).toISOString() }], gestuurd), null);
  assert.equal(kiesGhlAfspraak([{ id: 'zonder-datum', startTime: '2026-10-08T12:00:00Z' }], gestuurd), null);
  assert.deepEqual(kiesGhlAfspraak([{ id: 'ok', appointmentStatus: 'confirmed', dateAdded: new Date(NU).toISOString(), startTime: '2026-10-08T12:00:00Z' }], gestuurd),
    { ghl_appointment_id: 'ok', scheduled_at: '2026-10-08T12:00:00.000Z' });
});

test('GHL rate-limit: één vraag per taak per 10 s', () => {
  const k = new Map();
  assert.equal(magGhlVragen('t', NU, k), true);
  assert.equal(magGhlVragen('t', NU + 5000, k), false);
  assert.equal(magGhlVragen('u', NU + 5000, k), true);
  assert.equal(magGhlVragen('t', NU + 10001, k), true);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

function nepDb(tabellen) {
  const writes = [];
  const from = (tabel) => {
    const f = []; let modus = 'select', payload = null;
    const k = {
      select: () => k,
      eq: (c, v) => { f.push((r) => String(r[c]) === String(v)); return k; },
      in: () => k, order: () => k, limit: () => k, gte: () => k,
      update: (p) => { modus = 'update'; payload = p; return k; },
      insert: (p) => { modus = 'insert'; payload = p; return k; },
      maybeSingle: async () => run(true),
      then: (a, b) => run(false).then(a, b),
    };
    async function run(een) {
      const rows = (tabellen[tabel] || []).filter((r) => f.every((x) => x(r)));
      if (modus === 'insert') { writes.push({ tabel, modus, payload }); (tabellen[tabel] = tabellen[tabel] || []).push(payload); return { data: payload, error: null }; }
      if (modus === 'update') { writes.push({ tabel, modus, payload }); rows.forEach((r) => Object.assign(r, payload)); return { data: een ? rows[0] || null : rows, error: null }; }
      return { data: een ? rows[0] || null : rows, error: null };
    }
    return k;
  };
  return { from, writes, t: tabellen };
}

async function laad(db, brug) {
  mock.module(url('api/supabase.js'), { namedExports: {
    supabaseAdmin: db, supabase: db,
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }),
  } });
  mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
  mock.module(url('api/_lib/opvolging-brug-ververs.js'), { namedExports: { brugLeadlijstVerversen: async () => ({ ok: false }) } });
  mock.module(url('api/_lib/whatsapp-brug-client.js'), { namedExports: { brugFetch: brug } });
  return (await import(url('api/opvolging-agenda-doorsturen.js') + '?t=' + Math.random())).default;
}
const res = () => { const u = {}; return { setHeader() {}, status(c) { u.code = c; return this; }, json(b) { u.body = b; return this; }, u }; };
const kaart = () => ({ id: 'k1', status: 'open', naam: 'Sara Janssens', telefoon: '+32471123456', created_at: new Date(Date.now() - 3600000).toISOString() });

test('endpoint: zonder agendalink 409 en NIETS veranderd, NIETS verstuurd', async (t) => {
  t.after(() => mock.reset());
  let verstuurd = 0;
  const db = nepDb({ app_settings: [{ key: 'opvolging_agenda_doorsturen', value: { agenda_link: null } }], opvolging_taken: [kaart()] });
  const h = await laad(db, async () => { verstuurd += 1; return {}; });
  const r = res();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1' } }, r);
  assert.equal(r.u.code, 409);
  assert.equal(r.u.body.code, 'GEEN_AGENDALINK');
  assert.equal(verstuurd, 0);
  assert.equal(db.writes.length, 0);
  assert.equal(db.t.opvolging_taken[0].status, 'open');
});

test('endpoint: mislukte verzending → kaart NIET op wacht, geen poging, wel wa.me', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ app_settings: [{ key: 'opvolging_agenda_doorsturen', value: { agenda_link: LINK } }], opvolging_taken: [kaart()] });
  const h = await laad(db, async () => { const e = new Error('x'); e.code = 'BRUG_FOUT'; e.status = 503; throw e; });
  const r = res();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1' } }, r);
  assert.equal(r.u.code, 503);
  assert.equal(r.u.body.code, 'NIET_VERBONDEN');
  assert.match(r.u.body.wa_me, /^https:\/\/wa\.me\/32471123456\?text=/);
  assert.equal(db.writes.length, 0);
  assert.equal(db.t.opvolging_taken[0].status, 'open');
});

test('endpoint: geslaagd → wacht_inplanning + poging agenda_doorgestuurd, bericht met link', async (t) => {
  t.after(() => mock.reset());
  let body = null;
  const db = nepDb({ app_settings: [{ key: 'opvolging_agenda_doorsturen', value: { agenda_link: LINK } }], opvolging_taken: [kaart()], opvolging_pogingen: [] });
  const h = await laad(db, async (_p, o) => { body = o.body; return { ok: true }; });
  const r = res();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1' } }, r);
  assert.equal(r.u.code, 200);
  assert.equal(body.nummer, '32471123456');
  assert.ok(body.tekst.includes(LINK));
  assert.ok(body.tekst.startsWith('Hey Sara,'));
  const k = db.t.opvolging_taken[0];
  assert.equal(k.status, 'wacht_inplanning');
  assert.ok(k.agenda_doorgestuurd_at);
  assert.equal(db.t.opvolging_pogingen[0].soort, 'agenda_doorgestuurd');
});

test('endpoint: herinnering max 1 per 24u', async (t) => {
  t.after(() => mock.reset());
  let verstuurd = 0;
  const db = nepDb({
    app_settings: [{ key: 'opvolging_agenda_doorsturen', value: { agenda_link: LINK } }],
    opvolging_taken: [{ ...kaart(), status: 'wacht_inplanning', agenda_doorgestuurd_at: new Date(Date.now() - 30 * 3600000).toISOString() }],
    opvolging_pogingen: [{ taak_id: 'k1', soort: 'agenda_herinnering', tijdstip: new Date(Date.now() - 2 * 3600000).toISOString() }],
  });
  const h = await laad(db, async () => { verstuurd += 1; return {}; });
  const r = res();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1', soort: 'herinnering' } }, r);
  assert.equal(r.u.code, 429);
  assert.equal(verstuurd, 0);
});

test('de brug heeft de route /leadlijst/ververs, achter auth, en geeft geen nummers terug', () => {
  const bron = readFileSync(join(ROOT, 'services/whatsapp-brug/server.js'), 'utf8');
  const m = bron.match(/app\.post\('\/leadlijst\/ververs', auth,[\s\S]*?\n\}\);/);
  assert.ok(m, 'route ontbreekt of staat niet achter auth');
  assert.match(m[0], /leadlijst\.ververs\(\)/);
  assert.match(m[0], /herbouwLidkaart\(\)/);
  assert.doesNotMatch(m[0], /nummers\(\)/);
});
