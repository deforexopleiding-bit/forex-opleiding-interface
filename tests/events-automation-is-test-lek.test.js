// tests/events-automation-is-test-lek.test.js
//
// EEN TESTDEELNEMER STROOMDE IN LIVE AUTOMATISATIES.
//
// GEMETEN op 15 september in productie. De testdeelnemer van één testrun
// (2ea7e337-68f2-4279-ab0e-aa2d1b72be99, is_test=true) had DRIE runs:
//
//   e65d8d6b  'Geen gehoor - laatste kans'   is_test=true    exited op stap 3
//   273a3cdd  'Welkom + vragenlijst'         is_test=FALSE   completed
//   b1018890  'Vragenlijst-herinnering'      is_test=FALSE   ACTIVE
//
// Binnen twee seconden stroomde een synthetische rij dus in twee LIVE
// on_signup-automatisaties, en de derde stond nog te draaien toen hij gevonden
// werd — op het event van 26 september, waar hij daarna ook de
// time_before_event-reminders had opgepikt.
//
// ── DE OORZAAK ──────────────────────────────────────────────────────────
// loadCandidatesForAutomation filterde `is_test` niet, en
// event_attendees.automation_enabled staat default true (migratie
// 2026-06-19-event-attendees-automation-enabled.sql). Een verse testdeelnemer
// matchte daarmee het on_signup-filter (assessment_response_id IS NULL +
// registered_at >= enabled_at) als volstrekt gewone kandidaat.
//
// Eén trigger (on_assessment_completed) had er los al een filter voor; de
// andere vier niet. Precies het patroon waarin zo'n lek ontstaat: elke tak
// denkt aan zijn eigen filters.
//
// ── DE FIX, EN WAAROM HIJ DE TESTER NIET BREEKT ─────────────────────────
// `.eq('is_test', false)` op de BASIS-query, dus voor alle vijf de
// trigger-types en voor elke trigger die er nog bij komt.
//
// api/events-automation-test.js loopt niet via enrollment: die INSERT'et zijn
// run zelf met is_test=true. Dat blijft de enige weg waarlangs een
// testdeelnemer een run krijgt.
//
// ── EN WAAROM `.eq('is_test', false)` VEILIG IS ─────────────────────────
// event_attendees.is_test is `boolean NOT NULL DEFAULT false` (migratie
// 2026-06-18-events-attendee-is-test.sql). Er zijn dus geen NULL-rijen die
// door een gelijkheidsfilter stil zouden wegvallen — dezelfde reden waarom de
// filters in _lib/plek-bezet.js en events-attendees-list.js veilig zijn.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const NU   = new Date('2026-09-15T16:28:00.000Z');

/** Supabase-dubbelganger die de hele filterketen per tabel onthoudt. */
function nepAdmin({ rijen = {} } = {}) {
  const ketens = [];
  const from = (tabel) => {
    const keten = { tabel, select: null, stappen: [] };
    ketens.push(keten);
    const data = () => Promise.resolve({ data: rijen[tabel] || [], error: null });
    const k = {
      select(kolommen) { keten.select = kolommen; return k; },
      eq(c, v)  { keten.stappen.push(['eq', c, v]);  return k; },
      in(c, v)  { keten.stappen.push(['in', c, v]);  return k; },
      is(c, v)  { keten.stappen.push(['is', c, v]);  return k; },
      not(c, o, v) { keten.stappen.push(['not', c, o, v]); return k; },
      gt(c, v)  { keten.stappen.push(['gt', c, v]);  return k; },
      gte(c, v) { keten.stappen.push(['gte', c, v]); return k; },
      lte(c, v) { keten.stappen.push(['lte', c, v]); return k; },
      or(s)     { keten.stappen.push(['or', s]);     return k; },
      order()   { return k; },
      limit(n)  { keten.stappen.push(['limit', n]);  return k; },
      insert(v) { keten.stappen.push(['insert', v]); keten.insert = v; return k; },
      update(v) { keten.stappen.push(['update', v]); return k; },
      maybeSingle: async () => ({
        data: keten.insert ? { id: 'run-nieuw' } : ((rijen[tabel] || [])[0] || null), error: null }),
      single: async () => ({ data: { id: 'run-nieuw' }, error: null }),
      then: (r, j) => data().then(r, j),
    };
    return k;
  };
  return { from, ketens };
}

