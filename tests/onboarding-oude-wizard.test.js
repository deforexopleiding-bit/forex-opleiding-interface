// tests/onboarding-oude-wizard.test.js — oude wizard vs nieuwe onboarding (28 okt 2026).
//
// Gemeten in forex-command-center op 28 okt: 14 onboardings op 'bezig', bijna
// allemaal begonnen in de KLASSIEKE wizard vóór de portal live ging (27 okt
// 16:26 UTC). Hun current_step is een pagina van die wizard (tot 10); in de
// nieuwe onboarding betekent hetzelfde getal een ander scherm. Het overzicht
// toonde "Stap 3" en dat las als de nieuwe onboarding.
//
// Bedoeld gedrag:
//   · één afleiding (portalVoortgang) voor lijst, detail, LMS-bord en spiegel;
//   · het kenmerk is portal_gestart_op (eerste save in de portal), nooit de
//     sleutels in answers — die zijn in beide wizards dezelfde;
//   · wie met een oude current_step de portal opent, komt op de eerste
//     onbeantwoorde vraag van de NIEUWE flow, nooit op een onbestaand scherm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  portalVoortgang, voortgangLabel, hervatStap, antwoordenVoorLms, PORTAL_FLOWS,
} from '../api/_lib/onboarding-antwoorden.js';
import { isPortalKolomOntbreekt, leesPortalKolommen } from '../api/_lib/onboarding-portal-kolommen.js';
import { maakHandler } from '../api/onboarding-portal.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// De gemeten gevallen (answers zoals in de databank, zonder waarden die er niet toe doen).
const ASCHWIN = { status: 'bezig', current_step: 3, portal_gestart_op: null, portal_geopend_op: null,
  answers: { coaching_locatie_voorkeur: 'bootcamp_dan_online', commitment_uren_per_week: 5, ervaring_trading: 'beginner', motivatie_primair: 'extra_inkomen' } };
const FLORIS = { status: 'bezig', current_step: 6, portal_gestart_op: null, portal_geopend_op: null,
  answers: { beschikbaarheid: { ma: ['avond'] }, coaching_locatie_voorkeur: 'enkel_online', commitment_uren_per_week: 4,
    ervaring_trading: 'geen', motivatie_primair: 'anders', robot_interesse: 'laterbespreken', waiver_bedenktijd_digitaal: true } };
const EVERTJAN = { status: 'bezig', current_step: 5, portal_gestart_op: null, portal_geopend_op: null,
  answers: { robot_interesse: 'nee', waiver_bedenktijd_membership: true } };
const MIGUEL = { status: 'bezig', current_step: 3, portal_gestart_op: null, portal_geopend_op: null, answers: {} };
const VERS = { status: 'aangemeld', current_step: 0, portal_gestart_op: null, portal_geopend_op: null, answers: {} };

test('stand: oude wizard ≠ nieuwe onboarding, op portal_gestart_op — niet op de sleutels', () => {
  assert.equal(portalVoortgang(ASCHWIN, '1op1').stand, 'oude_wizard');
  assert.equal(portalVoortgang(ASCHWIN, '1op1').label, 'Oude wizard (onvolledig) — nieuwe link nog niet geopend');
  assert.equal(portalVoortgang({ ...ASCHWIN, portal_geopend_op: '2026-10-28T09:00:00Z' }, '1op1').label,
    'Oude wizard (onvolledig) — nieuwe link geopend, nog niets ingevuld');
  assert.equal(portalVoortgang(FLORIS, '1op1').stand, 'oude_wizard');
  assert.equal(portalVoortgang(EVERTJAN, 'membership').stand, 'oude_wizard');
  assert.equal(portalVoortgang(MIGUEL, 'membership').stand, 'oude_wizard');
  // Dezelfde antwoorden, maar wel in de portal bewaard → nieuwe onboarding, x/y op de nieuwe flow.
  const nieuw = portalVoortgang({ ...ASCHWIN, portal_gestart_op: '2026-10-28T09:00:00Z' }, '1op1');
  assert.equal(nieuw.stand, 'bezig');
  assert.equal(nieuw.label, 'Nieuwe onboarding · 2/4');
  assert.equal(portalVoortgang({ ...EVERTJAN, portal_gestart_op: '2026-10-28T09:00:00Z', answers: { ervaring_trading: 'geen', motivatie_primair: 'anders' } }, 'membership').label,
    'Nieuwe onboarding · 1/2');
  // Nergens begonnen.
  assert.equal(portalVoortgang(VERS, '1op1').label, 'Nog niet gestart');
  assert.equal(portalVoortgang({ ...VERS, portal_geopend_op: '2026-10-28T09:00:00Z' }, '1op1').label, 'Nog niet gestart — link geopend');
  // Afgerond — welke wizard ook (Ljupce Trajkov, portal, 28 okt).
  const af = portalVoortgang({ status: 'afgerond', completed_at: '2026-10-28T14:05:38Z', current_step: 4, portal_gestart_op: null, answers: {} }, '1op1');
  assert.equal(af.stand, 'afgerond');
  assert.equal(af.label, 'Afgerond');
});

