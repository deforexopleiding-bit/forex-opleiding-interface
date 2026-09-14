// tests/events-automation-geen-gehoor-stappen.test.js
//
// DRIE UITBREIDINGEN DIE DE GEEN-GEHOOR-FLOW NODIG HEEFT.
//
//  (a) De wachtstap krijgt een bovengrens: 48 uur, maar nooit later dan 48 uur
//      vóór het event. Zonder die grens valt de deadline van iemand die zich
//      twee dagen voor de masterclass aanmeldt ná het event, en gaat de
//      vervolgstap (plek vervalt, melding aan Maxim) over een middag die al
//      geweest is.
//
//  (b) Een conditie 'geen_reactie_sinds_belstatus'. Op deze uitkomst vervalt
//      iemands plek, dus de regel die het hardst telt: NIET GEMETEN IS NIET
//      WAAR. Geen nummer en geen mailadres, geen nulpunt, of een query die
//      faalt → false, en de flow stopt.
//
//  (c) update_attendee_status mag er een belstatus bij zetten, zodat één stap
//      de inschrijving op 'geannuleerd' en de belstatus op 'komt_niet' zet.
//      Anders blijft de aanwezigenlijst staan op 'geen gehoor' bij iemand
//      wiens plek net vervallen is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  computeNextRunAt, applyWaitCeiling, evaluateCondition, buildConditionState,
  advanceRun, GEMETEN_CONDITION_CHECKS,
} from '../api/_lib/events-automation-engine.js';
import { validateSteps } from '../api/events-automation-save.js';
import {
  normalizeerTelefoon, telefoonVarianten, meetInkomendeReacties, geenReactieSindsBelstatus,
} from '../api/_lib/events-geen-gehoor-reactie.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU   = Date.parse('2026-09-14T12:00:00.000Z');
const UUR  = 3_600_000;

// ═══════════════════════════════════════════════════════════════════════════
// (a) DE BOVENGRENS OP DE WACHTSTAP
// ═══════════════════════════════════════════════════════════════════════════

test('computeNextRunAt blijft puur — geen grens, geen event nodig', () => {
  // De pure helper is niet aangeraakt; de grens komt er los bovenop.
  assert.equal(computeNextRunAt({ amount: 48, unit: 'hours' }, NU).getTime(), NU + 48 * UUR);
  assert.equal(computeNextRunAt({ amount: 1, unit: 'days' }, NU).getTime(), NU + 24 * UUR);
});

test('zonder grens in de config verandert er niets', () => {
  const gepland = computeNextRunAt({ amount: 48, unit: 'hours' }, NU);
  const uit = applyWaitCeiling(gepland, { amount: 48, unit: 'hours' },
    '2026-09-26T17:00:00.000Z', NU);
  assert.equal(uit.getTime(), NU + 48 * UUR);
});

test('de grens knipt de wachttijd af als het event te dichtbij is', () => {
  // Event op 16 september 10:00; 48 uur ervoor is 14 september 10:00 — dat is
  // al voorbij op het nu-moment (12:00), dus de flow gaat meteen door.
  const gepland = computeNextRunAt({ amount: 48, unit: 'hours' }, NU);
  const uit = applyWaitCeiling(gepland,
    { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 48 },
    '2026-09-16T10:00:00.000Z', NU);
  assert.equal(uit.getTime(), NU, 'grens in het verleden = wachttijd nul');
});

test('ligt de grens tussen nu en de geplande tijd, dan wint de grens', () => {
  // Event op 17 september 12:00 → grens op 15 september 12:00 (24 uur vanaf
  // nu). De geplande 48 uur zou op 16 september uitkomen: te laat.
  const gepland = computeNextRunAt({ amount: 48, unit: 'hours' }, NU);
  const uit = applyWaitCeiling(gepland,
    { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 48 },
    '2026-09-17T12:00:00.000Z', NU);
  assert.equal(uit.getTime(), Date.parse('2026-09-15T12:00:00.000Z'));
});

