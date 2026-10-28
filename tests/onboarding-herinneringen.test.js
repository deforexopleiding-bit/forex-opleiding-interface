// tests/onboarding-herinneringen.test.js — de onboarding-herinneringen
// (Maxim, 28 okt 2026, met de correctie: nooit tijdens de bedenktijd).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  besluitHerinnering, besluitOudDossier, eersteDag, normaliseerInstellingen, uitsluiting, isOudDossier,
  CONCEPT_TEKSTEN, SOORTEN, SIGNAAL,
} from '../api/_lib/onboarding-herinneringen.js';
import { dagPlus } from '../api/_lib/onboarding-auto-afronden.js';
import { maakHandler, RECHT_GOEDKEUREN } from '../api/onboarding-herinneringen.js';

//  Offerte getekend op 1 oktober 10:00 → bedenktijd vervalt 15 okt 10:00 → dag 15 = 16 okt.
const rij = (over = {}) => ({
  id: 'ob1', status: 'aangemeld', customer_name: 'Bram', created_at: '2026-10-01T09:00:00Z',
  start_date: '2026-11-20',
  bedenktijd: { status: 'vervallen', reason: 'verstreken', vervalt_op: '2026-10-15T10:00:00.000Z' },
  ...over,
});
const log = (...x) => x.map(([soort, dag, status = 'verstuurd']) => ({ soort, status, aangemaakt_op: dag + 'T08:05:00Z' }));
const op = (dag, r = rij(), extra = {}) => besluitHerinnering(r, { vandaag: dag, ...extra });

test('DE GRENS: dag 14 (de bedenktijd vervalt) geen mail, dag 15 wel', () => {
  assert.equal(eersteDag(rij()), '2026-10-16');
  //  Dag 14 — de bedenktijd is die dag nog lopend, of net vervallen: geen mail.
  assert.deepEqual(op('2026-10-15', rij({ bedenktijd: { status: 'lopend', vervalt_op: '2026-10-15T10:00:00.000Z' } })), { actie: 'niets', waarom: 'bedenktijd_loopt' });
  assert.deepEqual(op('2026-10-15'), { actie: 'niets', waarom: 'voor_dag_15' });
  //  Dag 15 = de dag na het vervallen.
  assert.deepEqual(op('2026-10-16'), { actie: 'mail', soort: 'herinnering_1' });
});

test('ZOLANG DE BEDENKTIJD LOOPT: nooit iets, ook niet start+7 of bijna-start', () => {
  const loopt = rij({ bedenktijd: { status: 'lopend', vervalt_op: '2026-12-30T10:00:00.000Z' }, start_date: '2026-11-01' });
  for (const dag of ['2026-10-16', '2026-10-30', '2026-11-08', '2026-11-20']) {
    assert.deepEqual(op(dag, loopt), { actie: 'niets', waarom: 'bedenktijd_loopt' }, dag);
  }
});

test('ZONDER VERVALDATUM: aanmelddatum + 15 dagen', () => {
  const zonder = rij({ bedenktijd: { status: 'onbekend', vervalt_op: null } });
  assert.equal(eersteDag(zonder), '2026-10-16');
  assert.equal(op('2026-10-15', zonder).waarom, 'voor_dag_15');
  assert.deepEqual(op('2026-10-16', zonder), { actie: 'mail', soort: 'herinnering_1' });
  //  Afstand gedaan: de vervaldatum blijft het anker (de wet: veertien dagen).
  assert.equal(eersteDag(rij({ bedenktijd: { status: 'vervallen', reason: 'afstand', vervalt_op: '2026-10-15T10:00:00Z' } })), '2026-10-16');
});