test('stand: kolom niet gelezen (migratie niet gedraaid) → de afleiding van vóór 28 okt, geen "oude wizard"', () => {
  const { portal_gestart_op, portal_geopend_op, ...zonder } = ASCHWIN;
  void portal_gestart_op; void portal_geopend_op;
  const v = portalVoortgang(zonder, '1op1');
  assert.equal(v.kolom_gelezen, false);
  assert.equal(v.stand, 'bezig');
  assert.equal(v.geopend, null);
  assert.equal(portalVoortgang({ status: 'aangemeld', answers: {} }, '1op1').stand, 'niet_gestart');
});

test('labels: één tekst voor lijst, detail en LMS', () => {
  assert.equal(voortgangLabel({ stand: 'bezig', stap: 3, totaal: 4 }), 'Nieuwe onboarding · 3/4');
  assert.equal(voortgangLabel({ stand: 'bezig', stap: null, totaal: null }), 'Nieuwe onboarding · bezig');
  // De LMS-spiegel krijgt dezelfde stand; het bord krijgt ook de tekst.
  const l = antwoordenVoorLms(ASCHWIN, '1op1');
  assert.equal(l.portal_stand, 'oude_wizard');
  assert.equal(l.portal_label, 'Oude wizard (onvolledig) — nieuwe link nog niet geopend');
  assert.equal(l.portal_geopend, false);
});

// ── 3. De portal openen met een OUDE current_step ─────────────────────────

test('hervatStap: oude current_step → eerste onbeantwoorde vraag van de NIEUWE flow, nooit een onbestaand scherm', () => {
  const v1 = PORTAL_FLOWS['1op1']; // welkom, locatie, jij, beschikbaar, extra, klaar
  const vm = PORTAL_FLOWS.membership; // welkom, jij, extra, klaar
  // Aschwin (oud step 3): locatie + jij ingevuld → beschikbaar.
  assert.equal(v1[hervatStap(ASCHWIN, '1op1')], 'beschikbaar');
  // Floris (oud step 6 — bestaat niet in de nieuwe 1-op-1-flow): alles behalve
  // een geldige Autopilot-keuze ('laterbespreken' kent de portal niet) → extra.
  assert.equal(v1[hervatStap(FLORIS, '1op1')], 'extra');
  // Evertjan (membership, oud step 5): jij nog open → jij.
  assert.equal(vm[hervatStap(EVERTJAN, 'membership')], 'jij');
  // Miguel (membership, oud step 3, niets ingevuld) → jij; 1-op-1 → locatie.
  assert.equal(vm[hervatStap(MIGUEL, 'membership')], 'jij');
  assert.equal(v1[hervatStap(MIGUEL, '1op1')], 'locatie');
  // Alles ingevuld in de oude wizard → de laatste vraag (afronden), nooit 'klaar'.
  const alles = { ...FLORIS, answers: { ...FLORIS.answers, robot_interesse: 'nee' } };
  assert.equal(v1[hervatStap(alles, '1op1')], 'extra');
  // Nergens begonnen → welkom.
  assert.equal(hervatStap(VERS, '1op1'), 0);
  // Voor elke oude stap 0..10 en elke flow: binnen de vraagschermen.
  for (const flow of ['1op1', 'membership']) {
    for (let s = 0; s <= 10; s++) {
      for (const ob of [ASCHWIN, FLORIS, EVERTJAN, MIGUEL]) {
        const i = hervatStap({ ...ob, current_step: s }, flow);
        assert.ok(i >= 1 && i <= PORTAL_FLOWS[flow].length - 2, `${flow} oud ${s} → ${i}`);
      }
    }
  }
});