const TRIGGERS = [
  ['on_signup',                         {}],
  ['on_assessment_completed',           {}],
  ['time_before_event',                 { hours_before: 24 }],
  ['on_assessment_not_completed_after', { hours_after_signup: 48 }],
  ['on_call_status',                    { call_status: 'geen_gehoor' }],
];

/** Draait enrollDueAttendees voor één automatisatie en geeft de keten terug. */
async function enroll({ trigger, cfg, kandidaten = [], enrollMode = 'new_only' }) {
  const admin = nepAdmin({
    rijen: {
      event_automations: [{
        id: 'auto-1', trigger_type: trigger, trigger_config: cfg,
        scope_type: 'all', scope_config: {}, enroll_mode: enrollMode,
        enabled_at: '2026-09-01T00:00:00.000Z', steps: [{ type: 'send_email' }],
      }],
      events: [{ id: 'ev-1' }],
      event_attendees: kandidaten,
      event_automation_runs: [],
    },
  });
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: admin, createUserClient: () => admin,
      checkCronAuth: () => ({ ok: true }), ADMIN_ROLES: [],
    },
  });
  const mod = await import(url('api/_lib/events-automation-engine.js') + '?t=' + Math.random());
  const summary = await mod.enrollDueAttendees({ now: NU });
  const keten = admin.ketens.find((x) => x.tabel === 'event_attendees');
  return { summary, admin, keten };
}

const stap = (keten, naam, kolom) =>
  keten && keten.stappen.find((s) => s[0] === naam && s[1] === kolom);

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ALLE VIJF DE TRIGGERS SLUITEN is_test UIT
// ═══════════════════════════════════════════════════════════════════════════

for (const [trigger, cfg] of TRIGGERS) {
  test(`${trigger} filtert is_test=false`, async (t) => {
    t.after(() => mock.reset());
    const { keten } = await enroll({ trigger, cfg });
    assert.ok(keten, 'de attendee-query hoort te draaien voor ' + trigger);
    assert.deepEqual(stap(keten, 'eq', 'is_test'), ['eq', 'is_test', false],
      trigger + ' hoort testdeelnemers uit te sluiten');
  });
}

test('de filter staat op de BASIS-query, niet per trigger', async (t) => {
  t.after(() => mock.reset());
  // Dit is de eigenschap die het lek onmogelijk maakt: een NIEUWE trigger
  // erft de filter, in plaats van dat iemand eraan moet denken. Een onbekend
  // trigger-type komt niet tot een query (return []), dus we meten het op de
  // basis-filters die alle takken delen.
  const bron = readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8');
  const i = bron.indexOf('let q = supabaseAdmin');
  const j = bron.indexOf('if (allowedEventIds != null)', i);
  const basis = bron.slice(i, j);
  assert.match(basis, /\.eq\('automation_enabled', true\)/);
  assert.match(basis, /\.eq\('is_test', false\)/,
    'de is_test-filter hoort op de basis-query te staan');
});