test('DE CADANS: dag 15, dag 22 (minstens 7 dagen na de eerste), daarna niets meer', () => {
  assert.deepEqual(op('2026-10-16', rij(), { log: log(['herinnering_1', '2026-10-16']) }), { actie: 'niets', waarom: 'vandaag_al_gemaild' });
  assert.deepEqual(op('2026-10-22', rij(), { log: log(['herinnering_1', '2026-10-16']) }), { actie: 'niets', waarom: 'wacht_op_dag_22' });
  assert.deepEqual(op('2026-10-23', rij(), { log: log(['herinnering_1', '2026-10-16']) }), { actie: 'mail', soort: 'herinnering_2' });
  //  De eerste ging laat (schakelaar later aangezet): de tweede pas 7 dagen daarna.
  assert.equal(op('2026-10-27', rij(), { log: log(['herinnering_1', '2026-10-25']) }).waarom, 'wacht_op_dag_22');
  assert.deepEqual(op('2026-11-01', rij(), { log: log(['herinnering_1', '2026-10-25']) }), { actie: 'mail', soort: 'herinnering_2' });
  assert.deepEqual(op('2026-11-05', rij(), { log: log(['herinnering_1', '2026-10-16'], ['herinnering_2', '2026-10-23']) }), { actie: 'niets', waarom: 'alles_gehad' });
  //  Een mislukte poging telt niet als gehad.
  assert.deepEqual(op('2026-10-17', rij(), { log: log(['herinnering_1', '2026-10-16', 'mislukt']) }), { actie: 'mail', soort: 'herinnering_1' });
});

test('BIJNA VAN START: start − 2, enkel na de bedenktijd en niet binnen 3 dagen van een vorige', () => {
  const r = rij({ start_date: '2026-11-20' });
  const twee = log(['herinnering_1', '2026-10-16'], ['herinnering_2', '2026-10-23']);
  assert.deepEqual(op('2026-11-18', r, { log: twee }), { actie: 'mail', soort: 'bijna_start' });
  assert.deepEqual(op('2026-11-17', r, { log: twee }), { actie: 'niets', waarom: 'alles_gehad' }, 'de dag ervoor nog niet');
  //  Te dicht: de tweede ging 3 dagen ervoor → overslaan.
  const dicht = log(['herinnering_1', '2026-11-08'], ['herinnering_2', '2026-11-15']);
  assert.deepEqual(op('2026-11-18', r, { log: dicht }), { actie: 'niets', waarom: 'te_dicht_bij_vorige' });
  //  4 dagen ertussen mag.
  assert.deepEqual(op('2026-11-18', r, { log: log(['herinnering_1', '2026-11-07'], ['herinnering_2', '2026-11-14']) }), { actie: 'mail', soort: 'bijna_start' });
  //  Start − 2 valt vóór het einde van de bedenktijd: nooit "bijna van start".
  const vroeg = rij({ start_date: '2026-10-17' });
  assert.deepEqual(op('2026-10-16', vroeg), { actie: 'mail', soort: 'herinnering_1' });
  assert.deepEqual(op('2026-10-17', vroeg, { log: log(['herinnering_1', '2026-10-16']) }), { actie: 'niets', waarom: 'wacht_op_dag_22' });
});

test('START + 7 EN NOG NIETS: geen mail meer, één signaal naar de administratie', () => {
  const r = rij({ start_date: '2026-10-20' });
  assert.deepEqual(op('2026-10-26', r, { log: log(['herinnering_1', '2026-10-16']) }), { actie: 'mail', soort: 'herinnering_2' }, 'start+6: nog een mail');
  assert.deepEqual(op('2026-10-27', r, { log: log(['herinnering_1', '2026-10-16']) }), { actie: 'signaal' });
  assert.deepEqual(op('2026-10-28', r, { log: log(['herinnering_1', '2026-10-16'], [SIGNAAL, '2026-10-27']) }), { actie: 'niets', waarom: 'signaal_al_gezet' });
  //  Ook het signaal pas na de bedenktijd.
  const laat = rij({ start_date: '2026-10-01', bedenktijd: { status: 'vervallen', vervalt_op: '2026-10-20T10:00:00Z' } });
  assert.deepEqual(op('2026-10-20', laat), { actie: 'niets', waarom: 'voor_dag_15' });
  assert.deepEqual(op('2026-10-21', laat), { actie: 'signaal' });
});

