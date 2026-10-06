// tests/opvolging-eigen-moment.test.js
//
// EEN ZOOMCALL HANDMATIG INPLANNEN, BUITEN DE VRIJE MOMENTEN VAN GHL.
//
// ── DE SITUATIE (gemeten op productie, 6 okt 2026) ──────────────────────
// 'Zoomcall inplannen met <lead>' toonde alleen wat GHL als vrij teruggaf, en
// de kalender heeft een boekvenster van ca. 20 dagen: per week 63, 95, 21 en
// daarna 0 vrije momenten. Vanaf 27/10 stond er in elke kolom een stil '—' en
// kon Dave niets kiezen.
//
// ── WAT HET BEDOELDE GEDRAG IS ──────────────────────────────────────────
//   · GHL krijgt ignoreDateRange: true (en ignoreFreeSlotValidation), bij
//     boeken én bij verzetten — anders weigert GHL een moment voorbij het
//     boekvenster.
//   · Onder het weekraster staat 'Ander moment kiezen (buiten de agenda)':
//     dag + uur per kwartier, de server rekent om (Brussel), en een
//     bevestigstap zegt hardop dat het moment niet vrij staat.
//   · Botsingen (±30 min, zelfde persoon of Dave) zijn een waarschuwing, geen
//     blokkade.
//   · Een handmatige boeking draagt `handmatig: true` (afspraak_ref van de taak,
//     of de audit-regel bij een verzetting), zodat het rapport hem kan
//     onderscheiden. Een gewone slot-boeking verandert niet.
//   · Een lege dag zegt waarom hij leeg is. Nooit meer een stil '—'.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { leesEigenMoment, zoekBotsingen } from '../api/_lib/opvolging-eigen-moment.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const BADGE_HELPER = join(ROOT, 'modules/klanten-v2/views/_opvolging-badge.js');

// 6 okt 2026, 12:00 in Brussel — de dag van de meting.
const NU = Date.parse('2026-10-06T10:00:00Z');

// ═══════════════════════════════════════════════════════════════════════════
// 1 · GHL — HET BOEKVENSTER NEGEREN, BIJ BOEKEN ÉN VERZETTEN
// ═══════════════════════════════════════════════════════════════════════════

async function laadGhl() {
  const verzonden = [];
  mock.module('node-fetch', {
    defaultExport: async (u, opts) => {
      verzonden.push({ url: u, method: opts.method, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ id: 'ghl-1' }), text: async () => '' };
    },
  });
  const mod = await import(url('api/_lib/ghl-appointment.js') + '?t=' + Math.random());
  return { mod, verzonden };
}

test('createGhlAppointment stuurt ignoreDateRange en ignoreFreeSlotValidation mee', async (t) => {
  t.after(() => mock.reset());
  process.env.GHL_PIT_TOKEN ||= 'test-token';
  const { mod, verzonden } = await laadGhl();
  await mod.createGhlAppointment({
    calendarId: 'cal', locationId: 'loc', contactId: 'c1',
    startTime: '2026-10-28T09:30:00.000Z', endTime: '2026-10-28T10:00:00.000Z',
  });
  assert.equal(verzonden.length, 1);
  assert.equal(verzonden[0].method, 'POST');
  assert.equal(verzonden[0].body.ignoreDateRange, true, 'zonder dit weigert GHL een moment voorbij het boekvenster');
  assert.equal(verzonden[0].body.ignoreFreeSlotValidation, true);
});

