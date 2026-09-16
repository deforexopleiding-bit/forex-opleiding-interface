// tests/events-reminders-niet-naar-afgezegd.test.js
//
// REMINDERS GINGEN NAAR WIE AFGEZEGD WAS.
//
// GEMETEN op 16 september. De tak `time_before_event` in
// loadCandidatesForAutomation had GEEN enkele statusfilter — anders dan
// on_call_status (.eq('status','aangemeld')) en on_assessment_completed
// (.in('status', CONFIRMED_STATUSES)).
//
// 'Warmup vroeg (waarde)' (120u) en 'Reminder laatste uren' (1u) hebben wel een
// condition-stap, maar die checkt assessment_completed: wie de vragenlijst
// invulde en daarna geannuleerd werd glipt er door. 'Reminder 24u' heeft
// helemaal geen condition. En `still_registered` sluit alleen
// switched_to_other_event en no_show uit, dus 'geannuleerd' leest daar als
// nog-ingeschreven.
//
// NULMETING op de drie komende events: 32 deelnemers, 27 aangemeld en 5 die
// niet meer komen —
//   23 sep: Achraf Deflaoui (belstatus leeg), Makbule Aydemir (komt_niet),
//           Florjan Xani (liever_zoom)
//   26 sep: Werner De Kesel (komt_niet), Dave Geelen (komt_niet)
// Er liepen 0 actieve runs op de drie reminders, dus er ging nog niets fout —
// maar de vensters van 120u en 24u openen binnen enkele dagen.
//
// ── DE VALKUIL DIE DEZE TEST BEWAAKT ────────────────────────────────────
// 'Geen gehoor - laatste kans' zet in stap 4 ZELF de status op geannuleerd en
// stuurt in stap 5 de interne melding naar Maxim. Een blinde guard op
// 'geannuleerd' zou die run afbreken en die melding voorgoed laten
// verdwijnen. De guard is daarom gescoped op send_email + send_whatsapp; de
// laatste test hieronder draait de hele flow en eist dat stap 5 nog gaat.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  advanceRun, buildConditionState,
  komtNietMeer, NIET_MEER_KOMEND_STATUSSEN, REMINDER_STATUSSEN,
} from '../api/_lib/events-automation-engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;
const NU   = new Date('2026-09-16T12:00:00.000Z');

// Bron-lezende tests meten CODE, niet uitleg. De toelichting in de engine
// citeert de guard bij naam, en een assertie die daar op aanslaat zou de
// uitleg laten wijken voor de test in plaats van andersom. Zelfde helper als
// in tests/events-automation-tester.test.js en
// tests/opvolging-aanmelding-eventsync.test.js.
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');

// ═══════════════════════════════════════════════════════════════════════════
// 1 · HET STATUSVOCABULAIRE — één definitie, en niets valt stil weg
// ═══════════════════════════════════════════════════════════════════════════

test('de drie statussen die niet meer komen', () => {
  assert.deepEqual([...NIET_MEER_KOMEND_STATUSSEN].sort(),
    ['geannuleerd', 'no_show', 'switched_to_other_event']);
});

test('EEN NIEUWE STATUS KAN NIET STIL WEGVALLEN', () => {
  // Dit is de test die het gat dichthoudt. Het vocabulaire staat in de
  // save-validator; wie daar een status toevoegt zonder hier te kiezen waar
  // hij hoort, krijgt een rode test in plaats van een reminder die stil
  // verdwijnt of stil doorgaat.
  const save = readFileSync(join(ROOT, 'api/events-automation-save.js'), 'utf8');
  const m = save.match(/const ATTENDEE_STATUSES = \[([^\]]+)\]/);
  assert.ok(m, 'ATTENDEE_STATUSES hoort in de save-validator te staan');
  const alle = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean).sort();

  const gedekt = [...REMINDER_STATUSSEN, ...NIET_MEER_KOMEND_STATUSSEN].sort();
  assert.deepEqual(gedekt, alle,
    'elke bekende attendee-status hoort in precies één van de twee lijsten te zitten');
  // En in precies één: geen overlap.
  for (const s of REMINDER_STATUSSEN) {
    assert.equal(NIET_MEER_KOMEND_STATUSSEN.includes(s), false, s + ' staat in beide lijsten');
  }
});