test('hervatStap: al in de portal bewaard → zijn scherm, afgeklemd, nooit voorbij een onbeantwoorde vraag', () => {
  const g = '2026-10-28T09:00:00Z';
  const v1 = PORTAL_FLOWS['1op1'];
  assert.equal(v1[hervatStap({ ...ASCHWIN, portal_gestart_op: g, current_step: 2 }, '1op1')], 'jij');
  assert.equal(v1[hervatStap({ ...ASCHWIN, portal_gestart_op: g, current_step: 9 }, '1op1')], 'beschikbaar');
  const alles = { ...FLORIS, portal_gestart_op: g, current_step: 9, answers: { ...FLORIS.answers, robot_interesse: 'nee' } };
  assert.equal(v1[hervatStap(alles, '1op1')], 'extra');
  assert.equal(hervatStap({ ...VERS, portal_gestart_op: g, current_step: -3 }, '1op1'), 0);
  // Kolom niet gelezen: afklemmen + eerste onbeantwoorde (zoals de website).
  const { portal_gestart_op, ...zonder } = FLORIS;
  void portal_gestart_op;
  assert.equal(v1[hervatStap(zonder, '1op1')], 'extra');
});

// ── De endpoint: open/save/complete zetten de kenmerken ──────────────────

function nepDb(rijen) {
  const log = [];
  const db = {
    log, rijen,
    from(t) {
      const filters = []; let op = 'select'; let waarden = null;
      const lijst = rijen[t] || [];
      const pas = (r) => filters.every((f) => f(r));
      const voer = () => {
        if (op === 'update') { const g = lijst.filter(pas); for (const r of g) Object.assign(r, waarden); log.push({ t, waarden, n: g.length }); return { data: null, error: null }; }
        return { data: lijst.filter(pas).map((r) => ({ ...r })), error: null };
      };
      const q = {
        select() { return q; }, update(v) { op = 'update'; waarden = v; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        is(k, v) { filters.push((r) => (r[k] ?? null) === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        maybeSingle() { const r = voer(); return Promise.resolve({ data: (r.data || [])[0] || null, error: r.error }); },
        then(ok, nok) { return Promise.resolve(voer()).then(ok, nok); },
      };
      return q;
    },
  };
  return db;
}
const TOKEN = '11111111-2222-4333-8444-555555555555';
function dbMet(ob, type = '1op1') {
  return nepDb({
    onboardings: [{ id: 'ob-1', token: TOKEN, startcode: 'ABCD2345', customer_id: null, traject_id: 't-1', mentor_user_id: null, start_date: null, ...ob }],
    onboarding_trajecten: [{ id: 't-1', type, label: 'x', duur_maanden: 12 }],
  });
}
function handler(db) {
  return maakHandler({ db: () => db, rateLimit: async () => ({ limited: false }), rondWizardAf: async () => ({ ok: true }),
    spiegel: async () => {}, naAutomation: async () => {}, nu: () => new Date('2026-10-28T10:00:00Z') });
}
async function post(h, body) {
  const r = { statusCode: 200, headers: {}, setHeader() {}, status(c) { r.statusCode = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } };
  await h({ method: 'POST', headers: { origin: 'https://www.deforexopleiding.nl' }, body }, r);
  return r;
}

test('open: Floris (oud step 6) krijgt het scherm "extra" van de nieuwe flow, niet 6; geopend wordt één keer gezet', async () => {
  const db = dbMet({ ...FLORIS });
  const h = handler(db);
  const r = await post(h, { action: 'open', code: 'ABCD-2345' });
  assert.equal(r.statusCode, 200);
  assert.equal(PORTAL_FLOWS['1op1'][r.body.current_step], 'extra');
  assert.equal(db.rijen.onboardings[0].portal_geopend_op, '2026-10-28T10:00:00.000Z');
  assert.equal(db.rijen.onboardings[0].portal_gestart_op, null, 'openen is nog geen start');
  db.rijen.onboardings[0].portal_geopend_op = '2026-10-27T08:00:00.000Z';
  await post(h, { action: 'open', code: 'ABCD2345' });
  assert.equal(db.rijen.onboardings[0].portal_geopend_op, '2026-10-27T08:00:00.000Z', 'eerste opening blijft staan');
  // Membership, oud step 5 → jij (index 1).
  const m = await post(handler(dbMet({ ...EVERTJAN }, 'membership')), { action: 'open', code: 'ABCD2345' });
  assert.equal(m.body.current_step, 1);
});

test('save en afronden zetten portal_gestart_op één keer; de klassieke wizard raakt hem niet', async () => {
  const db = dbMet({ ...ASCHWIN });
  const h = handler(db);
  const r = await post(h, { action: 'save', sessie: TOKEN, current_step: 3, answers: { beschikbaarheid: { ma: ['avond'] } } });
  assert.equal(r.statusCode, 200);
  assert.equal(db.rijen.onboardings[0].portal_gestart_op, '2026-10-28T10:00:00.000Z');
  db.rijen.onboardings[0].portal_gestart_op = '2026-10-28T09:00:00.000Z';
  await post(h, { action: 'save', sessie: TOKEN, current_step: 4, answers: { robot_interesse: 'nee' } });
  assert.equal(db.rijen.onboardings[0].portal_gestart_op, '2026-10-28T09:00:00.000Z', 'eerste save blijft het moment');
  assert.equal(portalVoortgang(db.rijen.onboardings[0], '1op1').label, 'Nieuwe onboarding · 4/4');
  // Afronden zonder eerdere save (bv. alles al ingevuld) zet hem ook.
  const db2 = dbMet({ ...FLORIS, answers: { ...FLORIS.answers, robot_interesse: 'nee' } });
  await post(handler(db2), { action: 'complete', sessie: TOKEN });
  assert.equal(db2.rijen.onboardings[0].portal_gestart_op, '2026-10-28T10:00:00.000Z');
  // De klassieke wizard schrijft het kenmerk nooit.
  assert.doesNotMatch(lees('api/onboarding-step-save.js'), /portal_gestart_op|portal_geopend_op/);
  assert.doesNotMatch(lees('api/onboarding-complete.js'), /portal_gestart_op/);
});

test('kolommen: faalzacht lezen — ontbrekende migratie geeft null, geen throw', async () => {
  assert.equal(isPortalKolomOntbreekt({ code: '42703', message: 'column onboardings.portal_gestart_op does not exist' }), true);
  assert.equal(isPortalKolomOntbreekt({ code: '42703', message: 'column onboardings.iets does not exist' }), false);
  const kapot = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { code: '42703', message: 'column onboardings.portal_gestart_op does not exist' } }) }) }) };
  assert.equal(await leesPortalKolommen(kapot, ['a']), null);
  const ok = { from: () => ({ select: () => ({ in: async () => ({ data: [{ id: 'a', portal_gestart_op: 'x', portal_geopend_op: null }], error: null }) }) }) };
  assert.deepEqual((await leesPortalKolommen(ok, ['a'])).get('a'), { portal_gestart_op: 'x', portal_geopend_op: null });
});

