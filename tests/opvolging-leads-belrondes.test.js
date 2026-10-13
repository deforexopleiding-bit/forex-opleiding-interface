// tests/opvolging-leads-belrondes.test.js
//
// Leads bellen — belrondes, de Belrij, de uitkomst na een call en het logboek.
// Het probleem dat dit oplost: wie niet opnam stond meteen weer bovenaan in
// Bezig, en de verse leads in Nieuw kregen geen belletje.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  belRondes, volgendeRondeMs, belPlan, momentInZone, dagInZone, dagPlusN, stelPottenSamen,
  belrijSectie, activatieMs, logErbij, MAX_RONDES, BELRIJ_SECTIES, RONDE_PAUZE, START_UUR,
  potVoorKaart, momentTekst,
} from '../api/_lib/opvolging-leads-pot.js';
import { beslisCorrectie } from '../api/_lib/opvolging-leads-uitkomst.js';
import { bouwLogboek } from '../api/_lib/opvolging-leads-logboek.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-leads-v2.js'), 'utf8');

// Dinsdag 13 oktober 2026, 10:00 Amsterdam (zomertijd, UTC+2).
const NU = Date.parse('2026-10-13T08:00:00Z');
const VANDAAG = dagInZone(NU);
const call = (iso, resultaat = 'niet opgenomen', extra = {}) => ({ soort: 'call', richting: 'uit', resultaat, tijdstip: iso, ...extra });
const min = (n) => new Date(NU - n * 60000).toISOString();

// ═══════════════════════════════════════════════════════════════════════════
// RONDES
// ═══════════════════════════════════════════════════════════════════════════

test('twee keer kort na elkaar bellen is één ronde; afgebroken telt niet', () => {
  const r = belRondes([
    call(min(300)), call(min(299)),              // ronde 1: dubbel bellen
    call(min(60)),                               // ronde 2
    call(min(10), 'afgebroken voor opnemen'),     // geen poging
    { soort: 'call', richting: 'in', tijdstip: min(5) },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].calls, 2);
});

test('momentInZone klopt in zomer- én wintertijd', () => {
  assert.equal(new Date(momentInZone('2026-10-13', 9)).toISOString(), '2026-10-13T07:00:00.000Z');
  assert.equal(new Date(momentInZone('2026-11-10', 9)).toISOString(), '2026-11-10T08:00:00.000Z');
  assert.equal(new Date(momentInZone('2026-10-25', 0)).toISOString(), '2026-10-24T22:00:00.000Z');
});

test('cadans: 3u, morgen 09:00, +2d, +3d; ronde 1 na 17u schuift naar morgenochtend', () => {
  const eind = NU;   // 10:00
  assert.equal(volgendeRondeMs(eind, 1), NU + 3 * 3600000);
  assert.equal(volgendeRondeMs(eind, 2), momentInZone(dagPlusN(VANDAAG, 1), START_UUR));
  assert.equal(volgendeRondeMs(eind, 3), momentInZone(dagPlusN(VANDAAG, 2), START_UUR));
  assert.equal(volgendeRondeMs(eind, 4), momentInZone(dagPlusN(VANDAAG, 3), START_UUR));
  const laat = momentInZone(VANDAAG, 18);
  assert.equal(volgendeRondeMs(laat, 1), momentInZone(dagPlusN(VANDAAG, 1), START_UUR));
  assert.equal(RONDE_PAUZE.length, MAX_RONDES - 1);
});

test('belPlan: net geprobeerd = niet aan de beurt; zonder poging wel', () => {
  const k = { id: 'k', status: 'open', due: VANDAAG };
  const net = belPlan({ kaart: k, pogingen: [call(min(20))], nuMs: NU });
  assert.equal(net.rondes, 1);
  assert.equal(net.klaar, false);
  assert.equal(net.volgende_at, new Date(NU - 20 * 60000 + 3 * 3600000).toISOString());
  assert.equal(belPlan({ kaart: k, pogingen: [], nuMs: NU }).klaar, true);
  assert.equal(belPlan({ kaart: k, pogingen: [call(min(200))], nuMs: NU }).klaar, true);
});

