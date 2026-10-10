// tests/massa-mail.test.js
//
// Massa-e-mail fase 2a (2026-10-10).
//   1. puur: filters (alle combinaties, AND), plan (overslaan + ontdubbelen),
//      voorkeuren, campagne-validatie, Amsterdam-dag;
//   2. verstuurMail in massa-modus: afmeldlink (HTML + tekst), List-Unsubscribe
//      one-click, verbinding hergebruiken, draad zonder afmeldregel; fase 1
//      ongewijzigd;
//   3. maakCampagne: preview = exact aantal; start alleen bij hetzelfde aantal;
//      campagne + items (queued + skipped met reden);
//   4. verwerkWachtrij: portie, afmelding vlak voor verzending, ongeldig adres,
//      daglimiet, stille uren, pauze/annuleren, fouten, hangende claims, tellers;
//   5. bedrading: draad, endpoints (RBAC), cron, SQL (RLS), UI + cache-busters.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const mails = [];
let smtpGedrag = () => ({ ok: true, messageId: '<m@x>' });
let poolsGesloten = 0;
const categorieen = new Map();
mock.module(url('api/supabase.js'), { namedExports: { supabase: null, supabaseAdmin: null, createUserClient: () => null, verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }) } });
mock.module(url('api/_lib/send-email-core.js'), {
  namedExports: {
    sendEmailViaSmtp: async (m) => { mails.push(m); return smtpGedrag(m); },
    sluitSmtpPools: () => { poolsGesloten++; },
  },
});
mock.module(url('api/_lib/inbox-categorie.js'), {
  namedExports: { bepaalCategorieen: async (_sb, personen) => new Map(personen.map((p) => [p.sleutel, categorieen.get(p.sleutel) || { categorie: 'lead_aanmelding', tags: [] }])) },
});
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), {
  namedExports: { haalLijn: async () => ({ phoneNumberId: '1' }), mailAfzender: () => 'welkom@deforexopleiding.nl' },
});
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: { sendTemplate: async () => ({}), templateStatusOpLijn: async () => null, goedgekeurdeTemplatesOpLijn: async () => null } });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });

const M = await import(url('api/_lib/massa-mail.js'));
const L = await import(url('api/_lib/lead-bericht.js'));
const S = await import(url('api/_lib/mail-shell-lead.js'));