test('NOOIT: klaar, geannuleerd, gearchiveerd, incasso, test, "Geen herinneringen", wil annuleren', () => {
  const nooit = [
    [rij({ status: 'afgerond' }), 'klaar'],
    [rij({ afgesloten: true }), 'klaar'],
    [rij({ handmatig_afgerond_op: '2026-10-10T00:00:00Z' }), 'klaar'],
    [rij({ status: 'geannuleerd' }), 'geannuleerd'],
    [rij({ archived_at: '2026-10-10T00:00:00Z' }), 'gearchiveerd'],
    [rij({ in_incasso: true }), 'incasso'],
    [rij({ is_test: true }), 'test'],
    [rij({ geen_herinneringen_op: '2026-10-10T00:00:00Z' }), 'geen_herinneringen'],
  ];
  for (const [r, waarom] of nooit) assert.deepEqual(op('2026-10-16', r), { actie: 'niets', waarom }, waarom);
  assert.deepEqual(op('2026-10-16', rij(), { wilAnnuleren: true }), { actie: 'niets', waarom: 'wil_annuleren' });
  assert.equal(uitsluiting(rij()), null);
});

test('DE OUDE AUTOMATION "Reminder na bedenktijd": aan = wij sturen dag 15 niet', () => {
  assert.deepEqual(op('2026-10-16', rij(), { oudeAutomationAan: true }), { actie: 'niets', waarom: 'oude_automation_stuurt_dag_15' });
  //  Haar mail telt als herinnering_1 → de tweede volgt gewoon.
  assert.deepEqual(op('2026-10-23', rij(), { oudeAutomationAan: true, log: log(['herinnering_1', '2026-10-16', 'overgenomen']) }), { actie: 'mail', soort: 'herinnering_2' });
});

test('OUDE DOSSIERS: start > 30 dagen geleden → niet in de cadans; één laatste mail; 7 dagen later dicht', () => {
  const oud = rij({ start_date: '2026-09-01', created_at: '2026-08-01T09:00:00Z', bedenktijd: { status: 'vervallen', vervalt_op: '2026-08-15T10:00:00Z' } });
  assert.equal(isOudDossier(oud, '2026-10-28'), true);
  assert.equal(isOudDossier(rij({ start_date: '2026-09-28' }), '2026-10-28'), false, 'precies 30 dagen: nog niet oud');
  assert.deepEqual(op('2026-10-28', oud), { actie: 'niets', waarom: 'oud_dossier' });
  assert.deepEqual(besluitOudDossier(oud, { vandaag: '2026-10-28' }), { actie: 'laatste_mail' });
  assert.deepEqual(besluitOudDossier(oud, { vandaag: '2026-11-03', log: log(['laatste', '2026-10-28']) }), { actie: 'niets', waarom: 'wacht_7_dagen' });
  assert.deepEqual(besluitOudDossier(oud, { vandaag: '2026-11-04', log: log(['laatste', '2026-10-28']) }), { actie: 'afronden' });
  assert.equal(besluitOudDossier({ ...oud, status: 'afgerond' }, { vandaag: '2026-11-04' }).waarom, 'klaar', 'ingevuld → niet afronden');
  assert.equal(besluitOudDossier({ ...oud, geen_herinneringen_op: 'x' }, { vandaag: '2026-10-28' }).waarom, 'geen_herinneringen');
});