test('verzetten (PUT) negeert het boekvenster ook', async (t) => {
  // Een handmatig moment kan ook bij 'Opnieuw inplannen' van een bestaande call
  // gekozen worden; dan gaat het via de PUT.
  t.after(() => mock.reset());
  process.env.GHL_PIT_TOKEN ||= 'test-token';
  const { mod, verzonden } = await laadGhl();
  await mod.updateGhlAppointmentTime('ghl-1', '2026-10-28T09:30:00.000Z', '2026-10-28T10:00:00.000Z');
  assert.equal(verzonden[0].method, 'PUT');
  assert.equal(verzonden[0].body.ignoreDateRange, true);
  assert.equal(verzonden[0].body.ignoreFreeSlotValidation, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · HET MOMENT LEZEN — DAG + UUR IN BRUSSEL
// ═══════════════════════════════════════════════════════════════════════════

test('28/10 10:30 Brussel is 09:30 UTC (wintertijd)', () => {
  const m = leesEigenMoment('2026-10-28', '10:30', NU);
  assert.equal(m.iso, '2026-10-28T09:30:00.000Z');
  assert.equal(m.dag, '2026-10-28');
  assert.equal(m.tijd, '10:30');
});

test('20/10 10:30 Brussel is 08:30 UTC (zomertijd)', () => {
  assert.equal(leesEigenMoment('2026-10-20', '10:30', NU).iso, '2026-10-20T08:30:00.000Z');
});

test('alleen per kwartier', () => {
  assert.match(leesEigenMoment('2026-10-28', '10:10', NU).fout, /kwartier/);
  assert.ok(leesEigenMoment('2026-10-28', '10:45', NU).iso);
});

test('niet in het verleden, niet een jaar vooruit, geen onbestaande dag', () => {
  assert.match(leesEigenMoment('2026-10-05', '10:00', NU).fout, /verleden/);
  assert.match(leesEigenMoment('2027-12-01', '10:00', NU).fout, /jaartal/);
  assert.match(leesEigenMoment('2026-11-31', '10:00', NU).fout, /bestaande/);
  assert.match(leesEigenMoment('', '10:00', NU).fout, /dag/);
  assert.match(leesEigenMoment('2026-10-28', '', NU).fout, /uur/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · BOTSINGEN — ±30 MINUTEN, WAARSCHUWEN, NIET BLOKKEREN
// ═══════════════════════════════════════════════════════════════════════════

const MOMENT = Date.parse('2026-10-28T09:30:00.000Z');           // 10:30 Brussel
const rij = (id, iso, extra = {}) => ({
  id, scheduled_at: iso, status: 'scheduled', lead_name: 'Lead ' + id, lead_phone: '+31600000' + id, ...extra,
});

test('een call van Dave binnen 30 minuten botst, op precies 30 minuten niet', () => {
  const b = zoekBotsingen({
    momentMs: MOMENT,
    afspraken: [
      rij('11', '2026-10-28T09:15:00.000Z'),   // 15 min eerder → botsing
      rij('12', '2026-10-28T10:00:00.000Z'),   // 30 min later → aansluitend, geen botsing
      rij('13', '2026-10-28T09:00:00.000Z'),   // 30 min eerder → aansluitend, geen botsing
    ],
  });
  assert.deepEqual(b.map((x) => x.appointment_id), ['11']);
  assert.equal(b[0].tijd, '10:15', 'de tijd staat in Brussel, zoals Dave hem kent');
  assert.equal(b[0].zelfde_persoon, false);
});

test('geannuleerde, verzette en proefafspraken botsen niet', () => {
  const b = zoekBotsingen({
    momentMs: MOMENT,
    afspraken: [
      rij('21', '2026-10-28T09:30:00.000Z', { status: 'cancelled' }),
      rij('22', '2026-10-28T09:30:00.000Z', { status: 'verplaatst' }),
      rij('23', '2026-10-28T09:30:00.000Z', { is_test: true }),
    ],
  });
  assert.equal(b.length, 0);
});

test('dezelfde persoon wordt herkend op nummer of e-mail', () => {
  const b = zoekBotsingen({
    momentMs: MOMENT,
    persoon: { lead_phone: '0612345678', lead_email: 'Filip@Voorbeeld.be' },
    afspraken: [
      rij('31', '2026-10-28T09:40:00.000Z', { lead_phone: '+31 6 12345678' }),
      rij('32', '2026-10-28T09:20:00.000Z', { lead_phone: null, lead_email: 'filip@voorbeeld.be' }),
      rij('33', '2026-10-28T09:35:00.000Z'),
    ],
  });
  const per = Object.fromEntries(b.map((x) => [x.appointment_id, x.zelfde_persoon]));
  assert.deepEqual(per, { 31: true, 32: true, 33: false });
});

test('de call die verzet wordt botst niet met zichzelf', () => {
  const b = zoekBotsingen({
    momentMs: MOMENT, negeerId: 'ap-oud',
    afspraken: [rij('ap-oud', '2026-10-28T09:30:00.000Z')],
  });
  assert.equal(b.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HET ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

/** Supabase-dubbelganger: onthoudt schrijfacties, geeft per tabel rijen terug. */
function nepAdmin({ rijen = {}, leesFaalt = false } = {}) {
  const log = [];
  const from = (tabel) => {
    const st = { tabel, filters: [] };
    const antwoord = () => (leesFaalt && tabel === 'follow_up_appointments' && !st.op
      ? { data: null, error: { message: 'stuk', code: 'XX000' } }
      : { data: rijen[tabel] || [], error: null });
    const k = {
      select: () => k, eq: (c, v) => { st.filters.push(['eq', c, v]); return k; },
      gt: (c, v) => { st.filters.push(['gt', c, v]); return k; },
      lt: (c, v) => { st.filters.push(['lt', c, v]); return k; },
      gte: () => k, lte: () => k, in: () => k, neq: () => k, not: () => k, filter: () => k, order: () => k,
      limit: () => k,
      update: (v) => { st.op = 'update'; st.waarde = v; log.push(st); return k; },
      insert: (v) => { st.op = 'insert'; st.waarde = v; log.push(st); return k; },
      maybeSingle: async () => ({ data: (rijen[tabel] || [])[0] || null, error: null }),
      then: (r, j) => Promise.resolve(antwoord()).then(r, j),
    };
    return k;
  };
  return { from, _log: log };
}

function nepRes() {
  const uit = { code: null, body: null };
  return {
    setHeader() {}, status(c) { uit.code = c; return this; }, json(b) { uit.body = b; return this; }, _uit: uit,
  };
}

async function laadAgenda({ rijen = {}, leesFaalt = false } = {}) {
  const admin = nepAdmin({ rijen, leesFaalt });
  const geboekt = [];
  const verzet = [];
  const user = { auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } };
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin, supabase: user, createUserClient: () => user,
      checkCronAuth: () => ({ ok: true }), ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: {
      requirePermission: async () => true, requirePermissionFailOpen: async () => true, checkPermissionOrDeny: async () => true,
    },
  });
  mock.module(url('api/_lib/create-appointment-from-lead.js'), {
    namedExports: {
      createAppointmentForLead: async (o) => {
        geboekt.push(o);
        return { appointment_id: 'ap-nieuw', ghl_appointment_id: 'ghl-nieuw', zoom_join_url: 'https://zoom/x', scheduled_at: o.scheduledAt };
      },
      mapGhlError: (s) => `GHL-fout ${s}`,
    },
  });
  mock.module(url('api/_lib/verzet-afspraak.js'), {
    namedExports: {
      verzetAfspraak: async (o) => { verzet.push(o); return { nieuweAfspraak: { id: 'ap-kind', scheduled_at: o.nieuwStartIso }, ghlBijgewerkt: true, zoomBijgewerkt: false }; },
      verzetBlokkade: () => null,
      mapGhlError: (s) => `GHL-fout ${s}`,
    },
  });
  const mod = await import(url('api/opvolging-agenda.js') + '?t=' + Math.random());
  return { handler: mod.default, admin, geboekt, verzet };
}

const KAART = { id: 't-1', naam: 'Filip Den dessel', telefoon: '+32470111222', email: 'filip@x.be', status: 'open', reden: 'zoom_nabellen', bron_ref: {} };
const post = (body) => ({ method: 'POST', headers: {}, body, query: {} });
const get  = (query) => ({ method: 'GET', headers: {}, query });
// Relatief, zodat de test niet vanzelf 'in het verleden' raakt.
const TOEKOMST = new Date(Math.floor((Date.now() + 30 * 86400000) / 900000) * 900000).toISOString();

test('GET eigen moment: de server rekent om en geeft de botsingen terug', async (t) => {
  t.after(() => mock.reset());
  const ver = new Date(Date.now() + 40 * 86400000);
  const dag = ver.toISOString().slice(0, 10);
  const { handler } = await laadAgenda({
    rijen: {
      opvolging_taken: [KAART],
      follow_up_appointments: [rij('41', '2000-01-01T00:00:00.000Z')],  // valt buiten de marge
    },
  });
  const res = nepRes();
  await handler(get({ eigen_dag: dag, eigen_tijd: '10:30', taak_id: 't-1' }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.moment.dag, dag);
  assert.equal(res._uit.body.moment.tijd, '10:30');
  assert.ok(res._uit.body.moment.iso.startsWith(dag), 'een ISO-tijdstip op die dag');
  assert.ok(Array.isArray(res._uit.body.botsingen), 'gemeten: een lijst, ook als die leeg is');
  assert.equal(res._uit.body.botsingen_melding, null);
});

test('GET eigen moment: lukt het lezen niet, dan zegt het antwoord dat — geen stille lege lijst', async (t) => {
  t.after(() => mock.reset());
  const dag = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  const { handler } = await laadAgenda({ rijen: { opvolging_taken: [KAART] }, leesFaalt: true });
  const res = nepRes();
  await handler(get({ eigen_dag: dag, eigen_tijd: '10:30', taak_id: 't-1' }), res);
  assert.equal(res._uit.code, 200, 'het moment kan nog steeds geboekt worden');
  assert.equal(res._uit.body.botsingen, null, 'null = niet gemeten, niet "geen botsing"');
  assert.match(res._uit.body.botsingen_melding, /lukte niet/);
});

test('GET eigen moment: een ongeldig uur geeft 400 met de reden', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadAgenda();
  const res = nepRes();
  await handler(get({ eigen_dag: '2026-10-28', eigen_tijd: '10:10' }), res);
  assert.equal(res._uit.code, 400);
  assert.match(res._uit.body.error, /kwartier/);
});

test('POST handmatig: zelfde boekpad, en de taak onthoudt dat het handmatig was', async (t) => {
  t.after(() => mock.reset());
  const { handler, admin, geboekt } = await laadAgenda({ rijen: { opvolging_taken: [KAART] } });
  const res = nepRes();
  await handler(post({ taak_id: 't-1', start: TOEKOMST, handmatig: true }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(geboekt.length, 1, 'via createAppointmentForLead — dus GHL, Zoom-link en afspraakrij');
  assert.equal(geboekt[0].scheduledAt, TOEKOMST);
  const upd = admin._log.find((r) => r.tabel === 'opvolging_taken' && r.op === 'update');
  assert.equal(upd.waarde.status, 'ingepland');
  assert.equal(upd.waarde.afspraak_ref.handmatig, true);
  assert.equal(upd.waarde.afspraak_ref.zoom_join_url, 'https://zoom/x');
});

test('POST zonder handmatig: de afspraak_ref blijft zoals hij altijd was', async (t) => {
  t.after(() => mock.reset());
  const { handler, admin } = await laadAgenda({ rijen: { opvolging_taken: [KAART] } });
  await handler(post({ taak_id: 't-1', start: TOEKOMST }), nepRes());
  const upd = admin._log.find((r) => r.tabel === 'opvolging_taken' && r.op === 'update');
  assert.ok(!('handmatig' in upd.waarde.afspraak_ref));
});

test('POST handmatig in het verleden wordt geweigerd vóór er iets geboekt wordt', async (t) => {
  t.after(() => mock.reset());
  const { handler, geboekt } = await laadAgenda({ rijen: { opvolging_taken: [KAART] } });
  const res = nepRes();
  await handler(post({ taak_id: 't-1', start: '2020-01-01T09:00:00.000Z', handmatig: true }), res);
  assert.equal(res._uit.code, 400);
  assert.match(res._uit.body.error, /verleden/);
  assert.equal(geboekt.length, 0);
});

test('POST handmatig op liever-via-zoom: ook daar staat handmatig in de afspraak_ref', async (t) => {
  t.after(() => mock.reset());
  mock.module(url('api/opvolging-aanmelding-actie.js'), {
    namedExports: { zetLieverZoom: async () => 'bijgewerkt', zetKomtNiet: async () => 'bijgewerkt' },
  });
  const { handler, admin } = await laadAgenda({
    rijen: { opvolging_taken: [{ ...KAART, reden: 'aanmelding', bron_ref: { attendee_id: 'a1' } }] },
  });
  const res = nepRes();
  await handler(post({ taak_id: 't-1', start: TOEKOMST, uitgang: 'liever_zoom', handmatig: true }), res);
  assert.equal(res._uit.code, 200);
  const upd = admin._log.find((r) => r.tabel === 'opvolging_taken' && r.op === 'update');
  assert.equal(upd.waarde.afspraak_ref.handmatig, true);
});

test('POST handmatig bij verzetten: de vlag gaat mee naar de verzetmotor (audit-regel)', async (t) => {
  t.after(() => mock.reset());
  const { handler, verzet } = await laadAgenda({
    rijen: { follow_up_appointments: [rij('ap-oud', '2026-10-07T08:00:00.000Z')], opvolging_taken: [] },
  });
  const res = nepRes();
  await handler(post({ appointment_id: 'ap-oud', start: TOEKOMST, handmatig: true }), res);
  assert.equal(res._uit.code, 200);
  assert.equal(verzet[0].handmatig, true);
  assert.equal(verzet[0].nieuwStartIso, TOEKOMST);
});

test('de verzetmotor schrijft handmatig in de audit-payload, alleen als het waar is', () => {
  const bron = readFileSync(join(ROOT, 'api/_lib/verzet-afspraak.js'), 'utf8');
  assert.match(bron, /\.\.\.\(handmatig \? \{ handmatig: true \} : \{\}\)/);
  const zoom = readFileSync(join(ROOT, 'api/opvolging-zoom-actie.js'), 'utf8');
  assert.match(zoom, /handmatig\s*:\s*b\.handmatig === true/, 'opwarmkaart-verzetten geeft de vlag ook door');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · HET VENSTER
// ═══════════════════════════════════════════════════════════════════════════

function laadView() {
  const window = {
    DFO: { VIEWS: {}, render() {} }, KV_V2: { helpers: {} }, KV: { authedJson: async () => ({}) },
    addEventListener() {}, setInterval() { return 0; }, clearInterval() {},
  };
  window.window = window;
  const ctx = createContext({
    window,
    document: { getElementById: () => null, head: { appendChild() {} }, createElement: () => ({ style: {} }) },
    console, queueMicrotask: () => {}, setInterval: () => 0, clearInterval: () => {},
    Date, Math, Number, String, JSON,
  });
  runInContext(readFileSync(BADGE_HELPER, 'utf8'), ctx, { filename: '_opvolging-badge.js' });
  runInContext(readFileSync(VIEW, 'utf8'), ctx, { filename: 'opvolging-v2.js' });
  assert.ok(window.__opvEigenMomentHelpers, 'de view hoort __opvEigenMomentHelpers te zetten');
  return window.__opvEigenMomentHelpers;
}
const H = laadView();

test('een dag voorbij de laatste vrije dag heet buiten het boekvenster', () => {
  const dagen = [
    { dag: '2026-10-26', vrij: [{ tijd: '10:00' }] },
    { dag: '2026-10-27', vrij: [] },
  ];
  const laatste = H.laatsteVrijeDag(dagen);
  assert.equal(laatste, '2026-10-26');
  const u = H.legeDagUitleg({ dag: '2026-10-27', vandaag: '2026-10-06', laatsteVrij: laatste, agendaOk: true, heeftBezet: false });
  assert.match(u, /Buiten het boekvenster van de agenda/);
  assert.match(u, /kies hieronder handmatig een moment/);
});

test('een hele week zonder vrij moment: elke dag buiten het boekvenster', () => {
  const u = H.legeDagUitleg({ dag: '2026-11-02', vandaag: '2026-10-06', laatsteVrij: null, agendaOk: true, heeftBezet: false });
  assert.match(u, /Buiten het boekvenster/);
});

test('een volle dag binnen het venster, een dag voorbij, en een agenda die stuk is', () => {
  assert.match(H.legeDagUitleg({ dag: '2026-10-08', vandaag: '2026-10-06', laatsteVrij: '2026-10-09', agendaOk: true }), /Niets vrij/);
  assert.equal(H.legeDagUitleg({ dag: '2026-10-05', vandaag: '2026-10-06', laatsteVrij: '2026-10-09', agendaOk: true }), 'Voorbij');
  assert.equal(H.legeDagUitleg({ dag: '2026-10-05', vandaag: '2026-10-06', laatsteVrij: null, agendaOk: true, heeftBezet: true }), null,
    'voorbij met calls erin: de calls zeggen genoeg');
  assert.match(H.legeDagUitleg({ dag: '2026-10-08', vandaag: '2026-10-06', laatsteVrij: null, agendaOk: false }), /niet bereikbaar/);
});

test('het uurveld gaat per kwartier', () => {
  const t = [...H.EIGEN_TIJDEN];
  assert.equal(t[0], '07:00');
  assert.equal(t[1], '07:15');
  assert.ok(t.includes('10:30'));
  assert.ok(t.every((x) => Number(x.slice(3)) % 15 === 0));
});

test('dicht: één duidelijke knop onder het raster', () => {
  const html = H.eigenMomentBlok({ soort: 'inplannen', taakId: 't-1' });
  assert.match(html, /Ander moment kiezen \(buiten de agenda\)/);
  assert.match(html, /__opvEigenOpen/);
});

test('open: een datumveld en een uurveld', () => {
  const html = H.eigenMomentBlok({ soort: 'inplannen', taakId: 't-1', eigen: { open: true, stap: 'kies', dag: '2026-10-28', tijd: '10:30' } });
  assert.match(html, /type="date"[^>]*value="2026-10-28"/);
  assert.match(html, /<option value="10:30" selected>/);
  assert.match(html, /__opvEigenVerder/);
});

test('bevestigen: de waarschuwing staat er letterlijk, botsingen erbij, boeken als handmatig', () => {
  const html = H.eigenMomentBlok({
    soort: 'inplannen', taakId: 't-1',
    eigen: {
      open: true, stap: 'bevestig',
      controle: {
        moment: { iso: '2026-10-28T09:30:00.000Z', dag: '2026-10-28', tijd: '10:30' },
        botsingen: [{ naam: 'Jan Peeters', tijd: '10:15', zelfde_persoon: false }, { naam: 'Filip', tijd: '10:30', zelfde_persoon: true }],
        botsingen_melding: null,
      },
    },
  });
  assert.match(html, /Dit moment staat niet vrij in de agenda van GHL\./);
  assert.match(html, /Controleer zelf dat er geen andere call op staat\./);
  assert.match(html, /wo 28\/10 om 10:30/);
  assert.match(html, /Jan Peeters om 10:15/);
  assert.match(html, /dezelfde persoon/);
  assert.match(html, /Toch inplannen op/, 'een botsing blokkeert niet');
  assert.match(html, /__opvEigenBoek/);
});

test('bevestigen zonder gemeten botsingen toont de melding in plaats van te zwijgen', () => {
  const html = H.eigenMomentBlok({
    soort: 'inplannen', taakId: 't-1',
    eigen: { open: true, stap: 'bevestig', controle: {
      moment: { iso: '2026-10-28T09:30:00.000Z', dag: '2026-10-28', tijd: '10:30' },
      botsingen: null, botsingen_melding: 'De controle op andere afspraken lukte niet.',
    } },
  });
  assert.match(html, /lukte niet/);
  assert.match(html, />Inplannen op/);
});

test('bron: het blok hangt in agendaBlok, dus in elk inplanvenster, en er is geen stil streepje meer', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function agendaBlok(');
  const j = bron.indexOf('function laatsteVrijeDag(');
  const blok = bron.slice(i, j);
  assert.match(blok, /const eigen = eigenMomentBlok\(_ui\.modal\)/);
  assert.match(blok, /\+ niets \+ eigen;/, 'onder het weekraster');
  assert.match(blok, /Agenda laden&hellip;<\/div>' \+ eigen/, 'ook terwijl de agenda laadt');
  assert.doesNotMatch(blok, /agleeg">&mdash;/, 'geen stil streepje meer');
  // Alle vier de vensters die agendaBlok gebruiken.
  for (const soort of ['call-verzet', 'aanmeld-zoom', 'opwarm-verzet', 'inplannen']) {
    assert.match(bron, new RegExp("m\\.soort === '" + soort + "'"), soort);
  }
});

test('bron: __opvBoek stuurt handmatig mee op alle vier de boekpaden', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('window.__opvBoek = async');
  const stuk = bron.slice(i, i + 3000);
  const posts = stuk.match(/await post\([^)]*\)/g) || [];
  assert.equal(posts.length, 4);
  for (const p of posts) assert.match(p, /\.\.\.extra/, p);
  assert.match(stuk, /opties\.handmatig === true \? \{ handmatig: true \} : \{\}/);
});

test('de release hoogt ?v= op voor opvolging-v2.js', () => {
  const html = readFileSync(join(ROOT, 'modules/klanten-v2/index.html'), 'utf8');
  const m = html.match(/views\/opvolging-v2\.js\?v=(\d+)/);
  assert.ok(m && Number(m[1]) >= 76, 'v=' + (m && m[1]));
});
