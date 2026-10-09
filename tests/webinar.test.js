// tests/webinar.test.js
//
// Webinar fase 1 (2026-10-09): planning, aanmelden, berichten, overslaan.
//   1. tijd: NL 19:00 → UTC, DST-correct; komende maandagen;
//   2. momenten: vensters + "alleen wie zich vóór het moment aanmeldde";
//   3. templates: parametervolgorde, script-integratie (code-terugval, UTILITY);
//   4. validatie van het publieke endpoint en het beheer;
//   5. integratie met een nep-database: aanmelden (idempotent, bevestiging 1×),
//      cron (reminders 1×, overgeslagen week niets), overslaan (doorschuiven +
//      nieuwe bevestiging), WhatsApp alleen bij een APPROVED template.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── Mocks vóór de import van de lib ─────────────────────────────────────────
const verzonden = { mails: [], wa: [], waLog: [] };
let templateStatus = 'APPROVED';
mock.module(url('api/supabase.js'), { namedExports: { supabase: null, supabaseAdmin: null, checkCronAuth: () => ({ ok: true }), createUserClient: () => null, verifyAdmin: async () => null } });
mock.module(url('api/_lib/meta-whatsapp.js'), {
  namedExports: {
    sendTemplate: async (a) => { verzonden.wa.push(a); return { wamid: 'wamid-' + verzonden.wa.length }; },
    templateStatusOpLijn: async () => templateStatus,
  },
});
mock.module(url('api/_lib/send-email-core.js'), {
  namedExports: { sendEmailViaSmtp: async (m) => { verzonden.mails.push(m); return { ok: true }; } },
});
mock.module(url('api/_lib/wa-outbound-log.js'), {
  namedExports: { logOutboundWa: async (_sb, a) => { verzonden.waLog.push(a); return { ok: true }; } },
});

const W = await import(url('api/_lib/webinar.js'));
const T = await import(url('api/_lib/webinar-templates.js'));
const { valideer } = await import(url('api/public-webinar-aanmelding.js'));
const { normZoom, valideerReeks } = await import(url('api/webinar-admin.js'));
const S = await import(url('scripts/360-templates-upload.mjs'));

function reset() { verzonden.mails.length = 0; verzonden.wa.length = 0; verzonden.waLog.length = 0; templateStatus = 'APPROVED'; }

// ── 1. Tijd ──────────────────────────────────────────────────────────────────
test('nlNaarUtc: 19:00 NL = 17:00Z in de zomer, 18:00Z in de winter (rond beide klokwissels)', () => {
  assert.equal(W.nlNaarUtc('2026-03-23', '19:00').toISOString(), '2026-03-23T18:00:00.000Z'); // winter
  assert.equal(W.nlNaarUtc('2026-03-30', '19:00').toISOString(), '2026-03-30T17:00:00.000Z'); // na 29 mrt: zomer
  assert.equal(W.nlNaarUtc('2026-10-19', '19:00').toISOString(), '2026-10-19T17:00:00.000Z'); // zomer
  assert.equal(W.nlNaarUtc('2026-10-26', '19:00').toISOString(), '2026-10-26T18:00:00.000Z'); // na 25 okt: winter
});

test('komendeData: maandagen vanaf vandaag (NL-datum), ook als het in UTC nog zondag is', () => {
  // Zondag 11 okt 23:30 NL = 21:30Z → eerste maandag 12 okt.
  assert.deepEqual(W.komendeData(1, 3, new Date('2026-10-11T21:30:00Z')), ['2026-10-12', '2026-10-19', '2026-10-26']);
  // Maandag 12 okt 00:30 NL (= zondag 22:30Z): vandaag telt mee.
  assert.deepEqual(W.komendeData(1, 2, new Date('2026-10-11T22:30:00Z')), ['2026-10-12', '2026-10-19']);
  // Dinsdag → volgende maandag.
  assert.deepEqual(W.komendeData(1, 1, new Date('2026-10-13T10:00:00Z')), ['2026-10-19']);
  assert.equal(W.datumLang('2026-10-12T17:00:00Z'), 'maandag 12 oktober');
  assert.equal(W.tijdNL('2026-10-26T18:00:00Z'), '19:00');
});

