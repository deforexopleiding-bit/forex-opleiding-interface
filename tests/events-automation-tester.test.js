// tests/events-automation-tester.test.js
//
// DE TESTKNOP DEED NIETS.
//
// Gemeten op 15 september in productie: Automatiseringen > Events > de rij
// 'Geen gehoor - laatste kans' > Test. Geen venster, geen toast, geen fout in
// de console. De modal-HTML werd nooit gerenderd.
//
// De oorzaak was NIET dat de modal bij de overzetting naar v2 verdwenen is —
// _evTestModal() bestond en werkte. Er stonden twee blokkades op `enabled`:
//
//   · modules/klanten-v2/views/automatiseringen-v2.js
//       if (!a.enabled) return _toast('Zet de automation eerst aan…');
//   · api/events-automation-test.js
//       if (!autom.enabled) return 400 'Automation staat uit — zet 'm eerst aan'
//
// Beide uit commit b4859a5 (#1533), zonder toelichting. Ze blokkeerden precies
// het geval waarvoor de tester bestaat: een flow één keer end-to-end zien
// draaien VOORDAT je hem op echte deelnemers aanzet.
//
// Die blokkade was geen veiligheidsmechanisme:
//   · events-automation-test.js omzeilt de enrollment volledig — het INSERT'et
//     zelf een event_automation_runs-rij en raakt enrollDueAttendees (die wél
//     op `enabled` filtert) niet aan;
//   · stepDueRuns selecteert op status='active' en joint NIET op
//     event_automations.enabled.
// De motor draait een testrun van een uitstaande automatisatie dus gewoon.
//
// Deze test legt vast: (a) de 400 blijft staan voor wie niets meestuurt,
// (b) met expliciete toestemming gaat hij door, (c) een testrun kan NOOIT de
// status van een echte deelnemer wijzigen, en (d) het scherm zwijgt nergens.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { advanceRun } from '../api/_lib/events-automation-engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

// ═══════════════════════════════════════════════════════════════════════════
// 1 · HET ENDPOINT — de 400 blijft, de weg eromheen is expliciet
// ═══════════════════════════════════════════════════════════════════════════

/** Supabase-dubbelganger: lookups per tabel + onthouden wat er INSERT'et wordt. */
function nepAdmin({ automation, event = { id: 'ev-1', status: 'published' } } = {}) {
  const inserts = [];
  let nr = 0;
  const from = (tabel) => {
    const k = {
      select: () => k,
      eq: () => k,
      insert(v) { inserts.push({ tabel, row: v }); return k; },
      delete: () => k,
      maybeSingle: async () => ({
        data: tabel === 'event_automations' ? automation
            : tabel === 'events' ? event : null,
        error: null,
      }),
      single: async () => ({ data: { id: (tabel === 'event_attendees' ? 'att-' : 'run-') + (++nr) }, error: null }),
      then: (r) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return k;
  };
  return { from, inserts };
}

function nepRes() {
  const uit = { code: null, body: null };
  return {
    setHeader() {},
    status(c) { uit.code = c; return this; },
    json(b) { uit.body = b; return this; },
    _uit: uit,
  };
}

const GELDIG = {
  event_id  : '11111111-1111-1111-1111-111111111111',
  first_name: 'TEST', last_name: 'Jeffrey',
  email     : 'biemoldjeffrey@gmail.com', phone: '+31600000000',
};
const AUTO_ID = '22222222-2222-2222-2222-222222222222';

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
  const res = nepRes();
  await mod.default({ method: 'POST', headers: {}, body }, res);
  return { res: res._uit, admin };
}

const UIT = { id: AUTO_ID, name: 'Geen gehoor - laatste kans', enabled: false, steps: [{ type: 'send_email' }] };
const AAN = { id: AUTO_ID, name: 'Welkom + vragenlijst',      enabled: true,  steps: [{ type: 'send_email' }] };

test('uitstaande automatisatie ZONDER toestemming: nog steeds 400, zelfde tekst', async (t) => {
  t.after(() => mock.reset());
  const { res, admin } = await postTest({ automation_id: AUTO_ID, ...GELDIG }, { automation: UIT });
  assert.equal(res.code, 400);
  // Letterlijk dezelfde tekst als voorheen: bestaande callers en logs mogen
  // hier niets van merken.
  assert.equal(res.body.error, 'Automation staat uit — zet \'m eerst aan');
  assert.equal(res.body.automation_enabled, false);
  // En er is NIETS aangemaakt.
  assert.equal(admin.inserts.length, 0);
});

