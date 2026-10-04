// tests/setter-keten.test.js
//
// WIE BOEKTE DEZE CALL — OOK NA VERZETTEN.
//
// Gemeten op 1 oktober 2026: Romy boekte Manjit Kaur (391bd97c…), de call werd
// verzet, en de opvolger (8ca3d4f0…) — waar de uitkomst op komt — droeg geen
// setter_user_id en geen booking_source. Haar rapport zou die call missen.
//
// Bewaakt:
//   1. erfSetterVelden / setterUitKeten / planSetterBackfill (pure functies);
//   2. dat verzetAfspraak() de setter en de bron echt meegeeft;
//   3. dat de vervolg-call in follow-up-outcomes.js hetzelfde doet;
//   4. gat 2: het afspraak-id uit createAppointmentForLead wordt gelezen;
//   5. dat boekingen-tellers een verzette boeking niet dubbel tellen;
//   6. dat het backfill-script standaard read-only is.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  erfSetterVelden, setterUitKeten, haalSetterViaKeten, planSetterBackfill,
} from '../api/_lib/setter-keten.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const bron = (p) => readFileSync(join(ROOT, p), 'utf8');
const code = (p) => bron(p).split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');

const ROMY = 'e5006a5f-463a-46c8-ba04-467503ab8cc7';

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE PURE FUNCTIES
// ═══════════════════════════════════════════════════════════════════════════

test('erfSetterVelden neemt alleen gevulde waarden mee', () => {
  assert.deepEqual(erfSetterVelden({ setter_user_id: ROMY, booking_source: 'romy' }),
    { setter_user_id: ROMY, booking_source: 'romy' });
  assert.deepEqual(erfSetterVelden({ setter_user_id: ROMY, booking_source: null }), { setter_user_id: ROMY });
  assert.deepEqual(erfSetterVelden({ setter_user_id: null, booking_source: '' }), {});
  assert.deepEqual(erfSetterVelden(null), {});
  assert.deepEqual(erfSetterVelden(undefined), {});
});

const keten = () => new Map([
  ['a', { id: 'a', parent_appointment_id: null, setter_user_id: ROMY, booking_source: 'romy' }],
  ['b', { id: 'b', parent_appointment_id: 'a', setter_user_id: null, booking_source: null }],
  ['c', { id: 'c', parent_appointment_id: 'b', setter_user_id: null, booking_source: null }],
]);

test('setterUitKeten loopt de keten omhoog', () => {
  const m = keten();
  const hit = setterUitKeten(m.get('c'), m);
  assert.equal(hit.setter_user_id, ROMY);
  assert.equal(hit.booking_source, 'romy');
  assert.equal(hit.bron_appointment_id, 'a');
  assert.equal(hit.diepte, 2);
  assert.deepEqual(hit.keten, ['c', 'b', 'a']);
  assert.equal(setterUitKeten(m.get('a'), m).diepte, 0, 'de rij zelf telt');
});

test('setterUitKeten: ontbrekende schakel, geen setter, cyclus → null, nooit een loop', () => {
  const m = keten();
  assert.equal(setterUitKeten({ id: 'x', parent_appointment_id: 'weg' }, m), null);
  assert.equal(setterUitKeten({ id: 'y', parent_appointment_id: null }, m), null);
  const cyclus = new Map([
    ['p', { id: 'p', parent_appointment_id: 'q' }],
    ['q', { id: 'q', parent_appointment_id: 'p' }],
  ]);
  assert.equal(setterUitKeten(cyclus.get('p'), cyclus), null);
  assert.equal(setterUitKeten(null, m), null);
});

