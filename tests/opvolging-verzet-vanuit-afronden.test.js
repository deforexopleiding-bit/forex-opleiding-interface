// tests/opvolging-verzet-vanuit-afronden.test.js
//
// EEN LEAD DIE BELT OM TE VERZETTEN IS GEEN NO-SHOW.
//
// ── DE SITUATIE ─────────────────────────────────────────────────────────
// Een lead met een zoomcall vandaag belt Dave om half tien dat het niet lukt.
// Tot PR 10 kon Dave alleen herplannen via 'Wat nu? → Opnieuw inplannen' op
// een werklijstkaart — en die kaart bestaat pas NADAT hij de call als no-show
// heeft afgerond. Twee dingen die dan in de administratie staan en geen van
// beide waar zijn:
//
//   · een no-show in het dagrapport, die leest als nalatigheid van Dave;
//   · een kaart 'hij kwam niet opdagen' in de werklijst, terwijl de lead juist
//     zelf belde.
//
// ── WELKE VORM VAN VERZETTEN ────────────────────────────────────────────
// Er stonden er twee in de data:
//
//   sander De groot — dezelfde rij, scheduled_at overschreven. Geen spoor van
//     het oude uur, en hij verdween stil van de dag waarop hij stond.
//   Yasmine — oude rij op 'verplaatst', nieuwe rij met parent_appointment_id.
//
// De tweede is de goede, en api/_lib/verzet-afspraak.js is sinds deze PR de
// enige plek waar hij gemaakt wordt. De cockpit (follow-up-verplaats-call) en
// het afrondvenster gebruiken dezelfde motor — geen tweede administratie.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { verzetBlokkade, VERZETBARE_STATUSSEN, mapGhlError } from '../api/_lib/verzet-afspraak.js';
import { bestemmingPerParent, vulVerzetBestemming } from '../api/_lib/opvolging-dagbeeld.js';
import { ACHTERSTAND_STATUS } from '../api/opvolging-agenda.js';
import { callStaat, relevanteAfspraken } from '../api/opvolging-rapport.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const VIEW = join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js');
const AGENDA = join(ROOT, 'api/opvolging-agenda.js');
const MOTOR  = join(ROOT, 'api/_lib/verzet-afspraak.js');

// De call van vandaag, en de lead belde om te verzetten.
const OUDE_CALL = {
  id: 'ap-1', lead_name: 'Testlead', lead_email: 't@x.nl', lead_phone: '+31612345678',
  lead_ghl_contact_id: 'ghl-c1', scheduled_at: '2026-09-11T08:00:00.000Z',
  status: 'scheduled', uitkomst: null, duration_minutes: 30,
  ghl_appointment_id: 'ghl-ap-1', ghl_calendar_id: 'cal-1',
  zoom_meeting_id: 'zm-1', zoom_join_url: 'https://zoom/x', owner_id: 'u-dave',
};
const NIEUW_MOMENT = '2026-09-15T11:30:00.000Z';

// ═══════════════════════════════════════════════════════════════════════════
// 1 · WANNEER MAG ER VERZET WORDEN
// ═══════════════════════════════════════════════════════════════════════════

test('een geplande call mag verzet worden', () => {
  assert.equal(verzetBlokkade(OUDE_CALL), null);
  for (const s of ['in_progress', 'no_show', 'completed']) {
    assert.equal(verzetBlokkade({ ...OUDE_CALL, status: s }), null, s);
  }
});

test('een al verzette call niet — die heeft elders een opvolger', () => {
  // Nog eens verzetten maakt een tweede keten en laat de eerste zweven.
  const r = verzetBlokkade({ ...OUDE_CALL, status: 'verplaatst' });
  assert.match(r, /al verzet/i);
});

test('een geannuleerde call niet — die hoort via de werklijst terug', () => {
  const r = verzetBlokkade({ ...OUDE_CALL, status: 'cancelled' });
  assert.match(r, /werklijst/i);
  assert.ok(!VERZETBARE_STATUSSEN.has('cancelled'));
  assert.ok(!VERZETBARE_STATUSSEN.has('verplaatst'));
});

