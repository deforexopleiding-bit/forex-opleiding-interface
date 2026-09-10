// tests/conv-reminder-venster.test.js
//
// Het verzendvenster van de no-reply-cyclus, met de ECHTE productie-config.
//
// GEMETEN (10 sep 2026): `joost_config.autonomy_config.communication_limits`
// staat op `office_hours_only: false`, met `office_hours_start` 08:00 en
// `office_hours_end` 20:00 die daardoor niets doen. Die schakelaar hoort bij
// Joost's eigen autonomie, maar de klant-herinneringen hingen er volledig aan.
// Gevolg: reeksen die 's nachts doorliepen, tot 01:15 en 02:15 UTC — drie en
// vier uur 's nachts bij de klant.
//
// De schakelaar blijft staan zoals hij staat: hem omzetten verandert ook
// Joost's gedrag buiten wanbetalers, en dat is niet wat hier gerepareerd
// wordt. In plaats daarvan is het venster van de AANMAANMOTOR leidend
// (app_settings.dunning_office_hours, 08:00-20:00 Europe/Amsterdam) — dat
// kent geen uit-knop. De Joost-config mag daarbinnen nog versmallen, niet
// openzetten.
//
// Deze test draait de echte `processReminderRun` met de echte productie-
// waarden en kijkt of er om 02:15 UTC iets uit zou gaan.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const RUN_ID  = 'run-nacht';
const CONV_ID = 'conv-nacht';
const CUST_ID = 'cust-nacht';

// De gemeten productie-config: de venster-schakelaar staat UIT.
const COMM_LIMITS_PRODUCTIE = {
  office_hours_only: false,
  office_hours_start: '08:00',
  office_hours_end:   '20:00',
  cooldown_after_outbound_seconds: 30,
  max_messages_per_conversation_total: 10,
  max_messages_per_conversation_per_day: 10,
};

// Venster van de motor, zoals _lib/dunning-office-hours.js het teruggeeft.
const MOTOR_VENSTER = { tz: 'Europe/Amsterdam', start: '08:00', end: '20:00', days: [0, 1, 2, 3, 4, 5, 6] };

/** Chainbare, awaitbare supabase-dubbelganger met vaste rijen per tabel. */
function nepAdmin(rows = {}) {
  const maak = (tabel) => {
    const k = {
      select: () => k, eq: () => k, in: () => k, is: () => k, not: () => k,
      gte: () => k, gt: () => k, lt: () => k, lte: () => k, order: () => k, limit: () => k,
      insert: () => k, update: () => k, single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({ data: (rows[tabel] || [])[0] || null, error: null }),
      then: (resolve) => Promise.resolve({ data: rows[tabel] || [], error: null }).then(resolve),
    };
    return k;
  };
  return { from: maak };
}

async function laadCron(rows) {
  mock.module(url('api/supabase.js'), {
    namedExports: {
      supabaseAdmin: nepAdmin(rows),
      checkCronAuth: () => true,
      createUserClient: () => ({}),
      verifyAdmin: async () => ({ ok: false }),
      supabase: {},
      ADMIN_ROLES: ['super_admin', 'admin', 'manager'],
    },
  });
  return import(url('api/cron-dunning-conversation-reminders.js') + '?t=' + Math.random());
}

function leegSummary() {
  return { processed_count: 0, r1_sent: 0, r2_sent: 0, resumed: 0, skipped: [], errors: [] };
}

// De situatie die in productie een bericht opleverde: klant zweeg lang, wij
// hadden inhoudelijk geantwoord, de drempel is ruim gehaald. Alleen het
// venster hoort dit tegen te houden.
const ROWS = {
  whatsapp_conversations: [{
    id: CONV_ID, phone_number: '+31600000000', phone_number_id: 'pn-1',
    last_inbound_at: '2026-09-01T09:00:00Z', customer_id: CUST_ID,
  }],
  whatsapp_messages: [{ id: 'msg-antwoord', created_at: '2026-09-02T09:00:00Z', template_name: null }],
  dunning_log: [],
};

const RUN = {
  id: RUN_ID,
  customer_id: CUST_ID,
  paused_by_conversation_id: CONV_ID,
  paused_conversation_reminder_count: 0,
  paused_conversation_last_reminder_at: null,
};

