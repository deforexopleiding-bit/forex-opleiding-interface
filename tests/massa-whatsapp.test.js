// tests/massa-whatsapp.test.js
//
// Massabericht fase 2b (2026-10-11): WhatsApp + "beide" op de motor van 2a.
//   1. puur: planWhatsApp (geen nummer / dubbel nummer), {{1}}/{{2}}-waarden,
//      valideerCampagne voor whatsapp/beide;
//   2. guard + templatelijst: alleen lijn 1273723375834177 / WABA 2579784712469452,
//      alleen MARKETING, lead-templates, max 2 variabelen;
//   3. maakCampagne "beide": items per kanaal, aantallen per kanaal, voorbeelden;
//   4. worker: WhatsApp via de fase-1 verzending (sendTemplate + logOutboundWa +
//      berichten_log 'massa-whatsapp'), eigen portie/daglimiet, guard faalt →
//      niets verstuurd, template ingetrokken → terug in de wachtrij; "beide" in
//      één run; geschiedenis telt WhatsApp mee;
//   5. popup (jsdom): kanaal WhatsApp/Beide, template, {{2}}, live voorbeeld,
//      controle per kanaal; bedrading + SQL + cache-busters.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const NUMMER = '1273723375834177';
const WABA = '2579784712469452';
const TPL = { name: 'massa_heropenen', language: 'nl', category: 'MARKETING', body: 'Hoi {{1}}! 👋\n\nBij De Forex Opleiding hebben we iets nieuws voor je: {{2}}. We denken dat dit goed bij je past.\n\nWil je dat ik je de details stuur?', aantal_vars: 2, header_format: null, header_heeft_var: false, footer: null, knoppen: [{ type: 'QUICK_REPLY', text: 'Ja, vertel me meer' }, { type: 'QUICK_REPLY', text: 'Nu even niet' }] };
const omgeving = {
  lijn: NUMMER,
  live: () => ({ ok: true, waba_id: WABA, nummer: NUMMER, templates: [
    TPL,
    { ...TPL, name: 'followup_2_druk', category: 'UTILITY', aantal_vars: 1, body: 'Hey {{1}}' },
    { ...TPL, name: 'aanmaning_dag7', category: 'MARKETING' },
    { ...TPL, name: 'massa_drie_vars', body: '{{1}} {{2}} {{3}}', aantal_vars: 3 },
    { ...TPL, name: 'agenda_doorsturen_v1', aantal_vars: 1, body: 'Hoi {{1}}' },
    { ...TPL, name: 'met_foto', header_format: 'IMAGE' },
  ] }),
};
const verzonden = { wa: [], waLog: [], mails: [] };
mock.module(url('api/supabase.js'), { namedExports: { supabase: null, supabaseAdmin: null, createUserClient: () => null, verifyAdmin: async () => null, checkCronAuth: () => ({ ok: true }) } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async (m) => { verzonden.mails.push(m); return { ok: true, messageId: '<m@x>' }; }, sluitSmtpPools: () => {} } });
mock.module(url('api/_lib/inbox-categorie.js'), { namedExports: { bepaalCategorieen: async (_sb, p) => new Map(p.map((x) => [x.sleutel, { categorie: 'lead_aanmelding', tags: [] }])) } });
mock.module(url('api/_lib/leadsonderhoud-gesprekken.js'), { namedExports: { haalLijn: async () => ({ phoneNumberId: omgeving.lijn }), mailAfzender: () => 'welkom@deforexopleiding.nl' } });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
  sendTemplate: async (a) => { verzonden.wa.push(a); return { wamid: 'wamid.' + verzonden.wa.length }; },
  templateStatusOpLijn: async () => 'PAUSED',
  goedgekeurdeTemplatesOpLijn: async () => omgeving.live(),
} });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async (_sb, a) => { verzonden.waLog.push(a); return { ok: true, conv_id: 'conv-1', message_id: 'm-1' }; } } });

const M = await import(url('api/_lib/massa-mail.js'));