// ── 2. Momenten ──────────────────────────────────────────────────────────────
test('momenten: vensters en late aanmelders', () => {
  const start = '2026-10-12T17:00:00Z';
  const [dag, uur, live] = W.MOMENTEN;
  const op = (iso) => new Date(iso);
  const vroeg = '2026-10-01T10:00:00Z';
  // dag: vanaf 24u vooraf tot 3u vooraf
  assert.equal(W.momentIsAanDeBeurt(dag, { startsAt: start, aangemeldOp: vroeg, nu: op('2026-10-11T16:59:00Z') }), false);
  assert.equal(W.momentIsAanDeBeurt(dag, { startsAt: start, aangemeldOp: vroeg, nu: op('2026-10-11T17:00:00Z') }), true);
  assert.equal(W.momentIsAanDeBeurt(dag, { startsAt: start, aangemeldOp: vroeg, nu: op('2026-10-12T14:00:00Z') }), false);
  // uur: 60 → 5 min vooraf
  assert.equal(W.momentIsAanDeBeurt(uur, { startsAt: start, aangemeldOp: vroeg, nu: op('2026-10-12T16:00:00Z') }), true);
  assert.equal(W.momentIsAanDeBeurt(uur, { startsAt: start, aangemeldOp: vroeg, nu: op('2026-10-12T16:56:00Z') }), false);
  // live: start → +20 min
  assert.equal(W.momentIsAanDeBeurt(live, { startsAt: start, aangemeldOp: vroeg, nu: op('2026-10-12T17:00:00Z') }), true);
  assert.equal(W.momentIsAanDeBeurt(live, { startsAt: start, aangemeldOp: vroeg, nu: op('2026-10-12T17:20:00Z') }), false);
  // Wie zich pas zondagavond 20:00 NL aanmeldt, krijgt geen "dag ervoor" (net bevestigd).
  assert.equal(W.momentIsAanDeBeurt(dag, { startsAt: start, aangemeldOp: '2026-10-11T18:00:00Z', nu: op('2026-10-11T18:05:00Z') }), false);
  // Wie zich om 18:30 NL aanmeldt, krijgt geen "uur ervoor" maar wel "live".
  assert.equal(W.momentIsAanDeBeurt(uur, { startsAt: start, aangemeldOp: '2026-10-12T16:30:00Z', nu: op('2026-10-12T16:35:00Z') }), false);
  assert.equal(W.momentIsAanDeBeurt(live, { startsAt: start, aangemeldOp: '2026-10-12T16:30:00Z', nu: op('2026-10-12T17:01:00Z') }), true);
});

test('context: Zoom van de week gaat voor de reeks; zonder link een nette tekst', () => {
  const sessie = { starts_at: '2026-10-12T17:00:00Z', ends_at: '2026-10-12T18:00:00Z', zoom_url: null };
  const c1 = W.bouwContext({ aanmelding: { voornaam: 'Thomas' }, sessie, reeks: { zoom_url: 'https://zoom.us/j/1' } });
  assert.equal(c1.zoom, 'https://zoom.us/j/1');
  assert.equal(c1.datum, 'maandag 12 oktober');
  assert.equal(c1.eind, '20:00');
  const c2 = W.bouwContext({ aanmelding: { voornaam: '' }, sessie: { ...sessie, zoom_url: 'https://zoom.us/j/2' }, reeks: { zoom_url: 'https://zoom.us/j/1' } });
  assert.equal(c2.zoom, 'https://zoom.us/j/2');
  assert.equal(c2.voornaam, 'daar');
  const c3 = W.bouwContext({ aanmelding: {}, sessie, reeks: {} });
  assert.equal(c3.zoom, 'volgt vóór de start');
  assert.equal(c3.zoomUrl, null);
});

