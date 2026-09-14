// tests/events-automation-on-call-status.test.js
//
// GEEN ENKELE TRIGGER KEEK NAAR DE BELSTATUS.
//
// Zes eventautomatiseringen draaien er (welkom+vragenlijst, herinnering,
// bevestiging, warmup 120u, reminder 24u, reminder laatste uren) op vier
// trigger-types: on_signup, on_assessment_completed, time_before_event,
// on_assessment_not_completed_after. Wat het belwerk oplevert deed nergens iets.
//
// Gemeten op 14 september op event_attendees.call_status: 85 leeg, 65
// bevestigd, 16 komt_niet, 15 geen_gehoor, 6 voicemail, 3 terugbellen, 1
// foutief_nummer. Die 15 geen_gehoor-rijen kregen nooit iets te horen.
//
// Deze test legt de vier filters vast die samen bepalen WIE er ingeschreven
// wordt, en vooral de vierde: new_only toetst op call_status_at. Zonder die
// regel worden bij het aanzetten van de automatisatie alle 15 bestaande rijen
// in één keer ingeschreven, en krijgt iemand die drie weken geleden gebeld is
// vandaag een deadline van 48 uur.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const NU = new Date('2026-09-14T12:00:00.000Z');

/**
 * Supabase-dubbelganger die de HELE filterketen per tabel onthoudt.
 *
 * Elke aanroep komt in `ketens` als { tabel, select, stappen: [[naam, ...args]] }.
 * Zo kan de test nakijken welke filters er op event_attendees gezet zijn — dat
 * is precies waar de trigger uit bestaat.
 */
function nepAdmin({ rijen = {} } = {}) {
  const ketens = [];
  const from = (tabel) => {
    const keten = { tabel, select: null, stappen: [] };
    ketens.push(keten);
    const data = () => Promise.resolve({ data: rijen[tabel] || [], error: null });
    const k = {
      select(kolommen) { keten.select = kolommen; return k; },
      eq(c, v)  { keten.stappen.push(['eq', c, v]);  return k; },
      neq(c, v) { keten.stappen.push(['neq', c, v]); return k; },
      in(c, v)  { keten.stappen.push(['in', c, v]);  return k; },
      is(c, v)  { keten.stappen.push(['is', c, v]);  return k; },
      not(c, o, v) { keten.stappen.push(['not', c, o, v]); return k; },
      gt(c, v)  { keten.stappen.push(['gt', c, v]);  return k; },
      gte(c, v) { keten.stappen.push(['gte', c, v]); return k; },
      lt(c, v)  { keten.stappen.push(['lt', c, v]);  return k; },
      lte(c, v) { keten.stappen.push(['lte', c, v]); return k; },
      or(s)     { keten.stappen.push(['or', s]);     return k; },
      order()   { return k; },
      limit(n)  { keten.stappen.push(['limit', n]);  return k; },
      insert(v) { keten.stappen.push(['insert', v]); keten.insert = v; return k; },
      update(v) { keten.stappen.push(['update', v]); return k; },
      // Na een insert geeft de echte client de nieuwe rij terug; de engine
      // telt daarop ('if (data) enrolled += 1').
      maybeSingle: async () => ({
        data: keten.insert ? { id: 'run-' + (ketens.length) } : ((rijen[tabel] || [])[0] || null),
        error: null,
      }),
      single: async () => ({
        data: keten.insert ? { id: 'run-' + (ketens.length) } : ((rijen[tabel] || [])[0] || null),
        error: null,
      }),
      then: (r, j) => data().then(r, j),
    };
    return k;
  };
  return { from, ketens };
}

/** De automatisatie zoals PR 4 hem aanmaakt. */
const AUTO = {
  id: 'auto-gg',
  trigger_type: 'on_call_status',
  trigger_config: { call_status: 'geen_gehoor' },
  scope_type: 'all',
  scope_config: {},
  enroll_mode: 'new_only',
  enabled_at: '2026-09-14T10:00:00.000Z',
  steps: [{ type: 'send_email', config: { subject: 's', body: 'b' } }],
};

async function enroll({ auto = AUTO, kandidaten = [] } = {}) {
  const admin = nepAdmin({
    rijen: {
      event_automations     : [auto],
      event_attendees       : kandidaten,
      event_automation_runs : [],
    },
  });
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin,
      createUserClient: () => admin,
      checkCronAuth: () => ({ ok: true }),
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  const mod = await import(url('api/_lib/events-automation-engine.js') + '?t=' + Math.random());
  const summary = await mod.enrollDueAttendees({ now: NU });
  const attendeeKeten = admin.ketens.find((k) => k.tabel === 'event_attendees');
  return { summary, admin, attendeeKeten };
}