test('die 400 vertelt nu ook hoe het wél kan — geen doodlopende melding', async (t) => {
  t.after(() => mock.reset());
  const { res } = await postTest({ automation_id: AUTO_ID, ...GELDIG }, { automation: UIT });
  assert.match(res.body.hint, /allow_disabled/);
});

test('uitstaande automatisatie MET expliciete toestemming: gaat door', async (t) => {
  t.after(() => mock.reset());
  const { res, admin } = await postTest(
    { automation_id: AUTO_ID, ...GELDIG, allow_disabled: true }, { automation: UIT });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  // Een testdeelnemer én een run.
  const att = admin.inserts.find((i) => i.tabel === 'event_attendees');
  const run = admin.inserts.find((i) => i.tabel === 'event_automation_runs');
  assert.ok(att, 'er hoort een testdeelnemer aangemaakt te worden');
  assert.ok(run, 'er hoort een run aangemaakt te worden');
  assert.equal(att.row.is_test, true);
  assert.equal(run.row.is_test, true);
  assert.match(att.row.first_name, /^TEST · /);
});

test('het antwoord zegt dat de automatisatie uitstond', async (t) => {
  t.after(() => mock.reset());
  // Zonder dit kan het scherm na de start niet meer melden dat er geen echte
  // deelnemers instromen.
  const { res } = await postTest(
    { automation_id: AUTO_ID, ...GELDIG, allow_disabled: true }, { automation: UIT });
  assert.equal(res.body.automation_enabled, false);
  assert.equal(res.body.automation_name, 'Geen gehoor - laatste kans');
  assert.equal(res.body.steps, 1);
});

test('een aanstaande automatisatie heeft die toestemming niet nodig', async (t) => {
  t.after(() => mock.reset());
  const { res } = await postTest({ automation_id: AUTO_ID, ...GELDIG }, { automation: AAN });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.automation_enabled, true);
});

test('alleen === true geeft toestemming, geen truthy waarde', async (t) => {
  t.after(() => mock.reset());
  for (const waarde of ['true', 1, 'ja', {}]) {
    // mock.module weigert een tweede mock op dezelfde module binnen één test.
    mock.reset();
    const { res } = await postTest(
      { automation_id: AUTO_ID, ...GELDIG, allow_disabled: waarde }, { automation: UIT });
    assert.equal(res.code, 400, 'allow_disabled=' + JSON.stringify(waarde) + ' mag niet doorlaten');
  }
});