// ── 3. Templates + script ────────────────────────────────────────────────────
test('templates: vier UTILITY-templates, parameters in de juiste volgorde', () => {
  assert.deepEqual([...T.WEBINAR_TEMPLATE_NAMEN], ['webinar_bevestiging', 'webinar_reminder_dag', 'webinar_reminder_uur', 'webinar_live']);
  const ctx = { voornaam: 'Thomas', datum: 'maandag 12 oktober', tijd: '19:00', zoom: 'https://zoom.us/j/1' };
  assert.deepEqual(T.templateVariabelen('webinar_bevestiging', ctx), ['Thomas', 'maandag 12 oktober', '19:00', 'https://zoom.us/j/1']);
  assert.deepEqual(T.templateVariabelen('webinar_reminder_uur', ctx), ['Thomas', '19:00', 'https://zoom.us/j/1']);
  assert.deepEqual(T.templateVariabelen('webinar_live', ctx), ['Thomas', 'https://zoom.us/j/1']);
  assert.match(T.renderTemplateTekst('webinar_live', ctx), /^Hoi Thomas, we zijn live!/);
  for (const t of Object.values(T.WEBINAR_TEMPLATES)) {
    const n = (t.body_text.match(/\{\{\d+\}\}/g) || []).length;
    assert.equal(n, t.vars.length, t.name);
    assert.equal(Object.keys(t.body_examples).length, n, t.name + ' voorbeelden');
    assert.equal(t.category, 'UTILITY');
  }
});

test('script: webinar in de vaste lijst, code-terugval zonder DB-rij, categorie UTILITY', () => {
  assert.deepEqual([...S.VASTE_TEMPLATES.webinar], [...T.WEBINAR_TEMPLATE_NAMEN]);
  const r = S.variantenVoor('webinar_live', undefined);
  assert.equal(r.uitCode, true);
  assert.equal(r.varianten[0].body_text, T.WEBINAR_TEMPLATES.webinar_live.body_text);
  assert.equal(S.variantenVoor('webinar_live', [{ name: 'webinar_live', body_text: 'db' }]).uitCode, false, 'DB-rij gaat voor');
  assert.deepEqual(S.variantenVoor('bestaat_niet', undefined), { varianten: [], uitCode: false });
  for (const naam of T.WEBINAR_TEMPLATE_NAMEN) {
    const c = S.kiesCategorie({ naam, bronnen: ['vast:webinar', 'code'], body: T.WEBINAR_TEMPLATES[naam].body_text });
    assert.equal(c.categorie, 'UTILITY', naam);
  }
  const { payload } = S.bouwPayload(T.WEBINAR_TEMPLATES.webinar_bevestiging, 'UTILITY');
  assert.deepEqual(payload.components.find((c) => c.type === 'BODY').example.body_text[0],
    ['Jeffrey', 'maandag 13 oktober', '19:00', 'https://us02web.zoom.us/j/12345678901']);
});

// ── 4. Validatie ─────────────────────────────────────────────────────────────
test('public endpoint: validatie', () => {
  const goed = { voornaam: ' Thomas ', email: 'T@Gmail.com', telefoon: '+32470000090', bron: 'webinar-v1', lead_id: '6b5eecd3-0000-4000-8000-000000000000', toestemming: true };
  assert.deepEqual(valideer(goed).waarden, { voornaam: 'Thomas', email: 't@gmail.com', telefoon: '+32470000090', bron: 'webinar-v1', leadId: '6b5eecd3-0000-4000-8000-000000000000', toestemming: true });
  assert.equal(valideer({ ...goed, bron: '7-daagse-v3' }).ok, false);
  assert.equal(valideer({ ...goed, email: 'geen' }).ok, false);
  assert.equal(valideer({ ...goed, voornaam: '' }).ok, false);
  assert.equal(valideer({ ...goed, telefoon: '0612345678' }).ok, false, 'E.164 verplicht');
  assert.equal(valideer({ ...goed, telefoon: '' }).waarden.telefoon, null);
  assert.equal(valideer({ ...goed, lead_id: 'x' }).waarden.leadId, null);
});

