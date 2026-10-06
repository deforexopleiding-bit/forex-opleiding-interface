// tests/student-telefoon-aanvullen.test.js — telefoonnummers aanvullen voor
// ALLE LMS-studenten (Maxim, 6 oktober 2026): koppeling, voorrang, droogloop,
// en nooit een bestaand nummer overschrijven.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  koppelStudenten, isActief, draaiStudentTelefoonAanvullen,
} from '../api/_lib/student-telefoon-aanvullen.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('ACTIEF: geen einddatum of een einddatum vanaf vandaag', () => {
  assert.equal(isActief({ eind_datum: null }, '2026-10-06'), true);
  assert.equal(isActief({ eind_datum: '2026-10-06' }, '2026-10-06'), true);
  assert.equal(isActief({ eind_datum: '2026-10-05T23:00:00Z' }, '2026-10-06'), false);
});

test('KOPPELING: onboarding > bubble-id > e-mail; twee klanten op één adres is geen koppeling', () => {
  const m = koppelStudenten([
    { id: 's1', bubble_user_id: 'b1', email: 'a@x.be' },
    { id: 's2', bubble_user_id: 'b2', email: 'a@x.be' },
    { id: 's3', bubble_user_id: null, email: ' A@X.be ' },
    { id: 's4', bubble_user_id: null, email: 'dubbel@x.be' },
    { id: 's5', bubble_user_id: null, email: null },
  ], {
    obOpStudent: new Map([['s1', { customer_id: 'k1', answers: { gsm: '1' } }]]),
    obOpBubble: new Map([['b1', { customer_id: 'kX' }], ['b2', { customer_id: 'k2' }]]),
    klantenOpEmail: new Map([['a@x.be', ['k3']], ['dubbel@x.be', ['k4', 'k5']]]),
  });
  assert.deepEqual(m.get('s1'), { customer_id: 'k1', answers: { gsm: '1' }, via: 'onboarding' });
  assert.equal(m.get('s2').via, 'bubble');
  assert.equal(m.get('s2').customer_id, 'k2');
  assert.deepEqual(m.get('s3'), { customer_id: 'k3', answers: null, via: 'email' });
  assert.deepEqual(m.get('s4'), { customer_id: null, answers: null, via: 'email-dubbel' });
  assert.deepEqual(m.get('s5'), { customer_id: null, answers: null, via: null });
});

