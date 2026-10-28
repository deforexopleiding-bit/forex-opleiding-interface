// tests/onboarding-antwoorden.test.js
//
// DE ONBOARDING-ANTWOORDEN IN HET LMS (28 okt 2026).
//
// De nieuwe onboarding (website /onboarding) vervangt de klassieke wizard. De
// LMS-spiegel (`hlms_crm_onboarding`, één schrijver: onboarding-spiegel.js)
// krijgt de portalstand, de antwoorden en de stappen van de NIEUWE flow; de
// Autopilot-interesse gaat naar een eigen tabel die de mentor niet leest.
// Getoetst: de pure afleiding, de rij die de spiegel schrijft, de terugval
// zonder migratie, en het overzicht voor het hoofdmentorbord.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

const OB = '11111111-1111-4111-8111-111111111111';
const KLANT = '22222222-2222-4222-8222-222222222222';
const STUDENT = '33333333-3333-4333-8333-333333333333';
const TRAJECT_1OP1 = 'tttttttt-1111-4111-8111-111111111111';
const TRAJECT_MEMB = 'tttttttt-2222-4222-8222-222222222222';
const tabellen = {};

function nepAdmin() {
  return {
    from(tabel) {
      let rows = [...(tabellen[tabel] || [])];
      const k = {
        select: () => k,
        eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return k; },
        in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return k; },
        is: () => k, order: () => k, limit: () => k, not: () => k, neq: () => k, gte: () => k, lte: () => k,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r, j) => Promise.resolve({ data: rows, error: null }).then(r, j),
      };
      return k;
    },
  };
}
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: nepAdmin(), createUserClient: () => nepAdmin() } });

const { antwoordenVoorLms, schermKlaar, schoneBeschikbaarheid, PORTAL_SCHERMEN } =
  await import(url('api/_lib/onboarding-antwoorden.js'));
const { spiegelOnboarding, AUTOMATION_TABEL, SPIEGEL_TABEL, ANTWOORD_KOLOMMEN, isAntwoordKolomOntbreekt } =
  await import(url('api/_lib/onboarding-spiegel.js'));

/** Een nep-LMS die per tabel bijhoudt wat er geschreven werd, met optionele fouten. */
function nepLms({ kolommenOntbreken = false, automationOntbreekt = false } = {}) {
  const geschreven = {};
  return {
    geschreven,
    from(tabel) {
      const k = {
        select: () => k, eq: () => k, in: () => k, limit: () => k, or: () => k, update: () => k,
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async (rij) => {
          if (tabel === SPIEGEL_TABEL && kolommenOntbreken && 'portal_stand' in rij) {
            return { error: { code: 'PGRST204', message: "Could not find the 'portal_stand' column of 'hlms_crm_onboarding' in the schema cache" } };
          }
          if (tabel === AUTOMATION_TABEL && automationOntbreekt) {
            return { error: { code: 'PGRST205', message: "Could not find the table 'public.hlms_crm_onboarding_automation' in the schema cache" } };
          }
          (geschreven[tabel] ||= []).push(rij);
          return { error: null };
        },
        delete: () => ({ eq: async () => ({ error: null }) }),
        then: (r, j) => Promise.resolve({ data: [], error: null }).then(r, j),
      };
      return k;
    },
  };
}

function zetOnboarding(over = {}) {
  tabellen.onboardings = [{
    id: OB, customer_id: KLANT, traject_id: TRAJECT_1OP1, status: 'bezig', archived_at: null, start_date: '2026-11-03',
    current_step: 9, mentor_user_id: null, dfo_lms_student_id: STUDENT, completed_at: null,
    answers: {
      coaching_locatie_voorkeur: 'zoveel_mogelijk_kantoor', ervaring_trading: 'beginner', motivatie_primair: 'extra_inkomen',
      commitment_uren_per_week: 6, beschikbaarheid: { ma: ['avond', 'ochtend'], za: ['namiddag'], xx: ['avond'] },
      robot_interesse: 'ja_interesse', robot_belmoment: ['avond', 'voormiddag', 'nacht'],
    },
    ...over,
  }];
  tabellen.onboarding_trajecten = [
    { id: TRAJECT_1OP1, type: '1op1' },
    { id: TRAJECT_MEMB, type: 'membership' },
  ];
  tabellen.invoices = [];
}

// ── PUUR ──────────────────────────────────────────────────────────────────