test('ligt de grens ná de geplande tijd, dan wint de geplande tijd', () => {
  // Event op 26 september (Gent) → grens op 24 september. 48 uur vanaf nu is
  // 16 september, ruim daarvoor. De grens is dan geen grens.
  const gepland = computeNextRunAt({ amount: 48, unit: 'hours' }, NU);
  const uit = applyWaitCeiling(gepland,
    { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 48 },
    '2026-09-26T17:00:00.000Z', NU);
  assert.equal(uit.getTime(), NU + 48 * UUR);
});

test('een event zonder leesbare startdatum levert GEEN grens op', () => {
  // Een grens verzinnen op een event zonder datum zou de run vooruitduwen op
  // een schatting.
  const gepland = computeNextRunAt({ amount: 48, unit: 'hours' }, NU);
  for (const start of [null, undefined, '', 'binnenkort', 'zaterdag']) {
    const uit = applyWaitCeiling(gepland,
      { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 48 }, start, NU);
    assert.equal(uit.getTime(), NU + 48 * UUR, 'start=' + String(start));
  }
});

test('een onleesbare grens wordt genegeerd, niet als nul gelezen', () => {
  const gepland = computeNextRunAt({ amount: 48, unit: 'hours' }, NU);
  for (const grens of ['tweeënveertig', NaN, -1, {}, []]) {
    const uit = applyWaitCeiling(gepland,
      { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: grens },
      '2026-09-16T10:00:00.000Z', NU);
    assert.equal(uit.getTime(), NU + 48 * UUR, 'grens=' + String(grens));
  }
});

test('de wachtstap in advanceRun past de grens toe', async () => {
  const run = {
    current_step_index: 0,
    steps_snapshot: [
      { type: 'wait', config: { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 48 } },
      { type: 'condition', config: { check: 'still_registered' } },
    ],
  };
  const u = await advanceRun({
    run,
    attendee: { id: 'a1', status: 'aangemeld' },
    event   : { id: 'e1', starts_at: '2026-09-17T12:00:00.000Z' },
    now     : new Date(NU),
    deps    : { isStepDone: async () => false, recordLog: async () => {} },
  });
  assert.equal(u.status, 'active');
  assert.equal(u.current_step_index, 1);
  assert.equal(new Date(u.next_run_at).getTime(), Date.parse('2026-09-15T12:00:00.000Z'));
});

test('de save-validator accepteert een wait zonder grens en weigert een onzin-grens', () => {
  assert.equal(validateSteps([{ type: 'wait', config: { amount: 1, unit: 'days' } }]), null);
  assert.equal(validateSteps([{ type: 'wait',
    config: { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 48 } }]), null);
  assert.equal(validateSteps([{ type: 'wait',
    config: { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 0 } }]), null);
  assert.match(String(validateSteps([{ type: 'wait',
    config: { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: 'veel' } }])),
    /uiterlijk_uren_voor_event/);
  assert.match(String(validateSteps([{ type: 'wait',
    config: { amount: 48, unit: 'hours', uiterlijk_uren_voor_event: -3 } }])),
    /uiterlijk_uren_voor_event/);
});

// ═══════════════════════════════════════════════════════════════════════════
// (b) DE CONDITIE — NIET GEMETEN IS NIET WAAR
// ═══════════════════════════════════════════════════════════════════════════

test('de check staat in de lijst met checks die een meting nodig hebben', () => {
  assert.ok(GEMETEN_CONDITION_CHECKS.has('geen_reactie_sinds_belstatus'));
});

test('gemeten en niets binnengekomen = waar', () => {
  const state = { ...buildConditionState({ status: 'aangemeld' }, {}),
    meting: { niet_gemeten: false, waar: true, aantal_treffers: 0 } };
  assert.equal(evaluateCondition('geen_reactie_sinds_belstatus', state), true);
});

test('gemeten en er kwam iets binnen = niet waar', () => {
  const state = { ...buildConditionState({ status: 'aangemeld' }, {}),
    meting: { niet_gemeten: false, waar: false, aantal_treffers: 1 } };
  assert.equal(evaluateCondition('geen_reactie_sinds_belstatus', state), false);
});