test('beheer: Zoom-link en reeks-velden', () => {
  assert.deepEqual(normZoom(''), { ok: true, waarde: null });
  assert.equal(normZoom('http://zoom.us/j/1').ok, false);
  assert.equal(normZoom('zoom.us/j/1').ok, false);
  assert.equal(normZoom(' https://us02web.zoom.us/j/123?pwd=abc ').waarde, 'https://us02web.zoom.us/j/123?pwd=abc');
  assert.deepEqual(valideerReeks({ starttijd: '19:30', duur_min: 60, actief: false }).patch, { starttijd: '19:30', duur_min: 60, actief: false });
  assert.equal(valideerReeks({ starttijd: '7pm' }).ok, false);
  assert.equal(valideerReeks({ duur_min: 5 }).ok, false);
  assert.equal(valideerReeks({}).ok, false);
});

// ── 5. Integratie met een nep-database ───────────────────────────────────────
function nepDb() {
  const tab = { webinar_reeksen: [], webinar_sessies: [], webinar_aanmeldingen: [], leads: [], whatsapp_module_config: [] };
  let seq = 0;
  const id = () => 'id-' + (++seq);
  const waarde = (rij, kol) => (kol.includes('.') ? kol.split('.').reduce((o, k) => (o ? o[k] : undefined), rij) : rij[kol]);
  function bouwer(t) {
    const f = []; let sort = null; let lim = null; let op = 'select'; let data = null; let opts = null; let kolommen = '*';
    const k = {
      select: (c) => { kolommen = c || '*'; return k; },
      eq: (c, v) => { f.push((r) => waarde(r, c) === v); return k; },
      is: (c, v) => { f.push((r) => (waarde(r, c) ?? null) === v); return k; },
      gt: (c, v) => { f.push((r) => String(waarde(r, c)) > v); return k; },
      gte: (c, v) => { f.push((r) => String(waarde(r, c)) >= v); return k; },
      lte: (c, v) => { f.push((r) => String(waarde(r, c)) <= v); return k; },
      ilike: (c, v) => { f.push((r) => String(waarde(r, c) || '').toLowerCase() === String(v).toLowerCase()); return k; },
      order: (c, o) => { sort = [c, o?.ascending !== false]; return k; },
      limit: (n) => { lim = n; return k; },
      insert: (r) => { op = 'insert'; data = r; return k; },
      update: (p) => { op = 'update'; data = p; return k; },
      upsert: (r, o) => { op = 'upsert'; data = r; opts = o; return k; },
      delete: () => { op = 'delete'; return k; },
      maybeSingle: () => k.then((r) => ({ data: r.error ? null : (r.data || [])[0] || null, error: r.error })),
      single: () => k.then((r) => ({ data: r.error ? null : (r.data || [])[0] || null, error: r.error })),
      then(ok, nok) {
        const rijen = tab[t];
        let res;
        const verrijk = (r) => (kolommen.includes('webinar_sessies!inner') ? { ...r, webinar_sessies: tab.webinar_sessies.find((s) => s.id === r.sessie_id) } : { ...r });
        if (op === 'insert') {
          const nieuw = { id: id(), aangemeld_op: new Date().toISOString(), bevestiging_op: null, reminder_dag_op: null, reminder_uur_op: null, live_op: null, berichten: {}, is_test: false, verplaatst_van_sessie_id: null, ...data };
          if (t === 'webinar_aanmeldingen' && rijen.some((r) => r.sessie_id === nieuw.sessie_id && r.email.toLowerCase() === nieuw.email.toLowerCase())) {
            res = { data: null, error: { code: '23505', message: 'duplicate' } };
          } else { rijen.push(nieuw); res = { data: [{ ...nieuw }], error: null }; }
        } else if (op === 'upsert') {
          const toegevoegd = [];
          for (const r of data) {
            const sleutels = opts.onConflict.split(',');
            if (rijen.some((x) => sleutels.every((s) => x[s] === r[s]))) continue;
            const n = { id: id(), zoom_url: null, ...r }; rijen.push(n); toegevoegd.push({ id: n.id });
          }
          res = { data: toegevoegd, error: null };
        } else {
          let m = rijen.map(verrijk).filter((r) => f.every((fn) => fn(r)));
          if (op === 'update') {
            for (const r of m) Object.assign(rijen.find((x) => x.id === r.id), data);
            m = m.map((r) => ({ ...rijen.find((x) => x.id === r.id) }));
          } else if (op === 'delete') {
            for (const r of m) rijen.splice(rijen.findIndex((x) => x.id === r.id), 1);
          }
          if (sort) m.sort((a, b) => (String(a[sort[0]]) < String(b[sort[0]]) ? -1 : 1) * (sort[1] ? 1 : -1));
          if (lim != null) m = m.slice(0, lim);
          res = { data: m, error: null };
        }
        return Promise.resolve(res).then(ok, nok);
      },
    };
    return k;
  }
  return { tab, from: (t) => bouwer(t) };
}