test('een onbekende status wordt geweigerd met de status erbij', () => {
  const r = verzetBlokkade({ ...OUDE_CALL, status: 'iets_nieuws' });
  assert.match(r, /iets_nieuws/);
});

test('de GHL-fouten blijven in gewone taal', () => {
  assert.match(mapGhlError(400, 'no slot available'), /niet beschikbaar/i);
  assert.match(mapGhlError(404, ''), /bestaat niet meer/i);
  assert.match(mapGhlError(503, ''), /tijdelijk niet beschikbaar/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE MOTOR — WAT ER GESCHREVEN WORDT, EN IN WELKE VOLGORDE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Een supabase-dubbelganger die alles ONTHOUDT wat er geschreven wordt.
 *
 * Een bron-test zou hier niet volstaan: 'update({status:"verplaatst"})' staat
 * er, maar of hij ook draait en in welke volgorde ten opzichte van de
 * GHL-call is precies wat misging bij eerdere sync-flows.
 */
function nepAdmin({ rijen = {}, insertFaalt = false } = {}) {
  const log = [];
  const maak = (tabel) => {
    const st = { tabel, filters: [] };
    const k = {
      select: () => k, eq: (c, v) => { st.filters.push([c, v]); return k; },
      neq: () => k, in: (c, v) => { st.filters.push([c, v]); return k; },
      gte: () => k, lt: () => k, gt: () => k, lte: () => k, not: () => k,
      filter: () => k, order: () => k, limit: async () => ({ data: rijen[tabel] || [], error: null }),
      update: (v) => { st.op = 'update'; st.waarde = v; log.push({ ...st }); return k; },
      insert: (v) => { st.op = 'insert'; st.waarde = v; log.push({ ...st }); return k; },
      upsert: () => k, delete: () => k,
      maybeSingle: async () => ({ data: (rijen[tabel] || [])[0] || null, error: null }),
      single: async () => {
        if (st.op === 'insert') {
          if (insertFaalt) return { data: null, error: { message: 'insert stuk' } };
          return { data: { id: 'ap-nieuw', ...st.waarde }, error: null };
        }
        return { data: (rijen[tabel] || [])[0] || null, error: null };
      },
      then: undefined,
    };
    // Een update zonder .single() moet ook awaitbaar zijn.
    k.then = (res) => Promise.resolve({ data: null, error: null }).then(res);
    return k;
  };
  return { from: maak, _log: log };
}

/** Laadt de motor met GHL, Zoom en de bevestiging gestubd. */
async function laadMotor({ ghlFaalt = false } = {}) {
  const gebeld = [];
  mock.module(url('api/_lib/ghl-appointment.js'), {
    namedExports: {
      updateGhlAppointmentTime: async (id, s, e) => {
        gebeld.push({ wat: 'ghl', id, s, e });
        if (ghlFaalt) {
          const err = new Error('GHL stuk'); err.ghlStatus = 400; err.ghlBody = 'no slot available';
          throw err;
        }
        return { ok: true };
      },
    },
  });
  mock.module(url('api/_lib/zoom-meeting.js'), {
    namedExports: {
      updateZoomMeetingTime: async (id) => { gebeld.push({ wat: 'zoom', id }); return { ok: true }; },
    },
  });
  mock.module(url('api/_lib/afspraak-status-notify.js'), {
    namedExports: { stuurVerzetBericht: async () => {}, stuurBevestiging: async () => {} },
  });
  const mod = await import(url('api/_lib/verzet-afspraak.js') + '?t=' + Math.random());
  return { verzetAfspraak: mod.verzetAfspraak, gebeld };
}

test('de oude rij gaat op verplaatst en de nieuwe draagt parent_appointment_id', async (t) => {
  t.after(() => mock.reset());
  const { verzetAfspraak } = await laadMotor();
  const admin = nepAdmin();
  const uit = await verzetAfspraak({
    supabaseAdmin: admin, afspraak: OUDE_CALL, nieuwStartIso: NIEUW_MOMENT, bron: 'opvolging-afronden',
  });

  const updates = admin._log.filter((r) => r.tabel === 'follow_up_appointments' && r.op === 'update');
  assert.equal(updates.length, 1, 'precies één update op de oude rij');
  assert.deepEqual(updates[0].waarde, { status: 'verplaatst' });
  assert.deepEqual(updates[0].filters[0], ['id', 'ap-1']);

  const insert = admin._log.find((r) => r.tabel === 'follow_up_appointments' && r.op === 'insert');
  assert.ok(insert, 'er hoort een nieuwe rij bij te komen');
  assert.equal(insert.waarde.parent_appointment_id, 'ap-1');
  assert.equal(insert.waarde.status, 'scheduled');
  assert.equal(insert.waarde.scheduled_at, NIEUW_MOMENT);
  assert.equal(insert.waarde.ghl_appointment_id, null, 'de parent houdt de GHL-id (UNIQUE)');
  assert.equal(uit.nieuweAfspraak.id, 'ap-nieuw');
});

test('GEEN uitkomst, GEEN no-show, GEEN kaart — verzet is geen oordeel', async (t) => {
  // Dit is de hele reden dat deze knop bestaat. Schrijft de motor hier ook maar
  // één uitkomst, dan is het rapport van morgen weer onwaar.
  t.after(() => mock.reset());
  const { verzetAfspraak } = await laadMotor();
  const admin = nepAdmin();
  await verzetAfspraak({ supabaseAdmin: admin, afspraak: OUDE_CALL, nieuwStartIso: NIEUW_MOMENT });

  for (const r of admin._log) {
    const j = JSON.stringify(r.waarde || {});
    assert.doesNotMatch(j, /"uitkomst"/, 'geen uitkomst op een verzette afspraak');
    assert.doesNotMatch(j, /no_show/, 'en zeker geen no-show');
  }
  assert.equal(admin._log.filter((r) => r.tabel === 'opvolging_taken').length, 0,
    'verzetten maakt geen werklijstkaart');
});

test('GHL gaat eerst, en faalt hij, dan is er niets geschreven', async (t) => {
  // Validate-first. Andersom zou de databank een verzetting kennen die in de
  // agenda van Dave nooit gebeurd is — en dan staat er een spookafspraak op
  // het oude uur.
  t.after(() => mock.reset());
  const { verzetAfspraak, gebeld } = await laadMotor({ ghlFaalt: true });
  const admin = nepAdmin();
  await assert.rejects(
    () => verzetAfspraak({ supabaseAdmin: admin, afspraak: OUDE_CALL, nieuwStartIso: NIEUW_MOMENT }),
    (e) => e.code === 'GHL_UPDATE' && e.ghlStatus === 400,
  );
  assert.equal(admin._log.length, 0, 'geen enkele schrijfactie na een mislukte GHL-call');
  assert.equal(gebeld[0].wat, 'ghl');
});

test('de bestaande GHL-afspraak wordt VERZET, niet geannuleerd en opnieuw gemaakt', async (t) => {
  // Anders blijft er een afspraak op het oude uur in Daves agenda staan.
  t.after(() => mock.reset());
  const { verzetAfspraak, gebeld } = await laadMotor();
  await verzetAfspraak({ supabaseAdmin: nepAdmin(), afspraak: OUDE_CALL, nieuwStartIso: NIEUW_MOMENT });
  const ghl = gebeld.find((g) => g.wat === 'ghl');
  assert.equal(ghl.id, 'ghl-ap-1', 'op de BESTAANDE afspraak-id');
  assert.equal(ghl.s, NIEUW_MOMENT);
  assert.equal(ghl.e, '2026-09-15T12:00:00.000Z', 'nieuw moment plus de duur');

  const bron = readFileSync(MOTOR, 'utf8');
  assert.doesNotMatch(bron, /cancelGhlAppointment|deleteGhlAppointment/,
    'annuleren-en-opnieuw laat een spookafspraak achter');
});

test('mislukt de nieuwe rij, dan gaat de oude terug naar scheduled', async (t) => {
  t.after(() => mock.reset());
  const { verzetAfspraak } = await laadMotor();
  const admin = nepAdmin({ insertFaalt: true });
  await assert.rejects(
    () => verzetAfspraak({ supabaseAdmin: admin, afspraak: OUDE_CALL, nieuwStartIso: NIEUW_MOMENT }),
    (e) => e.code === 'CHILD_INSERT',
  );
  const updates = admin._log.filter((r) => r.op === 'update' && r.tabel === 'follow_up_appointments');
  assert.equal(updates.length, 2, 'heen en terug');
  assert.deepEqual(updates[1].waarde, { status: 'scheduled' }, 'de afspraak mag nergens verdwijnen');
});

test('de proefvlag reist mee naar de nieuwe rij', async (t) => {
  // Een testafspraak die na het verzetten als echte afspraak terugkomt staat
  // morgen in Daves lijst en in het rapport. Zelfde les als PR 6.
  t.after(() => mock.reset());
  const { verzetAfspraak } = await laadMotor();
  const admin = nepAdmin();
  await verzetAfspraak({
    supabaseAdmin: admin, afspraak: { ...OUDE_CALL, is_test: true }, nieuwStartIso: NIEUW_MOMENT,
  });
  const insert = admin._log.find((r) => r.op === 'insert' && r.tabel === 'follow_up_appointments');
  assert.equal(insert.waarde.is_test, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · HET ENDPOINT — OOK ZONDER TAAK
// ═══════════════════════════════════════════════════════════════════════════

function nepRes() {
  const uit = { code: null, body: null, headers: {} };
  return {
    setHeader: (k, v) => { uit.headers[k] = v; },
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
    _uit: uit,
  };
}

/**
 * Laadt het endpoint met de VERZET-MOTOR als dubbelganger.
 *
 * Waarom niet de echte motor met een gestubde GHL: dit testbestand importeert
 * verzet-afspraak.js ook bovenaan, statisch. Die module heeft zijn eigen import
 * van ghl-appointment.js dan al gebonden, en een mock.module() daarna verandert
 * daar niets meer aan — de endpoint-test zou dan de ECHTE GHL-call doen.
 *
 * De verdeling is daarmee scherp, en dat is geen verlies: sectie 2 draait de
 * echte motor tegen een gestubde GHL en kijkt naar wat er geschreven wordt;
 * hier kijken we naar wat het ENDPOINT doet — lezen, weigeren, de motor met de
 * juiste gegevens aanroepen, kaarten sluiten, en foutcodes naar HTTP vertalen.
 */
async function laadAgenda({ rijen = {}, mag = true, ghlFaalt = false } = {}) {
  const admin = nepAdmin({ rijen });
  const motorGebeld = [];
  mock.module(url('api/_lib/verzet-afspraak.js'), {
    namedExports: {
      // De pure functies echt, niet nagebouwd: anders test de 409-tak een
      // kopie van de regel in plaats van de regel.
      verzetBlokkade, VERZETBARE_STATUSSEN, mapGhlError, VERZET_DUUR_MIN: 30,
      verzetAfspraak: async (o) => {
        motorGebeld.push(o);
        if (ghlFaalt) {
          const e = new Error('stuk'); e.code = 'GHL_UPDATE'; e.ghlStatus = 400;
          e.ghlBody = 'no slot available'; throw e;
        }
        return {
          nieuweAfspraak: { id: 'ap-nieuw', scheduled_at: o.nieuwStartIso },
          ghlBijgewerkt: true, zoomBijgewerkt: true,
        };
      },
    },
  });
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin,
      supabase: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) } },
      createUserClient: () => ({
        ...admin,
        auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
      }),
      checkCronAuth: () => ({ ok: true }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: {
      requirePermission: async () => mag,
      requirePermissionFailOpen: async () => mag,
      checkPermissionOrDeny: async () => mag,
    },
  });
  mock.module(url('api/_lib/ghl-appointment.js'), {
    namedExports: {
      updateGhlAppointmentTime: async () => {
        if (ghlFaalt) {
          const e = new Error('stuk'); e.ghlStatus = 400; e.ghlBody = 'no slot available'; throw e;
        }
        return { ok: true };
      },
    },
  });
  mock.module(url('api/_lib/zoom-meeting.js'), {
    namedExports: { updateZoomMeetingTime: async () => ({ ok: true }) },
  });
  mock.module(url('api/_lib/afspraak-status-notify.js'), {
    namedExports: { stuurVerzetBericht: async () => {}, stuurBevestiging: async () => {} },
  });
  const mod = await import(url('api/opvolging-agenda.js') + '?t=' + Math.random());
  return { handler: mod.default, admin, motorGebeld };
}

const post = (body) => ({ method: 'POST', headers: { authorization: 'Bearer x' }, body, query: {} });

test('een call ZONDER taak is gewoon te verzetten', async (t) => {
  // Het normale geval: de lead boekte zelf een zoomcall en kwam nooit in de
  // werklijst. Een guard op een taak zou dit venster stil laten sneuvelen —
  // precies wat er met de vier call-uitkomsten gebeurde.
  t.after(() => mock.reset());
  const { handler, admin, motorGebeld } = await laadAgenda({
    rijen: { follow_up_appointments: [OUDE_CALL], opvolging_taken: [] },
  });
  const res = nepRes();
  await handler(post({ appointment_id: 'ap-1', start: NIEUW_MOMENT }), res);

  assert.equal(res._uit.code, 200, JSON.stringify(res._uit.body));
  assert.equal(res._uit.body.verzet.appointment_id, 'ap-1');
  assert.equal(res._uit.body.verzet.naar, NIEUW_MOMENT);
  assert.equal(res._uit.body.kaarten_gesloten, 0);

  // De motor krijgt de oude rij en het gekozen moment — niet een taak.
  assert.equal(motorGebeld.length, 1);
  assert.equal(motorGebeld[0].afspraak.id, 'ap-1');
  assert.equal(motorGebeld[0].nieuwStartIso, NIEUW_MOMENT);
  assert.equal(motorGebeld[0].bron, 'opvolging-afronden');
  assert.equal(admin._log.filter((r) => r.op === 'insert').length, 0,
    'het endpoint schrijft zelf niets — dat doet de motor');
});

test('een open zoom_geannuleerd-kaart voor deze lead gaat dicht', async (t) => {
  // De opdracht op die kaart is 'plan hem opnieuw in', en dat is zojuist
  // gebeurd. Blijft hij staan, dan belt Dave iemand over iets wat al geregeld
  // is — dezelfde valse taak als in PR 8.
  t.after(() => mock.reset());
  const { handler, admin } = await laadAgenda({
    rijen: {
      follow_up_appointments: [OUDE_CALL],
      opvolging_taken: [
        { id: 't1', telefoon: '0612345678', status: 'open', reden: 'zoom_geannuleerd', bron_ref: {} },
      ],
    },
  });
  const res = nepRes();
  await handler(post({ appointment_id: 'ap-1', start: NIEUW_MOMENT }), res);

  assert.equal(res._uit.code, 200);
  assert.equal(res._uit.body.kaarten_gesloten, 1);
  const dicht = admin._log.find((r) => r.tabel === 'opvolging_taken' && r.op === 'update');
  assert.equal(dicht.waarde.status, 'gearchiveerd');
  assert.match(dicht.waarde.archief_reden, /opnieuw ingepland/i);
});

test('een al verzette afspraak geeft 409 met een leesbare reden, geen 500', async (t) => {
  t.after(() => mock.reset());
  const { handler, admin, motorGebeld } = await laadAgenda({
    rijen: { follow_up_appointments: [{ ...OUDE_CALL, status: 'verplaatst' }] },
  });
  const res = nepRes();
  await handler(post({ appointment_id: 'ap-1', start: NIEUW_MOMENT }), res);
  assert.equal(res._uit.code, 409);
  assert.match(res._uit.body.error, /al verzet/i);
  assert.equal(admin._log.length, 0, 'en er is niets geschreven');
  assert.equal(motorGebeld.length, 0, 'de motor wordt niet eens aangeroepen');
});

test('een appointment_id dat niet bestaat geeft 404', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadAgenda({ rijen: { follow_up_appointments: [] } });
  const res = nepRes();
  await handler(post({ appointment_id: 'weg', start: NIEUW_MOMENT }), res);
  assert.equal(res._uit.code, 404);
});

test('een mislukte GHL-call geeft 422 in gewone taal en schrijft niets', async (t) => {
  t.after(() => mock.reset());
  const { handler, admin } = await laadAgenda({
    rijen: { follow_up_appointments: [OUDE_CALL] }, ghlFaalt: true,
  });
  const res = nepRes();
  await handler(post({ appointment_id: 'ap-1', start: NIEUW_MOMENT }), res);
  assert.equal(res._uit.code, 422);
  assert.match(res._uit.body.error, /niet beschikbaar/i);
  assert.equal(admin._log.length, 0, 'geen kaart gesloten op een verzetting die niet doorging');
});

test('zonder start is het 400, en de oude taak_id-weg blijft bestaan', async (t) => {
  t.after(() => mock.reset());
  const { handler } = await laadAgenda({ rijen: { follow_up_appointments: [OUDE_CALL] } });
  const res = nepRes();
  await handler(post({ appointment_id: 'ap-1' }), res);
  assert.equal(res._uit.code, 400);

  const bron = readFileSync(AGENDA, 'utf8');
  assert.match(bron, /if \(b\.appointment_id\) return await verzetCall/);
  assert.match(bron, /taak_id of appointment_id ontbreekt/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE OUDE RIJ VERDWIJNT NERGENS, EN WORDT NERGENS BEOORDEELD
// ═══════════════════════════════════════════════════════════════════════════

test('Nog af te ronden pakt "verplaatst" niet op', () => {
  // Anders duikt de oude call morgen op als onafgeronde achterstand, met een
  // knop om alsnog een uitkomst te kiezen die niet meer bestaat.
  assert.ok(!ACHTERSTAND_STATUS.includes('verplaatst'));
  assert.deepEqual(ACHTERSTAND_STATUS, ['scheduled', 'in_progress', 'completed', 'no_show']);
});

test('het rapport noemt de oude rij verzet en beoordeelt hem niet', () => {
  const nu = Date.parse('2026-09-20T10:00:00Z');
  assert.equal(callStaat({ status: 'verplaatst', scheduled_at: OUDE_CALL.scheduled_at }, nu), 'verplaatst');
  // En zodra de opvolger in dezelfde periode staat valt de voorganger er
  // helemaal uit — anders staat dezelfde persoon er twee keer in.
  const lijst = relevanteAfspraken([
    { id: 'ap-1', status: 'verplaatst', scheduled_at: OUDE_CALL.scheduled_at },
    { id: 'ap-2', status: 'scheduled', scheduled_at: NIEUW_MOMENT, parent_appointment_id: 'ap-1' },
  ], nu);
  assert.equal(lijst.length, 1);
  assert.equal(lijst[0].id, 'ap-2');
});

test('de annuleringen-cron maakt geen kaart van een verzette afspraak', () => {
  // Die cron selecteert op status 'cancelled'. 'verplaatst' hoort daar niet
  // bij, en dat moet zo blijven: een verzette call is niet afgezegd.
  const bron = readFileSync(join(ROOT, 'api/cron-opvolging-annuleringen.js'), 'utf8');
  assert.match(bron, /=== 'cancelled'/);
  assert.doesNotMatch(bron, /'verplaatst'/);
});

test('de 12u-instroom kijkt alleen naar geplande calls', () => {
  // De NIEUWE rij staat op 'scheduled' en op zijn eigen dag; die krijgt daar
  // gewoon zijn nabel-instroom. De oude staat op 'verplaatst' en valt eruit.
  const bron = readFileSync(join(ROOT, 'api/cron-opvolging-zoom-nabel.js'), 'utf8');
  assert.match(bron, /\.eq\('status', 'scheduled'\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · 'VERZET NAAR …' OP DE OUDE DAG
// ═══════════════════════════════════════════════════════════════════════════

test('de bestemming komt uit de opvolger, niet uit het niets', () => {
  const kaart = bestemmingPerParent([
    { id: 'ap-2', parent_appointment_id: 'ap-1', scheduled_at: '2026-09-15T11:30:00.000Z' },
  ]);
  const b = kaart.get('ap-1');
  assert.equal(b.dag, '2026-09-15');
  assert.equal(b.tijd, '13:30', 'Amsterdamse tijd, niet UTC');
});

test('twee opvolgers: het laatste moment wint', () => {
  const kaart = bestemmingPerParent([
    { parent_appointment_id: 'ap-1', scheduled_at: '2026-09-15T11:30:00.000Z' },
    { parent_appointment_id: 'ap-1', scheduled_at: '2026-09-18T09:00:00.000Z' },
  ]);
  assert.equal(kaart.get('ap-1').dag, '2026-09-18');
});

test('het label op de oude dag noemt de dag én het uur', () => {
  const dagen = [{ dag: '2026-09-11', gepland: [{ appointment_id: 'ap-1', label: 'verzet' }] }];
  const n = vulVerzetBestemming(dagen, bestemmingPerParent([
    { parent_appointment_id: 'ap-1', scheduled_at: '2026-09-15T11:30:00.000Z' },
  ]));
  assert.equal(n, 1);
  assert.match(dagen[0].gepland[0].label, /^verzet naar /);
  assert.match(dagen[0].gepland[0].label, /13:30/);
  assert.deepEqual(dagen[0].gepland[0].verzet_naar, { dag: '2026-09-15', tijd: '13:30' });
});

test('een regel die al een bestemming heeft blijft ongemoeid', () => {
  // Die komt uit eerst_gepland_op (de andere vorm van verzetten) en is even
  // waar. Overschrijven zou een werkend label vervangen door een tweede bron.
  const dagen = [{ dag: '2026-09-11', gepland: [{ appointment_id: 'ap-1', label: 'verzet naar 12 september om 10:00' }] }];
  const n = vulVerzetBestemming(dagen, bestemmingPerParent([
    { parent_appointment_id: 'ap-1', scheduled_at: '2026-09-15T11:30:00.000Z' },
  ]));
  assert.equal(n, 0);
  assert.match(dagen[0].gepland[0].label, /12 september/);
});

test('en een regel die geen verzetting is krijgt er geen', () => {
  // Deze functie vult een bestemming aan; hij spreekt geen nieuw oordeel uit.
  const dagen = [{ dag: '2026-09-11', gepland: [{ appointment_id: 'ap-1', label: null }] }];
  vulVerzetBestemming(dagen, bestemmingPerParent([
    { parent_appointment_id: 'ap-1', scheduled_at: '2026-09-15T11:30:00.000Z' },
  ]));
  assert.equal(dagen[0].gepland[0].label, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6 · HET VENSTER
// ═══════════════════════════════════════════════════════════════════════════

test('het afrondvenster heeft een vijfde optie: opnieuw inplannen', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf("if (m.soort === 'call-afrond')");
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 1800);
  for (const knop of ['klant_geworden', 'wil_nog_beslissen', 'no_show', 'geen_interesse']) {
    assert.match(blok, new RegExp("__opvCallUitkomst\\('" + knop + "'\\)"), knop + ' hoort te blijven');
  }
  assert.match(blok, /Opnieuw inplannen/);
  assert.match(blok, /window\.__opvCallVerzet\(\)/);
  // GEEN __opvCallUitkomst: er wordt niets beoordeeld, er wordt verplaatst.
  assert.doesNotMatch(blok, /__opvCallUitkomst\('verzet/);
});

test("'call-verzet' staat bij de vensters die geen taak nodig hebben", () => {
  // Dit is de stille-guard-val van eerder: een zoomcall heeft meestal geen
  // taak, en dan sneuvelt het venster op de taak-guard in modalHtml().
  const bron = readFileSync(VIEW, 'utf8');
  const m = bron.match(/const MODAL_ZONDER_TAAK = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'MODAL_ZONDER_TAAK hoort te bestaan');
  assert.match(m[1], /'call-verzet'/);
});

test('het verzet-venster toont de agenda en GEEN handmatige datumkeuze', () => {
  // Een zoomcall heeft een uur nodig. Een kale datum levert een afspraak op
  // waar geen moment bij hoort.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf("if (m.soort === 'call-verzet')");
  assert.ok(i > 0, 'het venster hoort te bestaan');
  const blok = bron.slice(i, i + 1400);
  assert.match(blok, /agendaBlok\(\{ handmatig: false \}\)/);
  assert.doesNotMatch(blok, /type="date"/, 'geen kale datumkeuze bij een zoomcall');
  assert.doesNotMatch(blok, /__opvVerplaats/);
});

test('zonder afspraak-id een melding, nooit een leeg venster', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf("if (m.soort === 'call-verzet')");
  const blok = bron.slice(i, i + 900);
  assert.match(blok, /if \(!c\.appointment_id\)/);
  assert.match(blok, /geen afspraak-id/i);
});

test('valt de agenda weg, dan verwijst de melding niet naar een knop die er niet is', () => {
  // agendaBlok() wordt door twee vensters gebruikt. Het ene heeft een
  // datumveld eronder, het andere niet — en 'zet hem hieronder zelf op een
  // dag' is dan een verwijzing naar het niets.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function agendaBlok(');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 4200);
  assert.match(blok, /const handmatig = !o \|\| o\.handmatig !== false;/);
  assert.match(blok, /handmatig[\s\S]{0,200}hieronder gewoon zelf op een dag/);
  assert.match(blok, /Geen momenten in deze week/, 'nul dagen is geen leeg scherm');
});

test('tijdens het vastleggen zijn de slots dood', () => {
  // Twee klikken op twee momenten zouden anders twee afspraken opleveren, en
  // bij verzetten een tweede keten op dezelfde lead.
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('function agendaBlok(');
  const blok = bron.slice(i, i + 4200);
  assert.match(blok, /const bezig = !!_ui\.bezig;/);
  assert.match(blok, /bezig[\s\S]{0,220}cursor:default/);
  assert.match(blok, /Bezig met vastleggen/);
});

test('__opvBoek kiest zijn bestemming op de soort van het venster', () => {
  const bron = readFileSync(VIEW, 'utf8');
  const i = bron.indexOf('window.__opvBoek = async');
  assert.ok(i > 0);
  const blok = bron.slice(i, i + 2400);
  assert.match(blok, /m\.soort === 'call-verzet'/);
  assert.match(blok, /appointment_id: call\.appointment_id/);
  assert.match(blok, /taak_id: m\.taakId/, 'de bestaande weg blijft');
  assert.match(blok, /if \(_ui\.bezig\) return;/, 'dubbelklik-guard');
  assert.match(blok, /finally \{/, 'en bezig gaat altijd weer uit');
});

test('de view is opgehoogd zodat de browser de nieuwe versie haalt', () => {
  const html = readFileSync(join(ROOT, 'modules/klanten-v2/index.html'), 'utf8');
  const m = html.match(/views\/opvolging-v2\.js\?v=(\d+)/);
  assert.ok(m, 'de view hoort met een ?v= geladen te worden');
  assert.ok(Number(m[1]) >= 63, 'PR 10 hoort hem op minstens 63 te zetten');
});
