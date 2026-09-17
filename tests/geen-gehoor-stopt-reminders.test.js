// tests/geen-gehoor-stopt-reminders.test.js
//
// TIJDENS DE BELRONDE GEEN REMINDERS.
//
// GEMETEN en in de code bevestigd. De geen-gehoor-flow laat de deelnemer MET
// OPZET op status 'aangemeld' staan tot de deadline verstrijkt — pas stap 4
// van 'Geen gehoor - laatste kans' zet hem op geannuleerd (zie het blok bij
// actie 'geen_gehoor' in api/opvolging-aanmelding-actie.js).
//
// De reminderfilter uit #1617 kijkt naar `status`, niet naar `call_status`. In
// dat venster van 48 uur is iemand dus een geldige reminder-kandidaat. Bij een
// event dat 2 tot 5 dagen weg is valt het 120-uursvenster van 'Warmup vroeg
// (waarde)' er middenin:
//
//   'je plek vervalt als we je niet bereiken'   ← geen-gehoor, stap 0/1
//   'waarom deze masterclass je dag verandert'  ← Warmup vroeg, 120u
//
// ── DE VAL DIE DEZE TEST BEWAAKT ────────────────────────────────────────
// 'Geen gehoor - laatste kans' stuurt in stap 0 en 1 zelf een mail en een
// WhatsApp naar iemand die per definitie call_status='geen_gehoor' heeft — dat
// IS zijn trigger. Een guard die alleen naar de belstatus kijkt, laat die flow
// zijn eigen berichten overslaan en zet de hele functie stil uit. De pauze is
// daarom gescoped op trigger_type 'time_before_event'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  advanceRun, reminderWachtOpBelronde, REMINDER_PAUZE_BELSTATUS,
  komtNietMeer, NIET_MEER_KOMEND_STATUSSEN,
} from '../api/_lib/events-automation-engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU   = new Date('2026-09-17T12:00:00.000Z');
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');

// De reminder zoals hij live staat: mail + WhatsApp.
const REMINDER = [
  { type: 'send_email',    config: { subject: 'Waarom deze masterclass', body: '...' } },
  { type: 'send_whatsapp', config: { template_name: 'warmup_vroeg' } },
];

// 'Geen gehoor - laatste kans', de zes stappen zoals ze in productie draaien.
const GEEN_GEHOOR = [
  { type: 'send_email',    config: { subject: 'Je plek vervalt', body: 'we bereiken je niet' } },
  { type: 'send_whatsapp', config: { template_name: 'geen_gehoor_laatste_kans' } },
  { type: 'wait',          config: { amount: 48, unit: 'hours' } },
  { type: 'condition',     config: { check: 'geen_reactie_sinds_belstatus' } },
  { type: 'update_attendee_status', config: { new_status: 'geannuleerd', call_status: 'komt_niet' } },
  { type: 'send_internal_notification', config: { subject: 'Plek vervallen', body: 'x' } },
];

async function draai({ stappen, triggerType, attendee, stepIndex = 0, conditieWaar = true }) {
  const gelogd = [];
  const gedaan = [];
  const u = await advanceRun({
    run: {
      id: 'run-1', is_test: false, current_step_index: stepIndex, attempts: 0,
      last_error: null, steps_snapshot: stappen,
    },
    attendee,
    event: { id: 'ev-1', starts_at: '2026-09-21T17:00:00.000Z' },
    now: NU,
    triggerType,
    deps: {
      isStepDone: async () => false,
      recordLog:  async (i, t, r) => gelogd.push({ i, t, r }),
      sendEmail:    async () => { gedaan.push('email'); return { ok: true }; },
      sendWhatsApp: async () => { gedaan.push('wa'); return { ok: true }; },
      setTag:       async () => { gedaan.push('tag'); return { ok: true }; },
      updateAttendeeStatus: async () => { gedaan.push('status'); return { ok: true }; },
      sendInternalNotification: async () => { gedaan.push('intern'); return { ok: true }; },
      measureCondition: async () => ({ gemeten: true, waar: conditieWaar, reden: 'test' }),
    },
  });
  return { u, gelogd, gedaan };
}

