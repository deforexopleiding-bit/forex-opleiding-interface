// tests/dfo-lms-membership-calls.test.js
//
// DE BUG. Op 9 september 2026 faalde de LMS-inhaalslag op één klant:
// Martin Van Pijkeren, Membership 36 maanden.
//
//   null value in column calls_totaal violates not-null constraint
//
// `bepaalCallsTotaal()` keek alleen naar het traject en gaf `null` zodra daar
// geen positief aantal stond. Een membership HÉÉFT geen calls, dus rolde daar
// altijd `null` uit — en `hlms_student.calls_totaal` staat op NOT NULL.
//
// WAAROM DIT ERGER IS DAN ÉÉN MISLUKTE RIJ. De knop vertelde het ons. Maar
// dezelfde functie zit in het pad van `onboarding-create` → elke NIEUWE
// membership-aanmelding liep hier stuk, faalzacht, en het enige spoor is een
// regel in `dfo_lms_provision_error` waar niemand naar kijkt. De klant wordt
// aangemeld, het CRM zegt niets, en er komt geen LMS-rij.
//
// Daarom staat de test op de ECHTE weg — `provisionDfoLmsStudent()` met een
// nagebootste databank — en niet alleen op de rekenfunctie. Wat we borgen is
// wat er in de INSERT belandt, want dat is wat de constraint te zien krijgt.
//
// Membership → 0 (de bestaande conventie in het LMS: van de 102
// membership-studenten staan er 84 op 0, minimum 0).
// Mentorship → het echte aantal, en zonder aantal een LEESBARE fout in plaats
// van een constraint-fout uit de databank.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const url = (p) => pathToFileURL(path.resolve(process.cwd(), p)).href;

const OB_ID = '11111111-1111-4111-8111-111111111111';

// ── Nagebootst CRM ─────────────────────────────────────────────────────────
function nepAdmin({ onboarding, customer, traject }) {
  const geschreven = [];
  const from = (tabel) => {
    const k = {
      _upd: null,
      select() { return k; },
      update(patch) { k._upd = patch; return k; },
      eq(kolom, waarde) {
        if (k._upd) geschreven.push({ tabel, kolom, waarde, patch: k._upd });
        return k;
      },
      async maybeSingle() {
        if (tabel === 'onboardings')          return { data: onboarding, error: null };
        if (tabel === 'customers')            return { data: customer,   error: null };
        if (tabel === 'onboarding_trajecten') return { data: traject,    error: null };
        return { data: null, error: null };
      },
      then(res, rej) { return Promise.resolve({ data: null, error: null }).then(res, rej); },
    };
    return k;
  };
  return { from, _geschreven: geschreven };
}

// ── Nagebootst LMS ─────────────────────────────────────────────────────────
// Belangrijk: de insert wordt NIET gefilterd of opgeschoond. Wat de code
// aanbiedt is precies wat we nakijken — anders test je je eigen nabewerking.
function nepLms({ personeel = [] } = {}) {
  const inserts = [];
  const from = (tabel) => {
    const k = {
      _eq: {}, _ilike: null, _insert: null,
      select() { return k; },
      eq(kolom, waarde) { k._eq[kolom] = waarde; return k; },
      ilike(kolom, waarde) { k._ilike = String(waarde).toLowerCase(); return k; },
      insert(rij) { k._insert = rij; inserts.push(rij); return k; },
      update() { return k; },
      async maybeSingle() { return { data: null, error: null }; },
      async single() {
        if (k._insert) return { data: { id: 'nieuwe-student' }, error: null };
        return { data: null, error: null };
      },
      then(res, rej) {
        const data = tabel === 'hlms_personeel' ? personeel : [];
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return k;
  };
  return { from, _inserts: inserts };
}

async function provision({ traject, mentorUserId = null }) {
  const admin = nepAdmin({
    onboarding: {
      id: OB_ID, customer_id: 'cust-1', traject_id: 'traj-1', status: 'lopend',
      start_date: '2026-09-01', mentor_user_id: mentorUserId,
      dfo_lms_student_id: null, dfo_lms_provisioned: false,
      dfo_lms_provisioned_at: null, dfo_lms_provision_error: null,
    },
    customer: {
      id: 'cust-1', first_name: 'Martin', last_name: 'Van Pijkeren',
      email: 'martin@voorbeeld.nl', phone: null,
    },
    traject,
  });
  const lms = nepLms();

  // Elke aanroep zet zijn eigen nabootsing; zonder dit weigert de tweede
  // ("module is already mocked") en zouden latere tests op de vorige
  // databank draaien.
  mock.restoreAll();
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: admin } });
  mock.module(url('api/_lib/dfo-lms-db.js'), {
    namedExports: {
      getDfoLmsClient : () => lms,
      UNIQUE_VIOLATION: '23505',
      isUniqueViolation: (e) => e?.code === '23505',
    },
  });

  const mod = await import(url('api/_lib/dfo-lms-student.js') + '?t=' + Math.random());
  const uit = await mod.provisionDfoLmsStudent(OB_ID);
  return { uit, inserts: lms._inserts, geschreven: admin._geschreven };
}