test('TEKSTEN: concept tot goedgekeurd; een wijziging zet ze terug op concept; standaard UIT', () => {
  const leeg = normaliseerInstellingen(null);
  assert.equal(leeg.aan, false);
  for (const s of SOORTEN) {
    assert.equal(leeg.teksten[s].goedgekeurd, false, s);
    assert.match(CONCEPT_TEKSTEN[s].tekst, /^\{\{onboarding\.startcode\}\}$/m, s + ': de code op een eigen regel');
    assert.match(CONCEPT_TEKSTEN[s].tekst, /^\[knop: [^\]]+\]$/m, s + ': een knop');
  }
  const t = CONCEPT_TEKSTEN.herinnering_1;
  const ok = normaliseerInstellingen({ aan: true, teksten: { herinnering_1: { ...t, goedgekeurd_op: 'x', goedgekeurd_door: 'Maxim', goedgekeurd_onderwerp: t.onderwerp, goedgekeurd_tekst: t.tekst } } });
  assert.equal(ok.teksten.herinnering_1.goedgekeurd, true);
  assert.equal(ok.aan, true);
  const anders = normaliseerInstellingen({ teksten: { herinnering_1: { ...t, tekst: t.tekst + '\nPS', goedgekeurd_op: 'x', goedgekeurd_onderwerp: t.onderwerp, goedgekeurd_tekst: t.tekst } } });
  assert.equal(anders.teksten.herinnering_1.goedgekeurd, false);
  assert.equal(normaliseerInstellingen({ aan: 'ja' }).aan, false, 'alleen true is aan');
});

test('DAGEN: dag 15 = vervaldag + 1 in Brussel, ook als hij om 23:30 UTC vervalt', () => {
  assert.equal(eersteDag(rij({ bedenktijd: { status: 'vervallen', vervalt_op: '2026-10-15T23:30:00Z' } })), '2026-10-17');
  assert.equal(dagPlus('2026-10-31', 1), '2026-11-01');
});

test('DE CRON: geheim, schakelaar, droogloop, logboek als grendel, en in vercel.json', () => {
  const src = readFileSync(new URL('../api/cron/onboarding-herinneringen.js', import.meta.url), 'utf8');
  assert.match(src, /CRON_SECRET/);
  assert.match(src, /!inst\.aan && !dry/);
  assert.match(src, /tekst_niet_goedgekeurd/);
  assert.match(src, /log === null && !dry/);
  //  Eerst claimen, dan mailen.
  assert.ok(src.indexOf("claim(supabaseAdmin, r.id, b.soort)") < src.indexOf('stuurHerinnering(supabaseAdmin, r, tekst)'));
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(v.crons.some((c) => c.path === '/api/cron/onboarding-herinneringen'));
  const sql = readFileSync(new URL('../docs/sql-migrations/2026-10-28-onboarding-opvolgflow.sql', import.meta.url), 'utf8');
  assert.match(sql, /unique \(onboarding_id, soort\)/);
  assert.match(sql, /enable row level security/);
});

function nepRes() {
  return {
    code: 200, json: null, headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.code = c; return this; },
    json(b) { this.json = b; return this; },
  };
}

test('HET ENDPOINT: goedkeuren, schakelaar en oude dossiers enkel met het goedkeur-recht', async () => {
  const h = maakHandler({
    ingelogd: async () => ({ id: 'u1', email: 'jeffrey@x.nl' }),
    mag: async (_req, recht) => recht !== RECHT_GOEDKEUREN,
    db: {},
  });
  for (const actie of ['goedkeuren', 'schakelaar', 'oude_dossiers']) {
    const res = nepRes();
    await h({ method: 'POST', headers: {}, body: { actie, soort: 'herinnering_1', aan: true } }, res);
    assert.equal(res.code, 403, actie);
  }
  const zonder = maakHandler({ ingelogd: async () => null });
  const res = nepRes();
  await zonder({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 401);
});

test('DE LMS-ROUTE kent "geen_herinneringen" en de rijen dragen de schakelaar en het logboek', () => {
  const route = readFileSync(new URL('../api/lms-onboarding-sessie.js', import.meta.url), 'utf8');
  assert.match(route, /actie === 'geen_herinneringen'/);
  const rijen = readFileSync(new URL('../api/_lib/onboarding-overzicht-rijen.js', import.meta.url), 'utf8');
  assert.match(rijen, /geen_herinneringen:\s+r\.geen_herinneringen_op \?/);
  assert.match(rijen, /herinneringen:\s+herinneringenByOb === null \? null/);
});
