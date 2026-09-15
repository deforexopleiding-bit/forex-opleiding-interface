// tests/events-automation-test-begintoestand.test.js
//
// DE TESTDEELNEMER BEGON NIET WAAR DE TRIGGER BEGINT.
//
// Gemeten op 15 september in productie, run 5e9f8deb… op 'Geen gehoor -
// laatste kans' (deelnemer 2ea7e337…, event 26 sep Gent):
//
//   stap 0  send_email                 gedaan  16:28
//   stap 1  send_whatsapp              gedaan  16:28 (echte wamid)
//   stap 2  wait                       versneld naar 15s
//   stap 3  condition                  NIET WAAR — flow stopt hier
//           "geen bruikbaar nulpunt (call_status_at ontbreekt of is onleesbaar)"
//   stap 4  update_attendee_status     niet meer gedraaid
//   stap 5  send_internal_notification niet meer gedraaid
//
// Dat de flow stopte was JUIST. De oorzaak zat in de TESTMOTOR:
// events-automation-test.js maakte de deelnemer met status 'aangemeld' maar
// zonder call_status en zonder call_status_at — een toestand die via geen
// enkel productiepad kan ontstaan, want beide schrijfpaden stempelen het
// tijdstip mee (zetBelstatusGeenGehoor en events-attendee-update).
//
// Deze test legt de regressie in BEIDE richtingen vast: met de begintoestand
// meet stap 3 en draaien stap 4 en 5; zonder stopt de run precies zoals
// gemeten.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { beginToestandVoorTrigger } from '../api/_lib/events-test-begintoestand.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE HELPER
// ═══════════════════════════════════════════════════════════════════════════

const NU = '2026-09-15T16:28:00.000Z';

test('on_call_status zet de belstatus uit de trigger-config én het nulpunt', () => {
  const uit = beginToestandVoorTrigger(
    { trigger_type: 'on_call_status', trigger_config: { call_status: 'geen_gehoor' } }, NU);
  assert.equal(uit.fout, null);
  assert.deepEqual(uit.patch, { call_status: 'geen_gehoor', call_status_at: NU });
});

test('de belstatus komt uit de config, niet uit een vaste waarde', () => {
  // Dezelfde trigger dekt later ook voicemail en foutief_nummer; dan hoort de
  // testdeelnemer dáár op te beginnen.
  const uit = beginToestandVoorTrigger(
    { trigger_type: 'on_call_status', trigger_config: { call_status: 'voicemail' } }, NU);
  assert.equal(uit.patch.call_status, 'voicemail');
});

test('witruimte rond de belstatus wordt weggehaald', () => {
  const uit = beginToestandVoorTrigger(
    { trigger_type: 'on_call_status', trigger_config: { call_status: '  geen_gehoor  ' } }, NU);
  assert.equal(uit.patch.call_status, 'geen_gehoor');
});

test('`called` gaat NIET mee — de trigger leest het niet', () => {
  // Een rij met een belstatus en called=false bestaat in productie ook: dat is
  // wat een handmatige wijziging in de eventmodule oplevert.
  const uit = beginToestandVoorTrigger(
    { trigger_type: 'on_call_status', trigger_config: { call_status: 'geen_gehoor' } }, NU);
  assert.deepEqual(Object.keys(uit.patch).sort(), ['call_status', 'call_status_at']);
});

test('een regel voor het scherm, met de belstatus en het nulpunt erin', () => {
  const uit = beginToestandVoorTrigger(
    { trigger_type: 'on_call_status', trigger_config: { call_status: 'geen_gehoor' } }, NU);
  assert.match(uit.tekst, /belstatus geen_gehoor/);
  assert.match(uit.tekst, /nulpunt/);
});