/** Zoekt een filterstap op naam + kolom. */
const stap = (keten, naam, kolom) =>
  keten.stappen.find((s) => s[0] === naam && s[1] === kolom);

// ═══════════════════════════════════════════════════════════════════════════
// DE VIER FILTERS
// ═══════════════════════════════════════════════════════════════════════════

test('filtert op de belstatus uit trigger_config', async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll();
  assert.deepEqual(stap(attendeeKeten, 'eq', 'call_status'), ['eq', 'call_status', 'geen_gehoor']);
});

test('filtert op automation_enabled, zoals alle andere trigger-types', async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll();
  // Stil toegevoegde deelnemers mogen geen automation-flow krijgen.
  assert.deepEqual(stap(attendeeKeten, 'eq', 'automation_enabled'), ['eq', 'automation_enabled', true]);
});

test("alleen wie nog op 'aangemeld' staat", async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll();
  // Iemand die zelf afzegde heeft geen plek te verliezen, en 'aanwezig'/'sale'
  // zijn eindstanden.
  assert.deepEqual(stap(attendeeKeten, 'eq', 'status'), ['eq', 'status', 'aangemeld']);
});

test('alleen events die nog moeten komen — via de FK-gekwalificeerde join', async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll();
  const g = stap(attendeeKeten, 'gt', 'events.starts_at');
  assert.ok(g, 'events.starts_at > nu hoort erbij');
  assert.equal(g[2], NU.toISOString());

  // PGRST201-VALKUIL: event_attendees heeft TWEE FK's naar events (event_id +
  // switched_from_event_id), dus een kaal 'events!inner' is ambigu. De select
  // hoort de FK expliciet te noemen.
  assert.match(attendeeKeten.select, /events!event_attendees_event_id_fkey!inner\(starts_at\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// NEW_ONLY — DE REGEL DIE DE 15 BESTAANDE RIJEN BUITEN DE FLOW HOUDT
// ═══════════════════════════════════════════════════════════════════════════

test('new_only toetst op call_status_at, niet op registered_at', async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll();
  // registered_at zou hier het verkeerde ding meten: wie zich vorige maand
  // aanmeldde en vandaag gebeld wordt is voor deze trigger nieuw.
  assert.deepEqual(stap(attendeeKeten, 'gte', 'call_status_at'),
    ['gte', 'call_status_at', AUTO.enabled_at]);
  assert.equal(stap(attendeeKeten, 'gte', 'registered_at'), undefined);
});

test('een lege call_status_at telt NIET als nieuw', async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll();
  // Met de hand gezette rijen hebben die kolom vaak leeg. Zonder NOT NULL
  // zouden ze op de enabled_at-vergelijking meeliften, en dan is er geen
  // nulpunt voor de deadline in de mail.
  assert.deepEqual(stap(attendeeKeten, 'not', 'call_status_at'),
    ['not', 'call_status_at', 'is', null]);
});

test('zonder new_only staat er geen call_status_at-grens', async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll({
    auto: { ...AUTO, enroll_mode: 'include_existing' },
  });
  assert.equal(stap(attendeeKeten, 'gte', 'call_status_at'), undefined);
  assert.equal(stap(attendeeKeten, 'not', 'call_status_at'), undefined);
});

// ═══════════════════════════════════════════════════════════════════════════
// STIL NIETS DOEN IS GEEN OPTIE — EN OOK NIET IEDEREEN PAKKEN
// ═══════════════════════════════════════════════════════════════════════════

test('zonder call_status in de config komt er GEEN kandidaat', async (t) => {
  t.after(() => mock.reset());
  // Zou dit doorvallen naar 'geen filter', dan kreeg elke aangemelde deelnemer
  // een 'je plek vervalt'-mail. Liever nul dan iedereen.
  const { summary, admin } = await enroll({
    auto: { ...AUTO, trigger_config: {} },
    kandidaten: [{ id: 'a1', event_id: 'e1' }],
  });
  assert.equal(summary.enrolled, 0);
  // De basis-query wordt opgebouwd vóór de trigger-dispatch, dus het
  // keten-object bestaat; wat er NIET mag staan is een belstatus-filter (dan
  // was de dispatch doorgevallen) en er mag geen enkele run bijkomen.
  const keten = admin.ketens.find((k) => k.tabel === 'event_attendees');
  assert.equal(stap(keten, 'eq', 'call_status'), undefined);
  assert.equal(stap(keten, 'eq', 'status'), undefined);
  assert.equal(admin.ketens.find((k) => k.tabel === 'event_automation_runs' && k.insert), undefined,
    'er mag geen enkele deelnemer ingeschreven worden');
});