const MEMBERSHIP = {
  id: 'traj-1', key: 'membership-36m', type: 'membership',
  label: 'Membership 36 maanden', duur_maanden: 36,
  calls: null, alpha_calls_total: null,
};
const MENTORSHIP = {
  id: 'traj-1', key: '1op1-12m', type: '1op1',
  label: '1-op-1 12 maanden', duur_maanden: 12,
  calls: 24, alpha_calls_total: 48,
};

// ══════════════════════════════════════════════════════════════════════════
// MEMBERSHIP — het geval dat stuk was
// ══════════════════════════════════════════════════════════════════════════

test('membership: de aanmaak lukt (dit is de bug van 9 september)', async () => {
  const { uit } = await provision({ traject: MEMBERSHIP });
  assert.equal(uit.ok, true, 'membership-aanmaak hoort te lukken: ' + JSON.stringify(uit));
});

test('membership: calls_totaal is 0 in de INSERT, nooit null', async () => {
  const { inserts } = await provision({ traject: MEMBERSHIP });
  assert.equal(inserts.length, 1, 'er hoort precies één rij ingevoegd te worden');
  // Niet `!= null` maar streng op 0: undefined zou de kolom óók laten vallen
  // en dan slaat dezelfde constraint alsnog toe.
  assert.equal(inserts[0].calls_totaal, 0);
  assert.equal(typeof inserts[0].calls_totaal, 'number');
});

test('membership: product_soort blijft membership', async () => {
  const { inserts } = await provision({ traject: MEMBERSHIP });
  assert.equal(inserts[0].product_soort, 'membership');
});

test('membership MET een aantal calls in het CRM krijgt tóch 0', async () => {
  // Een membership-traject waar per ongeluk calls op staan is een
  // gegevensfout in het CRM. Die nemen we niet over — 0 is de betekenis.
  const { inserts } = await provision({
    traject: { ...MEMBERSHIP, calls: 12, alpha_calls_total: 24 },
  });
  assert.equal(inserts[0].calls_totaal, 0);
});

// ══════════════════════════════════════════════════════════════════════════
// MENTORSHIP — mag niet meeveranderd zijn
// ══════════════════════════════════════════════════════════════════════════

test('mentorship: het echte aantal calls komt door, geen 0', async () => {
  const { uit, inserts } = await provision({ traject: MENTORSHIP });
  assert.equal(uit.ok, true);
  assert.equal(inserts[0].calls_totaal, 24, 'calls wint van alpha_calls_total');
  assert.equal(inserts[0].product_soort, 'mentorship');
});

test('mentorship: valt terug op alpha_calls_total', async () => {
  const { inserts } = await provision({
    traject: { ...MENTORSHIP, calls: null },
  });
  assert.equal(inserts[0].calls_totaal, 48);
});

test('mentorship ZONDER aantal calls stopt leesbaar, en voegt niets in', async () => {
  // Hier mag 0 juist NIET het antwoord zijn: een 1-op-1-klant die zijn
  // traject als "0 calls" ziet staan is erger dan een aanmaak die stopt.
  const { uit, inserts, geschreven } = await provision({
    traject: { ...MENTORSHIP, calls: null, alpha_calls_total: null },
  });
  assert.equal(uit.ok, false);
  assert.equal(inserts.length, 0, 'er mag geen rij ingevoegd worden');
  assert.match(uit.error, /geen aantal calls/i);
  assert.match(uit.error, /1op1-12m/, 'de melding moet zeggen wélk traject');
  // En de reden hoort op de onboarding te staan, niet alleen in een log.
  const fout = geschreven.find((g) => g.patch?.dfo_lms_provision_error);
  assert.ok(fout, 'de fout hoort naar dfo_lms_provision_error geschreven te worden');
  assert.match(fout.patch.dfo_lms_provision_error, /geen aantal calls/i);
});

test('de melding noemt de databank-constraint NIET — dat was de onleesbare versie', async () => {
  const { uit } = await provision({
    traject: { ...MENTORSHIP, calls: null, alpha_calls_total: null },
  });
  assert.doesNotMatch(uit.error, /not-null constraint|violates/i);
});