test('planSetterBackfill: precies het productiegeval van 1 oktober', () => {
  // De rijen zoals de read-only dry-run ze vond.
  const rijen = [
    { id: '391bd97c-72a3-4f68-bc67-157e7aee8b95', lead_name: 'Manjit Kaur', status: 'verplaatst',
      scheduled_at: '2026-10-01T12:00:00+00:00', parent_appointment_id: null,
      setter_user_id: ROMY, booking_source: 'romy', is_test: false },
    { id: '8ca3d4f0-348f-4383-bc18-d6d55e8bd192', lead_name: 'Manjit Kaur', status: 'scheduled',
      scheduled_at: '2026-10-01T12:00:00+00:00', parent_appointment_id: '391bd97c-72a3-4f68-bc67-157e7aee8b95',
      setter_user_id: null, booking_source: null, is_test: false },
  ];
  const plan = planSetterBackfill(rijen);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].id, '8ca3d4f0-348f-4383-bc18-d6d55e8bd192');
  assert.deepEqual(plan[0].zet, { setter_user_id: ROMY, booking_source: 'romy' });
  assert.deepEqual(plan[0].keten, ['8ca3d4f0-348f-4383-bc18-d6d55e8bd192', '391bd97c-72a3-4f68-bc67-157e7aee8b95']);
});

test('planSetterBackfill: smal — alleen opvolgers zonder setter met een voorganger mét setter', () => {
  const rijen = [
    { id: 'a', parent_appointment_id: null, setter_user_id: ROMY, booking_source: 'romy', scheduled_at: '2026-09-01' },
    { id: 'b', parent_appointment_id: 'a', setter_user_id: null, booking_source: 'eigen-bron', scheduled_at: '2026-09-03' },
    { id: 'c', parent_appointment_id: 'b', setter_user_id: null, booking_source: null, scheduled_at: '2026-09-02' },
    { id: 'd', parent_appointment_id: 'a', setter_user_id: 'iemand-anders', scheduled_at: '2026-09-04' },
    { id: 'e', parent_appointment_id: null, setter_user_id: null, scheduled_at: '2026-09-05' },
    { id: 'f', parent_appointment_id: 'e', setter_user_id: null, scheduled_at: '2026-09-06' },
    { id: 'g', parent_appointment_id: 'bestaat-niet', setter_user_id: null, scheduled_at: '2026-09-07' },
  ];
  const plan = planSetterBackfill(rijen);
  assert.deepEqual(plan.map((p) => p.id), ['c', 'b'], 'gesorteerd op scheduled_at; d/e/f/g vallen af');
  const b = plan.find((p) => p.id === 'b');
  assert.deepEqual(b.zet, { setter_user_id: ROMY }, 'een bestaande bron wordt NOOIT overschreven');
  const c = plan.find((p) => p.id === 'c');
  assert.deepEqual(c.zet, { setter_user_id: ROMY, booking_source: 'romy' });
  assert.deepEqual(c.keten, ['c', 'b', 'a']);
});

test('planSetterBackfill: na de backfill is het plan leeg (idempotent)', () => {
  const rijen = [
    { id: 'a', parent_appointment_id: null, setter_user_id: ROMY, booking_source: 'romy' },
    { id: 'b', parent_appointment_id: 'a', setter_user_id: null, booking_source: null },
  ];
  const plan = planSetterBackfill(rijen);
  for (const p of plan) Object.assign(rijen.find((r) => r.id === p.id), p.zet);
  assert.equal(planSetterBackfill(rijen).length, 0);
  assert.deepEqual(planSetterBackfill(null), []);
});