test("'sale' krijgt nog steeds reminders", () => {
  // Bewust niet CONFIRMED_STATUSES gebruikt: die is ['aangemeld','aanwezig'],
  // en dan zou iemand die gekocht heeft stil geen reminder meer krijgen — een
  // gedragswijziging die niemand gevraagd heeft.
  assert.ok(REMINDER_STATUSSEN.includes('sale'));
  assert.ok(REMINDER_STATUSSEN.includes('aangemeld'));
  assert.ok(REMINDER_STATUSSEN.includes('aanwezig'));
});

test('komtNietMeer kent de drie, en laat onbekend/leeg door', () => {
  for (const s of ['geannuleerd', 'no_show', 'switched_to_other_event']) {
    assert.equal(komtNietMeer({ status: s }), true, s);
  }
  for (const s of ['aangemeld', 'aanwezig', 'sale']) {
    assert.equal(komtNietMeer({ status: s }), false, s);
  }
  // Leeg of onbekend faalt dezelfde kant op als de positieve lijst: 'komt
  // nog', zodat een rare status niet stil uit de reminders valt.
  for (const s of [null, undefined, '', 'iets_nieuws', 'GEANNULEERD']) {
    assert.equal(komtNietMeer({ status: s }), false, JSON.stringify(s));
  }
  assert.equal(komtNietMeer(null), false);
  assert.equal(komtNietMeer(undefined), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE KANDIDAAT-FILTER OP time_before_event
// ═══════════════════════════════════════════════════════════════════════════

function nepAdmin({ rijen = {} } = {}) {
  const ketens = [];
  const from = (tabel) => {
    const keten = { tabel, stappen: [] };
    ketens.push(keten);
    const data = () => Promise.resolve({ data: rijen[tabel] || [], error: null });
    const k = {
      select() { return k; },
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
      insert(v) { keten.insert = v; return k; },
      update(v) { keten.stappen.push(['update', v]); return k; },
      maybeSingle: async () => ({ data: keten.insert ? { id: 'r' } : ((rijen[tabel] || [])[0] || null), error: null }),
      single: async () => ({ data: { id: 'r' }, error: null }),
      then: (r, j) => data().then(r, j),
    };
    return k;
  };
  return { from, ketens };
}

async function enroll({ trigger, cfg, events = [{ id: 'ev-1' }] }) {
  const admin = nepAdmin({
    rijen: {
      event_automations: [{
        id: 'auto-1', trigger_type: trigger, trigger_config: cfg,
        scope_type: 'all', scope_config: {}, enroll_mode: 'new_only',
        enabled_at: '2026-09-01T00:00:00.000Z', steps: [{ type: 'send_email' }],
      }],
      events,
      event_attendees: [],
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
  await mod.enrollDueAttendees({ now: NU });
  return admin.ketens.find((x) => x.tabel === 'event_attendees');
}

const stap = (keten, naam, kolom) =>
  keten && keten.stappen.find((s) => s[0] === naam && s[1] === kolom);

test('time_before_event filtert nu op de reminder-statussen', async (t) => {
  t.after(() => mock.reset());
  const keten = await enroll({ trigger: 'time_before_event', cfg: { hours_before: 24 } });
  assert.ok(keten, 'de attendee-query hoort te draaien');
  const f = stap(keten, 'in', 'status');
  assert.ok(f, 'er hoort een statusfilter te staan — die ontbrak volledig');
  assert.deepEqual([...f[2]].sort(), ['aangemeld', 'aanwezig', 'sale']);
});

test('de eigen filters van time_before_event blijven staan', async (t) => {
  t.after(() => mock.reset());
  const keten = await enroll({ trigger: 'time_before_event', cfg: { hours_before: 24 } });
  assert.deepEqual(stap(keten, 'gte', 'registered_at'),
    ['gte', 'registered_at', '2026-09-01T00:00:00.000Z']);
  // En de basis-filters van de vorige twee PR's.
  assert.deepEqual(stap(keten, 'eq', 'automation_enabled'), ['eq', 'automation_enabled', true]);
  assert.deepEqual(stap(keten, 'eq', 'is_test'), ['eq', 'is_test', false]);
});

test('DE ANDERE TRIGGERS ZIJN NIET AANGERAAKT', async (t) => {
  t.after(() => mock.reset());
  // on_call_status houdt .eq('status','aangemeld') — niet de reminder-lijst.
  let keten = await enroll({ trigger: 'on_call_status', cfg: { call_status: 'geen_gehoor' } });
  assert.deepEqual(stap(keten, 'eq', 'status'), ['eq', 'status', 'aangemeld']);
  assert.equal(stap(keten, 'in', 'status'), undefined);
  mock.reset();

  // on_assessment_completed houdt CONFIRMED_STATUSES (zonder 'sale').
  keten = await enroll({ trigger: 'on_assessment_completed', cfg: {} });
  assert.deepEqual(stap(keten, 'in', 'status'), ['in', 'status', ['aangemeld', 'aanwezig']]);
  mock.reset();

  // on_signup heeft nog steeds geen statusfilter — bewust niet aangeraakt.
  keten = await enroll({ trigger: 'on_signup', cfg: {} });
  assert.equal(stap(keten, 'in', 'status'), undefined);
  assert.equal(stap(keten, 'eq', 'status'), undefined);
});

test('de vijf gemeten rijen vallen buiten de filter, de 27 aangemelde niet', async (t) => {
  t.after(() => mock.reset());
  const keten = await enroll({ trigger: 'time_before_event', cfg: { hours_before: 24 } });
  const toegestaan = stap(keten, 'in', 'status')[2];
  // De nulmeting van 16 september, met de status die ze hadden.
  const gemeten = [
    { naam: 'Achraf Deflaoui',  status: 'geannuleerd' },
    { naam: 'Makbule Aydemir',  status: 'geannuleerd' },
    { naam: 'Florjan Xani',     status: 'geannuleerd' },
    { naam: 'Werner De Kesel',  status: 'geannuleerd' },
    { naam: 'Dave Geelen',      status: 'geannuleerd' },
  ];
  for (const r of gemeten) {
    assert.equal(toegestaan.includes(r.status), false, r.naam + ' hoort geen reminder te krijgen');
  }
  assert.equal(toegestaan.includes('aangemeld'), true, 'de 27 aangemelde wel');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE STOP-GUARD OP LOPENDE RUNS
// ═══════════════════════════════════════════════════════════════════════════
//
// De kandidaat-filter houdt nieuwe inschrijvingen tegen, maar niet een run die
// al liep toen de deelnemer afzegde. 'Reminder 24u' wordt 120 uur voor het
// event ingeschreven.

/** advanceRun met een reminder-flow: mail, wachten, WhatsApp. */
async function draaiReminder(status) {
  const gelogd = [];
  const verstuurd = [];
  const run = {
    id: 'run-1', current_step_index: 0, is_test: false,
    steps_snapshot: [
      { type: 'send_email',    config: { subject: 'Morgen is het zover', body: 'tot morgen' } },
      { type: 'send_whatsapp', config: { template_name: 'reminder_24u' } },
    ],
  };
  const u = await advanceRun({
    run,
    attendee: { id: 'att-1', status, email: 'x@y.nl', phone: '+31600000000' },
    event: { id: 'ev-1', starts_at: '2026-09-23T17:00:00.000Z' },
    now: NU,
    deps: {
      isStepDone: async () => false,
      recordLog: async (i, t, r) => gelogd.push({ i, t, r }),
      sendEmail:    async () => { verstuurd.push('email'); return { ok: true }; },
      sendWhatsApp: async () => { verstuurd.push('wa'); return { ok: true }; },
    },
  });
  return { u, gelogd, verstuurd };
}

for (const status of ['geannuleerd', 'no_show', 'switched_to_other_event']) {
  test(`een lopende reminder stuurt niets meer bij status ${status}`, async () => {
    const { u, gelogd, verstuurd } = await draaiReminder(status);
    assert.deepEqual(verstuurd, [], 'er mag geen mail en geen WhatsApp uitgaan');
    // NIET STIL: beide stappen staan als overgeslagen in het log, met de
    // status erbij, dus in de run-historie op het scherm is te zien waarom.
    assert.equal(gelogd.length, 2);
    for (const g of gelogd) {
      assert.equal(g.r.skipped, true);
      assert.match(g.r.reason, /niet-meer-komend/);
      assert.equal(g.r.attendee_status, status);
    }
    // En de run loopt netjes af in plaats van te blijven hangen.
    assert.equal(u.status, 'completed');
  });
}

for (const status of ['aangemeld', 'aanwezig', 'sale']) {
  test(`een lopende reminder stuurt gewoon bij status ${status}`, async () => {
    const { verstuurd } = await draaiReminder(status);
    assert.deepEqual(verstuurd, ['email', 'wa']);
  });
}

test('een lege status blokkeert de reminder NIET', async () => {
  // Dezelfde kant op als de positieve lijst faalt: liever een reminder te veel
  // dan iemand stil uit de flow laten vallen op een lege kolom.
  const { verstuurd } = await draaiReminder(null);
  assert.deepEqual(verstuurd, ['email', 'wa']);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE VALKUIL — DE GEEN-GEHOOR-FLOW MOET STAP 5 NOG DRAAIEN
// ═══════════════════════════════════════════════════════════════════════════

test('geen-gehoor: stap 4 annuleert, en stap 5 gaat ALSNOG', async () => {
  // DIT IS DE BELANGRIJKSTE TEST VAN DEZE WIJZIGING. Een blinde guard op
  // 'geannuleerd' zou deze run bij stap 5 afbreken en de melding aan Maxim
  // voorgoed laten verdwijnen — de stille fout waar dit project vanaf wil.
  const gelogd = [];
  const intern = [];
  const verstuurd = [];
  const attendee = { id: 'att-gg', status: 'aangemeld', call_status: 'geen_gehoor',
    call_status_at: '2026-09-16T10:00:00.000Z', email: 'x@y.nl', phone: '+31600000000',
    is_test: false };
  const run = {
    id: 'run-gg', current_step_index: 3, is_test: false,
    steps_snapshot: [
      { type: 'send_email',    config: { subject: 'Je plek', body: '…' } },
      { type: 'send_whatsapp', config: { template_name: 'geen_gehoor_bevestiging' } },
      { type: 'wait',          config: { amount: 48, unit: 'hours' } },
      { type: 'condition',     config: { check: 'geen_reactie_sinds_belstatus', on_fail: 'exit' } },
      { type: 'update_attendee_status', config: { new_status: 'geannuleerd', call_status: 'komt_niet' } },
      { type: 'send_internal_notification', config: { to_email: 'maxim@deforexopleiding.nl',
          subject: 'Plek vervallen', body: '…' } },
    ],
  };
  const u = await advanceRun({
    run, attendee, event: { id: 'ev-1', starts_at: '2026-09-26T17:00:00.000Z' }, now: NU,
    deps: {
      isStepDone: async () => false,
      recordLog: async (i, t, r) => gelogd.push({ i, t, r }),
      sendEmail:    async () => { verstuurd.push('email'); return { ok: true }; },
      sendWhatsApp: async () => { verstuurd.push('wa'); return { ok: true }; },
      measureCondition: async () => ({ niet_gemeten: false, waar: true, aantal_treffers: 0,
        kanalen: ['whatsapp', 'email'], reden: 'gemeten: geen inkomend bericht' }),
      // Zoals de echte dep: schrijft weg EN werkt de rij in het geheugen bij,
      // want daar hangt de stop-guard vanaf.
      updateAttendeeStatus: async (step) => {
        const vorige = attendee.status;
        attendee.status = step.config.new_status;
        attendee.call_status = step.config.call_status;
        return { ok: true, new_status: step.config.new_status, previous_status: vorige };
      },
      sendInternalNotification: async (step) => {
        intern.push(step.config.to_email);
        return { ok: true, to: step.config.to_email };
      },
    },
  });

  // stap 4 heeft geannuleerd
  assert.equal(attendee.status, 'geannuleerd');
  const upd = gelogd.find((g) => g.t === 'update_attendee_status');
  assert.equal(upd.r.ok, true);
  assert.equal(upd.r.previous_status, 'aangemeld', 'previous_status mag niet al de nieuwe zijn');

  // EN STAP 5 IS GEGAAN, ondanks dat de deelnemer nu geannuleerd staat.
  assert.deepEqual(intern, ['maxim@deforexopleiding.nl'],
    'de melding aan Maxim MOET nog uitgaan — anders verdwijnt hij voorgoed');
  const notif = gelogd.find((g) => g.t === 'send_internal_notification');
  assert.equal(notif.r.ok, true);
  assert.equal(notif.r.skipped, undefined, 'de interne melding mag niet overgeslagen worden');

  assert.equal(u.status, 'completed');
});

test('en zou er ná het annuleren nog een klantmail staan, dan gaat die NIET', async () => {
  // De keerzijde van dezelfde regel, en de reden dat de dep de rij in het
  // geheugen bijwerkt: een flow die eerst annuleert en daarna nog een
  // klantbericht stuurt, mag dat bericht niet op een verouderde status alsnog
  // versturen. Zo'n flow bestaat vandaag niet; de guard hoort niet van de
  // volgorde af te hangen.
  const gelogd = [];
  const verstuurd = [];
  const attendee = { id: 'att-x', status: 'aangemeld', email: 'x@y.nl', phone: '+31600000000' };
  const run = {
    id: 'run-x', current_step_index: 0, is_test: false,
    steps_snapshot: [
      { type: 'update_attendee_status', config: { new_status: 'geannuleerd' } },
      { type: 'send_email', config: { subject: 'toch nog iets', body: '…' } },
    ],
  };
  await advanceRun({
    run, attendee, event: { id: 'ev-1', starts_at: '2026-09-26T17:00:00.000Z' }, now: NU,
    deps: {
      isStepDone: async () => false,
      recordLog: async (i, t, r) => gelogd.push({ i, t, r }),
      sendEmail: async () => { verstuurd.push('email'); return { ok: true }; },
      updateAttendeeStatus: async (step) => {
        attendee.status = step.config.new_status;
        return { ok: true, new_status: step.config.new_status };
      },
    },
  });
  assert.deepEqual(verstuurd, []);
  const mail = gelogd.find((g) => g.t === 'send_email');
  assert.equal(mail.r.skipped, true);
  assert.match(mail.r.reason, /niet-meer-komend/);
});

test('de echte dep werkt de rij in het geheugen bij', () => {
  // Met een nep-dep kun je dat niet meten; dit leest de bron.
  const bron = readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8');
  const i = bron.indexOf('updateAttendeeStatus: async (step)');
  const blok = bron.slice(i, bron.indexOf('sendInternalNotification', i));
  assert.match(blok, /attendee\.status\s*=\s*newStatus/);
  assert.match(blok, /attendee\.call_status\s*=\s*newCallStatus/);
  // En previous_status komt uit de bewaarde waarde, niet uit de bijgewerkte rij.
  assert.match(blok, /previous_status:\s*vorigeStatus/);
});

test('de guard raakt ALLEEN send_email en send_whatsapp', () => {
  // De scope is het hele punt. Zou de guard breder staan, dan breekt hij de
  // geen-gehoor-flow; zou hij in stepDueRuns naast de switched-guard staan,
  // dan cancelt hij de run.
  const bron = readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8');
  const i = bron.indexOf("if (type === 'send_email' || type === 'send_whatsapp')");
  const j = bron.indexOf("if (type === 'set_tag'", i);
  assert.ok(i > 0 && j > i);
  const sendBlok = bron.slice(i, j);
  assert.match(sendBlok, /komtNietMeer\(attendee\)/, 'de guard hoort in de send-tak te staan');

  // En NERGENS anders: niet in de set_tag/update/notification-tak, en niet
  // naast de switched_to_other_event-guard in stepDueRuns.
  //
  // We tellen AANROEPEN, niet de tekst. De declaratie hierboven in het bestand
  // (`export function komtNietMeer(attendee) {`) bevat exact dezelfde letters
  // maar is geen guard, en een aanroep die in een stuk uitleg staat is er ook
  // geen. Zonder die twee correcties meet deze test commentaar in plaats van
  // code — dezelfde valkuil als in tests/events-automation-tester.test.js.
  const rest   = zonderUitleg(bron.slice(0, i) + bron.slice(j));
  const roepen = (rest.match(/(?<!function\s)komtNietMeer\(attendee\)/g) || []).length;
  assert.equal(roepen, 0,
    'komtNietMeer(attendee) mag alleen in de send-tak aangeroepen worden; '
    + 'de declaratie telt niet mee');
  assert.doesNotMatch(bron, /attendee\.status === 'geannuleerd'/,
    'geen losse geannuleerd-check naast de switched-guard');
});

test('still_registered is niet stil veranderd', () => {
  // Bewust NIET aangeraakt: die check wordt door bestaande automatisaties
  // gebruikt en oprekken zou hun gedrag wijzigen. De bescherming zit in de
  // kandidaat-filter en de send-guard, niet in deze conditie.
  const state = buildConditionState({ status: 'geannuleerd' }, {});
  assert.equal(state.still_registered, true,
    'geannuleerd leest hier nog steeds als ingeschreven — zie de PR-toelichting');
  assert.equal(buildConditionState({ status: 'no_show' }, {}).still_registered, false);
  assert.equal(buildConditionState({ status: 'switched_to_other_event' }, {}).still_registered, false);
});