// ── Nep-database (zelfde als tests/massa-mail.test.js) ─────────────────────
function nepDb(tab) {
  let teller = 0;
  const db = { tab };
  db.from = (t) => {
    const f = []; let op = 'select'; let patch = null; let rijenIn = null; let lim = null; let sort = null; let head = false; let terug = false; let enkel = null; let range = null;
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
          for (const r of rijenIn) { const rij = { id: `${t}-${++teller}`, aangemaakt_op: new Date(Date.now() + teller).toISOString(), ...r }; rijen.push(rij); nieuw.push(rij); }
          res = { data: enkel ? nieuw[0] : nieuw, error: null };
        } else {
          let sel = rijen.filter((r) => f.every((fn) => fn(r)));
          if (op === 'update') { for (const r of sel) Object.assign(r, patch); res = { data: terug ? sel.map((r) => ({ ...r })) : null, error: null }; }
          else if (op === 'delete') { tab[t] = rijen.filter((r) => !sel.includes(r)); res = { data: sel, error: null }; }
          else {
            if (sort) sel = [...sel].sort((a, b) => (String(a[sort[0]]) < String(b[sort[0]]) ? -1 : String(a[sort[0]]) > String(b[sort[0]]) ? 1 : 0) * (sort[1] ? 1 : -1));
            if (range) sel = sel.slice(range[0], range[1] + 1);
            if (lim != null) sel = sel.slice(0, lim);
            res = head ? { data: null, count: sel.length, error: null } : { data: enkel ? (sel[0] ? { ...sel[0] } : null) : sel.map((r) => ({ ...r })), error: null };
          }
        }
        return Promise.resolve(res).then(ok, nok);
      },
    };
    return k;
  };
  return db;
}
const NU = new Date('2026-10-11T10:00:00Z'); // 12:00 NL
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lead = (n, extra = {}) => ({ id: id(n), voornaam: 'Lead' + n, achternaam: null, email: `lead${n}@example.com`, telefoon_e164: '+3161000000' + n, bron: 'x', soort: 'y', traject: '7-daagse', status: 'nieuw', kwalificatie: null, aangemaakt: '2026-10-01T09:00:00Z', afspraak_op: null, customer_id: null, toestemming: true, verwijderd_op: null, ...extra });
const CAMP = { naam: 'Okt', kanaal: 'whatsapp', wa_template: 'massa_heropenen', wa_taal: 'nl', wa_param2: 'een gratis live webinar over onze strategie' };

// ── 1. Puur ────────────────────────────────────────────────────────────────

test('planWhatsApp + waarden + valideerCampagne', () => {
  const p = M.planWhatsApp([{ id: 'a', telefoon_e164: '+31612345678' }, { id: 'b', telefoon_e164: null }, { id: 'c', telefoon_e164: '0612' }, { id: 'd', telefoon_e164: '+31612345678' }]);
  assert.deepEqual(p.verzenden.map((l) => l.id), ['a']);
  assert.deepEqual(p.redenen, { geen_geldig_nummer: 2, dubbel_nummer: 1 });
  assert.deepEqual(M.waWaardenVoor({ voornaam: 'Robby van Dijk' }, 'webinar', 2), ['Robby', 'webinar']);
  assert.deepEqual(M.waWaardenVoor({ voornaam: '' }, 'webinar', 2), ['daar', 'webinar'], 'Meta weigert een lege parameter');
  assert.deepEqual(M.waWaardenVoor({ voornaam: 'A' }, 'x', 1), ['A']);
  assert.equal(M.telWaVars(TPL.body), 2);
  const v = M.valideerCampagne(CAMP);
  assert.equal(v.kanaal, 'whatsapp');
  assert.equal(v.soort, null, 'geen soort/onderwerp nodig voor alleen WhatsApp');
  assert.deepEqual(v.wa, { template: 'massa_heropenen', taal: 'nl', param2: 'een gratis live webinar over onze strategie' });
  const fout = (b) => { try { M.valideerCampagne(b); return null; } catch (e) { return e.code; } };
  assert.equal(fout({ ...CAMP, wa_template: '' }), 'WA_TEMPLATE_LEEG');
  assert.equal(fout({ ...CAMP, wa_param2: 'regel1\nregel2' }), 'WA_PARAM_ONGELDIG');
  assert.equal(fout({ ...CAMP, kanaal: 'beide' }), 'SOORT_ONGELDIG', 'beide vraagt ook de e-mailvelden');
  assert.equal(M.valideerCampagne({ ...CAMP, kanaal: 'beide', soort: 'tips', onderwerp: 'Hoi', html: '<p>x</p>' }).kanaal, 'beide');
  assert.deepEqual(M.itemKanalen('beide'), ['email', 'whatsapp']);
});