test('NIET GEMETEN is NIET waar — in elke vorm', () => {
  // Dit is de tak die iemands plek beschermt. Een onbekende check valt in deze
  // engine bewust door naar `true` ("onbekende check blokkeert niet"); déze
  // check mag dat nooit doen.
  const basis = buildConditionState({ status: 'aangemeld' }, {});
  const varianten = [
    undefined,
    null,
    { niet_gemeten: true, waar: false, reden: 'geen nummer en geen mailadres' },
    { niet_gemeten: true, waar: true },          // zelfs als 'waar' meeliegt
    { meetbaar: false, waar: true },
    { reden: 'iets' },                            // geen waar-veld
  ];
  for (const meting of varianten) {
    assert.equal(evaluateCondition('geen_reactie_sinds_belstatus', { ...basis, meting }), false,
      'meting=' + JSON.stringify(meting));
  }
  // En zonder meting-veld helemaal.
  assert.equal(evaluateCondition('geen_reactie_sinds_belstatus', basis), false);
});

test('de bestaande checks doen nog precies wat ze deden', () => {
  const ingevuld = buildConditionState({ assessment_response_id: 'r1', status: 'aangemeld' },
    { niveau: 'Basis' });
  assert.equal(evaluateCondition('assessment_completed', ingevuld), true);
  assert.equal(evaluateCondition('assessment_not_completed', ingevuld), false);
  assert.equal(evaluateCondition('still_registered', ingevuld), true);
  assert.equal(evaluateCondition('niveau_is_basis', ingevuld), true);
  assert.equal(evaluateCondition('niveau_is_gevorderd', ingevuld), false);
  assert.equal(evaluateCondition('iets_onbekends', ingevuld), true,
    'een onbekende check blokkeert niet — bestaand gedrag');
});

test('zonder meter is de uitkomst niet_gemeten en stopt de flow', async () => {
  const gelogd = [];
  const run = {
    current_step_index: 0,
    steps_snapshot: [
      { type: 'condition', config: { check: 'geen_reactie_sinds_belstatus', on_fail: 'exit' } },
      { type: 'update_attendee_status', config: { new_status: 'geannuleerd' } },
    ],
  };
  const u = await advanceRun({
    run,
    attendee: { id: 'a1', status: 'aangemeld' },
    event   : { id: 'e1', starts_at: '2026-09-26T17:00:00.000Z' },
    now     : new Date(NU),
    // Bewust GEEN measureCondition: een oudere caller of een test die de dep
    // vergeet mag geen annulering veroorzaken.
    deps: { isStepDone: async () => false, recordLog: async (i, t, r) => gelogd.push({ i, t, r }) },
  });
  assert.equal(u.status, 'exited', 'de flow hoort te stoppen, niet door te lopen');
  assert.equal(u.current_step_index, 0, 'de annulerings-stap is niet bereikt');
  assert.equal(gelogd[0].r.pass, false);
  assert.equal(gelogd[0].r.niet_gemeten, true, 'niet_gemeten hoort letterlijk in het log');
  assert.match(String(gelogd[0].r.meting_reden), /geen meter/);
});

test('een meter die gooit levert niet_gemeten op, geen crash en geen annulering', async () => {
  const gelogd = [];
  const run = {
    current_step_index: 0,
    steps_snapshot: [
      { type: 'condition', config: { check: 'geen_reactie_sinds_belstatus', on_fail: 'exit' } },
      { type: 'update_attendee_status', config: { new_status: 'geannuleerd' } },
    ],
  };
  const u = await advanceRun({
    run,
    attendee: { id: 'a1', status: 'aangemeld' },
    event   : { id: 'e1', starts_at: '2026-09-26T17:00:00.000Z' },
    now     : new Date(NU),
    deps: {
      isStepDone: async () => false,
      recordLog: async (i, t, r) => gelogd.push({ i, t, r }),
      measureCondition: async () => { throw new Error('databank weg'); },
    },
  });
  assert.equal(u.status, 'exited');
  assert.equal(gelogd[0].r.niet_gemeten, true);
  assert.match(String(gelogd[0].r.meting_reden), /databank weg/);
});