test('de schermen van de nieuwe flow: 1-op-1 vier, membership twee (zelfde als de website)', () => {
  assert.deepEqual([...PORTAL_SCHERMEN['1op1']], ['locatie', 'jij', 'beschikbaar', 'extra']);
  assert.deepEqual([...PORTAL_SCHERMEN.membership], ['jij', 'extra']);
  //  dfo-website lib/onboarding-portal.ts FLOWS = deze lijsten met 'welkom'
  //  ervoor en 'klaar' erachter. Wijzigt de website een scherm, dan hier ook.
});

test('stap X van Y telt de INGEVULDE schermen, niet current_step van de oude wizard', () => {
  const ob = { status: 'bezig', current_step: 9, answers: { ervaring_trading: 'beginner', motivatie_primair: 'anders' } };
  assert.deepEqual(
    (({ wizard_stap, wizard_stappen_totaal }) => ({ wizard_stap, wizard_stappen_totaal }))(antwoordenVoorLms(ob, '1op1')),
    { wizard_stap: 1, wizard_stappen_totaal: 4 },
  );
  assert.equal(antwoordenVoorLms(ob, 'membership').wizard_stappen_totaal, 2);
  assert.equal(antwoordenVoorLms(ob, 'membership').wizard_stap, 1);
  //  Afgerond = alles, ook als een oud antwoord ontbreekt.
  assert.equal(antwoordenVoorLms({ ...ob, status: 'afgerond' }, '1op1').wizard_stap, 4);
  //  Traject niet gelezen → onbekend, niet "0 van 4".
  const onbekend = antwoordenVoorLms(ob, undefined);
  assert.equal(onbekend.wizard_stap, null);
  assert.equal(onbekend.wizard_stappen_totaal, null);
  assert.equal(onbekend.flow_type, null);
  //  Geen traject → 1-op-1 (zelfde terugval als de portal).
  assert.equal(antwoordenVoorLms(ob, null).flow_type, '1op1');
});

test('de portalstand: niet gestart · bezig · afgerond, met het afrondmoment', () => {
  assert.equal(antwoordenVoorLms({ status: 'aangemeld', answers: {} }, '1op1').portal_stand, 'niet_gestart');
  assert.equal(antwoordenVoorLms({ status: 'aangemeld', answers: { commitment_uren_per_week: null } }, '1op1').portal_stand, 'niet_gestart');
  assert.equal(antwoordenVoorLms({ status: 'aangemeld', current_step: 1, answers: {} }, '1op1').portal_stand, 'bezig');
  assert.equal(antwoordenVoorLms({ status: 'bezig', answers: { ervaring_trading: 'geen' } }, '1op1').portal_stand, 'bezig');
  const af = antwoordenVoorLms({ status: 'afgerond', completed_at: '2026-10-27T15:56:55Z', answers: {} }, '1op1');
  assert.equal(af.portal_stand, 'afgerond');
  assert.equal(af.portal_afgerond_op, '2026-10-27T15:56:55Z');
  assert.equal(antwoordenVoorLms({ status: 'bezig', answers: {} }, '1op1').portal_afgerond_op, null);
});

test('de antwoorden: geschoond, niets verzonnen, oude wizardwaarden ongewijzigd', () => {
  const a = antwoordenVoorLms({ status: 'bezig', answers: {
    coaching_locatie_voorkeur: ' enkel_online ', ervaring_trading: 'middelbaar', motivatie_primair: '',
    commitment_uren_per_week: '4', beschikbaarheid: { zo: ['avond'], di: ['avond', 'ochtend', 'nacht'], ma: [] },
    robot_interesse: 'laterbespreken',
  } }, '1op1');
  assert.equal(a.coaching_locatie_voorkeur, 'enkel_online');
  assert.equal(a.ervaring_trading, 'middelbaar');
  assert.equal(a.motivatie_primair, null);
  assert.equal(a.commitment_uren_per_week, 4);
  assert.deepEqual(a.beschikbaarheid, { ma: [], di: ['ochtend', 'avond'], wo: [], do: [], vr: [], za: [], zo: ['avond'] });
  //  Een onbekende Autopilot-keuze is geen ja en geen nee.
  assert.equal(a.automation_interesse, null);
  assert.deepEqual(a.automation_belmoment, []);
  assert.equal(schoneBeschikbaarheid({ ma: [] }), null, 'leeg raster = niet ingevuld');
  assert.equal(schermKlaar('beschikbaar', { beschikbaarheid: { ma: [] } }), false);
});

// ── DE SPIEGEL ────────────────────────────────────────────────────────────