// ── Nep-database (genoeg van PostgREST voor deze code) ─────────────────────
function nepDb(tab) {
  let teller = 0;
  const db = { tab, inserts: [], updates: [] };
  db.from = (t) => {
    const f = []; let op = 'select'; let patch = null; let rijenIn = null; let lim = null; let sort = null;
    let head = false; let range = null; let terug = false; let enkel = null;
    const k = {
      select: (_v, o) => { if (o && o.head) head = true; if (op !== 'select') terug = true; return k; },
      eq: (c, v) => { f.push((r) => String(r[c]) === String(v)); return k; },
      neq: (c, v) => { f.push((r) => r[c] !== v); return k; },
      in: (c, v) => { f.push((r) => v.map(String).includes(String(r[c]))); return k; },
      is: (c, v) => { f.push((r) => (v === null ? r[c] == null : r[c] === v)); return k; },
      lt: (c, v) => { f.push((r) => r[c] != null && String(r[c]) < String(v)); return k; },
      gte: (c, v) => { f.push((r) => r[c] != null && String(r[c]) >= String(v)); return k; },
      ilike: (c, v) => { f.push((r) => String(r[c] || '').toLowerCase() === String(v).toLowerCase()); return k; },
      order: (c, o) => { sort = [c, o?.ascending !== false]; return k; },
      limit: (n) => { lim = n; return k; },
      range: (a, b) => { range = [a, b]; return k; },
      update: (p) => { op = 'update'; patch = p; return k; },
      delete: () => { op = 'delete'; return k; },
      insert: (r) => { op = 'insert'; rijenIn = Array.isArray(r) ? r : [r]; return k; },
      maybeSingle: () => { enkel = 'maybe'; return k; },
      single: () => { enkel = 'single'; return k; },
      then(ok, nok) {
        const rijen = tab[t] || (tab[t] = []);
        let res;
        if (op === 'insert') {
          const nieuw = [];
          for (const r of rijenIn) {
            if (t === 'lead_mail_voorkeuren' && rijen.some((x) => x.email === r.email)) { res = { data: null, error: { code: '23505', message: 'dubbel' } }; break; }
            const rij = { id: `${t}-${++teller}`, aangemaakt_op: new Date(Date.now() + teller).toISOString(), ...r };
            rijen.push(rij); nieuw.push(rij); db.inserts.push({ t, rij });
          }
          if (!res) res = { data: enkel ? nieuw[0] : nieuw, error: null };
        } else {
          let sel = rijen.filter((r) => f.every((fn) => fn(r)));
          if (op === 'update') {
            for (const r of sel) Object.assign(r, patch);
            db.updates.push({ t, patch, n: sel.length });
            res = { data: terug ? sel.map((r) => ({ ...r })) : null, error: null };
          } else if (op === 'delete') {
            tab[t] = rijen.filter((r) => !sel.includes(r));
            res = { data: sel, error: null };
          } else {
            if (sort) sel = [...sel].sort((a, b) => (String(a[sort[0]]) < String(b[sort[0]]) ? -1 : String(a[sort[0]]) > String(b[sort[0]]) ? 1 : 0) * (sort[1] ? 1 : -1));
            if (range) sel = sel.slice(range[0], range[1] + 1);
            if (lim != null) sel = sel.slice(0, lim);
            res = head ? { data: null, count: sel.length, error: null }
              : { data: enkel ? (sel[0] ? { ...sel[0] } : null) : sel.map((r) => ({ ...r })), error: null };
          }
        }
        return Promise.resolve(res).then(ok, nok);
      },
    };
    return k;
  };
  return db;
}

const NU = new Date('2026-10-10T10:00:00Z'); // 12:00 Amsterdam
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function lead(n, extra = {}) {
  return { id: id(n), voornaam: 'Lead' + n, achternaam: null, email: `lead${n}@example.com`, telefoon_e164: '+3161000000' + n, bron: '7-daagse-v2', soort: 'instagram', traject: '7-daagse', status: 'nieuw', kwalificatie: null, aangemaakt: '2026-10-0' + ((n % 9) + 1) + 'T09:00:00Z', afspraak_op: null, customer_id: null, toestemming: true, verwijderd_op: null, ...extra };
}

// ── 1. Puur ────────────────────────────────────────────────────────────────

test('normaliseerFilter: onbekend valt weg, lijsten, massa-modus', () => {
  const f = M.normaliseerFilter({ status: 'nieuw', klant: 'misschien', bron: ['a', ''], traject: '7-Daagse', van: '2026-10-01', tot: 'gisteren', massa: { modus: 'dagen', dagen: '14' }, lead_ids: [id(1), 'nep'] });
  assert.deepEqual(f.status, ['nieuw']);
  assert.equal(f.klant, '');
  assert.deepEqual(f.bron, ['a']);
  assert.deepEqual(f.traject, ['7-daagse']);
  assert.equal(f.van, '2026-10-01');
  assert.equal(f.tot, '');
  assert.deepEqual(f.massa, { modus: 'dagen', dagen: 14, campagne_id: '' });
  assert.deepEqual(f.lead_ids, [id(1)]);
});

