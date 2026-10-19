// tests/lab-belmelding.test.js
//
// DE BELMELDING VAN THE LAB — contracttoetsen.
//   - de vier redenen, in volgorde van voorrang, en elk op zijn eigen moment;
//   - NOOIT na een boeking (LMS-vinkje of afspraak in het CRM), en een open
//     belopdracht vervalt bij een boeking;
//   - idempotent: één taak per lead per reden, ook over runs heen, en nooit
//     een tweede open kaart naast de eerste;
//   - ma–za (Europe/Brussels): op zondag staat de taak op maandag;
//   - testleads krijgen een testtaak;
//   - "Dave belt je" (lab-terugbellen): meteen een kaart, of de vraag erbij.

import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { maakFakeDb } from './lab-fake-db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

let crm; let lms;
const doorsturen = (get) => new Proxy({}, { get: (_t, k) => { const o = get(); const v = o[k]; return typeof v === 'function' ? v.bind(o) : v; } });
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: doorsturen(() => crm), checkCronAuth: () => ({ ok: true }) } });
mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: () => false } });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: false }) } });

const regels = await import(url('api/_lib/lab-belmelding.js'));
const { leadStand, geldendeRedenen, beslis, werkdagVoor, taakRij, antwoordenRegel } = regels;
const { draaiBelmelding } = await import(url('api/cron-lab-belmelding.js'));
const { default: terugbellen, schoneVraag } = await import(url('api/lab-terugbellen.js'));