function nieuweDb({ zoom = 'https://zoom.us/j/vast' } = {}) {
  const db = nepDb();
  db.tab.webinar_reeksen.push({ id: 'reeks-1', slug: 'maandag', titel: 'Gratis webinar De Forex Opleiding', weekdag: 1, starttijd: '19:00:00', duur_min: 60, zoom_url: zoom, actief: true });
  db.tab.whatsapp_module_config.push({ module: 'events', is_active: true, phone_number_id: '1273723375834177' });
  return db;
}
const DONDERDAG = new Date('2026-10-08T10:00:00Z');   // do 8 okt → volgende webinar ma 12 okt 19:00 NL (17:00Z)

test('aanmelden: eerstvolgende maandag, bevestiging per mail + WA, idempotent', async () => {
  reset();
  const db = nieuweDb();
  const r = await W.meldAan(db, { voornaam: 'Thomas', email: 'Thomas@Example.com', telefoon: '+32470000090', bron: 'webinar-v1', toestemming: true, nu: DONDERDAG });
  assert.equal(r.sessie.datum, '2026-10-12');
  assert.equal(r.sessie.starts_at, '2026-10-12T17:00:00.000Z');
  assert.equal(r.alAangemeld, false);
  assert.equal(db.tab.webinar_sessies.length, W.AANTAL_WEKEN_VOORUIT, 'komende 6 weken gepland');
  assert.equal(verzonden.mails.length, 1);
  assert.equal(verzonden.mails[0].fromMailbox, 'events@deforexopleiding.nl');
  assert.equal(verzonden.mails[0].to, 'thomas@example.com');
  assert.match(verzonden.mails[0].subject, /maandag 12 oktober/);
  assert.match(verzonden.mails[0].html, /https:\/\/zoom\.us\/j\/vast/);
  assert.equal(verzonden.wa.length, 1);
  assert.deepEqual(verzonden.wa[0], { to: '32470000090', templateName: 'webinar_bevestiging', variables: ['Thomas', 'maandag 12 oktober', '19:00', 'https://zoom.us/j/vast'], phoneNumberId: '1273723375834177' });
  assert.equal(verzonden.waLog[0].source, 'webinar');
  const rij = db.tab.webinar_aanmeldingen[0];
  assert.ok(rij.bevestiging_op);
  assert.equal(rij.berichten.bevestiging.mail.ok, true);
  assert.equal(rij.berichten.bevestiging.wa.ok, true);

  const r2 = await W.meldAan(db, { voornaam: 'Thomas', email: 'thomas@example.com', telefoon: '+32470000090', bron: 'webinar-v2', nu: DONDERDAG });
  assert.equal(r2.alAangemeld, true);
  assert.equal(db.tab.webinar_aanmeldingen.length, 1);
  assert.equal(verzonden.mails.length, 1, 'geen tweede bevestiging');
});