test("office_hours_only=false en tóch niets om 02:15 UTC", async (t) => {
  t.after(() => mock.reset());
  const mod = await laadCron(ROWS);
  const summary = leegSummary();

  await mod.processReminderRun({
    run: RUN,
    autonomyCfg:    { communication_limits: COMM_LIMITS_PRODUCTIE },
    officeHoursCfg: MOTOR_VENSTER,
    noReplyCfg:     { reminder_1_hours: 24, reminder_2_hours: 24, resume_after_hours: 24 },
    deps:      {},
    dryRunOn:  false,
    nowMs:     Date.parse('2026-09-10T02:15:00Z'),   // 04:15 in Amsterdam
    summary,
    logPrefix: 'test',
  });

  assert.equal(summary.r1_sent, 0, 'er mag om kwart over vier ’s nachts niets uitgaan');
  assert.equal(summary.r2_sent, 0);
  const reden = (summary.skipped[0] || {}).reason || '';
  assert.match(reden, /OFFICE_HOURS_CLOSED/, 'geblokkeerd op het venster: ' + JSON.stringify(summary.skipped));
  assert.match(reden, /motorvenster/, 'en wel op het venster van de motor, niet dat van Joost');
});

test('dezelfde run gaat overdag wél door de vensterpoort heen', async (t) => {
  t.after(() => mock.reset());
  const mod = await laadCron(ROWS);
  const summary = leegSummary();

  await mod.processReminderRun({
    run: RUN,
    autonomyCfg:    { communication_limits: COMM_LIMITS_PRODUCTIE },
    officeHoursCfg: MOTOR_VENSTER,
    noReplyCfg:     { reminder_1_hours: 24, reminder_2_hours: 24, resume_after_hours: 24 },
    deps:      {},
    dryRunOn:  false,
    nowMs:     Date.parse('2026-09-10T09:15:00Z'),   // 11:15 in Amsterdam
    summary,
    logPrefix: 'test',
  });

  // Hij komt voorbij het venster en struikelt verderop (geen klant-rij in de
  // nep-db). Dat is precies wat we willen weten: het venster is niet de reden.
  const reden = (summary.skipped[0] || {}).reason || '';
  assert.doesNotMatch(reden, /OFFICE_HOURS_CLOSED/, 'overdag mag het venster niet de blocker zijn');
});

test('het Joost-venster mag nog wél verder versmallen', async (t) => {
  t.after(() => mock.reset());
  const mod = await laadCron(ROWS);
  const summary = leegSummary();

  await mod.processReminderRun({
    run: RUN,
    // Nu staat de Joost-schakelaar AAN, met een smaller venster (tot 10:00).
    autonomyCfg: {
      communication_limits: {
        ...COMM_LIMITS_PRODUCTIE,
        office_hours_only: true,
        office_hours_start: '08:00',
        office_hours_end:   '10:00',
      },
    },
    officeHoursCfg: MOTOR_VENSTER,
    noReplyCfg:     { reminder_1_hours: 24, reminder_2_hours: 24, resume_after_hours: 24 },
    deps:      {},
    dryRunOn:  false,
    nowMs:     Date.parse('2026-09-10T09:15:00Z'),   // 11:15 Amsterdam: binnen motor, buiten Joost
    summary,
    logPrefix: 'test',
  });

  const reden = (summary.skipped[0] || {}).reason || '';
  assert.match(reden, /Joost-venster/, 'versmallen blijft werken: ' + JSON.stringify(summary.skipped));
});

// ── Dagcap: per KLANT, niet per run ──────────────────────────────────
//
// GEMETEN (10 sep 2026): 30 van de 141 wanbetalers hebben in de laatste
// dertig dagen gebeurtenissen van meer dan één run. Op run-niveau tellen zou
// die groep twee herinneringen op één dag kunnen bezorgen — twee runs, twee
// keer "één per dag". De cap gaat over de telefoon van de klant, dus telt hij
// over alle runs van die klant.

test('een herinnering van vanochtend blokkeert een tweede run van dezelfde klant', async (t) => {
  t.after(() => mock.reset());
  // Run B van dezelfde klant; run A heeft vanochtend al een herinnering
  // gestuurd. De dagcap-lookup vindt beide runs van de klant en daarna de
  // log-regel van run A.
  const mod = await laadCron({
    ...ROWS,
    dunning_workflow_runs: [{ id: 'run-a' }, { id: 'run-b' }],
    dunning_log: [{ id: 'log-a' }],   // de herinnering van run A, vanochtend
  });
  const summary = leegSummary();

  await mod.processReminderRun({
    run: { ...RUN, id: 'run-b' },
    autonomyCfg:    { communication_limits: COMM_LIMITS_PRODUCTIE },
    officeHoursCfg: MOTOR_VENSTER,
    noReplyCfg:     { reminder_1_hours: 24, reminder_2_hours: 24, resume_after_hours: 24 },
    deps:      {},
    dryRunOn:  false,
    nowMs:     Date.parse('2026-09-10T13:00:00Z'),   // 15:00 Amsterdam, binnen venster
    summary,
    logPrefix: 'test',
  });

  assert.equal(summary.r1_sent, 0);
  const reden = (summary.skipped[0] || {}).reason || '';
  assert.match(reden, /AL_HERINNERD_VANDAAG/, JSON.stringify(summary.skipped));
  assert.match(reden, /klant-breed/, 'de cap telt over alle runs van de klant');
});
