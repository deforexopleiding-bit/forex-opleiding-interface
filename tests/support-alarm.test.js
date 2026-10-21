// tests/support-alarm.test.js
//
// EEN SUPPORTCHAT MAG NOOIT GEMIST WORDEN.
//
//   1. de regel "wat is onbeantwoord" (api/_lib/support-alarm.js alarmLijst):
//      bot-venster, wachtrij zonder tijdslimiet, oppakken, collega's,
//      escalatie vanaf het OUDSTE onbeantwoorde bericht;
//   2. wanneer het team een mail krijgt (teamMailReden) — nooit per bericht;
//   3. de mail zelf (bouwTeamMail): tel:-link, knop naar het gesprek, geen
//      kenmerk in het onderwerp, [TEST] voor +labtest;
//   4. meldTeam: claim → mail; claim kwijt → geen mail; mail mislukt → claim
//      terug;
//   5. de instellingen (geschoond, grenzen);
//   6. de CRM-balk (modules/klanten-v2/support-alarm.js): de pure beslissing
//      en, in jsdom, de balk, het belletje, Stil, Ik neem het, 403;
//   7. de bedrading: endpoint-recht, hooks, deeplinks, scripts, migratie.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── Nep-database + nep-SMTP voor meldTeam ─────────────────────────────────
const db = { gesprek: null, berichten: [], instellingen: null, claimWint: true, sendOk: true, updates: [], mails: [] };

function antwoord(q) {
  const upd = q.ops.find((o) => o[0] === 'update');
  if (q.tabel === 'app_settings') return { data: db.instellingen ? { value: db.instellingen } : null, error: null };
  if (q.tabel === 'support_berichten') return { data: db.berichten, error: null };
  if (q.tabel === 'support_gesprekken' && upd) {
    db.updates.push({ waarde: upd[1], ops: q.ops.filter((o) => o[0] !== 'update') });
    const isClaim = db.updates.length === 1;
    return { data: isClaim && db.claimWint ? [{ id: db.gesprek.id }] : [], error: null };
  }
  if (q.tabel === 'support_gesprekken') return { data: db.gesprek, error: null };
  return { data: null, error: null };
}
function query(tabel) {
  const q = { tabel, ops: [] };
  const z = {};
  for (const m of ['select', 'eq', 'is', 'in', 'neq', 'gte', 'lt', 'order', 'limit', 'update', 'insert', 'upsert']) {
    z[m] = (...a) => { q.ops.push([m, ...a]); return z; };
  }
  z.maybeSingle = () => Promise.resolve(antwoord(q));
  z.then = (ok, nok) => Promise.resolve(antwoord(q)).then(ok, nok);
  return z;
}
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: { from: (t) => query(t) },
    supabase: { auth: { getUser: async () => ({ data: { user: null }, error: new Error('geen') }) } },
    checkCronAuth: () => ({ ok: true }),
  },
});
mock.module('../api/_lib/send-email-core.js', {
  namedExports: {
    sendEmailViaSmtp: async (o) => { db.mails.push(o); return db.sendOk ? { ok: true, messageId: 'x' } : { ok: false, reason: 'smtp weg' }; },
  },
});

const A = await import('../api/_lib/support-alarm.js');
const {
  alarmLijst, wachtOpOns, teamMailReden, bouwTeamMail, leesAlarmInstellingen, valideerAlarmWijziging,
  eersteWoorden, crmGesprekPad, crmGesprekLink, meldTeam, ALARM_STANDAARD, MIN,
} = A;

const NU = Date.parse('2026-10-21T12:00:00Z');
const iso = (msVoorNu) => new Date(NU - msVoorNu).toISOString();
const IK = '11111111-1111-1111-1111-111111111111';
const COLLEGA = '22222222-2222-2222-2222-222222222222';

function gesprek(o = {}) {
  return {
    id: 'g1', kenmerk: 'SUP-ABC123', soort: 'bezoeker', onderwerp: 'informatie', status: 'bot',
    naam: 'Jan', email: 'jan@voorbeeld.nl', telefoon: '+32470123456',
    toegewezen_aan: null, toegewezen_op: null,
    laatste_klant_bericht_op: iso(1 * MIN), laatste_ons_bericht_op: null,
    created_at: iso(1 * MIN), team_gemaild_op: null, ...o,
  };
}
const klant = (gesprek_id, msVoorNu, tekst = 'hallo') => ({ gesprek_id, tekst, created_at: iso(msVoorNu) });

// ═══════════════════════════════════════════════════════════════════════════
// 1 · WAT IS ONBEANTWOORD
// ═══════════════════════════════════════════════════════════════════════════