test('haalSetterViaKeten leest de keten uit de databank, en faalt zacht', async () => {
  const m = keten();
  const gelezen = [];
  const db = {
    from: () => {
      let id = null;
      const k = {
        select: () => k,
        eq: (_c, v) => { id = v; return k; },
        maybeSingle: async () => { gelezen.push(id); return { data: m.get(id) || null, error: null }; },
      };
      return k;
    },
  };
  const hit = await haalSetterViaKeten(db, 'c');
  assert.equal(hit.setter_user_id, ROMY);
  assert.deepEqual(gelezen, ['c', 'b', 'a'], 'stopt bij de eerste rij mét setter');

  const stuk = { from: () => { throw new Error('netwerk'); } };
  assert.equal(await haalSetterViaKeten(stuk, 'c'), null);
  assert.equal(await haalSetterViaKeten(null, 'c'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · verzetAfspraak() GEEFT HEM ECHT MEE
// ═══════════════════════════════════════════════════════════════════════════

function nepAdmin() {
  const log = [];
  const maak = (tabel) => {
    const st = { tabel };
    const k = {
      select: () => k, eq: () => k,
      update: (v) => { st.op = 'update'; st.waarde = v; log.push({ ...st }); return k; },
      insert: (v) => { st.op = 'insert'; st.waarde = v; log.push({ ...st }); return k; },
      single: async () => ({ data: { id: 'ap-nieuw', ...st.waarde }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
    };
    k.then = (res) => Promise.resolve({ data: null, error: null }).then(res);
    return k;
  };
  return { from: maak, _log: log };
}

async function laadVerzet() {
  mock.module(url('api/_lib/ghl-appointment.js'), {
    namedExports: { updateGhlAppointmentTime: async () => ({ ok: true }) },
  });
  mock.module(url('api/_lib/zoom-meeting.js'), {
    namedExports: { updateZoomMeetingTime: async () => ({ ok: true }) },
  });
  mock.module(url('api/_lib/afspraak-status-notify.js'), {
    namedExports: { stuurVerzetBericht: async () => {}, stuurBevestiging: async () => {} },
  });
  return (await import(url('api/_lib/verzet-afspraak.js') + '?t=' + Math.random())).verzetAfspraak;
}

const OUDE = {
  id: '391bd97c-72a3-4f68-bc67-157e7aee8b95', status: 'scheduled',
  scheduled_at: '2026-09-24T12:00:00Z', lead_name: 'Manjit Kaur',
  ghl_appointment_id: 'ghl-1', zoom_meeting_id: 'z-1', owner_id: 'dave',
};

test('VERZET: de nieuwe rij erft setter_user_id en booking_source', async (t) => {
  t.after(() => mock.reset());
  const verzetAfspraak = await laadVerzet();
  const admin = nepAdmin();
  await verzetAfspraak({
    supabaseAdmin: admin,
    afspraak: { ...OUDE, setter_user_id: ROMY, booking_source: 'romy' },
    nieuwStartIso: '2026-10-01T12:00:00Z',
  });
  const insert = admin._log.find((r) => r.op === 'insert' && r.tabel === 'follow_up_appointments');
  assert.equal(insert.waarde.setter_user_id, ROMY);
  assert.equal(insert.waarde.booking_source, 'romy');
  assert.equal(insert.waarde.parent_appointment_id, OUDE.id);
});

test('VERZET: zonder setter op de oude rij noemt de insert die kolommen niet', async (t) => {
  t.after(() => mock.reset());
  const verzetAfspraak = await laadVerzet();
  const admin = nepAdmin();
  await verzetAfspraak({ supabaseAdmin: admin, afspraak: OUDE, nieuwStartIso: '2026-10-01T12:00:00Z' });
  const insert = admin._log.find((r) => r.op === 'insert' && r.tabel === 'follow_up_appointments');
  assert.ok(!('setter_user_id' in insert.waarde));
  assert.ok(!('booking_source' in insert.waarde));
});

test('alle callers van verzetAfspraak lezen de volledige rij (select *)', () => {
  // Anders komt setter_user_id nooit binnen en erft de opvolger niets.
  for (const p of ['api/follow-up-verplaats-call.js', 'api/opvolging-agenda.js', 'api/opvolging-zoom-actie.js']) {
    assert.match(bron(p), /from\('follow_up_appointments'\)\s*\.select\('\*'\)/, p);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE VERVOLG-CALL IN follow-up-outcomes.js
// ═══════════════════════════════════════════════════════════════════════════

test('follow-up-outcomes leest setter en bron, en geeft ze aan de vervolg-call', () => {
  const c = code('api/follow-up-outcomes.js');
  assert.match(c, /select\('id, status, ghl_appointment_id[^']*setter_user_id, booking_source'\)/);
  const i = c.indexOf('const childRow = {');
  const blok = c.slice(i, c.indexOf('};', i));
  assert.match(blok, /parent_appointment_id: appointment_id/);
  assert.match(blok, /\.\.\.erfSetterVelden\(parentAppt\)/);
});

test('er is geen andere plek die een opvolger met parent_appointment_id maakt', () => {
  // Komt er een bij, dan hoort die ook erfSetterVelden te gebruiken.
  const treffers = [];
  const loop = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { loop(p); continue; }
      if (!n.endsWith('.js')) continue;
      const t = readFileSync(p, 'utf8');
      if (/parent_appointment_id\s*:\s*(?!null)[A-Za-z_]/.test(t)) treffers.push(p.slice(ROOT.length + 1).replace(/\\/g, '/'));
    }
  };
  loop(join(ROOT, 'api'));
  assert.deepEqual(treffers.sort(), ['api/_lib/verzet-afspraak.js', 'api/follow-up-outcomes.js']);
  for (const p of treffers) assert.match(code(p), /erfSetterVelden\(/, p);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · GAT 2: HET AFSPRAAK-ID
// ═══════════════════════════════════════════════════════════════════════════

test('createAppointmentForLead geeft appointment_id terug', () => {
  const c = code('api/_lib/create-appointment-from-lead.js');
  const i = c.lastIndexOf('return {', c.indexOf('export function mapGhlError'));
  assert.match(c.slice(i, i + 200), /appointment_id\s*:\s*inserted\.id/);
});

test('opstartsessie-create leest appointment_id — de setter-override draait weer', () => {
  const c = code('api/leadsonderhoud-opstartsessie-create.js');
  assert.match(c, /const apptId = result\?\.appointment_id \|\|/);
  assert.match(c, /\.update\(\{ setter_user_id: user\.id \}\)\s*\.eq\('id', apptId\)/);
});

test('appointment-create geeft het echte id terug in de response', () => {
  const c = code('api/leadsonderhoud-appointment-create.js');
  assert.match(c, /follow_up_appointment_id: result\.appointment_id \|\|/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · BOEKINGEN NIET DUBBEL TELLEN
// ═══════════════════════════════════════════════════════════════════════════

test('setter-dashboard telt boekingen alleen op de oorspronkelijke rij', () => {
  const c = code('api/setter-dashboard-metrics.js');
  const tellers = c.split("{ count: 'exact', head: true })").slice(1)
    .map((stuk) => stuk.split('supabaseAdmin.from')[0]);
  assert.equal(tellers.length, 3, 'drie boekingen-tellers');
  for (const t of tellers) assert.match(t, /\.is\('parent_appointment_id', null\)/);
});

test('booking-sources-list telt alleen de oorspronkelijke boeking', () => {
  assert.match(code('api/booking-sources-list.js'),
    /\.not\('booking_source', 'is', null\)\s*\.is\('parent_appointment_id', null\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · HET BACKFILL-SCRIPT
// ═══════════════════════════════════════════════════════════════════════════

test('backfill-script: dry-run is de standaard, met een read-only client', () => {
  const s = bron('scripts/backfill-setter-keten.mjs');
  assert.match(s, /const APPLY = args\.has\('--apply'\)/);
  assert.match(s, /const db = APPLY \? ruw : alleenLezen\(ruw\)/);
  assert.match(s, /new Set\(\['insert', 'update', 'upsert', 'delete', 'rpc'\]\)/);
  assert.match(s, /planSetterBackfill/, 'de pure kern wordt hergebruikt, niet nagebouwd');
  assert.match(s, /\.is\('setter_user_id', null\)/, 'apply overschrijft nooit een bestaande setter');
});