test('NOOIT STIL SLAGEN: geen call_status in de config = een fout, geen halve run', () => {
  for (const cfg of [{}, { call_status: '' }, { call_status: '   ' },
    { call_status: null }, { call_status: 42 }, null, undefined]) {
    const uit = beginToestandVoorTrigger({ trigger_type: 'on_call_status', trigger_config: cfg }, NU);
    assert.ok(uit.fout, 'config=' + JSON.stringify(cfg) + ' hoort te weigeren');
    assert.deepEqual(uit.patch, {}, 'en niets te zetten');
    // De fout legt uit wat er gebeurt als je hem toch zou starten.
    assert.match(uit.fout, /trigger_config\.call_status/);
  }
});

test('de andere trigger-types houden exact het huidige gedrag', () => {
  for (const t of ['on_signup', 'on_assessment_completed', 'time_before_event',
    'on_assessment_not_completed_after', 'iets_nieuws', '', undefined]) {
    const uit = beginToestandVoorTrigger({ trigger_type: t, trigger_config: {} }, NU);
    assert.deepEqual(uit.patch, {}, 'trigger=' + t);
    assert.equal(uit.fout, null, 'trigger=' + t + ' mag niet weigeren');
    assert.equal(uit.tekst, null);
  }
  // En zonder automatisatie-object valt hij ook niet om.
  assert.deepEqual(beginToestandVoorTrigger(null, NU).patch, {});
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · HET ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

function nepAdmin({ automation } = {}) {
  const inserts = [];
  let nr = 0;
  const from = (tabel) => {
    const k = {
      select: () => k, eq: () => k, delete: () => k,
      insert(v) { inserts.push({ tabel, row: v }); return k; },
      maybeSingle: async () => ({
        data: tabel === 'event_automations' ? automation
            : tabel === 'events' ? { id: 'ev-1', status: 'published' } : null,
        error: null,
      }),
      single: async () => ({ data: { id: (tabel === 'event_attendees' ? 'att-' : 'run-') + (++nr) }, error: null }),
      then: (r) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return k;
  };
  return { from, inserts };
}

const GELDIG = {
  automation_id: '22222222-2222-2222-2222-222222222222',
  event_id     : '11111111-1111-1111-1111-111111111111',
  first_name   : 'TEST', last_name: 'Jeffrey',
  email        : 'biemoldjeffrey@gmail.com', phone: '+31600000000',
  allow_disabled: true,
};

async function postTest(body, { automation } = {}) {
  const admin = nepAdmin({ automation });
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin,
      createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }),
      checkCronAuth: () => ({ ok: true }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  mock.module(url('api/_lib/requirePermission.js'), {
    namedExports: {
      requirePermission: async () => true,
      requirePermissionFailOpen: async () => true,
      checkPermissionOrDeny: async () => true,
    },
  });
  const mod = await import(url('api/events-automation-test.js') + '?t=' + Math.random());
  const uit = { code: null, body: null };
  await mod.default({ method: 'POST', headers: {}, body }, {
    setHeader() {}, status(c) { uit.code = c; return this; }, json(b) { uit.body = b; return this; },
  });
  return { res: uit, admin };
}

const GG = {
  id: GELDIG.automation_id, name: 'Geen gehoor - laatste kans', enabled: false,
  trigger_type: 'on_call_status', trigger_config: { call_status: 'geen_gehoor' },
  steps: [{ type: 'send_email' }, { type: 'send_whatsapp' }, { type: 'wait' },
    { type: 'condition' }, { type: 'update_attendee_status' }, { type: 'send_internal_notification' }],
};

test('de testdeelnemer wordt aangemaakt MET call_status en call_status_at', async (t) => {
  t.after(() => mock.reset());
  const { res, admin } = await postTest(GELDIG, { automation: GG });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const att = admin.inserts.find((i) => i.tabel === 'event_attendees');
  assert.equal(att.row.call_status, 'geen_gehoor');
  assert.ok(att.row.call_status_at, 'het nulpunt hoort gezet te zijn');
  // En de rest van de rij is ongewijzigd.
  assert.equal(att.row.status, 'aangemeld');
  assert.equal(att.row.is_test, true);
  assert.equal(att.row.source, 'automation_test');
});

test('het nulpunt is hetzelfde moment als registered_at', async (t) => {
  t.after(() => mock.reset());
  const { admin } = await postTest(GELDIG, { automation: GG });
  const att = admin.inserts.find((i) => i.tabel === 'event_attendees');
  assert.equal(att.row.call_status_at, att.row.registered_at);
});

test('het antwoord vertelt welke begintoestand gezet is', async (t) => {
  t.after(() => mock.reset());
  const { res } = await postTest(GELDIG, { automation: GG });
  assert.deepEqual(Object.keys(res.body.begintoestand).sort(), ['call_status', 'call_status_at']);
  assert.match(res.body.begintoestand_tekst, /belstatus geen_gehoor/);
  assert.equal(res.body.trigger_type, 'on_call_status');
});

test('zonder call_status op de trigger: 400 en GEEN deelnemer, GEEN run', async (t) => {
  t.after(() => mock.reset());
  const { res, admin } = await postTest(GELDIG,
    { automation: { ...GG, trigger_config: {} } });
  assert.equal(res.code, 400);
  assert.match(res.body.error, /trigger_config\.call_status/);
  // DIT IS HET PUNT: liever niets dan een run die drie stappen later stukloopt.
  assert.equal(admin.inserts.length, 0);
});

test('een on_signup-automatisatie krijgt geen belstatus opgeplakt', async (t) => {
  t.after(() => mock.reset());
  const { res, admin } = await postTest(GELDIG, {
    automation: { ...GG, trigger_type: 'on_signup', trigger_config: {}, enabled: true },
  });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  const att = admin.inserts.find((i) => i.tabel === 'event_attendees');
  assert.equal('call_status' in att.row, false, 'bestaand gedrag blijft bestaand gedrag');
  assert.equal('call_status_at' in att.row, false);
  assert.equal(res.body.begintoestand_tekst, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE HELE FLOW, MET DE ECHTE MOTOR
// ═══════════════════════════════════════════════════════════════════════════
//
// Dit is de meting die telt: stepDueRuns over alle zes stappen, met de echte
// condition-lib eronder. Eén keer met de begintoestand (alles moet draaien) en
// één keer zonder (de run moet stoppen zoals in productie gemeten).

/** Stateful nep-databank: houdt attendee, run en log bij tussen de ticks. */
function nepWereld({ attendee, run, event, waMessages = [], mails = [], convs = [] }) {
  const log = [];
  const state = { attendee: { ...attendee }, run: { ...run }, log };
  const from = (tabel) => {
    const f = { tabel, filters: [], patch: null };
    const rows = () => {
      if (tabel === 'event_automation_runs') {
        return String(state.run.status) === 'active' ? [state.run] : [];
      }
      if (tabel === 'whatsapp_conversations') return convs;
      if (tabel === 'whatsapp_messages')      return waMessages;
      if (tabel === 'email_messages')         return mails;
      return [];
    };
    const k = {
      select: () => k,
      eq(c, v) { f.filters.push([c, v]); return k; },
      in: () => k, is: () => k, not: () => k, or: () => k,
      gt: () => k, gte: () => k, lt: () => k, lte: () => k, ilike: () => k,
      order: () => k, limit: () => k,
      update(v) {
        f.patch = v;
        if (tabel === 'event_attendees') Object.assign(state.attendee, v);
        if (tabel === 'event_automation_runs') Object.assign(state.run, v);
        return k;
      },
      insert(v) {
        if (tabel === 'event_automation_run_log') log.push(v);
        return k;
      },
      maybeSingle: async () => {
        if (tabel === 'event_attendees')  return { data: state.attendee, error: null };
        if (tabel === 'events')           return { data: event, error: null };
        if (tabel === 'event_automation_run_log') {
          const idx = (f.filters.find((x) => x[0] === 'step_index') || [])[1];
          const hit = log.find((l) => Number(l.step_index) === Number(idx));
          return { data: hit ? { id: 'l' } : null, error: null };
        }
        return { data: null, error: null };
      },
      single: async () => ({ data: null, error: null }),
      then: (r) => Promise.resolve({ data: rows(), error: null }).then(r),
    };
    return k;
  };
  return { from, state, log };
}

const EVENT = { id: 'ev-gent', title: 'Forex Masterclass Gent',
  starts_at: '2026-09-26T17:00:00.000Z', location: 'Gent', niveau: 'masterclass',
  capacity: 20, status: 'published' };

const STAPPEN = [
  { type: 'send_email', config: { subject: 'Je plek', body: 'Beste {{attendee.voornaam}}' } },
  { type: 'send_whatsapp', config: { template_name: 'geen_gehoor_bevestiging' } },
  { type: 'wait', config: { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 48 } },
  { type: 'condition', config: { check: 'geen_reactie_sinds_belstatus', on_fail: 'exit' } },
  { type: 'update_attendee_status', config: { new_status: 'geannuleerd', call_status: 'komt_niet' } },
  { type: 'send_internal_notification', config: { to_email: 'maxim@deforexopleiding.nl',
      subject: 'Plek vervallen', body: '{{attendee.naam}} is niet bereikt' } },
];

/** Draait de motor tot de run niet meer 'active' is (max 12 ticks). */
async function draaiFlow({ callStatusAt }) {
  const wereld = nepWereld({
    attendee: {
      id: 'att-test', event_id: 'ev-gent', first_name: 'TEST · Maxim', last_name: 'D',
      email: 'maxim@deforexopleiding.nl', phone: '+32470000000',
      status: 'aangemeld', is_test: true,
      call_status: callStatusAt ? 'geen_gehoor' : null,
      call_status_at: callStatusAt || null,
      assessment_response_id: null, choice_token: 't', customer_id: null,
    },
    run: {
      id: 'run-1', automation_id: 'auto-gg', attendee_id: 'att-test', event_id: 'ev-gent',
      status: 'active', current_step_index: 0, next_run_at: null,
      steps_snapshot: STAPPEN, context: {}, attempts: 0, last_error: null, is_test: true,
    },
    event: EVENT,
  });

  const mails = [];
  const wa = [];
  const internal = [];

  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: wereld, createUserClient: () => wereld,
      checkCronAuth: () => ({ ok: true }), ADMIN_ROLES: [],
    },
  });
  mock.module(url('api/_lib/events-send.js'), {
    namedExports: {
      sendEventEmail: async (o) => { mails.push(o); return { ok: true, to: o.attendee?.email }; },
      sendEventWhatsAppTemplate: async (o) => { wa.push(o); return { ok: true, meta_wamid: 'wamid.TEST123' }; },
      renderEmailParts: () => ({ subject: '', text: '', html: '' }),
    },
  });
  mock.module(url('api/_lib/comms-log.js'), {
    namedExports: { logComms: async () => ({}), mapSendStatus: () => ({ status: 'sent', reason: null }) },
  });
  mock.module(url('api/_lib/event-attendee-mutations.js'), {
    namedExports: {
      onConfirmedAttendeeMutation: async () => ({ ok: true }),
      onAttendeePlekChange: async () => ({ ok: true }),
      PLEK_SELECT: 'id',
    },
  });
  mock.module(url('api/mailer.js'), {
    namedExports: {
      sendEventMail: async (o) => { internal.push(o); return { ok: true }; },
      sendMail: async () => ({ ok: true }), wrapEmailHtml: (t, b) => b,
    },
  });

  const eng = await import(url('api/_lib/events-automation-engine.js') + '?t=' + Math.random());
  let nu = Date.parse('2026-09-15T16:28:00.000Z');
  for (let i = 0; i < 12 && String(wereld.state.run.status) === 'active'; i++) {
    await eng.stepDueRuns({ now: new Date(nu) });
    nu += 30_000;   // de cron tikt elke minuut; 15s test-wait is dan verstreken
  }
  return { wereld, mails, wa, internal, log: wereld.log };
}

test('MET de begintoestand: alle zes stappen draaien', async (t) => {
  t.after(() => mock.reset());
  const { wereld, mails, wa, internal, log } = await draaiFlow({
    callStatusAt: '2026-09-15T16:28:00.000Z',
  });

  // stap 0 + 1 — de twee berichten
  assert.equal(mails.length, 1, 'de mail hoort één keer uit te gaan');
  assert.equal(wa.length, 1, 'de WhatsApp-template hoort één keer uit te gaan');

  // stap 3 — DE CONDITIE MEET NU ECHT
  const cond = log.find((l) => l.step_type === 'condition');
  assert.ok(cond, 'de conditie hoort gedraaid te hebben');
  assert.equal(cond.result.niet_gemeten, false, 'niet meer "niet gemeten" — dit was de bug');
  assert.equal(cond.result.pass, true, 'niets binnengekomen = waar, dus door');
  assert.match(String(cond.result.meting_reden), /geen inkomend bericht/);

  // stap 4 — DE STATUS WORDT ECHT BIJGEWERKT
  assert.equal(wereld.state.attendee.status, 'geannuleerd');
  assert.equal(wereld.state.attendee.call_status, 'komt_niet');
  const upd = log.find((l) => l.step_type === 'update_attendee_status');
  assert.equal(upd.result.ok, true);
  assert.equal(upd.result.new_status, 'geannuleerd');

  // stap 5 — DE INTERNE NOTIFICATIE GAAT ECHT
  assert.equal(internal.length, 1, 'de melding aan Maxim hoort verstuurd te zijn');
  assert.equal(internal[0].to, 'maxim@deforexopleiding.nl');
  assert.match(internal[0].subject, /\[INTERNAL\]/);

  // en de run is netjes afgerond
  assert.equal(wereld.state.run.status, 'completed');

  // VIJF LOGREGELS BIJ ZES STAPPEN, en dat is juist: de wait-tak in advanceRun
  // plant alleen next_run_at en breekt de loop — hij roept recordLog NIET aan.
  // Daarom mag de run-historie op het scherm niet op logregels alleen leunen;
  // een stap zonder regel wordt daar als 'wacht' getoond. Zou de motor hier
  // ooit wél voor een wait gaan loggen, dan hoort deze test te wijzigen en niet
  // stil mee te schuiven.
  assert.equal(log.length, 5, 'vijf logregels: alle stappen behalve de wait');
  assert.deepEqual(log.map((l) => l.step_type),
    ['send_email', 'send_whatsapp', 'condition', 'update_attendee_status', 'send_internal_notification']);
  assert.deepEqual(log.map((l) => l.step_index), [0, 1, 3, 4, 5],
    'step_index 2 (de wait) ontbreekt met opzet');
});

test('ZONDER de begintoestand: de run stopt bij stap 3, precies zoals gemeten', async (t) => {
  t.after(() => mock.reset());
  const { wereld, mails, wa, internal, log } = await draaiFlow({ callStatusAt: null });

  // De eerste twee stappen gingen in productie ook goed.
  assert.equal(mails.length, 1);
  assert.equal(wa.length, 1);

  // En hier liep het vast — met exact de gemeten reden.
  const cond = log.find((l) => l.step_type === 'condition');
  assert.equal(cond.result.pass, false);
  assert.equal(cond.result.niet_gemeten, true);
  assert.match(String(cond.result.meting_reden), /nulpunt/);

  // Stap 4 en 5 zijn nooit gedraaid — dat is juist gedrag, en precies waarom
  // ze ongetest bleven.
  assert.equal(log.find((l) => l.step_type === 'update_attendee_status'), undefined);
  assert.equal(internal.length, 0);
  assert.equal(wereld.state.attendee.status, 'aangemeld', 'geen plek afgenomen');
  assert.equal(wereld.state.run.status, 'exited');
});

test('en als er WEL een reactie is, stopt de flow ook — maar dan gemeten', async (t) => {
  t.after(() => mock.reset());
  // De derde uitkomst: gemeten, en er kwam iets binnen. Dan hoort de plek ook
  // te blijven staan, maar om een andere reden dan 'niet gemeten'.
  const wereld = nepWereld({
    attendee: {
      id: 'att-test', event_id: 'ev-gent', first_name: 'TEST · Maxim', last_name: 'D',
      email: 'maxim@deforexopleiding.nl', phone: '+32470000000',
      status: 'aangemeld', is_test: true,
      call_status: 'geen_gehoor', call_status_at: '2026-09-15T16:28:00.000Z',
      assessment_response_id: null,
    },
    run: {
      id: 'run-2', automation_id: 'auto-gg', attendee_id: 'att-test', event_id: 'ev-gent',
      status: 'active', current_step_index: 3, next_run_at: null,
      steps_snapshot: STAPPEN, context: {}, attempts: 0, last_error: null, is_test: true,
    },
    event: EVENT,
    convs: [{ id: 'c1', phone_number: '+32470000000' }],
    waMessages: [{ id: 'm1', body: 'ja ik kom!', created_at: '2026-09-15T17:00:00.000Z', direction: 'in' }],
  });
  mock.module(url('api/supabase.js'), {
    namedExports: { supabaseAdmin: wereld, createUserClient: () => wereld,
      checkCronAuth: () => ({ ok: true }), ADMIN_ROLES: [] },
  });
  mock.module(url('api/_lib/events-send.js'), {
    namedExports: { sendEventEmail: async () => ({ ok: true }),
      sendEventWhatsAppTemplate: async () => ({ ok: true }), renderEmailParts: () => ({}) },
  });
  mock.module(url('api/_lib/comms-log.js'), {
    namedExports: { logComms: async () => ({}), mapSendStatus: () => ({ status: 'sent' }) },
  });
  mock.module(url('api/_lib/event-attendee-mutations.js'), {
    namedExports: { onConfirmedAttendeeMutation: async () => ({}),
      onAttendeePlekChange: async () => ({}), PLEK_SELECT: 'id' },
  });
  mock.module(url('api/mailer.js'), {
    namedExports: { sendEventMail: async () => ({ ok: true }), sendMail: async () => ({ ok: true }),
      wrapEmailHtml: (t, b) => b },
  });
  const eng = await import(url('api/_lib/events-automation-engine.js') + '?t=' + Math.random());
  await eng.stepDueRuns({ now: new Date('2026-09-15T18:00:00.000Z') });

  const cond = wereld.log.find((l) => l.step_type === 'condition');
  assert.equal(cond.result.niet_gemeten, false, 'dit is WEL gemeten');
  assert.equal(cond.result.pass, false, 'er kwam een reactie, dus niet waar');
  assert.equal(cond.result.meting_treffers, 1);
  assert.equal(wereld.state.attendee.status, 'aangemeld', 'de plek blijft staan');
  assert.equal(wereld.state.run.status, 'exited');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HET SCHERM TOONT DE BEGINTOESTAND
// ═══════════════════════════════════════════════════════════════════════════

const VIEW = readFileSync(join(ROOT, 'modules/klanten-v2/views/automatiseringen-v2.js'), 'utf8');

test('het testvenster neemt de begintoestand-regel mee en toont hem', () => {
  assert.match(VIEW, /begintoestand_tekst: j\?\.begintoestand_tekst \|\| null/);
  const i = VIEW.indexOf('function _evTestResultModal()');
  const blok = VIEW.slice(i, VIEW.indexOf('function _runStatusPill', i));
  assert.match(blok, /r\.begintoestand_tekst/);
  assert.match(blok, /Begintoestand:/);
});

test('de regel staat onder de runkop, vóór de stappenlijst', () => {
  const i = VIEW.indexOf('function _evTestResultModal()');
  const blok = VIEW.slice(i, VIEW.indexOf('function _runStatusPill', i));
  const iKop  = blok.indexOf('_runStatusPill(runStatus)');
  const iRegel = blok.indexOf('begintoestand_tekst');
  const iStap = blok.indexOf('stappen.map(');
  assert.ok(iKop < iRegel && iRegel < iStap,
    'begintoestand hoort tussen de runkop en de stappen te staan');
});