test('gemeten-en-niets levert wél door naar de volgende stap', async () => {
  const gelogd = [];
  const run = {
    current_step_index: 0,
    steps_snapshot: [
      { type: 'condition', config: { check: 'geen_reactie_sinds_belstatus', on_fail: 'exit' } },
      { type: 'wait', config: { amount: 1, unit: 'hours' } },
    ],
  };
  const u = await advanceRun({
    run,
    attendee: { id: 'a1', status: 'aangemeld' },
    event   : { id: 'e1', starts_at: '2026-09-26T17:00:00.000Z' },
    now     : new Date(NU),
    deps: {
      isStepDone: async () => false,
      recordLog: async (i, t, r) => gelogd.push({ i, t, r }),
      measureCondition: async () => ({
        niet_gemeten: false, waar: true, aantal_treffers: 0,
        kanalen: ['whatsapp', 'email'], reden: 'gemeten: geen inkomend bericht',
      }),
    },
  });
  assert.equal(u.status, 'active');
  assert.equal(gelogd[0].r.pass, true);
  assert.equal(gelogd[0].r.niet_gemeten, false);
  assert.deepEqual(gelogd[0].r.meting_kanalen, ['whatsapp', 'email']);
});

// ── DE METING ZELF ────────────────────────────────────────────────────────

test('telefoonnummers worden op pure digits vergeleken', () => {
  assert.equal(normalizeerTelefoon('+31 6 55 27 02 12'), '31655270212');
  assert.equal(normalizeerTelefoon('0031655270212'), '0031655270212');
  assert.equal(normalizeerTelefoon(null), '');
  const v = telefoonVarianten('+31655270212');
  assert.equal(v.digits, '31655270212');
  assert.equal(v.laatste9, '655270212');
  assert.match(v.orFilter, /phone_number\.eq\.\+31655270212/);
  assert.match(v.orFilter, /phone_number\.ilike\.%655270212/);
});

test('een te kort nummer krijgt geen ilike-staart', () => {
  // '%123' zou half de databank matchen.
  const v = telefoonVarianten('123');
  assert.doesNotMatch(String(v.orFilter), /ilike/);
});

/** Nep-databank met per tabel een vaste uitkomst of fout. */
function nepDb(tabellen) {
  return {
    from(tabel) {
      const conf = tabellen[tabel] || { data: [] };
      const k = {
        select: () => k, eq: () => k, in: () => k, is: () => k, not: () => k,
        or: () => k, gte: () => k, lte: () => k, ilike: () => k, order: () => k,
        limit: () => k,
        then: (r, j) => Promise.resolve(
          conf.error ? { data: null, error: { message: conf.error } } : { data: conf.data || [], error: null },
        ).then(r, j),
      };
      return k;
    },
  };
}

const SINDS = '2026-09-14T11:05:00.000Z';

test('zonder nulpunt is er geen meting', async () => {
  for (const sinceIso of [null, undefined, '', 'gisteren']) {
    const uit = await meetInkomendeReacties({ phone: '+31612345678', email: 'a@b.nl', sinceIso, db: nepDb({}) });
    assert.equal(uit.niet_gemeten, true, 'since=' + String(sinceIso));
    assert.match(String(uit.reden), /nulpunt/);
  }
});

test('zonder nummer en zonder mailadres is er geen meting', async () => {
  const uit = await meetInkomendeReacties({ phone: null, email: '  ', sinceIso: SINDS, db: nepDb({}) });
  assert.equal(uit.niet_gemeten, true);
  assert.match(uit.reden, /geen telefoonnummer en geen e-mailadres/);
  assert.deepEqual(uit.treffers, []);
});