test('één afleiding: lijst/LMS-bord (overzicht-rijen), LMS-spiegel en detail lezen de portalkolommen', () => {
  assert.match(lees('api/_lib/onboarding-overzicht-rijen.js'), /leesPortalKolommen/);
  assert.match(lees('api/_lib/onboarding-spiegel.js'), /vulPortalKolommenAan/);
  assert.match(lees('api/onboarding-detail.js'), /portalVoortgang/);
  assert.match(lees('docs/sql-migrations/2026-10-28-onboarding-portal-gestart.sql'), /add column if not exists portal_gestart_op timestamptz/);
});

test('schermen: lijst, detail, profiel en v1-overzicht tonen de afleiding — nooit meer "Stap N" van de oude wizard', () => {
  const lijst = lees('modules/klanten-v2/views/onboarding-v2.js');
  assert.match(lijst, /v\.portal_label/);
  assert.match(lijst, /'af_te_ronden'/);
  assert.match(lijst, /Moet onboarding nog afronden/);
  // aangemeld of bezig, niet geannuleerd; standaard op startdatum.
  assert.match(lijst, /function moetNogAfronden\(r\)[\s\S]*?st === 'aangemeld' \|\| st === 'bezig'/);
  assert.match(lijst, /\['binnenkort', 'af_te_ronden'\]\.includes[\s\S]*?'startdatum:asc'/);
  assert.match(lees('modules/klanten-v2/views/modals/onboarding-detail.js'), /function voortgangHtml\(o\)/);
  assert.doesNotMatch(lees('modules/klanten-v2/views/modals/onboarding-detail.js'), /<span>Wizard-stap<\/span>/);
  assert.match(lees('modules/klanten-v2/views/tabs/profiel.js'), /ob\.voortgang\?\.label/);
  assert.match(lees('modules/shared/onboarding-overzicht.js'), /onboarding_antwoorden\.portal_label/);
});