test('leadVoldoet: elke filter, gecombineerd (AND)', () => {
  const nuMs = NU.getTime();
  const basis = { ...lead(1), categorie: 'lead_aanmelding', tags: [], is_klant: false, kennismaking: 'geen', laatst_massa_op: null, massa_campagnes: [], afgemeld: false, geldig_email: true, geldig_nummer: true };
  const ja = (f, l = basis) => M.leadVoldoet(l, M.normaliseerFilter(f), nuMs);
  assert.equal(ja({}), true);
  assert.equal(ja({ status: 'opgevolgd' }), false);
  assert.equal(ja({ klant: 'ja' }), false);
  assert.equal(ja({ klant: 'nee' }), true);
  assert.equal(ja({ kennismaking: 'geen' }), true);
  assert.equal(ja({ kennismaking: 'ooit' }), false);
  assert.equal(ja({ kennismaking: 'ingepland' }, { ...basis, kennismaking: 'ingepland' }), true);
  assert.equal(ja({ bron: '7-daagse-v1' }), false);
  assert.equal(ja({ soort: 'instagram' }), true);
  assert.equal(ja({ traject: '7-DAAGSE' }), true);
  assert.equal(ja({ categorie: 'wanbetaler' }), false);
  assert.equal(ja({ wanbetaler_onboarding: 'uitsluiten' }, { ...basis, tags: ['onboarding'] }), false);
  assert.equal(ja({ wanbetaler_onboarding: 'alleen_wanbetaler' }, { ...basis, categorie: 'wanbetaler' }), true);
  assert.equal(ja({ van: '2026-10-03' }), false, 'aangemeld 2 okt');
  assert.equal(ja({ tot: '2026-10-02' }), true);
  assert.equal(ja({ email: 'nee' }), false);
  assert.equal(ja({ nummer: 'ja' }, { ...basis, geldig_nummer: false }), false);
  assert.equal(ja({ toestemming: 'ja' }, { ...basis, toestemming: false }), false);
  assert.equal(ja({ afgemeld: 'verbergen' }, { ...basis, afgemeld: true }), false);
  assert.equal(ja({ kwalificatie: 'knock-out' }, { ...basis, kwalificatie: 'geen toegang' }), true);
  assert.equal(ja({ kwalificatie: 'geen' }), true);
  assert.equal(ja({ q: 'lead1@' }), true);
  const gehad = { ...basis, laatst_massa_op: '2026-10-05T10:00:00Z', massa_campagnes: [id(99)] };
  assert.equal(ja({ massa: { modus: 'nooit' } }, gehad), false);
  assert.equal(ja({ massa: { modus: 'dagen', dagen: 3 } }, gehad), true, '5 dagen geleden');
  assert.equal(ja({ massa: { modus: 'dagen', dagen: 7 } }, gehad), false);
  assert.equal(ja({ massa: { modus: 'campagne', campagne_id: id(99) } }, gehad), false);
  assert.equal(ja({ massa: { modus: 'alleen_gehad' } }), false);
  assert.equal(ja({ status: 'nieuw', soort: 'instagram', toestemming: 'ja', massa: { modus: 'nooit' } }), true);
  assert.equal(ja({ status: 'nieuw', soort: 'facebook' }), false, 'AND');
});

test('planCampagne: geen adres, afgemeld, voorkeur uit, dubbel adres', () => {
  const p = M.planCampagne([
    { id: 'a', email: 'a@x.nl' },
    { id: 'b', email: 'geen-adres' },
    { id: 'c', email: 'c@x.nl', afgemeld: true },
    { id: 'd', email: 'd@x.nl', voorkeuren: { events: false } },
    { id: 'e', email: 'A@X.nl' },
    { id: 'f', email: 'f@x.nl', voorkeuren: { tips: false } },
  ], 'events');
  assert.deepEqual(p.verzenden.map((l) => l.id), ['a', 'f']);
  assert.deepEqual(p.redenen, { geen_geldig_email: 1, afgemeld: 1, voorkeur_uit: 1, dubbel_email: 1 });
  assert.deepEqual(M.magOntvangen(null, 'tips'), { ok: true, reden: null });
});