// ── 2. Guard + lijst ───────────────────────────────────────────────────────

test('massaWaTemplates: guard op lijn en WABA, alleen MARKETING lead-templates', async () => {
  const r = await M.massaWaTemplates();
  assert.equal(r.ok, true);
  assert.deepEqual(r.templates.map((t) => [t.name, t.bruikbaar]), [['massa_heropenen', true], ['massa_drie_vars', false]], 'UTILITY, aanmaning, media-kop en niet-massa_-namen (agenda) eruit; 3 variabelen niet bruikbaar');
  omgeving.lijn = '999';
  assert.equal((await M.massaWaTemplates()).reden, 'VERKEERDE_LIJN');
  omgeving.lijn = NUMMER;
  const echt = omgeving.live;
  omgeving.live = () => ({ ...echt(), waba_id: '1407819217160812' });
  assert.equal((await M.massaWaTemplates()).reden, 'VERKEERDE_WABA');
  omgeving.live = () => ({ ok: false });
  assert.equal((await M.massaWaTemplates()).reden, 'TEMPLATES_ONBEKEND');
  omgeving.live = echt;
});

// ── 3. maakCampagne ────────────────────────────────────────────────────────

function campDb() {
  return nepDb({
    leads: [
      lead(1),                                              // mail + nummer
      lead(2, { telefoon_e164: null }),                     // alleen mail
      lead(3, { email: null }),                             // alleen nummer
      lead(4, { telefoon_e164: '+31610000001' }),           // zelfde nummer als lead 1
    ],
    lead_mail_voorkeuren: [], massa_items: [], massa_campagnes: [], onderhoud_trajecten: [], app_settings: [],
  });
}
const IDS = [id(1), id(2), id(3), id(4)];

test('maakCampagne "beide": per lead de juiste items, aantallen per kanaal, voorbeelden', async () => {
  const db = campDb();
  const b = { ...CAMP, kanaal: 'beide', soort: 'tips', onderwerp: 'Hoi {{voornaam}}', html: '<p>Tekst</p>', lead_ids: IDS };
  const p = await M.maakCampagne(db, b, { nu: NU });
  assert.deepEqual(p.per_kanaal.email, { verzenden: 3, overgeslagen: 1, redenen: { geen_geldig_email: 1 } });
  assert.deepEqual(p.per_kanaal.whatsapp, { verzenden: 2, overgeslagen: 2, redenen: { geen_geldig_nummer: 1, dubbel_nummer: 1 } });
  assert.equal(p.aantal_verzenden, 5);
  assert.equal(p.wa_portie, 20, 'rustige standaard');
  assert.equal(p.voorbeeld_wa.tekst.startsWith('Hoi Lead1! 👋'), true);
  assert.match(p.voorbeeld_wa.tekst, /iets nieuws voor je: een gratis live webinar over onze strategie\./);
  assert.deepEqual(p.voorbeeld_wa.knoppen.map((k) => k.text), ['Ja, vertel me meer', 'Nu even niet']);
  assert.ok(p.voorbeeld.html, 'mailvoorbeeld ook');
  await assert.rejects(M.maakCampagne(db, { ...b, bevestig_aantal: 4 }, { start: true, nu: NU }), (e) => e.code === 'AANTAL_GEWIJZIGD');
  const s = await M.maakCampagne(db, { ...b, bevestig_aantal: 5 }, { start: true, userId: 'u1', nu: NU });
  const c = db.tab.massa_campagnes[0];
  assert.equal(s.campagne_id, c.id);
  assert.equal(c.kanaal, 'beide');
  assert.equal(c.wa_template, 'massa_heropenen');
  assert.equal(c.wa_param2, 'een gratis live webinar over onze strategie');
  assert.equal(c.wa_body, TPL.body);
  const items = db.tab.massa_items.map((i) => `${i.lead_id.slice(-1)}:${i.kanaal}:${i.status}${i.reden ? ':' + i.reden : ''}`).sort();
  assert.deepEqual(items, ['1:email:queued', '1:whatsapp:queued', '2:email:queued', '2:whatsapp:skipped:geen_geldig_nummer', '3:email:skipped:geen_geldig_email', '3:whatsapp:queued', '4:email:queued', '4:whatsapp:skipped:dubbel_nummer']);
});