test('template nog niet goedgekeurd: alleen de mail, reden vastgelegd', async () => {
  reset();
  templateStatus = 'PENDING';
  const db = nieuweDb();
  await W.meldAan(db, { voornaam: 'Vincent', email: 'v@example.com', telefoon: '+31600000077', bron: 'webinar-v2', nu: DONDERDAG });
  assert.equal(verzonden.mails.length, 1);
  assert.equal(verzonden.wa.length, 0);
  assert.equal(db.tab.webinar_aanmeldingen[0].berichten.bevestiging.wa.overgeslagen, 'template_pending');
});

test('cron: reminders op het juiste moment, elk precies één keer', async () => {
  reset();
  const db = nieuweDb();
  await W.meldAan(db, { voornaam: 'Thomas', email: 't@example.com', telefoon: '+32470000090', bron: 'webinar-v1', nu: DONDERDAG });
  db.tab.webinar_aanmeldingen[0].aangemeld_op = DONDERDAG.toISOString();
  reset();
  const ronde = (iso) => W.cronRonde(db, { nu: new Date(iso), wachtMs: 0 });
  assert.equal((await ronde('2026-10-11T12:00:00Z')).dag, 0, 'zondag 14:00 NL: nog te vroeg');
  assert.equal((await ronde('2026-10-11T17:01:00Z')).dag, 1, 'zondag 19:01 NL: dag ervoor');
  assert.equal((await ronde('2026-10-11T17:06:00Z')).dag, 0, 'niet dubbel');
  assert.equal((await ronde('2026-10-12T16:01:00Z')).uur, 1, 'maandag 18:01 NL: uur ervoor');
  assert.equal((await ronde('2026-10-12T17:01:00Z')).live, 1, '19:01: live');
  assert.equal((await ronde('2026-10-12T17:05:00Z')).live, 0);
  assert.deepEqual(verzonden.wa.map((w) => w.templateName), ['webinar_reminder_dag', 'webinar_reminder_uur', 'webinar_live']);
  assert.deepEqual(verzonden.wa[1].variables, ['Thomas', '19:00', 'https://zoom.us/j/vast']);
  assert.equal(verzonden.mails.length, 3);
});

test('overslaan: aanmelders schuiven door, nieuwe bevestiging via de cron, de overgeslagen week krijgt niets', async () => {
  reset();
  const db = nieuweDb();
  await W.meldAan(db, { voornaam: 'Thomas', email: 't@example.com', telefoon: '+32470000090', bron: 'webinar-v1', nu: DONDERDAG });
  await W.meldAan(db, { voornaam: 'Vincent', email: 'v@example.com', telefoon: '+31600000077', bron: 'webinar-v2', nu: DONDERDAG });
  const week12 = db.tab.webinar_sessies.find((s) => s.datum === '2026-10-12');
  const week19 = db.tab.webinar_sessies.find((s) => s.datum === '2026-10-19');
  // Vincent stond óók al op de 19e → die dubbele vervalt.
  db.tab.webinar_aanmeldingen.push({ id: 'al-19', sessie_id: week19.id, email: 'v@example.com', voornaam: 'Vincent', aangemeld_op: DONDERDAG.toISOString(), bevestiging_op: DONDERDAG.toISOString(), reminder_dag_op: null, reminder_uur_op: null, live_op: null, berichten: {}, is_test: false });
  reset();

  const r = await W.slaSessieOver(db, { sessieId: week12.id, notitie: 'Karl afwezig', nu: DONDERDAG });
  assert.equal(r.verplaatst, 1);
  assert.equal(r.vervallen, 1);
  assert.equal(r.doel.id, week19.id);
  assert.equal(week12.status, 'overgeslagen');
  const thomas = db.tab.webinar_aanmeldingen.find((a) => a.email === 't@example.com');
  assert.equal(thomas.sessie_id, week19.id);
  assert.equal(thomas.verplaatst_van_sessie_id, week12.id);
  assert.equal(thomas.bevestiging_op, null);

  const uit = await W.cronRonde(db, { nu: new Date('2026-10-08T10:01:00Z'), wachtMs: 0 });
  assert.equal(uit.bevestiging, 1, 'nieuwe bevestiging voor de doorgeschoven aanmelder');
  assert.match(verzonden.mails[0].subject, /verplaatst naar maandag 19 oktober/);
  assert.deepEqual(verzonden.wa[0].variables.slice(1, 3), ['maandag 19 oktober', '19:00']);

  // Op 12 okt zelf: geen enkele reminder (week is overgeslagen).
  reset();
  for (const iso of ['2026-10-11T17:01:00Z', '2026-10-12T16:01:00Z', '2026-10-12T17:01:00Z']) {
    const u = await W.cronRonde(db, { nu: new Date(iso), wachtMs: 0 });
    assert.equal(u.dag + u.uur + u.live, 0, iso);
  }
  // Nieuwe aanmelders zien 12 okt niet meer.
  const n = await W.meldAan(db, { voornaam: 'Mlak', email: 'm@example.com', telefoon: null, bron: 'webinar-v1', nu: DONDERDAG });
  assert.equal(n.sessie.datum, '2026-10-19');
});