// Iemand middenin het geen-gehoor-venster: nog 'aangemeld', belstatus gezet.
const IN_VENSTER = {
  id: 'att-1', status: 'aangemeld', call_status: 'geen_gehoor',
  call_status_at: '2026-09-17T09:00:00.000Z',
  email: 'x@y.nl', phone: '+31612345678',
};

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE VAL — DE GEEN-GEHOOR-FLOW STUURT ZIJN EIGEN BERICHTEN NOG
// ═══════════════════════════════════════════════════════════════════════════

test('DE GEEN-GEHOOR-FLOW BLOKKEERT ZICHZELF NIET', async () => {
  // DIT IS DE BELANGRIJKSTE TEST. Zijn trigger IS call_status='geen_gehoor',
  // dus een guard op de belstatus alleen zou stap 0 en 1 overslaan en de hele
  // functie stil uitzetten.
  const { gedaan } = await draai({
    stappen: GEEN_GEHOOR, triggerType: 'on_call_status', attendee: IN_VENSTER,
  });
  assert.equal(gedaan[0], 'email', 'de mail "je plek vervalt" MOET uitgaan');
  assert.equal(gedaan[1], 'wa',    'en de WhatsApp erbij');
});

test('en de rest van die flow ook: stap 4 annuleert, stap 5 meldt', async () => {
  // Vanaf de conditie, zodat de wait niet in de weg zit.
  const { gedaan, u } = await draai({
    stappen: GEEN_GEHOOR, triggerType: 'on_call_status', attendee: IN_VENSTER,
    stepIndex: 3, conditieWaar: true,
  });
  assert.deepEqual(gedaan, ['status', 'intern'],
    'annuleren en de interne melding horen beide te gebeuren');
  assert.equal(u.status, 'completed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · MAAR DE REMINDER ZWIJGT
// ═══════════════════════════════════════════════════════════════════════════

test('een reminder stuurt NIETS tijdens het geen-gehoor-venster', async () => {
  const { gedaan, gelogd, u } = await draai({
    stappen: REMINDER, triggerType: 'time_before_event', attendee: IN_VENSTER,
  });
  assert.deepEqual(gedaan, [], 'geen mail en geen WhatsApp');
  // NIET STIL: beide stappen staan met reden in het log.
  assert.equal(gelogd.length, 2);
  for (const g of gelogd) {
    assert.equal(g.r.skipped, true);
    assert.match(g.r.reason, /belronde loopt/);
    assert.equal(g.r.attendee_call_status, 'geen_gehoor');
  }
  assert.equal(u.status, 'completed', 'de run loopt af, hij blijft niet hangen');
});

test('de pauze raakt ALLEEN sends — intern en status blijven werken', async () => {
  // Zelfde principe als #1617. Een reminderflow die na de mail nog een interne
  // stap heeft, moet die stap houden.
  const { gedaan } = await draai({
    stappen: [
      { type: 'send_email', config: { subject: 'x', body: 'y' } },
      { type: 'update_attendee_status', config: { new_status: 'aangemeld' } },
      { type: 'send_internal_notification', config: { subject: 'a', body: 'b' } },
      { type: 'set_tag', config: { tag: 't' } },
    ],
    triggerType: 'time_before_event', attendee: IN_VENSTER,
  });
  assert.deepEqual(gedaan, ['status', 'intern', 'tag'],
    'de mail valt weg, de rest draait gewoon');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE SCOPING, PER TRIGGER
// ═══════════════════════════════════════════════════════════════════════════

test('alleen time_before_event pauzeert; andere triggers sturen gewoon', async () => {
  for (const tt of ['on_signup', 'on_call_status', 'on_assessment_completed',
                    'on_assessment_not_completed_after', 'on_status']) {
    const { gedaan } = await draai({
      stappen: REMINDER, triggerType: tt, attendee: IN_VENSTER,
    });
    assert.deepEqual(gedaan, ['email', 'wa'], tt + ' hoort gewoon te sturen');
  }
});

test('onbekend trigger_type pauzeert NIET', async () => {
  // De veilige kant bij een mislukte opzoeking: de pauze missen laat hoogstens
  // de bestaande tegenspraak staan, de pauze verkeerd toepassen breekt een
  // werkende flow.
  for (const tt of [null, undefined]) {
    const { gedaan } = await draai({
      stappen: REMINDER, triggerType: tt, attendee: IN_VENSTER,
    });
    assert.deepEqual(gedaan, ['email', 'wa']);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · HET PREDICAAT, EN WAT HET NIET IS
// ═══════════════════════════════════════════════════════════════════════════

test('reminderWachtOpBelronde kijkt alleen naar geen_gehoor', () => {
  assert.equal(REMINDER_PAUZE_BELSTATUS, 'geen_gehoor');
  assert.equal(reminderWachtOpBelronde({ call_status: 'geen_gehoor' }), true);
  // Andere belstatussen pauzeren niet: bevestigd komt, komt_niet wordt via de
  // STATUS al afgehandeld, en voicemail/terugbellen zijn geen 48-uursvenster.
  for (const cs of ['bevestigd', 'komt_niet', 'voicemail', 'terugbellen',
                    'foutief_nummer', 'liever_zoom', '', null, undefined]) {
    assert.equal(reminderWachtOpBelronde({ call_status: cs }), false,
      JSON.stringify(cs) + ' hoort niet te pauzeren');
  }
  assert.equal(reminderWachtOpBelronde({}), false);
  assert.equal(reminderWachtOpBelronde(null), false);
});

test("'geen_gehoor' is GEEN status en hoort niet in de statuslijst", () => {
  // Het is een PAUZE op de belstatus, geen afmelding. Iemand met geen_gehoor
  // komt mogelijk wél — daarom loopt de deadline nog. In
  // NIET_MEER_KOMEND_STATUSSEN zetten zou dat verwarren met 'komt niet meer',
  // en die lijst wordt ook door andere triggers gebruikt.
  assert.equal(NIET_MEER_KOMEND_STATUSSEN.includes('geen_gehoor'), false);
  assert.equal(komtNietMeer({ status: 'aangemeld', call_status: 'geen_gehoor' }), false,
    'de inschrijvingsstatus blijft aangemeld — dat is met opzet');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 · DE KANDIDAAT-FILTER
// ═══════════════════════════════════════════════════════════════════════════

test('de kandidaat-filter laat rijen ZONDER belstatus niet wegvallen', () => {
  // De valkuil in de filter zelf: `call_status <> 'geen_gehoor'` is NULL voor
  // elke rij zonder belstatus, en die vallen dan weg. Dat is de overgrote
  // meerderheid van de deelnemers — de reminders zouden vrijwel niemand meer
  // bereiken. Vandaar expliciet 'is null OF niet gelijk aan'.
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  const i = bron.indexOf("q = q.in('status', REMINDER_STATUSSEN);");
  const j = bron.indexOf("else if (auto.trigger_type === 'on_assessment_not_completed_after')", i);
  assert.ok(i > 0 && j > i);
  const tak = bron.slice(i, j);
  assert.match(tak, /call_status\.is\.null/,
    'rijen zonder belstatus moeten expliciet toegelaten worden');
  assert.doesNotMatch(tak, /\.neq\('call_status'/,
    'een kale .neq laat de NULL-rijen wegvallen');
});

test('de pauze zit in de send-tak en nergens anders', () => {
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  const i = bron.indexOf("if (type === 'send_email' || type === 'send_whatsapp')");
  const j = bron.indexOf("if (type === 'set_tag'", i);
  const sendBlok = bron.slice(i, j);
  assert.match(sendBlok, /reminderWachtOpBelronde\(attendee\)/);
  const rest = bron.slice(0, i) + bron.slice(j);
  const elders = (rest.match(/(?<!function\s)reminderWachtOpBelronde\(attendee\)/g) || []).length;
  assert.equal(elders, 0, 'de pauze hoort alleen in de send-tak');
  // En altijd samen met de trigger-scoping — nooit los.
  assert.match(sendBlok, /triggerType === 'time_before_event' && reminderWachtOpBelronde/,
    'zonder de scoping blokkeert de geen-gehoor-flow zichzelf');
});

test('stepDueRuns geeft het trigger_type door', () => {
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  assert.match(bron, /triggerPerAutomation/, 'de opzoeking hoort te bestaan');
  assert.match(bron, /triggerType: triggerPerAutomation\.get\(run\.automation_id\)/,
    'en doorgegeven te worden aan advanceRun');
  // Eén query voor de batch, geen N+1.
  assert.match(bron, /\.in\('id', automationIds\)/);
  // En niet stil falen.
  assert.match(bron, /trigger_type-opzoeking faalde/);
});