test('maakCampagne WhatsApp: template-checks, {{2}} verplicht, e-mail-only ongewijzigd (geen wa-kolommen)', async () => {
  const db = campDb();
  await assert.rejects(M.maakCampagne(db, { ...CAMP, wa_template: 'followup_2_druk', lead_ids: IDS }), (e) => e.code === 'WA_TEMPLATE_ONBEKEND', 'UTILITY mag niet voor massa');
  await assert.rejects(M.maakCampagne(db, { ...CAMP, wa_template: 'massa_drie_vars', lead_ids: IDS }), (e) => e.code === 'WA_TEMPLATE_TE_VEEL_VARS');
  await assert.rejects(M.maakCampagne(db, { ...CAMP, wa_template: 'agenda_doorsturen_v1', lead_ids: IDS }), (e) => e.code === 'WA_TEMPLATE_ONBEKEND', 'MARKETING maar geen massa_-template');
  await assert.rejects(M.maakCampagne(db, { ...CAMP, wa_param2: '', lead_ids: IDS }), (e) => e.code === 'WA_PARAM_LEEG');
  omgeving.lijn = '999';
  await assert.rejects(M.maakCampagne(db, { ...CAMP, lead_ids: IDS }), (e) => e.code === 'WA_GUARD' && e.status === 503);
  omgeving.lijn = NUMMER;
  await M.maakCampagne(db, { naam: 'Mail', soort: 'tips', onderwerp: 'X', html: '<p>Y</p>', lead_ids: IDS, bevestig_aantal: 3 }, { start: true, nu: NU });
  const c = db.tab.massa_campagnes[0];
  assert.equal(c.kanaal, 'email');
  assert.ok(!Object.keys(c).some((k) => k.startsWith('wa_')), 'e-mail-only noemt de 2b-kolommen niet');
  assert.ok(db.tab.massa_items.every((i) => i.kanaal === 'email'));
});

// ── 4. Worker ──────────────────────────────────────────────────────────────

function werkDb({ kanaal = 'whatsapp', n = 3, waInst = null, extra = [] } = {}) {
  const leads = Array.from({ length: n }, (_, i) => lead(i + 1));
  const items = [];
  leads.forEach((l, i) => {
    for (const k of M.itemKanalen(kanaal)) items.push({ id: `${k}-${i + 1}`, campagne_id: id(900), lead_id: l.id, kanaal: k, status: 'queued', aangemaakt_op: `2026-10-11T08:00:0${i}Z` });
  });
  return nepDb({
    leads, lead_mail_voorkeuren: [], onderhoud_trajecten: [], berichten_log: [],
    app_settings: waInst ? [{ key: 'massa_whatsapp', value: waInst }] : [],
    massa_campagnes: [{ id: id(900), naam: 'C', kanaal, soort: kanaal === 'whatsapp' ? null : 'tips', onderwerp: kanaal === 'whatsapp' ? null : 'Hoi', html: kanaal === 'whatsapp' ? null : '<p>x</p>', portie: 100, status: 'wachtrij', aangemaakt_door: 'u1', wa_template: 'massa_heropenen', wa_taal: 'nl', wa_param2: 'een webinar', wa_body: TPL.body, aangemaakt_op: '2026-10-11T07:00:00Z' }],
    massa_items: [...items, ...extra],
  });
}
const geenSlaap = async () => {};