test('een gefaalde query is niet_gemeten, niet "geen reactie"', async () => {
  const wa = await meetInkomendeReacties({
    phone: '+31612345678', email: null, sinceIso: SINDS,
    db: nepDb({ whatsapp_conversations: { error: 'timeout' } }),
  });
  assert.equal(wa.niet_gemeten, true);
  assert.match(wa.reden, /timeout/);

  const mail = await meetInkomendeReacties({
    phone: null, email: 'a@b.nl', sinceIso: SINDS,
    db: nepDb({ email_messages: { error: 'kolom bestaat niet' } }),
  });
  assert.equal(mail.niet_gemeten, true);
  assert.match(mail.reden, /kolom bestaat niet/);
});

test('geen conversatie is een GELDIGE meting met nul WhatsApp-treffers', async () => {
  const uit = await meetInkomendeReacties({
    phone: '+31612345678', email: null, sinceIso: SINDS,
    db: nepDb({ whatsapp_conversations: { data: [] } }),
  });
  assert.equal(uit.niet_gemeten, false);
  assert.equal(uit.meetbaar, true);
  assert.deepEqual(uit.treffers, []);
  assert.deepEqual(uit.kanalen, ['whatsapp']);
});

test('een inkomende WhatsApp en een inkomende mail worden allebei gevonden', async () => {
  const uit = await meetInkomendeReacties({
    phone: '+31612345678', email: 'Werner@Test.be', sinceIso: SINDS,
    db: nepDb({
      whatsapp_conversations: { data: [{ id: 'c1', phone_number: '+31612345678' }] },
      whatsapp_messages: { data: [
        { id: 'm1', body: 'ja ik kom', created_at: '2026-09-14T13:00:00.000Z', direction: 'in' },
      ] },
      email_messages: { data: [
        { id: 'e1', from_address: 'werner@test.be', subject: 'Re: je plek',
          snippet: 'sorry, telefoon stuk', date_received: '2026-09-14T12:30:00.000Z' },
      ] },
    }),
  });
  assert.equal(uit.niet_gemeten, false);
  assert.equal(uit.treffers.length, 2);
  // Chronologisch: de mail van 12:30 vóór de WhatsApp van 13:00.
  assert.equal(uit.treffers[0].kanaal, 'email');
  assert.equal(uit.treffers[0].bericht_id, 'mail:e1');
  assert.match(uit.treffers[0].tekst, /Re: je plek — sorry, telefoon stuk/);
  assert.equal(uit.treffers[1].kanaal, 'whatsapp');
  assert.equal(uit.treffers[1].bericht_id, 'wa:m1');
  assert.equal(uit.treffers[1].tekst, 'ja ik kom');
});

test('een WhatsApp zonder tekst (media) is nog steeds een reactie', async () => {
  const uit = await meetInkomendeReacties({
    phone: '+31612345678', email: null, sinceIso: SINDS,
    db: nepDb({
      whatsapp_conversations: { data: [{ id: 'c1' }] },
      whatsapp_messages: { data: [{ id: 'm2', body: null, created_at: '2026-09-14T13:00:00.000Z' }] },
    }),
  });
  assert.equal(uit.treffers.length, 1);
  assert.match(uit.treffers[0].tekst, /media of sticker/);
});