test('valideerCampagne: naam, soort, kanaal, onderwerp, inhoud, variabelen, portie', () => {
  const goed = { naam: ' Oktober ', soort: 'tips', onderwerp: 'Hoi {{voornaam}}', html: '<p>Tekst</p><script>x</script>', portie: 900 };
  const v = M.valideerCampagne(goed);
  assert.equal(v.naam, 'Oktober');
  assert.equal(v.portie, 500, 'maximaal 500');
  assert.doesNotMatch(v.html, /script/);
  assert.equal(M.valideerCampagne({ ...goed, portie: undefined }).portie, 100, 'standaard 100');
  const fout = (b) => { try { M.valideerCampagne(b); return null; } catch (e) { return e.code; } };
  assert.equal(fout({ ...goed, naam: '  ' }), 'NAAM_LEEG');
  assert.equal(fout({ ...goed, soort: 'spam' }), 'SOORT_ONGELDIG');
  assert.equal(fout({ ...goed, kanaal: 'whatsapp' }), 'KANAAL_NIET_ONDERSTEUND');
  assert.equal(fout({ ...goed, onderwerp: '' }), 'ONDERWERP_LEEG');
  assert.equal(fout({ ...goed, html: '<p> </p>' }), 'BERICHT_LEEG');
  assert.equal(fout({ ...goed, html: '<p>{{korting}}</p>' }), 'ONBEKENDE_VARIABELEN');
});

test('Amsterdam: dag, uur, middernacht', () => {
  assert.equal(M.amsDag('2026-10-09T22:30:00Z'), '2026-10-10');
  assert.equal(M.amsUur(new Date('2026-10-10T19:30:00Z')), 21);
  assert.equal(M.amsDagStartIso(NU), '2026-10-09T22:00:00.000Z');
  assert.equal(M.amsDagStartIso(new Date('2026-12-10T10:00:00Z')), '2026-12-09T23:00:00.000Z');
  assert.equal(M.kennismakingVan('2026-10-11T10:00:00Z', NU.getTime()), 'ingepland');
  assert.equal(M.kennismakingVan('2026-10-01T10:00:00Z', NU.getTime()), 'gehad');
  assert.equal(M.kennismakingVan(null, NU.getTime()), 'geen');
});

// ── 2. verstuurMail massa-modus ────────────────────────────────────────────