test('worker WhatsApp: fase-1 verzending, draad, berichten_log, porties, pauze', async () => {
  verzonden.wa.length = 0; verzonden.waLog.length = 0;
  const pauzes = [];
  const db = werkDb({ n: 3, waInst: { portie: 2, pauze_ms: 2500 } });
  const r = await M.verwerkWachtrij(db, { slaap: async (ms) => pauzes.push(ms), nu: () => NU });
  assert.equal(r.verstuurd, 2, 'WA-portie uit app_settings');
  assert.deepEqual(pauzes, [2500]);
  assert.deepEqual(verzonden.wa[0], { to: '31610000001', templateName: 'massa_heropenen', languageCode: 'nl', variables: ['Lead1', 'een webinar'], phoneNumberId: NUMMER });
  assert.equal(verzonden.waLog[0].source, 'massa', 'in de draad via logOutboundWa');
  assert.match(verzonden.waLog[0].body, /^Hoi Lead1! 👋/);
  assert.deepEqual(db.tab.berichten_log.map((b) => [b.soort, b.kanaal, b.agent]), [['massa-whatsapp', 'whatsapp', 'massa'], ['massa-whatsapp', 'whatsapp', 'massa']]);
  assert.deepEqual(db.tab.massa_items.map((i) => i.status), ['sent', 'sent', 'queued']);
  assert.equal(db.tab.massa_items[0].extern_id, 'wamid.1');
  await M.verwerkWachtrij(db, { slaap: geenSlaap, nu: () => NU });
  assert.equal(db.tab.massa_campagnes[0].status, 'klaar');
});

test('worker WhatsApp: guard faalt → niets verstuurd, alles blijft in de wachtrij', async () => {
  verzonden.wa.length = 0;
  omgeving.lijn = '758003047390806';
  const db = werkDb({ n: 2 });
  const r = await M.verwerkWachtrij(db, { slaap: geenSlaap, nu: () => NU });
  omgeving.lijn = NUMMER;
  assert.equal(r.reden, 'wa_guard');
  assert.equal(verzonden.wa.length, 0);
  assert.ok(db.tab.massa_items.every((i) => i.status === 'queued'));
});

test('worker WhatsApp: geen nummer → skipped, template ingetrokken → terug in de wachtrij', async () => {
  verzonden.wa.length = 0;
  const db = werkDb({ n: 2 });
  db.tab.leads[0].telefoon_e164 = null;
  const echt = omgeving.live;
  omgeving.live = () => ({ ...echt(), templates: echt().templates.filter((t) => t.name !== 'massa_heropenen') });
  const r = await M.verwerkWachtrij(db, { slaap: geenSlaap, nu: () => NU, waGuard: async () => ({ ok: true }) });
  omgeving.live = echt;
  assert.deepEqual(db.tab.massa_items.map((i) => [i.status, i.reden || null]), [['skipped', 'geen_geldig_nummer'], ['queued', null]]);
  assert.equal(r.reden, 'wa_template_niet_goedgekeurd');
  assert.equal(verzonden.wa.length, 0);
});