test('belPlan: een antwoord na de laatste poging maakt hem meteen warm', () => {
  const k = { id: 'k', status: 'open', due: VANDAAG };
  const p = belPlan({ kaart: k, nuMs: NU, pogingen: [
    call(min(30)), { soort: 'whatsapp', richting: 'in', tijdstip: min(5) },
  ] });
  assert.equal(p.reageerde, true);
  assert.equal(p.klaar, true);
  // statusregels (afgeleverd/gelezen) zijn geen nieuwe poging van ons
  const q = belPlan({ kaart: k, nuMs: NU, pogingen: [
    call(min(30)), { soort: 'whatsapp', richting: 'in', tijdstip: min(10) },
    { soort: 'whatsapp', richting: 'uit', resultaat: 'WhatsApp gelezen', tijdstip: min(5) },
  ] });
  assert.equal(q.reageerde, true);
});

test('belPlan: handmatig moment ná de laatste ronde telt, het latere wint', () => {
  const k = { id: 'k', status: 'open', due: VANDAAG, volgende_poging_at: new Date(NU + 8 * 3600000).toISOString() };
  const p = belPlan({ kaart: k, pogingen: [call(min(20))], nuMs: NU });
  assert.equal(p.handmatig, true);
  assert.equal(p.volgende_at, k.volgende_poging_at);
  // een oud handmatig moment (vóór de laatste call) telt niet meer
  const oud = { ...k, volgende_poging_at: min(60) };
  assert.equal(belPlan({ kaart: oud, pogingen: [call(min(20))], nuMs: NU }).handmatig, false);
});

test('belPlan: uitgebeld na ' + MAX_RONDES + ' rondes', () => {
  const pog = [0, 1, 2, 3, 4].map((d) => call(new Date(NU - (5 - d) * 86400000).toISOString()));
  const p = belPlan({ kaart: { status: 'open', due: VANDAAG }, pogingen: pog, nuMs: NU });
  assert.equal(p.rondes, 5);
  assert.equal(p.uitgebeld, true);
});

test('belPlan: uitkomst_open zolang er na de call van vandaag niets aangeklikt werd', () => {
  const k = { status: 'open', due: VANDAAG, uitkomst_log: [] };
  assert.equal(belPlan({ kaart: k, pogingen: [call(min(5))], nuMs: NU }).uitkomst_open, true);
  const k2 = { ...k, uitkomst_log: [{ op: min(2), soort: 'geen_gehoor' }] };
  assert.equal(belPlan({ kaart: k2, pogingen: [call(min(5))], nuMs: NU }).uitkomst_open, false);
  // een doorgestuurde agenda na de call is ook een vervolgstap
  assert.equal(belPlan({ kaart: k, pogingen: [call(min(5)), { soort: 'agenda_doorgestuurd', tijdstip: min(1) }], nuMs: NU }).uitkomst_open, false);
});