test('geenReactieSindsBelstatus vertaalt de meting naar waar/niet-waar', async () => {
  const stil = await geenReactieSindsBelstatus({
    phone: '+31612345678', email: null, sinceIso: SINDS,
    db: nepDb({ whatsapp_conversations: { data: [] } }),
  });
  assert.deepEqual(
    { waar: stil.waar, niet_gemeten: stil.niet_gemeten, aantal: stil.aantal_treffers },
    { waar: true, niet_gemeten: false, aantal: 0 });

  const antwoord = await geenReactieSindsBelstatus({
    phone: '+31612345678', email: null, sinceIso: SINDS,
    db: nepDb({
      whatsapp_conversations: { data: [{ id: 'c1' }] },
      whatsapp_messages: { data: [{ id: 'm1', body: 'ja', created_at: '2026-09-14T13:00:00.000Z' }] },
    }),
  });
  assert.equal(antwoord.waar, false);
  assert.equal(antwoord.aantal_treffers, 1);

  const onmeetbaar = await geenReactieSindsBelstatus({ phone: null, email: null, sinceIso: SINDS, db: nepDb({}) });
  assert.equal(onmeetbaar.waar, false, 'onmeetbaar mag NOOIT waar zijn');
  assert.equal(onmeetbaar.niet_gemeten, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// (c) BELSTATUS OP update_attendee_status
// ═══════════════════════════════════════════════════════════════════════════

test('de save-validator accepteert een stap zonder belstatus (bestaand gedrag)', () => {
  assert.equal(validateSteps([{ type: 'update_attendee_status',
    config: { new_status: 'geannuleerd' } }]), null);
});

test('de save-validator accepteert een geldige belstatus en weigert een onbekende', () => {
  assert.equal(validateSteps([{ type: 'update_attendee_status',
    config: { new_status: 'geannuleerd', call_status: 'komt_niet' } }]), null);
  assert.match(String(validateSteps([{ type: 'update_attendee_status',
    config: { new_status: 'geannuleerd', call_status: 'ergens_anders' } }])), /call_status/);
});

test('de engine zet status en belstatus in één patch, en houdt de cascade', () => {
  const bron = readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8');
  const i = bron.indexOf('updateAttendeeStatus: async (step)');
  assert.ok(i > 0);
  const blok = bron.slice(i, bron.indexOf('sendInternalNotification', i));
  assert.match(blok, /const newCallStatus = step\?\.config\?\.call_status \|\| null/);
  assert.match(blok, /patch\.call_status\s*=\s*newCallStatus/);
  assert.match(blok, /patch\.call_status_at\s*=\s*nowIso/);
  // De bestaande capaciteitscascade blijft draaien zoals hij draaide.
  assert.match(blok, /onConfirmedAttendeeMutation\(event\.id/);
  // En idempotent: al goed = overslaan, in beide velden.
  assert.match(blok, /statusAlGoed && belstatusAlGoed/);
});

test('zonder call_status in de config blijft de belstatus ongemoeid', () => {
  const bron = readFileSync(join(ROOT, 'api/_lib/events-automation-engine.js'), 'utf8');
  const i = bron.indexOf('updateAttendeeStatus: async (step)');
  const blok = bron.slice(i, bron.indexOf('sendInternalNotification', i));
  // belstatusAlGoed is waar zodra er geen nieuwe belstatus gevraagd is, dus
  // komt call_status niet in de patch.
  assert.match(blok, /!newCallStatus \|\| attendee\.call_status === newCallStatus/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE EDITORS KENNEN DE DRIE UITBREIDINGEN
// ═══════════════════════════════════════════════════════════════════════════

const HTML = readFileSync(join(ROOT, 'modules/events-automations.html'), 'utf8');
const VIEW = readFileSync(join(ROOT, 'modules/klanten-v2/views/automatiseringen-v2.js'), 'utf8');

test('de editors kunnen de bovengrens, de conditie en de belstatus instellen', () => {
  for (const [naam, bron] of [['events-automations.html', HTML], ['automatiseringen-v2.js', VIEW]]) {
    assert.match(bron, /uiterlijk_uren_voor_event/, naam + ': bovengrens');
    assert.match(bron, /geen_reactie_sinds_belstatus/, naam + ': conditie');
    assert.match(bron, /call_status/, naam + ': belstatus op de status-stap');
  }
});

test("de html-editor kent 'geannuleerd' als nieuwe status", () => {
  // Stond er niet terwijl de server hem wél toestaat. Wie de automatisatie
  // opende en bewaarde maakte er 'aangemeld' van, en dan vervalt er nooit een
  // plek.
  assert.match(HTML, /\['geannuleerd', 'Geannuleerd'\]/);
  assert.match(HTML, /'switched_to_other_event','geannuleerd'\]\.includes\(c\.new_status\)/);
});