test('worker "beide": e-mail en WhatsApp in één run, elk met eigen daglimiet; stille uren', async () => {
  verzonden.wa.length = 0; verzonden.mails.length = 0;
  const db = werkDb({ kanaal: 'beide', n: 2, waInst: { dag_max: 1 } });
  const r = await M.verwerkWachtrij(db, { slaap: geenSlaap, nu: () => NU });
  assert.equal(verzonden.mails.length, 2);
  assert.equal(verzonden.wa.length, 1, 'WA-daglimiet 1');
  assert.equal(r.per_kanaal.whatsapp.dag_resterend, 0);
  const st = Object.fromEntries(db.tab.massa_items.map((i) => [i.id, i.status]));
  assert.deepEqual(st, { 'email-1': 'sent', 'whatsapp-1': 'sent', 'email-2': 'sent', 'whatsapp-2': 'queued' });
  // Stille uren: cron niets, handmatig wel.
  const nacht = () => new Date('2026-10-11T20:30:00Z');
  assert.equal((await M.verwerkWachtrij(werkDb({ n: 1 }), { slaap: geenSlaap, nu: nacht })).reden, 'stille_uren');
  assert.equal((await M.verwerkWachtrij(werkDb({ n: 1 }), { slaap: geenSlaap, nu: nacht, handmatig: true })).verstuurd, 1);
});

test('geschiedenis telt WhatsApp mee (filter "al massabericht gehad")', async () => {
  const db = nepDb({
    leads: [lead(1), lead(2)],
    massa_items: [{ lead_id: id(1), campagne_id: id(900), kanaal: 'whatsapp', status: 'sent', verzonden_op: '2026-10-10T10:00:00Z' }],
    lead_mail_voorkeuren: [],
  });
  const s = await M.zoekSegment(db, { massa: { modus: 'nooit' } }, { nu: NU });
  assert.deepEqual(s.items.map((l) => l.id), [id(2)]);
});

// ── 5. Popup + bedrading ───────────────────────────────────────────────────