test('nieuwe chat (bot praat nog) → alarm "nieuw" met naam en eerste woorden', () => {
  const g = gesprek();
  const l = alarmLijst([g], [klant('g1', 1 * MIN, 'Ik kan niet inloggen op het platform, wat moet ik doen?')], { nu: NU, userId: IK });
  assert.equal(l.length, 1);
  assert.equal(l[0].niveau, 'nieuw');
  assert.equal(l[0].naam, 'Jan');
  assert.match(l[0].eerste_woorden, /^Ik kan niet inloggen/);
  assert.equal(l[0].wacht_s, 60);
});

test('na 5 minuten onbeantwoord → "urgent" (escalatie_min instelbaar)', () => {
  const g = gesprek({ laatste_klant_bericht_op: iso(6 * MIN) });
  assert.equal(alarmLijst([g], [klant('g1', 6 * MIN)], { nu: NU })[0].niveau, 'urgent');
  assert.equal(alarmLijst([g], [klant('g1', 6 * MIN)], { nu: NU, cfg: { ...ALARM_STANDAARD, escalatie_min: 10 } })[0].niveau, 'nieuw');
});

test('escalatie telt vanaf het OUDSTE onbeantwoorde bericht, niet het laatste', () => {
  // De klant schrijft elke minuut iets bij; dat mag de escalatie niet uitstellen.
  const g = gesprek({ laatste_klant_bericht_op: iso(0.5 * MIN), status: 'wacht_op_ons' });
  const l = alarmLijst([g], [klant('g1', 7 * MIN, 'eerste vraag'), klant('g1', 3 * MIN), klant('g1', 0.5 * MIN)], { nu: NU });
  assert.equal(l[0].niveau, 'urgent');
  assert.equal(l[0].eerste_woorden, 'eerste vraag');
});

test('bot-gesprek dat al 30+ minuten stil is → geen alarm (bezoeker weg, Sam antwoordde)', () => {
  const g = gesprek({ laatste_klant_bericht_op: iso(31 * MIN) });
  assert.equal(wachtOpOns(g, NU), false);
  assert.equal(alarmLijst([g], [], { nu: NU }).length, 0);
});

test('wachtrij (wacht_op_ons) alarmeert zonder tijdslimiet', () => {
  const g = gesprek({ status: 'wacht_op_ons', laatste_klant_bericht_op: iso(2 * 24 * 60 * MIN) });
  const l = alarmLijst([g], [], { nu: NU });
  assert.equal(l.length, 1);
  assert.equal(l[0].niveau, 'urgent');
});

test('een medewerker antwoordde na het klantbericht → geen alarm', () => {
  const g = gesprek({ status: 'wacht_op_klant', laatste_ons_bericht_op: iso(0.5 * MIN) });
  assert.equal(alarmLijst([g], [klant('g1', 1 * MIN)], { nu: NU }).length, 0);
});

test('"Ik neem het" (toegewezen ná het klantbericht) → bij iedereen weg, ook als het al urgent was', () => {
  const g = gesprek({ status: 'in_behandeling', laatste_klant_bericht_op: iso(9 * MIN), toegewezen_aan: COLLEGA, toegewezen_op: iso(0.2 * MIN) });
  assert.equal(alarmLijst([g], [klant('g1', 9 * MIN)], { nu: NU, userId: IK }).length, 0);
  assert.equal(alarmLijst([g], [klant('g1', 9 * MIN)], { nu: NU, userId: COLLEGA }).length, 0);
});

test('klant schrijft opnieuw in een opgepakt gesprek: eerst alleen bij wie het heeft, na de escalatie bij iedereen', () => {
  const g = gesprek({ status: 'wacht_op_ons', toegewezen_aan: COLLEGA, toegewezen_op: iso(20 * MIN), laatste_klant_bericht_op: iso(2 * MIN) });
  const vers = [klant('g1', 2 * MIN)];
  assert.equal(alarmLijst([g], vers, { nu: NU, userId: IK }).length, 0);
  const bijCollega = alarmLijst([g], vers, { nu: NU, userId: COLLEGA });
  assert.equal(bijCollega.length, 1);
  assert.equal(bijCollega[0].voor_mij, true);
  const oud = gesprek({ ...g, laatste_klant_bericht_op: iso(6 * MIN) });
  const bijMij = alarmLijst([oud], [klant('g1', 6 * MIN)], { nu: NU, userId: IK });
  assert.equal(bijMij.length, 1);
  assert.equal(bijMij[0].niveau, 'urgent');
});