test('verstuurMail massa: afmeldlink, List-Unsubscribe, hergebruik, draad zonder afmeldregel', async () => {
  mails.length = 0;
  const db = nepDb({});
  const r = await L.verstuurMail(db, {
    lead: { id: 'l1', voornaam: 'Robby', email: 'robby@example.com', traject: '7-daagse' },
    onderwerp: 'Hoi {{voornaam}}', html: '<p>Tekst</p>', boekingslink: null,
    massa: { voorkeurenUrl: 'https://www.deforexopleiding.nl/voorkeuren?token=T', afmeldUrl: 'https://www.deforexopleiding.nl/api/voorkeuren?token=T' },
  });
  assert.equal(r.ok, true);
  const m = mails[0];
  assert.equal(m.fromMailbox, 'welkom@deforexopleiding.nl');
  assert.equal(m.subject, 'Hoi Robby');
  assert.match(m.html, /Voorkeuren aanpassen of afmelden/);
  assert.match(m.html, /href="https:\/\/www\.deforexopleiding\.nl\/voorkeuren\?token=T"/);
  assert.match(m.text, /afmelden: https:\/\/www\.deforexopleiding\.nl\/voorkeuren\?token=T/);
  assert.deepEqual(m.headers, { 'List-Unsubscribe': '<https://www.deforexopleiding.nl/api/voorkeuren?token=T>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.equal(m.hergebruik, true);
  const er = db.tab.email_replies[0];
  assert.equal(er.from_address, 'welkom@deforexopleiding.nl');
  assert.equal(er.to_address, 'robby@example.com');
  assert.doesNotMatch(er.final_reply, /afmelden/, 'draad zonder afmeldregel');
  assert.equal(db.tab.berichten_log[0].soort, 'massa-mail');

  // Fase 1 (1-op-1) ongewijzigd: geen afmeldregel, geen headers, geen hergebruik.
  mails.length = 0;
  await L.verstuurMail(nepDb({}), { lead: { id: 'l1', voornaam: 'Robby', email: 'robby@example.com' }, onderwerp: 'X', html: '<p>Y</p>' });
  assert.doesNotMatch(mails[0].html, /afmelden/);
  assert.equal(mails[0].headers, null);
  assert.equal(mails[0].hergebruik, false);
  assert.equal(S.renderLeadMail({ bodyHtml: '<p>x</p>' }).includes('afmelden'), false);
});

// ── 3. maakCampagne ────────────────────────────────────────────────────────

function campagneDb() {
  return nepDb({
    leads: [lead(1), lead(2), lead(3, { email: 'kapot' }), lead(4, { email: 'lead1@example.com' }), lead(5, { email: 'weg@example.com' })],
    lead_mail_voorkeuren: [{ id: 'v5', email: 'weg@example.com', token: 'x'.repeat(43), afgemeld: true, voorkeuren: {} }],
    massa_items: [], massa_campagnes: [],
    onderhoud_trajecten: [{ slug: '7-daagse', agenda_link: 'https://agenda.example/7' }],
  });
}
const CAMP = { naam: 'Test oktober', soort: 'tips', onderwerp: 'Hoi {{voornaam}}', html: '<p>Plan: <a href="{{boekingslink}}">agenda</a></p>', portie: 2 };

test('maakCampagne: preview telt exact, start vraagt hetzelfde aantal, items queued + skipped', async () => {
  const db = campagneDb();
  const ids = [id(1), id(2), id(3), id(4), id(5)];
  const p = await M.maakCampagne(db, { ...CAMP, lead_ids: ids }, { nu: NU });
  assert.equal(p.aantal_verzenden, 2);
  assert.equal(p.aantal_overgeslagen, 3);
  assert.deepEqual(p.redenen, { geen_geldig_email: 1, dubbel_email: 1, afgemeld: 1 });
  assert.equal(p.voorbeeld.aan, 'lead1@example.com');
  assert.equal(p.voorbeeld.onderwerp, 'Hoi Lead1');
  assert.match(p.voorbeeld.html, /href="https:\/\/agenda\.example\/7"/);
  assert.match(p.voorbeeld.html, /Voorkeuren aanpassen of afmelden/);
  assert.equal(db.tab.massa_campagnes.length, 0, 'preview slaat niets op');

  await assert.rejects(M.maakCampagne(db, { ...CAMP, lead_ids: ids, bevestig_aantal: 3 }, { start: true, nu: NU }), (e) => e.code === 'AANTAL_GEWIJZIGD' && e.status === 409);
  const s = await M.maakCampagne(db, { ...CAMP, lead_ids: ids, bevestig_aantal: 2 }, { start: true, userId: 'u1', nu: NU });
  assert.ok(s.campagne_id);
  const c = db.tab.massa_campagnes[0];
  assert.equal(c.status, 'wachtrij');
  assert.equal(c.aantal, 2);
  assert.equal(c.portie, 2);
  assert.equal(c.aangemaakt_door, 'u1');
  assert.deepEqual(db.tab.massa_items.map((i) => [i.lead_id, i.status, i.reden || null]), [
    [id(1), 'queued', null], [id(2), 'queued', null],
    [id(3), 'skipped', 'geen_geldig_email'], [id(4), 'skipped', 'dubbel_email'], [id(5), 'skipped', 'afgemeld'],
  ]);
  await assert.rejects(M.maakCampagne(db, { ...CAMP, naam: '' , lead_ids: ids }), (e) => e.code === 'NAAM_LEEG');
  await assert.rejects(M.maakCampagne(db, { ...CAMP, lead_ids: [] }), (e) => e.code === 'GEEN_SELECTIE');
});

// ── 4. verwerkWachtrij ─────────────────────────────────────────────────────

function wachtrijDb({ n = 5, portie = 2, status = 'wachtrij', extraItems = [], instellingen = null } = {}) {
  const leads = Array.from({ length: n }, (_, i) => lead(i + 1));
  return nepDb({
    leads,
    lead_mail_voorkeuren: [],
    onderhoud_trajecten: [{ slug: '7-daagse', agenda_link: 'https://agenda.example/7' }],
    app_settings: instellingen ? [{ key: 'massa_mail', value: instellingen }] : [],
    massa_campagnes: [{ id: id(900), naam: 'C', soort: 'tips', onderwerp: 'Hoi {{voornaam}}', html: '<p>Hallo</p>', portie, status, aangemaakt_door: 'u1', gestart_op: null, aangemaakt_op: '2026-10-10T08:00:00Z' }],
    massa_items: [
      ...leads.map((l, i) => ({ id: 'it' + (i + 1), campagne_id: id(900), lead_id: l.id, status: 'queued', aangemaakt_op: '2026-10-10T08:00:0' + i + 'Z' })),
      ...extraItems,
    ],
  });
}
const geenSlaap = async () => {};

test('wachtrij: één portie per run, rest blijft in de wachtrij, draad + tellers', async () => {
  mails.length = 0; poolsGesloten = 0; smtpGedrag = () => ({ ok: true, messageId: '<m@x>' });
  const db = wachtrijDb({ n: 5, portie: 2 });
  const r = await M.verwerkWachtrij(db, { slaap: geenSlaap, nu: () => NU });
  assert.equal(r.verstuurd, 2);
  assert.equal(mails.length, 2, 'niet alles tegelijk');
  assert.deepEqual(db.tab.massa_items.map((i) => i.status), ['sent', 'sent', 'queued', 'queued', 'queued']);
  assert.equal(db.tab.email_replies.length, 2, 'in de draad');
  assert.match(mails[0].html, /voorkeuren\?token=/);
  assert.equal(db.tab.lead_mail_voorkeuren.length, 2, 'token per adres aangemaakt');
  const c = db.tab.massa_campagnes[0];
  assert.equal(c.status, 'bezig');
  assert.equal(c.aantal_verstuurd, 2);
  assert.equal(poolsGesloten, 1, 'SMTP-verbinding gesloten');
  // Volgende runs: 2 + 1, daarna klaar.
  await M.verwerkWachtrij(db, { slaap: geenSlaap, nu: () => NU });
  await M.verwerkWachtrij(db, { slaap: geenSlaap, nu: () => NU });
  assert.equal(mails.length, 5);
  assert.equal(db.tab.massa_campagnes[0].status, 'klaar');
  assert.ok(db.tab.massa_campagnes[0].klaar_op);
});

test('wachtrij: afmelding vlak voor verzending, ongeldig adres, verwijderde lead → skipped', async () => {
  mails.length = 0;
  const db = wachtrijDb({ n: 4, portie: 10 });
  db.tab.lead_mail_voorkeuren.push({ id: 'v', email: 'lead1@example.com', token: 't'.repeat(43), afgemeld: true, voorkeuren: {} });
  db.tab.lead_mail_voorkeuren.push({ id: 'w', email: 'lead2@example.com', token: 'u'.repeat(43), afgemeld: false, voorkeuren: { tips: false } });
  db.tab.leads[2].email = 'kapot';
  db.tab.leads[3].verwijderd_op = '2026-10-10T09:00:00Z';
  const r = await M.verwerkWachtrij(db, { slaap: geenSlaap, nu: () => NU });
  assert.equal(r.verstuurd, 0);
  assert.equal(mails.length, 0);
  assert.deepEqual(db.tab.massa_items.map((i) => [i.status, i.reden]), [['skipped', 'afgemeld'], ['skipped', 'voorkeur_uit'], ['skipped', 'geen_geldig_email'], ['skipped', 'lead_verwijderd']]);
  assert.equal(db.tab.massa_campagnes[0].status, 'klaar');
});

test('wachtrij: daglimiet, stille uren, gepauzeerd, fout → failed', async () => {
  mails.length = 0;
  // Daglimiet 1, er ging vandaag al 1 uit → niets.
  const vol = wachtrijDb({ n: 2, instellingen: { dag_max: 1 }, extraItems: [{ id: 'oud', campagne_id: id(901), lead_id: id(50), status: 'sent', verzonden_op: '2026-10-10T07:00:00Z' }] });
  assert.equal((await M.verwerkWachtrij(vol, { slaap: geenSlaap, nu: () => NU })).reden, 'daglimiet');
  assert.equal(mails.length, 0);
  // Daglimiet 2 → max 1 extra in deze run, ook al is de portie groter.
  const half = wachtrijDb({ n: 3, portie: 10, instellingen: { dag_max: 2 }, extraItems: [{ id: 'oud', campagne_id: id(901), lead_id: id(50), status: 'sent', verzonden_op: '2026-10-10T07:00:00Z' }] });
  assert.equal((await M.verwerkWachtrij(half, { slaap: geenSlaap, nu: () => NU })).verstuurd, 1);
  // Stille uren (22:30 NL): cron doet niets, handmatig wel.
  mails.length = 0;
  const nacht = () => new Date('2026-10-10T20:30:00Z');
  assert.equal((await M.verwerkWachtrij(wachtrijDb({ n: 1 }), { slaap: geenSlaap, nu: nacht })).reden, 'stille_uren');
  assert.equal((await M.verwerkWachtrij(wachtrijDb({ n: 1 }), { slaap: geenSlaap, nu: nacht, handmatig: true })).verstuurd, 1);
  // Gepauzeerd → niet opgepakt.
  mails.length = 0;
  assert.equal((await M.verwerkWachtrij(wachtrijDb({ n: 1, status: 'gepauzeerd' }), { slaap: geenSlaap, nu: () => NU })).verstuurd, 0);
  assert.equal(mails.length, 0);
  // SMTP-fout → failed met foutmelding, de rest gaat door.
  smtpGedrag = (m) => (m.to === 'lead1@example.com' ? { ok: false, reason: 'mailbox vol', code: 'SMTP_SEND_FAIL' } : { ok: true, messageId: '<m@x>' });
  const fout = wachtrijDb({ n: 2, portie: 10 });
  const r = await M.verwerkWachtrij(fout, { slaap: geenSlaap, nu: () => NU });
  assert.equal(r.mislukt, 1);
  assert.equal(r.verstuurd, 1);
  assert.equal(fout.tab.massa_items[0].status, 'failed');
  assert.match(fout.tab.massa_items[0].fout, /mailbox vol/);
  smtpGedrag = () => ({ ok: true, messageId: '<m@x>' });
});

test('wachtrij: pauze tussen mails, hangende claim → failed (niet dubbel versturen)', async () => {
  mails.length = 0;
  const pauzes = [];
  const db = wachtrijDb({ n: 3, portie: 10, instellingen: { pauze_ms: 1200 }, extraItems: [
    { id: 'hangt', campagne_id: id(900), lead_id: id(1), status: 'sending', geclaimd_op: '2026-10-10T09:00:00Z', aangemaakt_op: '2026-10-10T07:00:00Z' },
  ] });
  await M.verwerkWachtrij(db, { slaap: async (ms) => { pauzes.push(ms); }, nu: () => NU });
  assert.deepEqual(pauzes, [1200, 1200], 'pauze tussen mails, niet vóór de eerste');
  const hangt = db.tab.massa_items.find((i) => i.id === 'hangt');
  assert.equal(hangt.status, 'failed');
  assert.match(hangt.fout, /onderbroken/);
});

test('zoekSegment: verrijking (categorie, geschiedenis, afgemeld) + filter + opties', async () => {
  categorieen.set(id(2), { categorie: 'wanbetaler', tags: [] });
  const db = nepDb({
    leads: [lead(1), lead(2), lead(3, { verwijderd_op: '2026-10-01T00:00:00Z' }), lead(4, { afspraak_op: '2026-10-20T10:00:00Z' })],
    massa_items: [{ lead_id: id(1), campagne_id: id(900), status: 'sent', verzonden_op: '2026-10-08T10:00:00Z' }],
    lead_mail_voorkeuren: [{ email: 'lead4@example.com', afgemeld: true, voorkeuren: {} }],
  });
  const alle = await M.zoekSegment(db, {}, { nu: NU });
  assert.deepEqual(alle.items.map((l) => l.id).sort(), [id(1), id(2), id(4)], 'verwijderde lead niet');
  const l1 = alle.items.find((l) => l.id === id(1));
  assert.equal(l1.laatst_massa_op, '2026-10-08T10:00:00Z');
  assert.equal(alle.items.find((l) => l.id === id(4)).kennismaking, 'ingepland');
  assert.equal(alle.items.find((l) => l.id === id(4)).afgemeld, true);
  assert.deepEqual(alle.opties.traject, ['7-daagse']);
  const zonder = await M.zoekSegment(db, { wanbetaler_onboarding: 'uitsluiten', afgemeld: 'verbergen', massa: { modus: 'nooit' } }, { nu: NU });
  assert.deepEqual(zonder.items.map((l) => l.id), [], 'wanbetaler, afgemeld en al-gemaild vallen weg');
  categorieen.clear();
});

// ── 5. Bedrading ───────────────────────────────────────────────────────────

test('bedrading: draad, endpoints, cron, SQL, UI, cache-busters', () => {
  assert.match(lees('api/leadsonderhoud-gesprek-berichten.js'), /\.neq\('soort', 'massa-mail'\)/);
  const sel = lees('api/massa-selectie.js');
  assert.match(sel, /requirePermission\(req, 'leads\.update'\)/);
  const camp = lees('api/massa-campagne.js');
  assert.match(camp, /requirePermission\(req, 'leads\.view'\)/);
  assert.match(camp, /requirePermission\(req, 'leads\.update'\)/);
  assert.match(camp, /verwerkWachtrij\(supabaseAdmin, \{ campagneId: id, handmatig: true/);
  assert.match(lees('api/cron-massa-mail.js'), /checkCronAuth\(req\)/);
  const vercel = JSON.parse(lees('vercel.json'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron-massa-mail' && c.schedule === '*/15 * * * *'));
  assert.equal(vercel.functions['api/cron-massa-mail.js'].maxDuration, 300);
  const sql = lees('docs/sql-migrations/2026-10-10-massa-mail-fase2a.sql');
  for (const t of ['massa_campagnes', 'massa_items', 'lead_mail_voorkeuren']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${t}`));
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
    assert.match(sql, new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM anon, authenticated`));
  }
  assert.doesNotMatch(sql, /CREATE POLICY/, 'geen policies: alleen de service role');
  assert.match(sql, /status IN \('queued', 'sending', 'sent', 'failed', 'skipped'\)/);
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /<script src="views\/_massa-bericht\.js\?v=1"><\/script>/);
  assert.ok(html.indexOf('views/_massa-bericht.js') < html.indexOf('views/leads-v2.js'), 'popup vóór de views');
  const versie = (re) => Number((html.match(re) || [])[1] || 0);
  assert.ok(versie(/views\/leads-v2\.js\?v=(\d+)"/) >= 30);
  assert.ok(versie(/views\/leadsonderhoud-v2\.js\?v=(\d+)"/) >= 70);
  const leads = lees('modules/klanten-v2/views/leads-v2.js');
  assert.match(leads, /window\.MassaBericht\.open\(\{/);
  assert.match(leads, /__leadSelAlles/);
  assert.match(leads, /filter: handmatig \? \{\} : massaFilterVanLijst\(\),/, 'vinkjes zonder lijstfilters');
  assert.match(lees('modules/klanten-v2/views/leadsonderhoud-v2.js'), /filter: handmatig \? \{\} : \{ q:/);
  assert.match(leads, /Laatst massabericht/);
  const ls = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(ls, /window\.__lsMassa\(\)/);
  assert.match(ls, /__lsSelRij/);
});