test('popup: kanaal WhatsApp → template, {{2}}, live voorbeeld, controle per kanaal', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const verzoeken = [];
  w.KV = {
    toast: () => {},
    authedFetch: async (u, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      verzoeken.push({ url: u, body });
      let j = {};
      if (u === '/api/massa-selectie') j = { items: [{ id: 'a', naam: 'Anna de Vries', voornaam: 'Anna', email: 'a@x.nl', geldig_email: true, toestemming: true }, { id: 'b', naam: 'Bas', voornaam: 'Bas', email: 'b@x.nl', geldig_email: true, toestemming: true }], opties: { bron: [], soort: [], traject: [] }, campagnes: [] };
      else if (u === '/api/lead-mail-sjablonen') j = { sjablonen: [] };
      else if (u === '/api/massa-campagne?wa_templates=1') j = { ok: true, waba_id: WABA, wa_portie: 20, wa_dag_max: 100, templates: [{ name: 'massa_heropenen', language: 'nl', body: TPL.body, knoppen: TPL.knoppen, aantal_vars: 2, bruikbaar: true }] };
      else if (u === '/api/massa-campagne' && body.actie === 'preview') j = { ok: true, kanaal: 'whatsapp', aantal_geselecteerd: 2, aantal_verzenden: 2, aantal_overgeslagen: 0, per_kanaal: { whatsapp: { verzenden: 2, overgeslagen: 0, redenen: {} } }, redenen: {}, portie: 100, wa_portie: 20, voorbeeld: null, voorbeeld_wa: { template: 'massa_heropenen', tekst: 'Hoi Anna! 👋', knoppen: TPL.knoppen } };
      return { ok: true, status: 200, json: async () => j };
    },
  };
  w.document.execCommand = () => true;
  w.eval(lees('modules/klanten-v2/views/_massa-bericht.js'));
  const wacht = () => new Promise((ok) => setTimeout(ok, 0));
  const $ = (s) => w.document.querySelector(s);
  const klik = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const zet = (s, v, type = 'input') => { const el = $(s); el.value = v; el.dispatchEvent(new w.Event(type, { bubbles: true })); };
  w.MassaBericht.open({ filter: {}, leadIds: [] });
  await wacht(); await wacht();
  klik($('[data-mb-actie="naar-bericht"]'));
  await wacht(); await wacht();
  const radio = $('[data-mb-b="kanaal"][value="whatsapp"]');
  radio.checked = true; radio.dispatchEvent(new w.Event('change', { bubbles: true }));
  await wacht(); await wacht(); await wacht();
  assert.ok(verzoeken.some((v) => v.url === '/api/massa-campagne?wa_templates=1'));
  assert.equal($('[data-mb-b="wa_template"]').value, 'massa_heropenen|nl', 'de enige bruikbare template staat al klaar');
  assert.equal($('[data-mb-b="soort"]'), null, 'geen e-mailvelden bij alleen WhatsApp');
  assert.match($('[data-mb-wapreview]').textContent, /^Hoi Anna! 👋/);
  assert.match(w.document.body.textContent, /Ja, vertel me meer/);
  zet('[data-mb-b="naam"]', 'Okt WA');
  assert.ok($('[data-mb-actie="naar-controle"]').disabled, '{{2}} nog leeg');
  zet('[data-mb-b="wa_param2"]', 'een gratis live webinar');
  assert.match($('[data-mb-wapreview]').textContent, /iets nieuws voor je: een gratis live webinar\./, 'live voorbeeld');
  assert.equal($('[data-mb-actie="naar-controle"]').disabled, false);
  klik($('[data-mb-actie="naar-controle"]'));
  await wacht(); await wacht();
  const pv = verzoeken.find((v) => v.body && v.body.actie === 'preview').body;
  assert.equal(pv.kanaal, 'whatsapp');
  assert.equal(pv.wa_template, 'massa_heropenen');
  assert.equal(pv.wa_taal, 'nl');
  assert.equal(pv.wa_param2, 'een gratis live webinar');
  assert.equal(pv.onderwerp, undefined, 'geen e-mailvelden mee');
  assert.match($('[data-mb-perkanaal]').textContent, /2 WhatsApps/);
  assert.match($('[data-mb-actie="start"]').textContent, /2 berichten in de wachtrij/);
  // Beide: e-mailvelden komen erbij.
  klik($('[data-mb-actie="naar-bericht-terug"]'));
  const beide = $('[data-mb-b="kanaal"][value="beide"]');
  beide.checked = true; beide.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.ok($('[data-mb-b="soort"]') && $('[data-mb-b="wa_template"]'), 'beide = mail én WhatsApp invullen');
  assert.equal(w.MassaBericht._intern.waVoorbeeld('Hoi {{1}}, {{2}}', '', ''), 'Hoi daar, {{2}}');
});

test('bedrading: SQL, endpoint, guard-constanten, cache-busters', () => {
  const sql = lees('docs/sql-migrations/2026-10-11-massa-whatsapp-fase2b.sql');
  assert.match(sql, /CHECK \(kanaal IN \('email', 'whatsapp', 'beide'\)\)/);
  assert.match(sql, /massa_items_kanaal_check CHECK \(kanaal IN \('email', 'whatsapp'\)\)/);
  assert.match(sql, /UNIQUE \(campagne_id, lead_id, kanaal\)/);
  assert.match(sql, /ALTER COLUMN onderwerp DROP NOT NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS wa_param2 text/);
  assert.doesNotMatch(sql, /\bDO \$\$/);
  assert.equal(M.MASSA_WA_NUMMER, NUMMER);
  assert.equal(M.MASSA_WA_WABA, WABA);
  const camp = lees('api/massa-campagne.js');
  assert.match(camp, /req\.query\?\.wa_templates/);
  assert.match(camp, /requirePermission\(req, 'leads\.update'\)/);
  const html = lees('modules/klanten-v2/index.html');
  assert.ok(Number((html.match(/views\/_massa-bericht\.js\?v=(\d+)"/) || [])[1]) >= 2);
  assert.ok(Number((html.match(/views\/leads-v2\.js\?v=(\d+)"/) || [])[1]) >= 32);
  assert.match(lees('api/_lib/lead-bericht.js'), /soort = 'handmatig-template'/, 'fase 1 houdt zijn soort');
});