test('afgehandeld → nooit een alarm', () => {
  assert.equal(alarmLijst([gesprek({ status: 'afgehandeld' })], [klant('g1', 1 * MIN)], { nu: NU }).length, 0);
});

test('volgorde: urgent eerst, daarna wie het langst wacht', () => {
  const l = alarmLijst([
    gesprek({ id: 'a', laatste_klant_bericht_op: iso(1 * MIN) }),
    gesprek({ id: 'b', laatste_klant_bericht_op: iso(8 * MIN), status: 'wacht_op_ons' }),
    gesprek({ id: 'c', laatste_klant_bericht_op: iso(3 * MIN) }),
  ], [], { nu: NU });
  assert.deepEqual(l.map((c) => c.id), ['b', 'c', 'a']);
});

test('de stil-sleutel blijft gelijk zolang het over hetzelfde onbeantwoorde stuk gaat', () => {
  const g1 = gesprek({ status: 'wacht_op_ons', laatste_klant_bericht_op: iso(2 * MIN) });
  const g2 = gesprek({ status: 'wacht_op_ons', laatste_klant_bericht_op: iso(0.1 * MIN) });
  const a = alarmLijst([g1], [klant('g1', 2 * MIN)], { nu: NU })[0].sleutel;
  const b = alarmLijst([g2], [klant('g1', 2 * MIN), klant('g1', 0.1 * MIN)], { nu: NU })[0].sleutel;
  assert.equal(a, b);
});