const MIN = 60000; const UUR = 60 * MIN;
// Woensdag 21 oktober 2026, 14:00 in Brussel (12:00 UTC).
const NU = Date.parse('2026-10-21T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

const LEAD = (deel = {}) => ({
  id: 'll-1', auth_id: 'auth-1', email: 'lead@voorbeeld.be', voornaam: 'Lien', achternaam: 'Peeters',
  telefoon: '+32472223752', crm_lead_id: 'lead-1', hook: 'prop-firm', toegang_tot: iso(NU + 5 * 86400000),
  eerste_login_op: iso(NU - 2 * UUR), laatste_login_op: iso(NU - 2 * UUR), kwalificatie: null,
  sessie_geboekt_op: null, sessie_moment: null, is_test: false, aangemaakt_op: iso(NU - 3 * UUR), ...deel,
});
const SESSIE = (deel = {}) => ({ auth_id: 'auth-1', stap: 3, stappen: 25, voortgang: 12, bijgewerkt_op: iso(NU - 10 * MIN), afgerond: null, afgerond_op: null, ...deel });

/** De unieke index van de migratie: (bron_ref->>'lab_lead_id', reden_code) waar reden = 'lab_bellen'. */
const UNIEK = { opvolging_taken: (r, t) => r.reden === 'lab_bellen' && t.some((x) => x.reden === 'lab_bellen' && x.bron_ref?.lab_lead_id === r.bron_ref?.lab_lead_id && x.reden_code === r.reden_code) };

function opzet({ lead = LEAD(), sessie = SESSIE(), afspraken = [], taken = [] } = {}) {
  lms = maakFakeDb({ 'auth.users': [{ id: 'auth-1', email: lead.email, token: 'goed' }], hlms_lab_lead: [lead], hlms_lab_sessie: sessie ? [sessie] : [] });
  crm = maakFakeDb({ follow_up_appointments: afspraken, opvolging_taken: taken }, { uniek: UNIEK });
}
const taken = () => crm.tabellen.opvolging_taken;
beforeEach(() => opzet());

/* ── De regels, puur ─────────────────────────────────────────────────────── */

test('LAB AF: pas na 5 minuten zonder boeking, niet ervoor', () => {
  const af = (minGeleden) => leadStand({ labLead: LEAD(), sessie: SESSIE({ afgerond: 'true', voortgang: 100, afgerond_op: String(NU - minGeleden * MIN), bijgewerkt_op: iso(NU - minGeleden * MIN) }) });
  assert.deepEqual(geldendeRedenen(af(4), NU), []);
  assert.deepEqual(geldendeRedenen(af(5), NU), ['lab_af_niet_geboekt']);
});

test('LAB AF: de 5 minuten tellen vanaf afgerondOp (ms als tekst), niet vanaf de laatste hartslag', () => {
  // De lead kijkt nog naar zijn resultaat: de hartslag is 10 s oud, afgerond 6 min geleden.
  const s = leadStand({ labLead: LEAD(), sessie: SESSIE({ afgerond: 'true', voortgang: 100, afgerond_op: String(NU - 6 * MIN), bijgewerkt_op: iso(NU - 10000) }) });
  assert.equal(s.afgerondOp, NU - 6 * MIN);
  assert.deepEqual(geldendeRedenen(s, NU), ['lab_af_niet_geboekt']);
});

test('INVESTEREN: ja en misschien meteen, nee nooit', () => {
  for (const [antw, verwacht] of [['ja', ['lab_investeren']], ['misschien', ['lab_investeren']], ['nee', []]]) {
    const s = leadStand({ labLead: LEAD({ kwalificatie: { investeren: antw } }), sessie: SESSIE() });
    assert.deepEqual(geldendeRedenen(s, NU), verwacht, antw);
  }
});

test('24U STIL: alleen vanaf stap 5, en pas na 24 uur zonder activiteit', () => {
  const stil = (stap, uren) => leadStand({ labLead: LEAD({ laatste_login_op: iso(NU - uren * UUR), eerste_login_op: iso(NU - uren * UUR) }), sessie: SESSIE({ stap, bijgewerkt_op: iso(NU - uren * UUR) }) });
  assert.deepEqual(geldendeRedenen(stil(4, 30), NU), []);
  assert.deepEqual(geldendeRedenen(stil(5, 23), NU), []);
  assert.deepEqual(geldendeRedenen(stil(5, 24), NU), ['lab_stil_24u']);
  // Een recente login telt als activiteit, ook als de sessie stil ligt.
  const login = leadStand({ labLead: LEAD({ laatste_login_op: iso(NU - UUR) }), sessie: SESSIE({ stap: 7, bijgewerkt_op: iso(NU - 30 * UUR) }) });
  assert.deepEqual(geldendeRedenen(login, NU), []);
});

test('NOOIT NA BOEKING — LMS-vinkje of afspraak in het CRM; een open kaart vervalt', () => {
  const warm = { labLead: LEAD({ kwalificatie: { investeren: 'ja' } }), sessie: SESSIE({ afgerond: 'true', voortgang: 100, bijgewerkt_op: iso(NU - UUR) }) };
  assert.deepEqual(geldendeRedenen(leadStand({ ...warm, labLead: { ...warm.labLead, sessie_geboekt_op: iso(NU) } }), NU), []);
  const viaCrm = leadStand({ ...warm, geboektInCrm: true });
  assert.equal(beslis(viaCrm, {}, NU), null);
  assert.deepEqual(beslis(viaCrm, { heeftOpen: true }, NU), { actie: 'vervalt' });
});

test('ÉÉN OPEN KAART: een tweede reden wacht tot de eerste weg is, een gehad reden komt niet terug', () => {
  const s = leadStand({ labLead: LEAD({ kwalificatie: { investeren: 'ja' } }), sessie: SESSIE({ afgerond: 'true', voortgang: 100, bijgewerkt_op: iso(NU - UUR) }) });
  assert.deepEqual(beslis(s, {}, NU), { actie: 'maak', reden: 'lab_af_niet_geboekt' });
  assert.equal(beslis(s, { heeftOpen: true }, NU), null);
  assert.deepEqual(beslis(s, { gehad: new Set(['lab_af_niet_geboekt']) }, NU), { actie: 'maak', reden: 'lab_investeren' });
  assert.equal(beslis(s, { gehad: new Set(['lab_af_niet_geboekt', 'lab_investeren']) }, NU), null);
});

test('MA–ZA in Brussel: zaterdag blijft zaterdag, zondag wordt maandag (ook om 00:30 Brussel)', () => {
  assert.equal(werkdagVoor(Date.parse('2026-10-24T10:00:00Z')), '2026-10-24'); // zaterdag
  assert.equal(werkdagVoor(Date.parse('2026-10-25T10:00:00Z')), '2026-10-26'); // zondag → maandag
  // Zaterdag 22:30 UTC = zondag 00:30 in Brussel (nog zomertijd): al zondag → maandag.
  assert.equal(werkdagVoor(Date.parse('2026-10-24T22:30:00Z')), '2026-10-26');
  // Zondag 22:30 UTC = zondag 23:30 in Brussel (wintertijd sinds 03:00): nog zondag → maandag.
  assert.equal(werkdagVoor(Date.parse('2026-10-25T22:30:00Z')), '2026-10-26');
});

test('DE KAART: naam, gsm, hook, de drie antwoorden en de reden — lijst dag, reden lab_bellen', () => {
  const r = taakRij({ labLead: LEAD({ kwalificatie: { doel: 'bijverdienste', tijd: '3_6u', investeren: 'ja' } }), sessie: SESSIE({ stap: 25, stappen: 25 }), reden: 'lab_af_niet_geboekt', nu: NU });
  assert.equal(r.reden, 'lab_bellen');
  assert.equal(r.reden_code, 'lab_af_niet_geboekt');
  assert.equal(r.lijst, 'dag');
  assert.equal(r.naam, 'Lien Peeters');
  assert.equal(r.bron_ref.lab_lead_id, 'll-1');
  assert.equal(r.bron_ref.hook, 'prop-firm');
  assert.equal(r.due, '2026-10-21');
  assert.match(r.notitie, /Lab afgewerkt, nog niet geboekt\./);
  assert.match(r.notitie, /bijverdienste · 3–6 u\/week · investeren: ja/);
  assert.equal(antwoordenRegel(null), null);
});

/* ── De cron, met de twee databanken nagebootst ──────────────────────────── */

test('CRON: Lab af en niet geboekt → één kaart; tweede run maakt er geen tweede', async () => {
  opzet({ sessie: SESSIE({ stap: 25, voortgang: 100, afgerond: 'true', afgerond_op: String(NU - 6 * MIN), bijgewerkt_op: iso(NU - 6 * MIN) }) });
  const a = await draaiBelmelding(NU);
  assert.equal(a.gemaakt.length, 1);
  assert.equal(taken().length, 1);
  assert.equal(taken()[0].reden_code, 'lab_af_niet_geboekt');
  assert.equal(taken()[0].telefoon, '+32472223752');
  const b = await draaiBelmelding(NU + 5 * MIN);
  assert.equal(b.gemaakt.length, 0);
  assert.equal(taken().length, 1, 'idempotent over runs');
});

test('CRON: binnen 5 minuten na het einde nog niets', async () => {
  opzet({ sessie: SESSIE({ stap: 25, voortgang: 100, afgerond: 'true', afgerond_op: String(NU - 2 * MIN), bijgewerkt_op: iso(NU - 2 * MIN) }) });
  await draaiBelmelding(NU);
  assert.equal(taken().length, 0);
});

test('CRON: nooit na een boeking — afspraak in het CRM telt, een geannuleerde niet', async () => {
  const af = SESSIE({ stap: 25, voortgang: 100, afgerond: 'true', bijgewerkt_op: iso(NU - UUR) });
  opzet({ sessie: af, afspraken: [{ lead_email: 'lead@voorbeeld.be', scheduled_at: iso(NU + 86400000), status: 'scheduled' }] });
  await draaiBelmelding(NU);
  assert.equal(taken().length, 0);
  opzet({ sessie: af, afspraken: [{ lead_email: 'lead@voorbeeld.be', scheduled_at: iso(NU + 86400000), status: 'cancelled' }] });
  await draaiBelmelding(NU);
  assert.equal(taken().length, 1);
  // Een oude gehouden call van lang vóór de aanmelding telt niet als boeking.
  opzet({ sessie: af, afspraken: [{ lead_email: 'lead@voorbeeld.be', scheduled_at: iso(NU - 90 * 86400000), status: 'completed' }] });
  await draaiBelmelding(NU);
  assert.equal(taken().length, 1);
});

test('CRON: boekt de lead intussen, dan VERVALT de open kaart (gearchiveerd, met reden)', async () => {
  opzet({ lead: LEAD({ kwalificatie: { investeren: 'misschien' } }) });
  await draaiBelmelding(NU);
  assert.equal(taken()[0].status, 'open');
  lms.tabellen.hlms_lab_lead[0].sessie_geboekt_op = iso(NU + MIN);
  const v = await draaiBelmelding(NU + 5 * MIN);
  assert.deepEqual(v.vervallen, ['ll-1']);
  assert.equal(taken()[0].status, 'gearchiveerd');
  assert.match(taken()[0].archief_reden, /Sessie geboekt/);
});

test('CRON: testlead → testtaak; echte lead → echte taak', async () => {
  opzet({ lead: LEAD({ is_test: true, kwalificatie: { investeren: 'ja' } }) });
  await draaiBelmelding(NU);
  assert.equal(taken()[0].is_test, true);
  opzet({ lead: LEAD({ kwalificatie: { investeren: 'ja' } }) });
  await draaiBelmelding(NU);
  assert.equal(taken()[0].is_test, false);
});

test('CRON: op zondag ontstaat de kaart, maar ze staat op maandag', async () => {
  const zondag = Date.parse('2026-10-25T11:00:00Z');
  opzet({ lead: LEAD({ kwalificatie: { investeren: 'ja' }, aangemaakt_op: iso(zondag - UUR) }) });
  await draaiBelmelding(zondag);
  assert.equal(taken()[0].due, '2026-10-26');
});

test('VERCEL: de cron draait elke 5 minuten', () => {
  const v = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
  const c = v.crons.find((x) => x.path === '/api/cron-lab-belmelding');
  assert.equal(c?.schedule, '*/5 * * * *');
});

/* ── "Dave belt je" ──────────────────────────────────────────────────────── */

function res() {
  return { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
}
const post = async (token, body) => { const r = res(); await terugbellen({ method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body }, r); return r; };

test('TERUGBELLEN: zonder sessie 401; meteen een kaart met de vraag; tweede keer bij dezelfde kaart', async () => {
  assert.equal((await post(null, {})).statusCode, 401);
  const a = await post('goed', { vraag: '  Kan ik dit\nnaast mijn job?  ' });
  assert.equal(a.statusCode, 200);
  assert.equal(a.body.taak, 'nieuw');
  assert.equal(taken().length, 1);
  assert.equal(taken()[0].reden_code, 'lab_vraag');
  assert.match(taken()[0].notitie, /Vroeg zelf om te bellen .*"Kan ik dit naast mijn job\?"/);
  const b = await post('goed', { vraag: 'Nog een vraag' });
  assert.equal(b.body.taak, 'bestaand');
  assert.equal(taken().length, 1);
  assert.match(taken()[0].notitie, /Nog een vraag[\s\S]*Kan ik dit naast mijn job/);
});

test('TERUGBELLEN: al geboekt → 409, geen kaart', async () => {
  lms.tabellen.hlms_lab_lead[0].sessie_moment = iso(Date.now() + 86400000);
  const r = await post('goed', {});
  assert.equal(r.statusCode, 409);
  assert.equal(taken().length, 0);
});

test('schoneVraag: één regel, max 300', () => {
  assert.equal(schoneVraag('  a \n b '), 'a b');
  assert.equal(schoneVraag(''), null);
  assert.equal(schoneVraag('x'.repeat(400)).length, 300);
});

test('MEETEN PRATEN: koos "praten", 10 minuten later niet geboekt → bellen; eerder niet; nooit na boeking', () => {
  const st = (minGeleden, extra = {}) => leadStand({ labLead: LEAD({ route: 'praten', route_gekozen_op: iso(NU - minGeleden * MIN), ...extra }), sessie: null });
  assert.deepEqual(geldendeRedenen(st(9), NU), []);
  assert.deepEqual(geldendeRedenen(st(10), NU), ['lab_praten']);
  assert.deepEqual(geldendeRedenen(st(30, { sessie_geboekt_op: iso(NU) }), NU), []);
  // Via het gedrag uit het LMS (leesLabGedrag), ook als de rij het veld niet draagt.
  const viaGedrag = leadStand({ labLead: LEAD(), sessie: null, gedrag: { route: 'praten', routeOp: NU - 15 * MIN } });
  assert.deepEqual(geldendeRedenen(viaGedrag, NU), ['lab_praten']);
});

test('CRON: route uit het LMS → lab_praten-kaart', async () => {
  opzet({ lead: LEAD({ route: 'praten', route_gekozen_op: iso(NU - 12 * MIN) }), sessie: null });
  await draaiBelmelding(NU);
  assert.equal(taken()[0].reden_code, 'lab_praten');
  assert.match(taken()[0].notitie, /meteen praten/);
});