test('de steps_snapshot wordt bij de run bevroren', async (t) => {
  t.after(() => mock.reset());
  const auto = { ...UIT, steps: [{ type: 'send_email' }, { type: 'wait' }, { type: 'condition' }] };
  const { admin } = await postTest(
    { automation_id: AUTO_ID, ...GELDIG, allow_disabled: true }, { automation: auto });
  const run = admin.inserts.find((i) => i.tabel === 'event_automation_runs');
  assert.deepEqual(run.row.steps_snapshot, auto.steps);
  assert.equal(run.row.status, 'active');
  assert.equal(run.row.current_step_index, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · EEN TESTRUN RAAKT NOOIT EEN ECHTE DEELNEMER
// ═══════════════════════════════════════════════════════════════════════════
//
// update_attendee_status is de enige stap die iets ONHERROEPELIJKS doet:
// 'geannuleerd' zetten neemt iemands plek af, en 'Geen gehoor - laatste kans'
// doet precies dat. In de praktijk hangt een testrun aan zijn eigen
// synthetische deelnemer, maar 'in de praktijk' is geen garantie.

/** advanceRun met één update_attendee_status-stap. */
async function draaiStatusStap({ runIsTest, attendeeIsTest }) {
  const gelogd = [];
  const geschreven = [];
  const run = {
    id: 'run-1', is_test: runIsTest, current_step_index: 0,
    steps_snapshot: [{ type: 'update_attendee_status',
      config: { new_status: 'geannuleerd', call_status: 'komt_niet' } }],
  };
  const attendee = { id: 'att-1', status: 'aangemeld', call_status: 'geen_gehoor', is_test: attendeeIsTest };
  const u = await advanceRun({
    run, attendee, event: { id: 'ev-1', starts_at: '2026-10-01T10:00:00.000Z' },
    now: new Date('2026-09-15T12:00:00.000Z'),
    deps: {
      isStepDone: async () => false,
      recordLog: async (i, t, r) => gelogd.push({ i, t, r }),
      // De echte dep schrijft naar de databank; hier onthouden we alleen of hij
      // AANGEROEPEN is. De guard hoort vóór deze aanroep te zitten.
      updateAttendeeStatus: async (step) => {
        if (run.is_test === true && attendee.is_test !== true) {
          return { ok: false, error: 'geweigerd: een testrun mag de status van een echte deelnemer niet wijzigen' };
        }
        geschreven.push(step.config);
        return { ok: true, new_status: step.config.new_status };
      },
    },
  });
  return { u, gelogd, geschreven };
}

test('de guard staat in de motor, vóór de databank-update', () => {
  // Met een nep-dep kun je niet meten of de ECHTE dep de guard heeft; dat
  // leest deze test uit de bron. De regel hoort te staan vóór de .update().
  const bron = readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8');
  const i = bron.indexOf('updateAttendeeStatus: async (step)');
  assert.ok(i > 0);
  const blok = bron.slice(i, bron.indexOf('sendInternalNotification', i));
  const iGuard  = blok.indexOf("run.is_test === true && attendee.is_test !== true");
  const iUpdate = blok.indexOf(".update(patch)");
  assert.ok(iGuard > 0, 'de guard hoort te bestaan');
  assert.ok(iUpdate > 0);
  assert.ok(iGuard < iUpdate, 'de guard moet VÓÓR de update staan, niet erna');
  // En niet stil: de weigering gaat als fout terug, plus een console.error.
  assert.match(blok.slice(iGuard - 400, iGuard + 700), /console\.error/);
  assert.match(blok.slice(iGuard, iGuard + 700), /ok: false/);
});

test('testrun + echte deelnemer = geweigerd, en er wordt niets geschreven', async () => {
  const { u, gelogd, geschreven } = await draaiStatusStap({ runIsTest: true, attendeeIsTest: false });
  assert.equal(geschreven.length, 0, 'er mag geen status geschreven worden');
  // De motor logt de mislukte stap en gaat door (geen retry op dit staptype).
  const regel = gelogd.find((g) => g.t === 'update_attendee_status');
  assert.ok(regel, 'de weigering hoort in het run-log te staan');
  assert.equal(regel.r.ok, false);
  assert.match(regel.r.error, /testrun mag de status van een echte deelnemer niet wijzigen/);
  assert.equal(u.status, 'completed');
});

test('testrun + testdeelnemer = gewoon uitvoeren', async () => {
  const { geschreven } = await draaiStatusStap({ runIsTest: true, attendeeIsTest: true });
  assert.equal(geschreven.length, 1);
  assert.equal(geschreven[0].new_status, 'geannuleerd');
  assert.equal(geschreven[0].call_status, 'komt_niet');
});

test('een echte run op een echte deelnemer verandert niet', async () => {
  // De guard mag alleen testruns raken. Zou hij breder staan, dan vervalt er
  // nooit meer een plek in productie.
  const { geschreven } = await draaiStatusStap({ runIsTest: false, attendeeIsTest: false });
  assert.equal(geschreven.length, 1);
  assert.equal(geschreven[0].new_status, 'geannuleerd');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · is_test VALT BUITEN CAPACITEIT EN BUITEN DE LIJSTEN
// ═══════════════════════════════════════════════════════════════════════════

test('een testrij bezet geen plek', async () => {
  const { isPlekBezet } = await import('../api/_lib/plek-bezet.js');
  // Een rij die ZONDER de testvlag wél een plek zou bezetten.
  const echt = { status: 'aangemeld', call_status: 'bevestigd', is_test: false };
  assert.equal(isPlekBezet(echt), true, 'controle: deze rij bezet normaal een plek');
  assert.equal(isPlekBezet({ ...echt, is_test: true }), false, 'met is_test niet');
  // Ook via de vragenlijst-tak.
  const viaVragenlijst = { status: 'aangemeld', assessment_response_id: 'r1' };
  assert.equal(isPlekBezet(viaVragenlijst), true);
  assert.equal(isPlekBezet({ ...viaVragenlijst, is_test: true }), false);
});

test('de capaciteitsquery en de lijsten filteren is_test er hard uit', () => {
  const plek = readFileSync(join(ROOT, 'api/_lib/plek-bezet.js'), 'utf8');
  assert.match(plek, /\.eq\('is_test', false\)/);
  const lijst = readFileSync(join(ROOT, 'api/events-attendees-list.js'), 'utf8');
  // Twee plekken: de lijst zelf én de tellers per status. Beide, anders klopt
  // de badge niet met de rijen eronder.
  assert.ok((lijst.match(/\.eq\('is_test', false\)/g) || []).length >= 2);
});

test('de opruim-endpoint staat vast op is_test=true', () => {
  // De enige bescherming die telt: de DELETE mag niet op iets anders kunnen
  // vallen dan testrijen.
  const bron = readFileSync(join(ROOT, 'api/events-test-attendees-cleanup.js'), 'utf8');
  assert.match(bron, /\.delete\(\)\s*\n\s*\.eq\('is_test', true\)/);
  assert.doesNotMatch(bron, /\.delete\(\)\s*\n\s*\.neq/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HET SCHERM ZWIJGT NERGENS
// ═══════════════════════════════════════════════════════════════════════════

const VIEW = readFileSync(join(ROOT, 'modules/klanten-v2/views/automatiseringen-v2.js'), 'utf8');

// ── ALLEEN DE EVENTS-SECTIE ───────────────────────────────────────────────
// De Onboarding-tab in hetzelfde bestand draagt LETTERLIJK dezelfde twee
// defecten (`if (!a) return;` en `if (!a.enabled) return _toast(…)`, plus een
// tekstveld waarin je met de hand een traject-uuid moet plakken). Die tab hangt
// aan api/onboarding-automation-test.js en valt buiten deze opdracht — die ging
// over de eventautomatiseringen. Bewust niet aangeraakt, wel gemeld.
// Daarom meten deze tests op de events-sectie en niet op het hele bestand:
// anders zou een assertie hier per ongeluk over onboarding gaan.
const EV_VIEW = (() => {
  const van = VIEW.indexOf('// TAB: EVENTS');
  const tot = VIEW.indexOf('// TAB: ONBOARDING');
  assert.ok(van > 0 && tot > van, 'de sectiekoppen horen in de view te staan');
  return VIEW.slice(van, tot);
})();

/**
 * De code zonder commentaar — een test hoort naar wat er DRAAIT te kijken.
 * Zelfde helper als in tests/opvolging-verplaats-polish.test.js. Nodig omdat de
 * toelichting bij de weggehaalde blokkade die blokkade letterlijk citeert; zou
 * de assertie op commentaar meten, dan moest de uitleg wijken voor de test.
 */
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');
const EV_CODE = zonderUitleg(EV_VIEW);

test('de enabled-blokkade staat niet meer in de events-sectie', () => {
  // Op de CODE, niet op het commentaar: de toelichting citeert de weggehaalde
  // regel met opzet, zodat de volgende die hier komt weet waarom hij weg is.
  assert.doesNotMatch(EV_CODE, /if \(!a\.enabled\) return _toast/);
  assert.doesNotMatch(EV_CODE, /Zet de automation eerst aan voordat je een test-run doet/);
  // Controle dat de helper het juiste meet: in de ONBOARDING-sectie staat die
  // regel nog wél, en dat hoort deze test niet af te dekken.
  const ob = zonderUitleg(VIEW.slice(VIEW.indexOf('// TAB: ONBOARDING')));
  assert.match(ob, /if \(!a\.enabled\) return _toast/,
    'de onboarding-tab draagt hetzelfde defect — bewust buiten scope gelaten');
});

test('uitstaand is een melding in het venster, geen blokkade', () => {
  assert.match(EV_VIEW, /automation_enabled: a\.enabled === true/);
  assert.match(EV_VIEW, /Deze automatisatie staat UIT/);
  assert.match(EV_VIEW, /allow_disabled: t\.automation_enabled !== true/);
});

test('de testknop heeft geen stille return meer', () => {
  const i = VIEW.indexOf('window.__autEvTest = (id) =>');
  assert.ok(i > 0);
  const blok = VIEW.slice(i, VIEW.indexOf('window.__autEvRuns', i));
  // Elke uitgang zegt iets. Een kale `return;` is precies waarom deze knop
  // ongrijpbaar was.
  assert.doesNotMatch(blok, /if \(!a\) return;/);
  assert.match(blok, /if \(!a\) return _toast\(/);
});

test('de runs-modal wordt ook op de flows-tab gerenderd', () => {
  // Hier zat het tweede defect: __autEvRuns zette de state en hertekende, maar
  // alleen _evLogView() rendert die modal. Op de Flows-tab deed Runs dus niets.
  const i = VIEW.indexOf('function eventsView()');
  const blok = VIEW.slice(i, VIEW.indexOf('function _evList()', i));
  assert.match(blok, /if \(_ui\.ev\.runsModal\) return _evRunsModal\(\)/);
  assert.match(blok, /if \(_ui\.ev\.testResult\) return _evTestResultModal\(\)/);
});

test('alle drie de vensters renderen als "scrim on"', () => {
  // Zonder `on` houdt de globale .scrim-regel opacity op 0 en pointer-events
  // op none (app-shell.css r156-158) en blijft het venster onzichtbaar.
  for (const fn of ['_evTestModal', '_evTestResultModal', '_evRunsModal']) {
    const i = VIEW.indexOf('function ' + fn + '()');
    assert.ok(i > 0, fn + ' hoort te bestaan');
    const blok = VIEW.slice(i, i + 4000);
    assert.match(blok, /class="scrim on"/, fn + ' hoort scrim on te gebruiken');
  }
});

test('het event wordt gekozen uit een lijst, niet met een geplakte uuid', () => {
  assert.match(VIEW, /function _toekomstigeEvents\(\)/);
  assert.match(EV_VIEW, /__autEvTestField\('event_id', this\.value\)/);
  // Het oude instructieveld is weg uit de events-sectie. (De tekst staat nog
  // wél in een toelichtend commentaar bovenaan het bestand — dat legt uit wat
  // er WAS, en dat mag blijven staan.)
  const i = EV_VIEW.indexOf('function _evTestModal()');
  const tot = EV_VIEW.indexOf('function _evTestResultModal()');
  assert.doesNotMatch(EV_VIEW.slice(i, tot), /kopieer event-ID/);
  assert.doesNotMatch(EV_VIEW.slice(i, tot), /Event-ID \(uuid\)/);
});

test('de event-kiezer zegt het als er niets te kiezen is', () => {
  const i = VIEW.indexOf('function _evTestEventKiezer(');
  assert.ok(i > 0);
  // TOT DE VOLGENDE FUNCTIE, niet tot __autEvEventsRetry: die naam staat óók
  // in de retry-knop binnen deze functie, en dan knipt de slice halverwege af.
  const blok = VIEW.slice(i, VIEW.indexOf('window.__autEvEventsRetry = ', i));
  assert.match(blok, /geen enkel event dat nog moet komen/);
  assert.match(blok, /kon niet geladen worden/);
  assert.match(blok, /Events laden/);
});

test('de opruimknop is bereikbaar vanuit de events-tab', () => {
  assert.match(VIEW, /window\.__autEvTestCleanup = \(\) =>/);
  // In de toolbar van de lijst én onderaan het resultaat-venster.
  assert.ok((VIEW.match(/__autEvTestCleanup\(\)/g) || []).length >= 2);
  assert.match(VIEW, /events-test-attendees-cleanup/);
});

test('opruimen vraagt eerst en meldt daarna een aantal', () => {
  const i = VIEW.indexOf('window.__autEvTestCleanup = () =>');
  const blok = VIEW.slice(i, VIEW.indexOf('window.__autEvTestResultRefresh', i));
  assert.match(blok, /askConfirm\(/);
  assert.match(blok, /testdeelnemers/);
  // 'Opgeruimd' zonder getal is niet te onderscheiden van 'er stond niets'.
  assert.match(blok, /geen enkele testrij/);
});

test('de per-stap-historie onderscheidt niet-gemeten van niet-waar', () => {
  const i = VIEW.indexOf('function _evStapRegel(');
  const blok = VIEW.slice(i, i + 3000);
  assert.match(blok, /NIET GEMETEN/);
  assert.match(blok, /niet waar — flow stopt hier/);
  assert.match(blok, /mislukt/);
  // Een stap zonder logregel wordt niet weggelaten maar als 'wacht' getoond.
  assert.match(blok, /'wacht'/);
});

test('de poll stopt zichzelf en wordt altijd eerst geleegd', () => {
  // Lesson learned 20: handle in module-scope, clear vóór elke (her)start, en
  // ook op beforeunload. Anders lopen er twee polls na twee testruns.
  assert.match(VIEW, /function _stopTestPoll\(\)/);
  const i = VIEW.indexOf('function _startTestPoll()');
  const blok = VIEW.slice(i, i + 800);
  assert.match(blok, /_stopTestPoll\(\);/);
  assert.match(VIEW, /addEventListener\('beforeunload', _stopTestPoll\)/);
  // En hij stopt zodra de run niet meer actief is.
  assert.match(blok, /st !== 'active'/);
});