test('eersteWoorden: knipt op een woordgrens, één regel', () => {
  assert.equal(eersteWoorden('  hallo\n\n daar  '), 'hallo daar');
  const lang = eersteWoorden('Ik heb een vraag over mijn traject en de facturen die ik deze maand kreeg van jullie', 40);
  assert.ok(lang.length <= 41);
  assert.ok(lang.endsWith('…'));
  assert.ok(!/\s…$/.test(lang));
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · WANNEER KRIJGT HET TEAM EEN MAIL
// ═══════════════════════════════════════════════════════════════════════════

test('nieuw gesprek → "nieuw"', () => {
  assert.equal(teamMailReden(gesprek(), { nu: NU }), 'nieuw');
});

test('tweede bericht kort na de start → geen mail (niet per bericht)', () => {
  assert.equal(teamMailReden(gesprek({ created_at: iso(3 * MIN), team_gemaild_op: iso(3 * MIN) }), { nu: NU }), null);
});

test('klant schrijft opnieuw, 30+ min niemand van ons → "opnieuw"; daarna een half uur niets', () => {
  const g = gesprek({ created_at: iso(40 * MIN), team_gemaild_op: iso(40 * MIN) });
  assert.equal(teamMailReden(g, { nu: NU }), 'opnieuw');
  assert.equal(teamMailReden({ ...g, team_gemaild_op: iso(5 * MIN) }, { nu: NU }), null);
});

test('wij antwoordden recent → geen mail; wij antwoordden lang geleden → wel', () => {
  const basis = { created_at: iso(3 * 60 * MIN), team_gemaild_op: iso(3 * 60 * MIN) };
  assert.equal(teamMailReden(gesprek({ ...basis, laatste_ons_bericht_op: iso(5 * MIN) }), { nu: NU }), null);
  assert.equal(teamMailReden(gesprek({ ...basis, laatste_ons_bericht_op: iso(45 * MIN) }), { nu: NU }), 'opnieuw');
});

test('oppakken telt als reactie van ons', () => {
  const g = gesprek({ created_at: iso(60 * MIN), team_gemaild_op: iso(60 * MIN), toegewezen_aan: COLLEGA, toegewezen_op: iso(10 * MIN) });
  assert.equal(teamMailReden(g, { nu: NU }), null);
});

test('oud gesprek van vóór de migratie (team_gemaild_op leeg) heet niet "nieuw"', () => {
  assert.equal(teamMailReden(gesprek({ created_at: iso(3 * 24 * 60 * MIN) }), { nu: NU }), 'opnieuw');
});

test('mail uitgezet → nooit een mail', () => {
  assert.equal(teamMailReden(gesprek(), { nu: NU, cfg: { ...ALARM_STANDAARD, mail_aan: false } }), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE MAIL
// ═══════════════════════════════════════════════════════════════════════════

test('teammail: naam, e-mail, klikbare gsm, wie, pagina, eerste bericht en de knop naar het gesprek', () => {
  const m = bouwTeamMail({
    gesprek: gesprek({ bron_url: 'https://www.deforexopleiding.nl/the-lab', customer_id: null, soort: 'klant' }),
    reden: 'nieuw', eersteBericht: 'Ik kan niet inloggen',
  });
  assert.match(m.subject, /^Nieuwe chat: Jan — Ik kan niet inloggen$/);
  assert.ok(!/SUP-/.test(m.subject), 'geen kenmerk in het onderwerp (cron-support-mail leest dat patroon)');
  assert.match(m.html, /href="tel:\+32470123456"/);
  assert.match(m.html, /\+32 470 12 34 56/);
  assert.match(m.html, /mailto:jan@voorbeeld\.nl/);
  assert.match(m.html, /Klant \(nog niet geverifieerd\)/);
  assert.match(m.html, /the-lab/);
  assert.match(m.html, /Ik kan niet inloggen/);
  assert.match(m.html, /Open gesprek in CRM/);
  assert.ok(m.html.includes(crmGesprekLink('g1').replace(/&/g, '&amp;')));
  assert.match(m.text, /tel:\+32470123456/);
  assert.match(m.text, /v2preview=support&gesprek=g1/);
});

test('teammail "opnieuw" toont ook het nieuwste bericht; +labtest krijgt [TEST]; html ge-escaped', () => {
  const m = bouwTeamMail({
    gesprek: gesprek({ email: 'maxim+labtest@x.nl', naam: '<b>Piet</b>' }),
    reden: 'opnieuw', eersteBericht: 'eerste', laatsteBericht: 'nog steeds geen antwoord <script>',
    aantalOnbeantwoord: 3,
  });
  assert.match(m.subject, /^\[TEST\] Chat wacht op antwoord:/);
  assert.match(m.html, /Nieuwste bericht/);
  assert.match(m.html, /3 berichten zonder antwoord/);
  assert.ok(!m.html.includes('<script>'));
  assert.ok(!m.html.includes('<b>Piet</b>'));
});

test('geen gsm → "— geen nummer", geen tel:-link', () => {
  const m = bouwTeamMail({ gesprek: gesprek({ telefoon: null }), reden: 'nieuw', eersteBericht: 'x' });
  assert.match(m.html, /geen nummer/);
  assert.ok(!/tel:/.test(m.html));
});

test('deeplink naar het gesprek gebruikt v2preview (de shell kent geen ?mod=)', () => {
  assert.equal(crmGesprekPad('abc'), '/modules/klanten-v2/?v2preview=support&gesprek=abc');
  assert.match(crmGesprekLink('abc'), /^https:\/\/crm\.deforexopleiding\.nl\/modules\/klanten-v2\/\?v2preview=support&gesprek=abc$/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · meldTeam: CLAIM, VERSTUREN, TERUGDRAAIEN
// ═══════════════════════════════════════════════════════════════════════════

function reset(o = {}) {
  Object.assign(db, { gesprek: gesprek(), berichten: [{ tekst: 'Hallo, ik heb een vraag', created_at: iso(1 * MIN) }],
    instellingen: null, claimWint: true, sendOk: true, updates: [], mails: [] }, o);
}

test('meldTeam: nieuw gesprek → claim op team_gemaild_op IS NULL en één mail naar administratie@', async () => {
  reset();
  const r = await meldTeam({ gesprekId: 'g1', nu: NU });
  assert.deepEqual(r, { verstuurd: true, reden: 'nieuw' });
  assert.equal(db.mails.length, 1);
  assert.equal(db.mails[0].to, 'administratie@deforexopleiding.nl');
  assert.equal(db.mails[0].fromMailbox, 'info@deforexopleiding.nl');
  assert.ok(db.updates[0].ops.some((o) => o[0] === 'is' && o[1] === 'team_gemaild_op' && o[2] === null));
});

test('meldTeam: claim verloren (gelijktijdig verzoek) → geen tweede mail', async () => {
  reset({ claimWint: false });
  const r = await meldTeam({ gesprekId: 'g1', nu: NU });
  assert.equal(r.verstuurd, false);
  assert.equal(db.mails.length, 0);
});

test('meldTeam: versturen mislukt → claim terug, zodat cron of volgend bericht het opnieuw probeert', async () => {
  reset({ sendOk: false });
  const r = await meldTeam({ gesprekId: 'g1', nu: NU });
  assert.equal(r.verstuurd, false);
  assert.equal(db.updates.length, 2);
  assert.equal(db.updates[1].waarde.team_gemaild_op, null);
  assert.ok(db.updates[1].ops.some((o) => o[0] === 'eq' && o[1] === 'team_gemaild_op' && o[2] === new Date(NU).toISOString()));
});

test('meldTeam: herhaalmail claimt op de vorige waarde (geen dubbele bij twee berichten tegelijk)', async () => {
  reset({ gesprek: gesprek({ created_at: iso(50 * MIN), team_gemaild_op: iso(50 * MIN) }) });
  const r = await meldTeam({ gesprekId: 'g1', nu: NU });
  assert.equal(r.reden, 'opnieuw');
  assert.ok(db.updates[0].ops.some((o) => o[0] === 'eq' && o[1] === 'team_gemaild_op' && o[2] === iso(50 * MIN)));
});

test('meldTeam: niets te melden → geen update, geen mail', async () => {
  reset({ gesprek: gesprek({ created_at: iso(3 * MIN), team_gemaild_op: iso(3 * MIN) }) });
  const r = await meldTeam({ gesprekId: 'g1', nu: NU });
  assert.equal(r.verstuurd, false);
  assert.equal(db.updates.length, 0);
  assert.equal(db.mails.length, 0);
});

test('meldTeam (vangnet alleenNieuw): ook een gesprek van 20 min zonder teammail krijgt de "nieuwe chat"-mail', async () => {
  reset({ gesprek: gesprek({ created_at: iso(20 * MIN) }) });
  const r = await meldTeam({ gesprekId: 'g1', nu: NU, alleenNieuw: true });
  assert.deepEqual(r, { verstuurd: true, reden: 'nieuw' });
  reset({ gesprek: gesprek({ created_at: iso(20 * MIN), team_gemaild_op: iso(20 * MIN) }) });
  assert.equal((await meldTeam({ gesprekId: 'g1', nu: NU, alleenNieuw: true })).verstuurd, false);
});

test('meldTeam: meldadres uit de instellingen', async () => {
  reset({ instellingen: { mail_naar: 'info@deforexopleiding.nl' } });
  await meldTeam({ gesprekId: 'g1', nu: NU });
  assert.equal(db.mails[0].to, 'info@deforexopleiding.nl');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · INSTELLINGEN
// ═══════════════════════════════════════════════════════════════════════════

test('instellingen: standaard, grenzen, en nooit een meldadres buiten ons domein', () => {
  assert.deepEqual(leesAlarmInstellingen(null), { ...ALARM_STANDAARD });
  const l = leesAlarmInstellingen({ interval_s: 1, escalatie_min: 999, mail_naar: 'iemand@gmail.com', geluid: false });
  assert.equal(l.interval_s, 2);
  assert.equal(l.escalatie_min, 60);
  assert.equal(l.mail_naar, 'administratie@deforexopleiding.nl');
  assert.equal(l.geluid, false);
});

test('instellingen wijzigen: foutmeldingen in het Nederlands, geldige waarden overgenomen', () => {
  const fout = valideerAlarmWijziging(null, { interval_s: 0, mail_naar: 'x@gmail.com' });
  assert.equal(fout.fouten.length, 2);
  const goed = valideerAlarmWijziging({ interval_s: 4 }, { interval_s: '6', escalatie_min: 3, geluid: false });
  assert.deepEqual(goed.fouten, []);
  assert.equal(goed.waarde.interval_s, 6);
  assert.equal(goed.waarde.escalatie_min, 3);
  assert.equal(goed.waarde.geluid, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · DE CRM-BALK
// ═══════════════════════════════════════════════════════════════════════════

function laadShell({ antwoorden = {}, opslag = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>Dashboard</title></head><body>
    <div class="app"><header class="topbar"><div class="kv-notif-wrap"><button id="kvNotifBtn"></button></div></header></div>
  </body></html>`, { url: 'https://crm.deforexopleiding.nl/modules/klanten-v2/#dashboard', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  for (const [k, v] of Object.entries(opslag)) w.localStorage.setItem(k, v);
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  w.setTimeout = () => 0;
  w.HTMLCanvasElement.prototype.getContext = () => null;   // jsdom heeft geen canvas: geen favicon-badge
  const calls = [];
  const toasts = [];
  const nav = [];
  w.DFO = { goMod: (m) => nav.push(['goMod', m]), render: () => nav.push(['render']) };
  w.eval(lees('modules/klanten-v2/banner-stapel.js'));
  w.eval(lees('modules/klanten-v2/support-alarm.js'));
  const haal = async (url, init = {}) => {
    calls.push({ url, init });
    const a = antwoorden[url.split('?')[0]];
    const r = typeof a === 'function' ? a(init) : a;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return { w, calls, toasts, nav, haal, start: () => w.KVSupportAlarm.start({ haal, userId: IK, toast: (t) => toasts.push(t) }) };
}
const wacht = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const chat = (o = {}) => ({ id: 'g1', kenmerk: 'SUP-ABC123', naam: 'Jan', eerste_woorden: 'Ik kan niet inloggen', sinds: iso(60000),
  wacht_s: 60, niveau: 'nieuw', toegewezen_aan: null, voor_mij: false, sleutel: 'g1:1', test: false, ...o });
const alarmAntwoord = (chats, inst = {}) => ({ status: 200, body: { chats, teller: chats.length, ik: IK,
  instellingen: { geluid: true, interval_s: 4, escalatie_min: 5, ...inst } } });

test('pure beslissing: Stil stopt het rinkelen, escalatie laat het opnieuw rinkelen', () => {
  const { w } = laadShell();
  const S = w.KVSupportAlarm;
  const c = chat();
  const basis = { chats: [c], nu: NU, gehaaldOp: NU, instellingen: { geluid: true, escalatie_min: 5 }, geluidKeuze: 'aan' };
  assert.equal(S.alarmStaat({ ...basis, stil: {} }).rinkelen, true);
  const stil = S.markeerStil({}, [{ ...c, niveauNu: 'nieuw' }], NU);
  const na = S.alarmStaat({ ...basis, stil });
  assert.equal(na.rinkelen, false);
  assert.equal(na.zichtbaar, true, 'de balk blijft staan zolang de chat onbeantwoord is');
  // vijf minuten later (zonder nieuwe gegevens): rood, en weer rinkelen
  const later = S.alarmStaat({ ...basis, stil, nu: NU + 4 * MIN + 1000 });
  assert.equal(later.variant, 'urgent');
  assert.equal(later.rinkelen, true);
});

test('pure beslissing: geluid uit (browser of team) → geen geluid, wel balk en titel', () => {
  const { w } = laadShell();
  const S = w.KVSupportAlarm;
  const basis = { chats: [chat(), chat({ id: 'g2', sleutel: 'g2:1' })], nu: NU, gehaaldOp: NU, stil: {} };
  const a = S.alarmStaat({ ...basis, instellingen: { geluid: true }, geluidKeuze: 'uit' });
  assert.equal(a.rinkelen, false);
  assert.equal(a.knipperen, true);
  assert.equal(a.titel, '(2) Chat!');
  assert.equal(S.alarmStaat({ ...basis, instellingen: { geluid: false }, geluidKeuze: 'aan' }).rinkelen, false);
  assert.equal(S.wachtTekst(30), 'net');
  assert.equal(S.wachtTekst(185), '3 min');
  assert.equal(S.wachtTekst(3900), '1 u 5 min');
});

test('markeerStil ruimt sleutels ouder dan een dag op', () => {
  const { w } = laadShell();
  const uit = w.KVSupportAlarm.markeerStil({ oud: NU - 25 * 60 * MIN, vers: NU - MIN }, [], NU);
  assert.deepEqual(Object.keys(uit), ['vers']);
});

test('balk + belletje op elke pagina; teller; "Iemand zit in de chat — Jan · …"', async () => {
  const s = laadShell({ antwoorden: { '/api/support-alarm': alarmAntwoord([chat(), chat({ id: 'g2', sleutel: 'g2:1', naam: 'Els' })]) } });
  s.start();
  await wacht();
  const balk = s.w.document.getElementById('kv-support-alarm');
  assert.ok(balk, 'balk staat er');
  assert.equal(balk.parentNode.id, 'kv-banner-stapel');
  assert.match(balk.textContent, /Iemand zit in de chat — Jan · Ik kan niet inloggen/);
  assert.match(balk.textContent, /\+1 meer/);
  assert.ok(balk.querySelector('[data-kvsa="beantwoord"]'));
  assert.ok(balk.querySelector('[data-kvsa="neem"]'));
  assert.ok(balk.querySelector('[data-kvsa="stil"]'));
  const bel = s.w.document.getElementById('kvChatBel');
  assert.ok(bel, 'belletje in de topbalk');
  assert.equal(bel.querySelector('[data-kvsa-teller]').textContent, '2');
  assert.equal(bel.querySelector('[data-kvsa-teller]').hidden, false);
  // één keer per browser de vraag om het geluid
  assert.ok(s.w.document.getElementById('kv-support-geluidvraag'));
});

test('urgent → rode balk "Chat wacht al …"', async () => {
  const s = laadShell({ antwoorden: { '/api/support-alarm': alarmAntwoord([chat({ niveau: 'urgent', wacht_s: 420 })]) } });
  s.start();
  await wacht();
  const balk = s.w.document.getElementById('kv-support-alarm');
  assert.equal(balk.getAttribute('data-variant'), 'urgent');
  assert.match(balk.textContent, /Chat wacht al 7 min/);
});

test('"Liever niet" op de geluidsvraag wordt per browser onthouden', async () => {
  const s = laadShell({ antwoorden: { '/api/support-alarm': alarmAntwoord([]) } });
  s.start();
  await wacht();
  s.w.document.querySelector('#kv-support-geluidvraag [data-kvsa-v="uit"]').click();
  assert.equal(s.w.localStorage.getItem('kv_support_chatgeluid'), 'uit');
  assert.equal(s.w.document.getElementById('kv-support-geluidvraag'), null);
  const s2 = laadShell({ antwoorden: { '/api/support-alarm': alarmAntwoord([]) }, opslag: { kv_support_chatgeluid: 'uit' } });
  s2.start();
  await wacht();
  assert.equal(s2.w.document.getElementById('kv-support-geluidvraag'), null);
});

test('Stil: bewaard per gebruiker in deze browser, de balk blijft, de Stil-knop gaat weg', async () => {
  const s = laadShell({ antwoorden: { '/api/support-alarm': alarmAntwoord([chat()]) }, opslag: { kv_support_chatgeluid: 'aan' } });
  s.start();
  await wacht();
  s.w.document.querySelector('#kv-support-alarm [data-kvsa="stil"]').click();
  const opgeslagen = JSON.parse(s.w.localStorage.getItem('kv_support_alarm_stil:' + IK));
  assert.ok(opgeslagen['g1:1|nieuw']);
  assert.ok(s.w.document.getElementById('kv-support-alarm'));
  assert.equal(s.w.document.querySelector('#kv-support-alarm [data-kvsa="stil"]'), null);
});

test('Ik neem het: PATCH met alleen_als_vrij, opent het gesprek in de shell', async () => {
  const s = laadShell({ antwoorden: {
    '/api/support-alarm': alarmAntwoord([chat()]),
    '/api/support-gesprek-update': { status: 200, body: { gesprek: { id: 'g1' } } },
  } });
  s.start();
  await wacht();
  s.w.document.querySelector('#kv-support-alarm [data-kvsa="neem"]').click();
  await wacht();
  const patch = s.calls.find((c) => c.url === '/api/support-gesprek-update');
  assert.ok(patch);
  assert.equal(patch.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(patch.init.body), { gesprek_id: 'g1', toegewezen_aan: 'mij', alleen_als_vrij: true });
  assert.match(s.toasts[0], /opgepakt/);
  assert.deepEqual(s.nav[0], ['goMod', 'support']);
  assert.equal(new s.w.URL(s.w.location.href).searchParams.get('gesprek'), 'g1');
});

test('Ik neem het, maar een collega was sneller → melding, geen navigatie', async () => {
  const s = laadShell({ antwoorden: {
    '/api/support-alarm': alarmAntwoord([chat()]),
    '/api/support-gesprek-update': { status: 409, body: { error: 'Dave heeft dit gesprek al opgepakt.', toegewezen_aan: COLLEGA } },
  } });
  s.start();
  await wacht();
  s.w.document.querySelector('#kv-support-alarm [data-kvsa="neem"]').click();
  await wacht();
  assert.equal(s.toasts[0], 'Dave heeft dit gesprek al opgepakt.');
  assert.equal(s.nav.length, 0);
});

test('Beantwoorden: opent het gesprek en zet het belletje voor deze chat stil', async () => {
  const s = laadShell({ antwoorden: { '/api/support-alarm': alarmAntwoord([chat()]) } });
  s.start();
  await wacht();
  s.w.document.querySelector('#kv-support-alarm [data-kvsa="beantwoord"]').click();
  assert.deepEqual(s.nav[0], ['goMod', 'support']);
  assert.equal(new s.w.URL(s.w.location.href).searchParams.get('gesprek'), 'g1');
  assert.ok(JSON.parse(s.w.localStorage.getItem('kv_support_alarm_stil:' + IK))['g1:1|nieuw']);
});

test('geen chats meer (iemand nam het op) → balk weg, teller weg, titel terug', async () => {
  let chats = [chat()];
  const s = laadShell({ antwoorden: { '/api/support-alarm': () => alarmAntwoord(chats) } });
  s.start();
  await wacht();
  assert.ok(s.w.document.getElementById('kv-support-alarm'));
  chats = [];
  await s.w.KVSupportAlarm.ververs();
  assert.equal(s.w.document.getElementById('kv-support-alarm'), null);
  assert.equal(s.w.document.querySelector('#kvChatBel [data-kvsa-teller]').hidden, true);
  assert.equal(s.w.document.title, 'Dashboard');
});

test('zonder supportrechten (403) → geen balk en geen belletje', async () => {
  const s = laadShell({ antwoorden: { '/api/support-alarm': { status: 403, body: { error: 'nee' } } } });
  s.start();
  await wacht();
  assert.equal(s.w.document.getElementById('kv-support-alarm'), null);
  assert.equal(s.w.document.getElementById('kvChatBel'), null);
});

test('testchat (+labtest) is herkenbaar in de balk', async () => {
  const s = laadShell({ antwoorden: { '/api/support-alarm': alarmAntwoord([chat({ test: true })]) } });
  s.start();
  await wacht();
  assert.match(s.w.document.getElementById('kv-support-alarm').textContent, /\[TEST\] Jan/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7 · BEDRADING
// ═══════════════════════════════════════════════════════════════════════════

test('endpoint: alleen met support.reply; GET', () => {
  const src = lees('api/support-alarm.js');
  assert.match(src, /staffUit\(req, res, 'support\.reply'\)/);
  assert.match(src, /verkeerdeMethode\(req, res, 'GET'\)/);
});

test('hooks: nieuwe chat en nieuw klantbericht mailen na het antwoord; cron-mail en vangnet ook', () => {
  assert.match(lees('api/support-start.js'), /inAchtergrond\(meldTeam\(\{ gesprekId: gesprek\.id \}\)\)/);
  assert.match(lees('api/support-bericht.js'), /inAchtergrond\(meldTeam\(\{ gesprekId: gesprek\.id \}\)\)/);
  assert.match(lees('api/cron-support-mail.js'), /await meldTeam\(\{ gesprekId: gesprek\.id \}\)/);
  assert.match(lees('api/cron-support-opvolging.js'), /meldTeam\(\{ gesprekId: g\.id, cfg, alleenNieuw: true \}\)/);
});

test('"Ik neem het" kan een collega het gesprek niet afpakken (voorwaardelijke update + 409)', () => {
  const src = lees('api/support-gesprek-update.js');
  assert.match(src, /alleen_als_vrij === true/);
  assert.match(src, /q\.is\('toegewezen_aan', null\)/);
  assert.match(src, /AL_OPGEPAKT/);
});

test('geen ?mod=support-links meer (de shell kent die parameter niet); oude meldingen worden omgezet', () => {
  for (const f of ['api/_lib/support-escalatie.js', 'api/cron-support-opvolging.js', 'api/cron-support-mail.js', 'api/_lib/support-actie-uitvoeren.js']) {
    assert.ok(!lees(f).includes('?mod=support'), f);
  }
  assert.match(lees('modules/klanten-v2/klanten-v2.js'), /url\.replace\('\?mod=support', '\?v2preview=support'\)/);
});

test('shell: support-alarm.js na de bannerstapel en vóór klanten-v2.js; start alleen met support.reply', () => {
  const html = lees('modules/klanten-v2/index.html');
  const stapel = html.indexOf('banner-stapel.js');
  const alarm = html.indexOf('support-alarm.js');
  const shell = html.indexOf('klanten-v2.js?v=');
  assert.ok(stapel > 0 && alarm > stapel && shell > alarm);
  const js = lees('modules/klanten-v2/klanten-v2.js');
  assert.match(js, /RBAC\.can\('support\.reply'\)/);
  assert.match(js, /startSupportAlarm\(profile\)/);
});

test('instellingen: endpoint schrijft de alarm-groep met support.config; de pagina toont de kaart', () => {
  const api = lees('api/support-instellingen.js');
  assert.match(api, /req\.body\?\.alarm/);
  assert.match(api, /valideerAlarmWijziging/);
  const ui = lees('modules/klanten-v2/views/support-v2.js');
  assert.match(ui, /kaart\('Chatmeldingen'/);
  assert.match(ui, /body\.alarm = _inst\.concept\.alarm/);
});

test('migratie: alleen additief (kolom + realtime-publicatie), met controle voor en na', () => {
  const sql = lees('docs/sql-migrations/2026-10-21-support-chat-alarm.sql');
  assert.match(sql, /add column if not exists team_gemaild_op timestamptz/);
  assert.match(sql, /alter publication supabase_realtime add table public\.support_gesprekken/);
  assert.match(sql, /Controle VOOR/);
  assert.match(sql, /Controle NA/);
  const zonderCommentaar = sql.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  assert.ok(!/\b(drop|delete|truncate)\b/i.test(zonderCommentaar));
  assert.ok(!/\bupdate\s+public\./i.test(zonderCommentaar));
});
