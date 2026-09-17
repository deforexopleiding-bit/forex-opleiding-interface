// tests/whatsapp-weigering-niet-stil.test.js
//
// EEN DOOR META GEWEIGERDE WHATSAPP MAG NIET STIL 'COMPLETED' WORDEN.
//
// GEMETEN 16 september. Run 994c0636-ca55-4f91-9b7c-3a86021fa462,
// 'Welkom + vragenlijst', telefoon '0472223752':
//
//   stap 0  send_email     ok:true
//   stap 1  send_whatsapp  ok:FALSE — Meta API 131009 (#131009)
//           "Parameter value is not valid — Het telefoonnummer is onjuist
//            ingedeeld: Gebruik de volgende indeling: +1234567890"
//           permanent:true
//
// En tóch: run.status = 'completed', run.last_error = NULL. Op het scherm zag
// dat eruit alsof alles gelukt was.
//
// Oorzaak: `skipped` en `permanent` zaten in één tak van advanceRun, en die
// tak liet lastError ongemoeid.
//
// ── DE VALKUIL DIE DEZE TEST BEWAAKT ────────────────────────────────────
// De reparatie mag de flow NIET afbreken. De mail van stap 0 is al weg, en de
// stappen ná de WhatsApp horen gewoon te lopen. Afbreken op een mislukte
// WhatsApp laat een halve flow achter — erger dan het probleem zelf.
// De eerste test hieronder eist letterlijk dat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { advanceRun } from '../api/_lib/events-automation-engine.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU   = new Date('2026-09-17T12:00:00.000Z');
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');

// De weigering zoals events-send.js hem teruggeeft, letterlijk uit de meting.
const META_131009 = {
  ok: false,
  permanent: true,
  error: 'Meta API 131009 (#131009) Parameter value is not valid — Het telefoonnummer is '
       + 'onjuist ingedeeld: Gebruik de volgende indeling: +1234567890',
};

// De gemeten flow: mail, dan WhatsApp, dan nog twee stappen erna.
function bouwRun(stappen) {
  return {
    id: 'run-994c0636', is_test: false, current_step_index: 0, attempts: 0,
    last_error: null, steps_snapshot: stappen,
  };
}

async function draai({ stappen, whatsappResultaat, attendee }) {
  const gelogd = [];
  const gedaan = [];
  const gemarkeerd = [];
  const u = await advanceRun({
    run: bouwRun(stappen),
    attendee: attendee || {
      id: 'att-1', status: 'aangemeld', email: 'maxim@deforexopleiding.nl',
      phone: '0472223752', follow_up_flagged: false, follow_up_reason: null,
    },
    event: { id: 'ev-1', starts_at: '2026-09-23T17:00:00.000Z' },
    now: NU,
    deps: {
      isStepDone: async () => false,
      recordLog:  async (i, t, r) => gelogd.push({ i, t, r }),
      sendEmail:    async () => { gedaan.push('email'); return { ok: true }; },
      sendWhatsApp: async () => { gedaan.push('wa'); return whatsappResultaat; },
      setTag:       async () => { gedaan.push('tag'); return { ok: true }; },
      updateAttendeeStatus: async () => { gedaan.push('status'); return { ok: true }; },
      sendInternalNotification: async () => { gedaan.push('intern'); return { ok: true }; },
      markeerWhatsappOnbereikbaar: async (arg) => { gemarkeerd.push(arg); return { ok: true }; },
    },
  });
  return { u, gelogd, gedaan, gemarkeerd };
}

const FLOW = [
  { type: 'send_email',    config: { subject: 'Welkom', body: 'vul de vragenlijst in' } },
  { type: 'send_whatsapp', config: { template_name: 'welkom_vragenlijst' } },
  { type: 'set_tag',       config: { tag: 'welkom-gehad' } },
  { type: 'send_internal_notification', config: { to: 'maxim@deforexopleiding.nl' } },
];

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE VALKUIL — DE FLOW MOET DOORLOPEN
// ═══════════════════════════════════════════════════════════════════════════

