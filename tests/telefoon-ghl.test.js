// tests/telefoon-ghl.test.js
//
// BELGISCHE GSM'S DIE ALS +31 TERUGKOMEN UIT GHL (2026-10-21).
//
// Gemeten: 17 opvolgtaken met +314[5-9]…, 29 afspraken. De lead had in 14 van
// de 17 gevallen hetzelfde nummer met +32; GHL had het lokale '04…' met zijn
// standaardland NL aangevuld en de appointment-poll schreef dat terug in
// lead_phone (ook over een afspraak die wij zelf met +32 boekten).
//
//   1. telefoonUitGhl: +314[5-9]… wordt ALLEEN +32 als onze eigen data dat
//      voor dezelfde negen cijfers bevestigt; anders blijft het +31 (045-049
//      zijn in NL ook echte netnummers). Alle 17 gemeten rijen als geval.
//   2. leadTelefoonUitGhl leest de lead alleen bij de verdachte vorm.
//   3. De drie GHL-paden (poll, go-live-import, backfill) en de rauwe
//      lead_phone-schrijvers gebruiken de gedeelde NL/BE-regel.
//   4. De regel zelf: 04[5-9] + 10 cijfers → +32, 06 → +31.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const leadVragen = [];
let leadAntwoord = [];
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin: {
      from: (tabel) => {
        const k = {
          select: () => k,
          ilike: (kol, waarde) => { leadVragen.push({ tabel, kol, waarde }); return k; },
          limit: async () => ({ data: leadAntwoord, error: null }),
        };
        return k;
      },
    },
  },
});

const P = await import('../api/_lib/phone-e164.js');
const { leadTelefoonUitGhl } = await import('../api/_lib/ghl-telefoon.js');

// De 17 rijen van 21 oktober: [taak, telefoon in de taak (uit GHL), lead.telefoon_e164, verwacht]
const GEMETEN = [
  ['2b4a623a', '+31471693030', '+32471693030', '+32471693030'],
  ['1b9d1d26', '+31465808688', '+32465808688', '+32465808688'],
  ['a6708d05', '+3147979884', '047979884', '+3147979884'],      // ander nummer bij de lead: niet aanraken
  ['fe1cbff4', '+31465893669', '+32465893669', '+32465893669'],
  ['8d2293d2', '+31473352693', '+32473352693', '+32473352693'],
  ['c6575595', '+31470085329', '+32470085329', '+32470085329'],
  ['975d26c2', '+31465808688', '+32465808688', '+32465808688'],
  ['d65bcacc', '+3147979884', '047979884', '+3147979884'],
  ['33dcc394', '+31473352693', '+32473352693', '+32473352693'],
  ['c26cf135', '+31465705330', '+32465705330', '+32465705330'],
  ['e5f66021', '+31465705330', '+32465705330', '+32465705330'],
  ['d277a575', '+31472223752', '+32472223752', '+32472223752'],  // Maxim
  ['834da3a9', '+31475452053', '+31475452053', '+31475452053'],  // lead zelf +31: niet aanraken
  ['3e1d16f4', '+31475716706', '+32475716706', '+32475716706'],
  ['119621dc', '+31475716706', '+32475716706', '+32475716706'],
  ['fb75c6d0', '+31493359937', '+32493359937', '+32493359937'],
  ['1c710213', '+31472223752', '+32472223752', '+32472223752'],  // scan 20/10, door ons met +32 geboekt
];

test('1. telefoonUitGhl: +32 alleen met bevestiging uit onze eigen data — de 17 gemeten rijen', () => {
  for (const [taak, ghl, lead, verwacht] of GEMETEN) {
    assert.equal(P.telefoonUitGhl(ghl, { onze: [lead] }), verwacht, taak);
  }
  assert.equal(GEMETEN.filter(([, ghl, , v]) => v !== ghl).length, 14, '14 van de 17 zijn ondubbelzinnig Belgisch');
  // zonder bevestiging: niet gokken
  assert.equal(P.telefoonUitGhl('+31472223752'), '+31472223752');
  assert.equal(P.telefoonUitGhl('+31472223752', { onze: [null, '', '+32472223753'] }), '+31472223752');
  // bevestiging mag ook rauw/lokaal zijn (onze eigen afspraak of lead)
  assert.equal(P.telefoonUitGhl('+31472223752', { onze: ['0472 22 37 52'] }), '+32472223752');
  // andere vormen gaan gewoon door de regel
  assert.equal(P.telefoonUitGhl('+31612345678', { onze: ['+32612345678'] }), '+31612345678');
  assert.equal(P.telefoonUitGhl('0472223752'), '+32472223752', 'lokaal uit GHL: de regel maakt er +32 van');
  assert.equal(P.telefoonUitGhl('0612345678'), '+31612345678');
  assert.equal(P.telefoonUitGhl(null), null);
  assert.ok(P.isMogelijkBeGsmUitGhl('+31472223752'));
  assert.ok(!P.isMogelijkBeGsmUitGhl('+31401234567'), '040 Eindhoven is geen verdachte vorm');
  assert.ok(!P.isMogelijkBeGsmUitGhl('+3147979884'), 'een cijfer te kort: geen gsm-vorm');
});