test('geen actieve reeks of alles overgeslagen → geenSessie', async () => {
  const db = nieuweDb();
  db.tab.webinar_reeksen[0].actief = false;
  assert.deepEqual(await W.meldAan(db, { voornaam: 'X', email: 'x@example.com', bron: 'webinar-v1', nu: DONDERDAG }), { geenSessie: true });
});

test('bedrading: cron elke minuut, tab geregistreerd, bronlijsten, cache-busters, SQL', () => {
  const vercel = JSON.parse(lees('vercel.json'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron-webinar' && c.schedule === '* * * * *'));
  assert.match(lees('modules/shared/design-system/app-shell.js'), /tabs: \['Overzicht', 'Inbox', 'Inschrijvingen', 'Webinar', 'Statistieken'\]/);
  assert.match(lees('modules/klanten-v2/views/webinar-v2.js'), /window\.DFO\.VIEWS\['events\/Webinar'\] = webinarView;/);
  const html = lees('modules/klanten-v2/index.html');
  assert.match(html, /<script src="views\/webinar-v2\.js\?v=1"><\/script>/);
  for (const [f, v] of [['leads-v2.js', 28], ['funnel-dashboard-v2.js', 3], ['leadsonderhoud-v2.js', 66]]) {
    assert.match(html, new RegExp(`views/${f.replace('.', '\\.')}\\?v=${v}"`), f);
  }
  for (const f of ['api/_lib/funnel-stats-compute.js', 'modules/klanten-v2/views/leadsonderhoud-v2.js', 'modules/klanten-v2/views/leads-v2.js', 'modules/leads.html']) {
    const src = lees(f);
    assert.match(src, /webinar-v1/, f);
    assert.match(src, /webinar-v2/, f);
  }
  assert.match(lees('modules/klanten-v2/views/funnel-dashboard-v2.js'), /\{ groep: 'webinar'/);
  const sql = lees('docs/sql-migrations/2026-10-09-webinar-fase1.sql');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.webinar_aanmeldingen/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /CREATE OR REPLACE VIEW public\.website_webinar_volgende AS\s+SELECT s\.id, r\.titel, s\.starts_at, s\.ends_at/);
  assert.doesNotMatch(sql.split('CREATE OR REPLACE VIEW')[1].split(';')[0], /zoom/i, 'view bevat geen Zoom-link');
});

test('templates: geen body begint of eindigt op een variabele (Meta: "Invalid parameter")', () => {
  for (const t of Object.values(T.WEBINAR_TEMPLATES)) {
    const body = t.body_text.trim();
    assert.doesNotMatch(body, /^\{\{\d+\}\}/, t.name + ' begint met een variabele');
    assert.doesNotMatch(body, /\{\{\d+\}\}[.!?]?$/, t.name + ' eindigt op een variabele');
  }
});