test('automation_enabled blijft óók op de basis-query staan', async (t) => {
  t.after(() => mock.reset());
  // De tweede helft van de bevinding. automation_enabled default true is
  // BEDOELD — het is een opt-OUT voor rijen die admin stil toevoegt, en echte
  // aanmeldingen hóren automatisaties te krijgen. Het lek zat niet in die
  // default maar in het ontbreken van de is_test-filter ernaast.
  const { keten } = await enroll({ trigger: 'on_signup', cfg: {} });
  assert.deepEqual(stap(keten, 'eq', 'automation_enabled'), ['eq', 'automation_enabled', true]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE BESTAANDE FILTERS ZIJN NIET VERSCHOVEN
// ═══════════════════════════════════════════════════════════════════════════

test('on_signup houdt zijn eigen filters', async (t) => {
  t.after(() => mock.reset());
  const { keten } = await enroll({ trigger: 'on_signup', cfg: {} });
  assert.deepEqual(stap(keten, 'is', 'assessment_response_id'),
    ['is', 'assessment_response_id', null]);
  assert.deepEqual(stap(keten, 'gte', 'registered_at'),
    ['gte', 'registered_at', '2026-09-01T00:00:00.000Z']);
});

test('on_call_status houdt zijn eigen filters', async (t) => {
  t.after(() => mock.reset());
  const { keten } = await enroll({ trigger: 'on_call_status', cfg: { call_status: 'geen_gehoor' } });
  assert.deepEqual(stap(keten, 'eq', 'call_status'), ['eq', 'call_status', 'geen_gehoor']);
  assert.deepEqual(stap(keten, 'eq', 'status'), ['eq', 'status', 'aangemeld']);
  assert.deepEqual(stap(keten, 'not', 'call_status_at'), ['not', 'call_status_at', 'is', null]);
});

test('on_assessment_completed houdt zijn eigen is_test-regel erbij', async (t) => {
  t.after(() => mock.reset());
  // Die stond er los al; nu staat hij dubbelop. Twee keer dezelfde .eq geeft
  // in PostgREST dezelfde uitkomst, dus dat mag — maar hij moet er wel nog
  // staan, want als iemand de basis-filter ooit weghaalt is dit het vangnet.
  const { keten } = await enroll({ trigger: 'on_assessment_completed', cfg: {} });
  const alle = keten.stappen.filter((s) => s[0] === 'eq' && s[1] === 'is_test');
  assert.equal(alle.length, 2, 'basis-query + de eigen regel van deze tak');
  for (const s of alle) assert.equal(s[2], false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · WAT DE FILTER IN DE PRAKTIJK DOET
// ═══════════════════════════════════════════════════════════════════════════
//
// De nep-databank filtert niet zelf — hij geeft terug wat je 'm meegeeft. Deze
// twee tests meten dus of de FILTER wordt gezet met precies de rijen uit de
// productie-meting, en tellen wat er ingeschreven zou worden als de databank
// hem toepast.

test('de testdeelnemer uit de meting zou nu niet meer matchen', async (t) => {
  t.after(() => mock.reset());
  const testRij = {
    id: '2ea7e337-68f2-4279-ab0e-aa2d1b72be99', event_id: 'ev-gent',
    is_test: true, automation_enabled: true, status: 'aangemeld',
    registered_at: '2026-09-15T16:28:00.000Z', assessment_response_id: null,
  };
  const { keten } = await enroll({ trigger: 'on_signup', cfg: {}, kandidaten: [testRij] });
  const f = stap(keten, 'eq', 'is_test');
  assert.deepEqual(f, ['eq', 'is_test', false]);
  // En de rij zou door dat filter vallen — dat is wat de databank ermee doet.
  assert.equal(testRij.is_test === f[2], false,
    'is_test=true matcht het filter is_test=false niet');
});

test('een echte deelnemer wordt nog steeds ingeschreven', async (t) => {
  t.after(() => mock.reset());
  // De keerzijde die telt: deze fix mag geen echte aanmelding buitensluiten.
  const echt = {
    id: 'att-echt', event_id: 'ev-gent', is_test: false, automation_enabled: true,
    status: 'aangemeld', registered_at: '2026-09-15T16:28:00.000Z',
    assessment_response_id: null,
  };
  const { summary, admin } = await enroll({ trigger: 'on_signup', cfg: {}, kandidaten: [echt] });
  assert.equal(summary.enrolled, 1, 'een echte aanmelding hoort er wél in te komen');
  const ins = admin.ketens.find((x) => x.tabel === 'event_automation_runs' && x.insert);
  assert.equal(ins.insert.attendee_id, 'att-echt');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE TESTER BLIJFT WERKEN
// ═══════════════════════════════════════════════════════════════════════════

test('de tester loopt niet via enrollment, dus deze fix raakt hem niet', () => {
  // Het argument waarop deze hele wijziging rust: als de tester wél via
  // enrollment liep, zou de is_test-filter zijn eigen runs wegfilteren.
  const bron = readFileSync(join(ROOT, 'api/events-automation-test.js'), 'utf8');
  // Hij INSERT'et zijn run zelf, met is_test=true.
  assert.match(bron, /\.from\('event_automation_runs'\)\s*\n\s*\.insert\(\{/);
  assert.match(bron, /is_test:\s*true/);
  // En hij roept enrollDueAttendees nergens aan — gemeten op de CODE, want het
  // kopblok van dat bestand noemt enrollDueAttendees juist om uit te leggen
  // dat het endpoint er NIET langs gaat.
  const code = bron.split('\n')
    .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
    .join('\n');
  assert.doesNotMatch(code, /enrollDueAttendees/);
});

test('is_test is NOT NULL DEFAULT false — een gelijkheidsfilter is dus veilig', () => {
  // Was de kolom nullable, dan zou .eq('is_test', false) stil elke NULL-rij
  // uitsluiten: een echte aanmelding die nooit meer een automatisatie krijgt.
  const mig = readFileSync(
    join(ROOT, 'docs/sql-migrations/2026-06-18-events-attendee-is-test.sql'), 'utf8');
  assert.match(mig, /is_test boolean NOT NULL DEFAULT false/);
});