test('2. leadTelefoonUitGhl: lead alleen lezen bij +314[5-9]…, e-mail exact (geen wildcards)', async () => {
  leadVragen.length = 0;
  leadAntwoord = [{ telefoon_e164: '+32472223752' }];
  assert.equal(await leadTelefoonUitGhl({ ghlTelefoon: '+31612345678', email: 'x@y.nl' }), '+31612345678');
  assert.equal(leadVragen.length, 0, 'geen query voor een gewoon nummer');
  assert.equal(await leadTelefoonUitGhl({ ghlTelefoon: '+31472223752', email: 'maxim.delombaerde96+labtest@gmail.com' }), '+32472223752');
  assert.equal(leadVragen.length, 1);
  assert.equal(leadVragen[0].tabel, 'leads');
  assert.equal(leadVragen[0].waarde, 'maxim.delombaerde96+labtest@gmail.com');
  assert.equal(await leadTelefoonUitGhl({ ghlTelefoon: '+31472223752', email: 'a_b%c@x.nl' }), '+32472223752');
  assert.equal(leadVragen.at(-1).waarde, 'a\\_b\\%c@x.nl', 'wildcards ge-escaped');
  // het bestaande lead_phone (onze eigen boeking) bevestigt ook, zonder lead
  leadAntwoord = [];
  assert.equal(await leadTelefoonUitGhl({ ghlTelefoon: '+31472223752', email: null, bestaand: '+32472223752' }), '+32472223752');
  assert.equal(await leadTelefoonUitGhl({ ghlTelefoon: '+31472223752', email: 'x@y.nl' }), '+31472223752', 'geen bevestiging → +31 blijft');
});

test('3. de GHL-paden en de rauwe lead_phone-schrijvers gebruiken de gedeelde regel', () => {
  const poll = lees('api/follow-up-ghl-appointment-poll.js');
  assert.match(poll, /select\('id, status, zoom_meeting_id, zoom_join_url, ghl_calendar_id, lead_phone'\)/);
  assert.match(poll, /leadPhone = \(await leadTelefoonUitGhl\(\{\s*ghlTelefoon: leadPhone, email: leadEmail, bestaand: existing\?\.lead_phone \|\| null,/);
  assert.match(poll, /\|\| existing\?\.lead_phone \|\| null;/, 'geen nummer van GHL: het onze blijft');
  assert.match(lees('api/admin-afspraak-golive-import.js'), /leadPhone = await leadTelefoonUitGhl\(/);
  assert.match(lees('api/follow-up-backfill-contacts.js'), /update\.lead_phone = await leadTelefoonUitGhl\(/);
  for (const [f, v] of [
    ['api/_lib/events-complete-core.js', 'att.phone'], ['api/cron-event-belronde.js', 'a.phone'],
    ['api/event-followup-to-lead.js', 'att.phone'], ['api/sales-retention-to-followup.js', 'cust.phone'],
    ['api/follow-up-oude-retenties.js', 'cust.phone'],
  ]) {
    const s = lees(f);
    assert.doesNotMatch(s, new RegExp('lead_phone\\s*:\\s*' + v.replace('.', '\\.') + ' \\|\\| null'), f);
    assert.match(s, /lead_phone\s*:\s*telefoonNlBe\(/, f);
  }
  // alle schrijvers van opvolging_taken.telefoon gingen al via telefoonNlBe
  for (const f of ['api/cron-opvolging-zoom-opwarm.js', 'api/cron-opvolging-zoom-nabel.js', 'api/cron-opvolging-annuleringen.js', 'api/cron-opvolging-aanmeldingen.js']) {
    assert.match(lees(f), /telefoon\s*:\s*telefoonNlBe\(/, f);
  }
});

test('4. de regel: 04[5-9] + 10 cijfers → +32, 06 → +31', () => {
  const e = (x) => P.normaliseerNlBe(x).e164;
  assert.equal(e('0472223752'), '+32472223752');
  assert.equal(e('0475 71 67 06'), '+32475716706');
  assert.equal(e('0612345678'), '+31612345678');
  assert.equal(e('+32472223752'), '+32472223752');
  assert.equal(e('0032472223752'), '+32472223752');
  assert.equal(e('472223752'), '+32472223752');
  assert.equal(e('0472223752'), P.telefoonNlBe('0472223752'));
});