test('NOOIT OVERSCHRIJVEN: de lege-voorwaarde zit in de update zelf', () => {
  const bron = lees('api/_lib/student-telefoon-aanvullen.js');
  assert.match(bron, /from\('hlms_student'\)\s*\.update\(\{ telefoon: t\.telefoon \}\)\s*\.eq\('id', s\.id\)\s*\.or\('telefoon\.is\.null,telefoon\.eq\.'\)/);
  // Geen enkele andere schrijfactie: niets in het CRM, niets verwijderd.
  assert.equal((bron.match(/\.(insert|upsert|delete|update)\(/g) || []).length, 1);
});

test('EINDPUNTEN: knop achter students.all.view + POST, cron achter CRON_SECRET, beide de gedeelde kern', () => {
  const knop = lees('api/student-telefoon-aanvullen-run.js');
  assert.match(knop, /requirePermission\(req,\s*'students\.all\.view'\)/);
  assert.match(knop, /req\.method !== 'POST'/);
  assert.match(knop, /dry\s*:\s*body\.dry === true/);
  const cron = lees('api/cron/student-telefoon-aanvullen.js');
  assert.match(cron, /'Bearer ' \+ secret/);
  for (const b of [knop, cron]) {
    assert.match(b, /draaiStudentTelefoonAanvullen/);
    assert.doesNotMatch(b, /from\(['"]/);
  }
  const vercel = JSON.parse(lees('vercel.json'));
  assert.ok(vercel.crons.some((c) => c.path === '/api/cron/student-telefoon-aanvullen'));
});

test('HUB: de knop gaat via AgentShared.apiFetch en leest de JSON eruit', () => {
  const html = lees('modules/onboarding-hub.html');
  const i = html.indexOf('/api/student-telefoon-aanvullen-run');
  assert.ok(i > -1);
  assert.match(html.slice(i - 200, i), /AgentShared\.apiFetch/);
  assert.match(html.slice(i, i + 400), /\.json\(\)/);
});

// ── Een volledige ronde tegen nep-databanken ───────────────────────────────
// De nep-CRM filtert op `.in(kolom, waarden)`, zodat de koppeling echt getest wordt.
function nepCrm(tabellen) {
  return {
    from(t) {
      let rijen = tabellen[t] || [];
      const q = {
        select() { return q; }, order() { return q; },
        in(kolom, waarden) { rijen = rijen.filter((r) => waarden.includes(r[kolom])); return q; },
        update() { throw new Error('het CRM hoort niet beschreven te worden'); },
        then(ok) { return Promise.resolve({ data: rijen, error: null }).then(ok); },
      };
      return q;
    },
  };
}

function nepLms(studenten, { kapotVoor = null } = {}) {
  const updates = [];
  return {
    updates,
    from(t) {
      assert.equal(t, 'hlms_student');
      let upd = null; let id = null;
      const q = {
        select() { return q; }, order() { return q; },
        range() { return Promise.resolve({ data: studenten, error: null }); },
        update(v) { upd = v; return q; },
        eq(_k, v) { id = v; return q; },
        or(filter) {
          assert.equal(filter, 'telefoon.is.null,telefoon.eq.');
          if (id === kapotVoor) return { select: () => Promise.resolve({ data: null, error: { message: 'stuk' } }) };
          const s = studenten.find((x) => x.id === id);
          const leeg = !String(s.telefoon ?? '').trim();
          if (leeg) { updates.push({ id, ...upd }); s.telefoon = upd.telefoon; }
          return { select: () => Promise.resolve({ data: leeg ? [{ id }] : [], error: null }) };
        },
      };
      return q;
    },
  };
}

function wereld() {
  const studenten = [
    { id: 's1', email: 'met@x.be', bubble_user_id: null, telefoon: '+32470000001', eind_datum: null },   // heeft al een nummer
    { id: 's2', email: 'ob@x.be', bubble_user_id: null, telefoon: null, eind_datum: null },               // via onboarding
    { id: 's3', email: 'bub@x.be', bubble_user_id: 'b3', telefoon: '', eind_datum: '2099-01-01' },        // via bubble-id
    { id: 's4', email: 'Klant@X.be', bubble_user_id: null, telefoon: null, eind_datum: null },            // via e-mail
    { id: 's5', email: 'lead@x.nl', bubble_user_id: null, telefoon: null, eind_datum: '2000-01-01' },     // alleen een lead, oud
    { id: 's6', email: 'niks@x.be', bubble_user_id: null, telefoon: null, eind_datum: null },             // nergens
  ];
  const crm = nepCrm({
    onboardings: [
      { dfo_lms_student_id: 's2', bubble_user_id: null, customer_id: 'k2', answers: null, created_at: '2026-01-01', is_test: false },
      { dfo_lms_student_id: null, bubble_user_id: 'b3', customer_id: 'k3', answers: null, created_at: '2026-01-01', is_test: false },
    ],
    customers: [
      { id: 'k2', email: 'ob@x.be', phone: '0470 11 22 33', address_country: 'BE' },
      { id: 'k3', email: 'bub@x.be', phone: null, address_country: 'NL' },
      { id: 'k4', email: 'Klant@X.be', phone: null, address_country: 'BE' },
    ],
    whatsapp_conversations: [
      { customer_id: 'k3', phone_number: '+31612345678', last_message_at: '2026-10-01' },
      { customer_id: 'k4', phone_number: '+32499887766', last_message_at: '2026-10-01' },
    ],
    leads: [{ email: 'lead@x.nl', telefoon: '06-11223344', telefoon_e164: null }],
    follow_up_appointments: [],
  });
  return { studenten, crm };
}

test('DROOGLOOP: telt koppeling, bron en actief, en schrijft niets', async () => {
  const { studenten, crm } = wereld();
  const lms = nepLms(studenten);
  const { status, result } = await draaiStudentTelefoonAanvullen({ dry: true, lmsClient: lms, crmClient: crm });
  assert.equal(status, 200);
  assert.equal(result.zonder_nummer, 5);
  assert.equal(result.zonder_nummer_actief, 4);
  assert.deepEqual(result.gekoppeld, { onboarding: 1, bubble: 1, email: 1 });
  assert.equal(result.niet_gekoppeld, 2);
  assert.equal(result.gevonden, 4);
  assert.equal(result.gevonden_actief, 3);
  assert.deepEqual(result.per_bron, { klant: 1, whatsapp: 2, lead: 1 });
  assert.equal(result.niet_gevonden, 1);
  assert.equal(result.niet_gevonden_actief, 1);
  assert.equal(result.geschreven, 0);
  assert.equal(lms.updates.length, 0);
});

test('UITVOEREN: vult alleen lege nummers; een bestaand nummer blijft staan', async () => {
  const { studenten, crm } = wereld();
  const lms = nepLms(studenten);
  const { result } = await draaiStudentTelefoonAanvullen({ dry: false, lmsClient: lms, crmClient: crm });
  assert.equal(result.geschreven, 4);
  assert.deepEqual(lms.updates.map((u) => u.id).sort(), ['s2', 's3', 's4', 's5']);
  assert.equal(studenten.find((s) => s.id === 's1').telefoon, '+32470000001');
  assert.equal(studenten.find((s) => s.id === 's2').telefoon, '+32470112233');
  assert.equal(studenten.find((s) => s.id === 's3').telefoon, '+31612345678');
  assert.equal(studenten.find((s) => s.id === 's5').telefoon, '+31611223344');
  assert.equal(studenten.find((s) => s.id === 's6').telefoon, null);
});

test('FOUT PER RIJ: één mislukte update houdt de rest niet tegen', async () => {
  const { studenten, crm } = wereld();
  const lms = nepLms(studenten, { kapotVoor: 's3' });
  const { status, result } = await draaiStudentTelefoonAanvullen({ dry: false, lmsClient: lms, crmClient: crm });
  assert.equal(status, 200);
  assert.equal(result.mislukt, 1);
  assert.equal(result.geschreven, 3);
  assert.deepEqual(result.errors, [{ student_id: 's3', fout: 'stuk' }]);
});