test('een onbekend trigger_type levert nog steeds nul kandidaten', async (t) => {
  t.after(() => mock.reset());
  const { summary } = await enroll({
    auto: { ...AUTO, trigger_type: 'on_maanstand' },
    kandidaten: [{ id: 'a1', event_id: 'e1' }],
  });
  assert.equal(summary.enrolled, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE INSCHRIJVING ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('een kandidaat wordt ingeschreven met een bevroren kopie van de stappen', async (t) => {
  t.after(() => mock.reset());
  const { summary, admin } = await enroll({
    kandidaten: [{ id: 'att-werner', event_id: 'ev-gent', call_status: 'geen_gehoor',
      call_status_at: '2026-09-14T11:05:00.000Z', status: 'aangemeld' }],
  });
  assert.equal(summary.enrolled, 1);
  const ins = admin.ketens.find((k) => k.tabel === 'event_automation_runs' && k.insert);
  assert.ok(ins, 'er hoort een run aangemaakt te worden');
  assert.equal(ins.insert.attendee_id, 'att-werner');
  assert.equal(ins.insert.event_id, 'ev-gent');
  assert.equal(ins.insert.status, 'active');
  assert.equal(ins.insert.current_step_index, 0);
  // steps_snapshot WORDT BEVROREN. Wie al loopt houdt zijn eigen versie van de
  // stappen; een latere wijziging aan de automatisatie raakt hem niet.
  assert.deepEqual(ins.insert.steps_snapshot, AUTO.steps);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE BESTAANDE TRIGGERS BLIJVEN ONGEMOEID
// ═══════════════════════════════════════════════════════════════════════════

test('on_signup filtert nog steeds op registered_at en een lege vragenlijst', async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll({
    auto: { ...AUTO, trigger_type: 'on_signup', trigger_config: {} },
  });
  assert.deepEqual(stap(attendeeKeten, 'is', 'assessment_response_id'),
    ['is', 'assessment_response_id', null]);
  assert.deepEqual(stap(attendeeKeten, 'gte', 'registered_at'),
    ['gte', 'registered_at', AUTO.enabled_at]);
  // En geen belstatus-filter dat er niet hoort.
  assert.equal(stap(attendeeKeten, 'eq', 'call_status'), undefined);
});

test('on_assessment_completed houdt zijn eigen status-lijst', async (t) => {
  t.after(() => mock.reset());
  const { attendeeKeten } = await enroll({
    auto: { ...AUTO, trigger_type: 'on_assessment_completed', trigger_config: {} },
  });
  assert.deepEqual(stap(attendeeKeten, 'in', 'status'),
    ['in', 'status', ['aangemeld', 'aanwezig']]);
  assert.deepEqual(stap(attendeeKeten, 'gte', 'assessment_linked_at'),
    ['gte', 'assessment_linked_at', AUTO.enabled_at]);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE EDITORS EN DE SERVER-VALIDATIE KENNEN DE TRIGGER
// ═══════════════════════════════════════════════════════════════════════════

const SAVE   = readFileSync(join(ROOT, 'api/events-automation-save.js'), 'utf8');
const HTML   = readFileSync(join(ROOT, 'modules/events-automations.html'), 'utf8');
const VIEW   = readFileSync(join(ROOT, 'modules/klanten-v2/views/automatiseringen-v2.js'), 'utf8');

test('de server kent on_call_status en eist een belstatus', async () => {
  assert.match(SAVE, /'on_assessment_not_completed_after', 'on_call_status'\]/);
  assert.match(SAVE, /on_call_status vereist trigger_config\.call_status/);
});

test('beide editors kunnen de trigger kiezen en tonen', () => {
  assert.match(HTML, /on_call_status: 'Bij een belstatus'/);
  assert.match(HTML, /<option value="on_call_status"/);
  assert.match(HTML, /id="fCallStatus"/);
  assert.match(VIEW, /\{ v: 'on_call_status',\s+l: 'Bij een belstatus' \}/);
  assert.match(VIEW, /__autEvTrigCallStatus/);
});

test('de drie lijsten met belstatussen zijn dezelfde', () => {
  // Lopen ze uiteen, dan kiest een editor iets wat de server met een 400
  // weigert — en dat leest als een bug in het opslaan.
  const lees = (bron, naam) => {
    const i = bron.indexOf(naam);
    assert.ok(i > 0, naam + ' hoort te bestaan');
    const blok = bron.slice(i, bron.indexOf('];', i));
    return (blok.match(/'([a-z_]+)'/g) || []).map((x) => x.slice(1, -1)).sort();
  };
  const server = lees(SAVE, 'const CALL_STATUSES = [');
  const html   = lees(HTML, 'const CALL_STATUS_TRIGGER_OPTIONS = [')
    .filter((v) => !/^[A-Z]/.test(v));
  const view   = lees(VIEW, 'const EV_CALL_STATUSSEN = [');
  assert.deepEqual(html, server);
  assert.deepEqual(view, server);
});