test('terugbelafspraak: rondes tellen pas vanaf de afgesproken dag', () => {
  const k = { status: 'open', due: VANDAAG, reden_code: 'terugbellen',
    uitkomst_log: logErbij({}, { soort: 'terugbel', due: VANDAAG }).map((e) => ({ ...e, op: min(3 * 1440) })) };
  assert.equal(activatieMs(k), momentInZone(VANDAAG, 0));
  const p = belPlan({ kaart: k, pogingen: [call(min(3 * 1440 + 10))], nuMs: NU });
  assert.equal(p.rondes, 0, 'de call van vóór de afspraak telt niet');
  assert.equal(p.klaar, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BELRIJ
// ═══════════════════════════════════════════════════════════════════════════

const lead = (id, o = {}) => ({
  id, voornaam: 'L' + id, achternaam: 'X', email: id + '@x.be', telefoon_e164: '+3247' + String(id).padStart(7, '0').replace(/\D/g, '1'),
  traject: 'minicursus', bron: 'kennismakingscursus-v2', aangemaakt: new Date(NU - 86400000).toISOString(), ...o,
});

test('Belrij: volgorde reageerde → terugbellen → vers → opnieuw → nieuw; wie net geprobeerd is staat er niet in', () => {
  const vers = lead('a0000001');
  const oud = lead('a0000002', { aangemaakt: new Date(NU - 20 * 86400000).toISOString() });
  const leads = [vers, oud, lead('a0000003'), lead('a0000004'), lead('a0000005'), lead('a0000006')];
  const kaarten = [
    { id: 'tb', lead_id: 'a0000003', status: 'open', due: VANDAAG, reden_code: 'terugbellen', created_at: min(9000) },
    { id: 'net', lead_id: 'a0000004', status: 'open', due: VANDAAG, created_at: min(9000) },
    { id: 'klaar', lead_id: 'a0000005', status: 'open', due: VANDAAG, created_at: min(9000) },
    { id: 'reag', lead_id: 'a0000006', status: 'open', due: VANDAAG, created_at: min(9000) },
  ];
  const telPerKaart = new Map([
    ['net', { pogingen: [call(min(15))] }],
    ['klaar', { pogingen: [call(min(400))] }],
    ['reag', { pogingen: [call(min(30)), { soort: 'whatsapp', richting: 'in', tijdstip: min(3) }] }],
  ]);
  const o = stelPottenSamen({ leads, kaarten, telPerKaart, nuMs: NU });
  const volgorde = o.potten.belrij.map((r) => r.sectie + ':' + (r.kaart ? r.kaart.taak_id : r.lead_id));
  assert.deepEqual(volgorde, ['reageerde:reag', 'terugbellen:tb', 'vers:a0000001', 'opnieuw:klaar', 'nieuw:a0000002']);
  assert.equal(o.belrij.wacht_op_ronde, 1, 'de net geprobeerde lead wacht op zijn ronde');
  assert.equal(o.badge, 4, 'badge = dringend, zonder de rest van Nieuw');
  assert.equal(o.potten.bezig.length, 3);
  assert.ok(o.potten.belrij.every((r) => typeof r.waarom === 'string' && r.waarom.length));
});

test('een terugbelafspraak voor later staat in Terugbelafspraken maar niet in de Belrij', () => {
  const l = lead('b0000001');
  const k = { id: 'tb', lead_id: l.id, status: 'open', due: dagPlusN(VANDAAG, 11), reden_code: 'terugbellen', created_at: min(9000) };
  assert.equal(potVoorKaart(k, VANDAAG, NU), 'terugbellen');
  const o = stelPottenSamen({ leads: [l], kaarten: [k], nuMs: NU });
  assert.equal(o.aantallen.terugbellen, 1);
  assert.equal(o.potten.belrij.length, 0);
  // op de dag zelf: bovenaan
  assert.equal(belrijSectie({ kaart: { due: k.due, plan: { klaar: true, rondes: 0 } } }, 'terugbellen', k.due), 'terugbellen');
});

test('uitgebeld komt onderaan als eigen sectie', () => {
  const l = lead('c0000001');
  const pog = [0, 1, 2, 3, 4].map((d) => call(new Date(NU - (12 - 2 * d) * 86400000).toISOString()));
  const o = stelPottenSamen({ leads: [l], nuMs: NU,
    kaarten: [{ id: 'u', lead_id: l.id, status: 'open', due: VANDAAG, created_at: min(20000) }],
    telPerKaart: new Map([['u', { pogingen: pog }]]) });
  assert.equal(o.potten.belrij[0].sectie, 'uitgebeld');
  assert.equal(o.badge, 0);
});

test('momentTekst', () => {
  assert.equal(momentTekst(new Date(NU - 1000).toISOString(), NU), 'nu');
  assert.equal(momentTekst(new Date(NU + 3 * 3600000).toISOString(), NU), 'vandaag 13:00');
  assert.equal(momentTekst(new Date(momentInZone(dagPlusN(VANDAAG, 1), 9)).toISOString(), NU), 'morgen 09:00');
});

// ═══════════════════════════════════════════════════════════════════════════
// UITKOMST: DE CALL RECHTZETTEN
// ═══════════════════════════════════════════════════════════════════════════

test('voicemail die als "gesproken" gelogd werd, wordt niet opgenomen', () => {
  assert.deepEqual(beslisCorrectie({ resultaat: 'gesproken' }, 'voicemail'), { actie: 'bijstellen', resultaat: 'niet opgenomen: voicemail' });
  assert.deepEqual(beslisCorrectie({ resultaat: 'gesproken' }, 'geen_gehoor'), { actie: 'bijstellen', resultaat: 'niet opgenomen' });
  assert.deepEqual(beslisCorrectie({ resultaat: 'niet opgenomen' }, 'geen_gehoor'), { actie: 'niets' });
  assert.deepEqual(beslisCorrectie({ resultaat: 'niet opgenomen' }, 'voicemail'), { actie: 'bijstellen', resultaat: 'niet opgenomen: voicemail' });
  assert.deepEqual(beslisCorrectie({ resultaat: 'gesproken' }, 'gesproken'), { actie: 'niets' });
  // gebeld met de eigen gsm: er staat geen call → één handmatige poging
  assert.equal(beslisCorrectie(null, 'geen_gehoor').actie, 'toevoegen');
  assert.equal(beslisCorrectie(null, 'foutief_nummer').actie, 'niets');
});

// ═══════════════════════════════════════════════════════════════════════════
// LOGBOEK
// ═══════════════════════════════════════════════════════════════════════════

test('logboek: calls, berichten en beslissingen van één dag, nieuwste eerst', () => {
  const kaarten = [
    { id: 'k1', naam: 'Anna', status: 'open', created_at: min(100),
      uitkomst_log: [{ op: min(29), soort: 'voicemail', tekst: 'Voicemail' }, { op: min(3000), soort: 'geen_gehoor' }] },
    { id: 'k2', naam: 'Bram', status: 'gearchiveerd', gearchiveerd_at: min(5), archief_categorie: 'geen_interesse', archief_reden: 'Wil niet', created_at: min(5000) },
  ];
  const hist = new Map([
    ['k1', [call(min(30), 'niet opgenomen: voicemail', { duur_sec: 25 }), call(min(31), 'gesproken', { duur_sec: 40 }),
      { soort: 'whatsapp', richting: 'uit', resultaat: 'WhatsApp verstuurd', tijdstip: min(20) },
      { soort: 'whatsapp', richting: 'uit', resultaat: 'WhatsApp afgeleverd', tijdstip: min(19) },
      call(min(3000))]],
    ['k2', [call(min(10), 'gesproken', { duur_sec: 120 })]],
  ]);
  const l = bouwLogboek({ kaarten, histPerKaart: hist, dag: VANDAAG });
  assert.equal(l.kpi.pogingen, 3);
  assert.equal(l.kpi.leads_gebeld, 2);
  assert.equal(l.kpi.voicemail, 1);
  assert.equal(l.kpi.opgenomen, 2);
  assert.equal(l.kpi.wa_uit, 1, 'afgeleverd/gelezen is geen extra bericht');
  assert.equal(l.kpi.afgerond, 1);
  assert.equal(l.kpi.nieuw_aangeraakt, 1);
  assert.equal(l.kpi.belseconden, 185);
  assert.equal(l.rijen[0].naam, 'Bram');
  assert.match(l.rijen[0].tekst, /Afgerond: Geen interesse/);
  assert.ok(l.rijen.some((r) => r.tekst === 'Uitkomst: Voicemail'));
  assert.equal(l.per_lead.length, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// SCHERM: TWEELINGEN EN WIRING
// ═══════════════════════════════════════════════════════════════════════════

test('het scherm kent dezelfde secties en hetzelfde maximum als de server', () => {
  assert.equal(Number((VIEW.match(/const RONDES_MAX = (\d+);/) || [])[1]), MAX_RONDES);
  for (const s of BELRIJ_SECTIES) assert.ok(VIEW.includes("['" + s.code + "', '" + s.label + "'"), s.code);
});

test('het scherm opent standaard op Nu bellen, vraagt na een call de uitkomst en toont het logboek', () => {
  assert.match(VIEW, /function eerstePotMetInhoud\(\) \{ return 'belrij'; \}/);
  assert.match(VIEW, /soort: 'uitkomst', sleutel: g\.sleutel/);
  assert.match(VIEW, /\/api\/opvolging-leads-logboek/);
  assert.match(VIEW, /actie: 'uitkomst', uitkomst: u/);
  assert.match(VIEW, /actie: 'opnieuw_om'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ENDPOINT: UITKOMST EN OPNIEUW_OM
// ═══════════════════════════════════════════════════════════════════════════

const url = (p) => pathToFileURL(join(ROOT, p)).href;
function nepDb(tabellen) {
  const from = (tabel) => {
    const filters = []; let modus = 'select', payload = null;
    const rijen = () => (tabellen[tabel] || []).filter((r) => filters.every((f) => f(r)));
    const k = {
      select: () => k, eq: (c, v) => { filters.push((r) => String(r[c]) === String(v)); return k; },
      gte: () => k, order: () => k, limit: () => k, in: () => k,
      insert: (p) => { modus = 'insert'; payload = p; return k; },
      update: (p) => { modus = 'update'; payload = p; return k; },
      maybeSingle: async () => run(true), single: async () => run(true),
      then: (a, b) => run(false).then(a, b),
    };
    async function run(een) {
      if (modus === 'insert') { const r = { id: 'p' + Math.random(), ...payload }; (tabellen[tabel] = tabellen[tabel] || []).push(r); return { data: een ? r : [r], error: null }; }
      if (modus === 'update') { const h = rijen(); for (const r of h) Object.assign(r, payload); return { data: een ? h[0] || null : h, error: null }; }
      const h = rijen(); return { data: een ? h[0] || null : h, error: null };
    }
    return k;
  };
  return { from };
}
async function laad(db) {
  mock.module(url('api/supabase.js'), { namedExports: {
    supabaseAdmin: db, supabase: db, createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
    checkCronAuth: () => ({ ok: true }), ADMIN_ROLES: [] } });
  mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true, requirePermissionFailOpen: async () => true } });
  return (await import(url('api/opvolging-taak-update.js') + '?t=' + Math.random())).default;
}
const res = () => { const u = {}; return { setHeader() {}, status(c) { u.code = c; return this; }, json(b) { u.body = b; return this; }, u }; };

test('uitkomst voicemail: call rechtgezet, logregel erbij, plan terug', async (t) => {
  t.after(() => mock.reset());
  const nu = new Date().toISOString();
  const db = nepDb({
    opvolging_taken: [{ id: 't1', lijst: 'leads', status: 'open', due: '2026-10-13', uitkomst_log: [] }],
    opvolging_pogingen: [{ id: 'p1', taak_id: 't1', soort: 'call', richting: 'uit', resultaat: 'gesproken', tijdstip: nu }],
  });
  const h = await laad(db);
  const r = res();
  await h({ method: 'POST', body: { taak_id: 't1', actie: 'uitkomst', uitkomst: 'voicemail' }, headers: {} }, r);
  assert.equal(r.u.code, 200, JSON.stringify(r.u.body));
  assert.equal(db.from('opvolging_pogingen') && (await db.from('opvolging_pogingen').select().eq('id', 'p1').maybeSingle()).data.resultaat, 'niet opgenomen: voicemail');
  assert.equal(r.u.body.taak.uitkomst_log.length, 1);
  assert.equal(r.u.body.taak.uitkomst_log[0].soort, 'voicemail');
  assert.equal(r.u.body.plan.rondes, 1);
  assert.equal(r.u.body.plan.klaar, false);
});

test('uitkomst foutief nummer rondt af; uitkomst op een daglijstkaart wordt geweigerd', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ opvolging_taken: [
    { id: 't1', lijst: 'leads', status: 'open', uitkomst_log: [] },
    { id: 'd1', lijst: 'dag', status: 'open' },
  ], opvolging_pogingen: [] });
  const h = await laad(db);
  const r = res();
  await h({ method: 'POST', body: { taak_id: 't1', actie: 'uitkomst', uitkomst: 'foutief_nummer' }, headers: {} }, r);
  assert.equal(r.u.code, 200);
  assert.equal(r.u.body.taak.status, 'gearchiveerd');
  assert.equal(r.u.body.taak.archief_categorie, 'foutief_nummer');
  const r2 = res();
  await h({ method: 'POST', body: { taak_id: 'd1', actie: 'uitkomst', uitkomst: 'geen_gehoor' }, headers: {} }, r2);
  assert.equal(r2.u.code, 400);
});

test('opnieuw_om: alleen een moment in de toekomst', async (t) => {
  t.after(() => mock.reset());
  const db = nepDb({ opvolging_taken: [{ id: 't1', lijst: 'leads', status: 'open', uitkomst_log: [] }], opvolging_pogingen: [] });
  const h = await laad(db);
  const r = res();
  await h({ method: 'POST', body: { taak_id: 't1', actie: 'opnieuw_om', wanneer: new Date(Date.now() - 1000).toISOString() }, headers: {} }, r);
  assert.equal(r.u.code, 400);
  const r2 = res();
  await h({ method: 'POST', body: { taak_id: 't1', actie: 'opnieuw_om', wanneer: 'morgen' }, headers: {} }, r2);
  assert.equal(r2.u.code, 200);
  assert.ok(Date.parse(r2.u.body.taak.volgende_poging_at) > Date.now());
});