test('de spiegel schrijft de antwoorden en de nieuwe stappen; Autopilot apart', async () => {
  zetOnboarding();
  const lms = nepLms();
  const uit = await spiegelOnboarding(OB, { lmsClient: lms, zonderIntake: true });
  assert.equal(uit.resultaat, 'geschreven', JSON.stringify(uit));
  const rij = lms.geschreven[SPIEGEL_TABEL][0];
  assert.equal(rij.flow_type, '1op1');
  //  current_step 9 en nooit in de portal bewaard (portal_gestart_op null) =
  //  begonnen in de klassieke wizard (28 okt 2026, tests/onboarding-oude-wizard.test.js).
  assert.equal(rij.portal_stand, 'oude_wizard');
  assert.equal(rij.wizard_stap, 4, 'alle vier schermen ingevuld, ook al staat current_step op 9');
  assert.equal(rij.wizard_stappen_totaal, 4);
  assert.equal(rij.coaching_locatie_voorkeur, 'zoveel_mogelijk_kantoor');
  assert.equal(rij.commitment_uren_per_week, 6);
  assert.deepEqual(rij.beschikbaarheid.ma, ['ochtend', 'avond']);
  assert.ok(!('xx' in rij.beschikbaarheid));
  //  Geen automation op de rij die de mentor leest.
  assert.ok(!Object.keys(rij).some((k) => k.startsWith('automation') || k.startsWith('robot')));
  const auto = lms.geschreven[AUTOMATION_TABEL][0];
  assert.equal(auto.crm_onboarding_id, OB);
  assert.equal(auto.automation_interesse, 'ja');
  assert.deepEqual(auto.automation_belmoment, ['voormiddag', 'avond']);
});

test('membership: twee stappen', async () => {
  zetOnboarding({ traject_id: TRAJECT_MEMB, answers: { ervaring_trading: 'geen', motivatie_primair: 'anders' } });
  const lms = nepLms();
  await spiegelOnboarding(OB, { lmsClient: lms, zonderIntake: true });
  const rij = lms.geschreven[SPIEGEL_TABEL][0];
  assert.equal(rij.flow_type, 'membership');
  assert.equal(rij.wizard_stap, 1);
  assert.equal(rij.wizard_stappen_totaal, 2);
  assert.equal(lms.geschreven[AUTOMATION_TABEL][0].automation_interesse, null);
});

test('migratie nog niet gedraaid: de rij gaat ZONDER antwoordkolommen, Autopilot wordt overgeslagen', async () => {
  zetOnboarding();
  const lms = nepLms({ kolommenOntbreken: true, automationOntbreekt: true });
  const uit = await spiegelOnboarding(OB, { lmsClient: lms, zonderIntake: true });
  assert.equal(uit.resultaat, 'geschreven', JSON.stringify(uit));
  const rij = lms.geschreven[SPIEGEL_TABEL][0];
  for (const k of ANTWOORD_KOLOMMEN) assert.ok(!(k in rij), `${k} hoort weg te zijn`);
  assert.equal(rij.wizard_stap, 4, 'de stappen zelf bestaan al en gaan gewoon mee');
  assert.equal(lms.geschreven[AUTOMATION_TABEL], undefined);
  assert.equal(isAntwoordKolomOntbreekt({ code: '42703', message: 'column "beschikbaarheid" does not exist' }), true);
  assert.equal(isAntwoordKolomOntbreekt({ code: '42703', message: 'column "telefoon" does not exist' }), false);
});

test('één schrijver: alleen de spiegel schrijft naar de automation-tabel', () => {
  const bron = lees('api/_lib/onboarding-spiegel.js');
  assert.match(bron, /AUTOMATION_TABEL = 'hlms_crm_onboarding_automation'/);
  assert.match(bron, /await schrijfAutomation\(lms, ob\.id, ant\)/);
});

test('portal-save en afronden spiegelen meteen', () => {
  assert.match(lees('api/onboarding-portal.js'), /await d\.spiegel\(ob\.id, 'onboarding-portal-save'\)/);
  assert.match(lees('api/_lib/onboarding-afronden.js'), /await d\.spiegel\(ob\.id/);
});

test('het onboardingoverzicht (ook /api/lms-onboarding-overzicht voor het hoofdmentorbord) draagt dezelfde afleiding', () => {
  const bron = lees('api/_lib/onboarding-overzicht-rijen.js');
  assert.match(bron, /onboarding_antwoorden: antwoordenVoorLms\(r, t \? \(t\.type \?\? null\) : null\)/);
  //  En de LMS-route geeft de rijen ongewijzigd door (alleen het token eruit).
  assert.match(lees('api/lms-onboarding-overzicht.js'), /\.\.\.r,/);
});