test('DE FLOW LOOPT DOOR na een geweigerde WhatsApp', async () => {
  // DIT IS DE BELANGRIJKSTE TEST. De mail is al weg; de stappen erna moeten
  // gewoon gebeuren. Zou de reparatie de run afbreken, dan blijft er een
  // halve flow staan en is de kwaal erger dan het gebrek.
  const { u, gedaan } = await draai({ stappen: FLOW, whatsappResultaat: META_131009 });
  assert.deepEqual(gedaan, ['email', 'wa', 'tag', 'intern'],
    'elke stap ná de WhatsApp MOET nog gedraaid zijn');
  assert.equal(u.status, 'completed', 'de run loopt af, hij blijft niet hangen');
  assert.equal(u.current_step_index, FLOW.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · MAAR NIET MEER STIL
// ═══════════════════════════════════════════════════════════════════════════

test('de reden staat op de RUN, niet alleen in het staplogboek', async () => {
  const { u } = await draai({ stappen: FLOW, whatsappResultaat: META_131009 });
  assert.notEqual(u.last_error, null, 'last_error NULL was precies de bug');
  assert.match(u.last_error, /131009/,     'de Meta-code hoort erin');
  assert.match(u.last_error, /send_whatsapp/, 'welk staptype het was');
  assert.match(u.last_error, /stap 1/,     'welke stap het was');
});

test('EEN LATERE GESLAAGDE STAP WIST DE REDEN NIET', async () => {
  // De subtiele variant van dezelfde bug: lastError wordt bij elke geslaagde
  // stap op null gezet. Zonder aparte sticky-variabele zou de weigering op
  // stap 1 onzichtbaar worden zodra stap 2 lukt — en dan staat de run weer op
  // 'completed' met last_error NULL, precies zoals gemeten.
  const { u, gedaan } = await draai({
    stappen: [
      { type: 'send_whatsapp', config: { template_name: 'x' } },
      { type: 'send_email',    config: { subject: 'daarna', body: 'gaat wel' } },
    ],
    whatsappResultaat: META_131009,
  });
  assert.deepEqual(gedaan, ['wa', 'email'], 'de mail erna is wel verstuurd');
  assert.match(u.last_error || '', /131009/,
    'de weigering mag niet weggepoetst zijn door de geslaagde mail erna');
});

test('de deelnemer wordt gemarkeerd, met de Meta-reden erbij', async () => {
  const { gemarkeerd } = await draai({ stappen: FLOW, whatsappResultaat: META_131009 });
  assert.equal(gemarkeerd.length, 1, 'precies één markering');
  assert.equal(gemarkeerd[0].attendee.id, 'att-1');
  assert.match(gemarkeerd[0].reden, /131009/, 'de reden hoort mee');
  assert.equal(gemarkeerd[0].stepIndex, 1);
});

test('de weigering staat ook als mislukt in het staplogboek', async () => {
  const { gelogd } = await draai({ stappen: FLOW, whatsappResultaat: META_131009 });
  const wa = gelogd.find((g) => g.t === 'send_whatsapp');
  assert.ok(wa, 'de stap hoort gelogd te zijn');
  assert.equal(wa.r.ok, false, 'als MISLUKT, niet als skip');
  assert.equal(wa.r.permanent, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · WAT GEEN FOUT IS, BLIJFT GEEN FOUT
// ═══════════════════════════════════════════════════════════════════════════

test("'skipped' zonder permanent is geen fout en markeert niemand", async () => {
  // Geen nummer, of een template die niet APPROVED is: er was niets te
  // versturen. Dat is geen weigering en hoort geen last_error en geen
  // markering op de deelnemer op te leveren.
  for (const res of [
    { ok: false, skipped: true, reason: 'no-phone' },
    { ok: false, skipped: true, reason: 'template niet APPROVED' },
  ]) {
    const { u, gemarkeerd, gedaan } = await draai({ stappen: FLOW, whatsappResultaat: res });
    assert.equal(u.last_error, null, res.reason + ' hoort geen last_error te zetten');
    assert.deepEqual(gemarkeerd, [], res.reason + ' hoort niemand te markeren');
    assert.deepEqual(gedaan, ['email', 'wa', 'tag', 'intern']);
  }
});

test('een TIJDELIJKE fout blijft retryen, dat is niet aangeraakt', async () => {
  // Geen permanent, geen skipped → retry met backoff op dezelfde stap. Dit
  // gedrag bestond en moet blijven; de nieuwe tak mag het niet opslokken.
  const { u, gedaan } = await draai({
    stappen: FLOW,
    whatsappResultaat: { ok: false, error: 'Meta 500 tijdelijk' },
  });
  assert.equal(u.current_step_index, 1, 'blijft op de WhatsApp-stap staan');
  assert.equal(u.attempts, 1);
  assert.ok(u.next_run_at, 'er hoort een retry-moment te staan');
  assert.deepEqual(gedaan, ['email', 'wa'], 'de stappen erna komen nog niet');
  assert.notEqual(u.status, 'completed');
});

test('een geweigerde MAIL markeert niemand als WhatsApp-onbereikbaar', async () => {
  // Een geweigerd e-mailadres is een ander probleem met een andere oplossing.
  // Die samen in één markering gooien maakt de melding onbruikbaar.
  const gemarkeerd = [];
  const u = await advanceRun({
    run: bouwRun([{ type: 'send_email', config: { subject: 'x', body: 'y' } }]),
    attendee: { id: 'att-1', status: 'aangemeld', email: 'kapot@', phone: '+31612345678' },
    event: { id: 'ev-1', starts_at: '2026-09-23T17:00:00.000Z' },
    now: NU,
    deps: {
      isStepDone: async () => false,
      recordLog:  async () => {},
      sendEmail:  async () => ({ ok: false, permanent: true, error: 'mailbox bestaat niet' }),
      sendWhatsApp: async () => ({ ok: true }),
      markeerWhatsappOnbereikbaar: async (a) => { gemarkeerd.push(a); return { ok: true }; },
    },
  });
  assert.deepEqual(gemarkeerd, [], 'geen WhatsApp-markering bij een mailfout');
  // Maar de reden staat er wél op — stil falen mag ook hier niet.
  assert.match(u.last_error || '', /mailbox bestaat niet/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 · DE MARKERING OVERSCHRIJFT NIETS EN GROEIT NIET AAN
// ═══════════════════════════════════════════════════════════════════════════

test('markeren is fail-soft: een kapotte markering breekt de flow niet', async () => {
  // De markering is de zichtbaarheidsmaatregel, maar hij mag de flow niet
  // gijzelen — dat zou de valkuil uit test 1 via een achterdeur terugbrengen.
  const gedaan = [];
  const u = await advanceRun({
    run: bouwRun(FLOW),
    attendee: { id: 'att-1', status: 'aangemeld', email: 'a@b.nl', phone: '0472223752' },
    event: { id: 'ev-1', starts_at: '2026-09-23T17:00:00.000Z' },
    now: NU,
    deps: {
      isStepDone: async () => false,
      recordLog:  async () => {},
      sendEmail:    async () => { gedaan.push('email'); return { ok: true }; },
      sendWhatsApp: async () => { gedaan.push('wa'); return META_131009; },
      setTag:       async () => { gedaan.push('tag'); return { ok: true }; },
      sendInternalNotification: async () => { gedaan.push('intern'); return { ok: true }; },
      markeerWhatsappOnbereikbaar: async () => { throw new Error('DB weg'); },
    },
  });
  assert.deepEqual(gedaan, ['email', 'wa', 'tag', 'intern'], 'de flow loopt gewoon door');
  assert.match(u.last_error || '', /131009/, 'en de reden staat er nog steeds op');
});

test('de dep overschrijft een bestaande reden niet en is idempotent', () => {
  // Op de BRON, want de dep zit in stepDueRuns en heeft een echte DB nodig.
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  const i = bron.indexOf('markeerWhatsappOnbereikbaar:');
  assert.ok(i > 0, 'de dep hoort te bestaan');
  const blok = bron.slice(i, bron.indexOf('updateAttendeeStatus:', i));
  // Idempotent: al gemarkeerd → niets doen.
  assert.match(blok, /includes\(MARKERING\)/,
    'hij hoort te stoppen als de markering er al staat');
  // Bestaande reden blijft staan.
  assert.match(blok, /bestaand\s*\+/,
    'een bestaande reden hoort behouden te blijven, niet overschreven');
  // Gebruikt de bestaande needs_review-vlag, geen nieuwe kolom.
  assert.match(blok, /follow_up_flagged/);
  assert.match(blok, /follow_up_reason/);
  // En faalt niet stil.
  assert.match(blok, /console\.error/);
});

test('permanent en skipped zitten niet meer in één tak', () => {
  const bron = zonderUitleg(
    readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8'));
  assert.doesNotMatch(bron, /result\.skipped \|\| result\.permanent/,
    'dat was de bug: een Meta-weigering behandeld als "niets te doen"');
});
