// tests/checkin-portal.test.js — "Jouw DFO-check-in" voor bestaande studenten
// (www.deforexopleiding.nl/checkin) en de API erachter (api/checkin-portal.js).
//
// Bedoeld gedrag (opdracht 27 okt 2026):
//   · niemand komt erin vóór Run: concept, en een gewone toewijzing in een
//     testcampagne, geven dezelfde 404 als een onbekende code;
//   · 'open' geeft geen e-mail/telefoon/achternaam;
//   · 'save' schrijft alleen de whitelist, met typecontrole, per flow en opties;
//     een verstuurde toewijzing wijzigt niet meer (409);
//   · 'submit' controleert de verplichte velden, is idempotent: tweede keer =
//     zelfde antwoord, geen tweede signaal, geen tweede kaart;
//   · begeleidingssignaal en automation-kaart staan LOS van elkaar;
//   · testtoewijzingen krijgen nooit een automation-kaart;
//   · netwerk-/DB-fout bij versturen → geen "ok".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  valideerPatch, schoneAntwoorden, ontbrekend, verplicht, signaalVoor, signaalBewijs, flowVoor,
  optiesVan, maandVan, persoonKort, isZichtbaar, LABELS, CHECKIN_SLEUTELS,
} from '../api/_lib/checkin-portal.js';
import { maakHandler } from '../api/checkin-portal.js';
import { syncCheckinAutomationKaart, checkinKaartRij } from '../api/_lib/automation-interesse.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ── Regels ────────────────────────────────────────────────────────────────

test('flow uit product_soort; opties met veilige standaarden', () => {
  assert.equal(flowVoor('mentorship'), '1op1');
  assert.equal(flowVoor('membership'), 'membership');
  assert.equal(flowVoor(null), 'membership');
  assert.deepEqual(optiesVan(null, null), { payout_vraag: true, trustpilot_vraag: false, autopilot_stap: true });
  // Wat bij het starten vastgelegd is wint van de campagne (geen stille wijziging).
  assert.deepEqual(optiesVan({ opties: { trustpilot_vraag: true } }, { opties: { autopilot_stap: false } }),
    { payout_vraag: true, trustpilot_vraag: true, autopilot_stap: true });
});

test('valideerPatch: whitelist + typecontrole', () => {
  const ok = valideerPatch({
    fase: 'demo', doel_3m: 'routine', uren_per_week: 0, payout: 'ja_eerste', payout_delen: 'ja', nps: 10,
    helpt: ['live', 'mentor'], knelpunt: ['risico', 'setups'], verbeter: '  beter  ', hulp: 'feedback',
    mentor_score: 4, begeleiding_contact: 'nee', robot_interesse: 'ja_interesse', robot_belmoment: ['avond', 'voormiddag'],
  }, { flow: '1op1' });
  assert.equal(ok.ok, true, JSON.stringify(ok.fouten));
  assert.deepEqual(ok.schoon.helpt, ['mentor', 'live']); // vaste volgorde
  assert.deepEqual(ok.schoon.robot_belmoment, ['voormiddag', 'avond']);
  assert.equal(ok.schoon.verbeter, 'beter');

  for (const [k, v] of [
    ['fase', 'anders'], ['nps', 11], ['nps', -1], ['nps', 5.5], ['nps', '7'], ['uren_per_week', 11],
    ['mentor_score', 0], ['mentor_score', 6], ['helpt', ['live', 'videos', 'recaps', 'journal']],
    ['knelpunt', ['niets', 'tijd']], ['knelpunt', 'tijd'], ['verbeter', 'x'.repeat(2001)], ['hulp', ['niets']],
    ['onbekend', 1], ['robot_belmoment', ['nacht']], ['begeleiding_contact', true],
  ]) {
    const r = valideerPatch({ [k]: v }, { flow: '1op1' });
    assert.equal(r.ok, false, `${k}=${JSON.stringify(v)} hoort geweigerd`);
    assert.deepEqual(r.fouten, [k]);
  }
  assert.equal(valideerPatch(null).ok, false);
  assert.equal(valideerPatch([]).ok, false);
});

test('valideerPatch: mentorvragen alleen bij mentorship, optionele stappen alleen als ze aanstaan', () => {
  assert.equal(valideerPatch({ mentor_score: 3 }, { flow: 'membership' }).ok, false);
  assert.equal(valideerPatch({ helpt: ['mentor'] }, { flow: 'membership' }).ok, false);
  assert.equal(valideerPatch({ helpt: ['live'] }, { flow: 'membership' }).ok, true);
  assert.equal(valideerPatch({ payout: 'nog_niet' }, { opties: { payout_vraag: false } }).ok, false);
  assert.equal(valideerPatch({ robot_interesse: 'nee' }, { opties: { autopilot_stap: false } }).ok, false);
});

test('verplicht + ontbrekend per flow', () => {
  assert.deepEqual(verplicht('1op1'), ['fase', 'doel_3m', 'nps', 'knelpunt', 'hulp', 'begeleiding_contact', 'mentor_score', 'robot_interesse']);
  assert.deepEqual(verplicht('membership'), ['fase', 'doel_3m', 'nps', 'knelpunt', 'hulp', 'begeleiding_contact', 'robot_interesse']);
  assert.deepEqual(verplicht('membership', { autopilot_stap: false }), ['fase', 'doel_3m', 'nps', 'knelpunt', 'hulp', 'begeleiding_contact']);
  const vol = { fase: 'demo', doel_3m: 'routine', nps: 0, knelpunt: ['tijd'], hulp: 'niets', begeleiding_contact: 'nee', robot_interesse: 'nee' };
  assert.deepEqual(ontbrekend('membership', {}, vol), []);
  assert.deepEqual(ontbrekend('1op1', {}, vol), ['mentor_score']);
  assert.deepEqual(ontbrekend('membership', {}, { ...vol, knelpunt: [] }), ['knelpunt']);
  // nps 0 is een antwoord, geen "leeg".
  assert.ok(!ontbrekend('membership', {}, vol).includes('nps'));
});

test('schoneAntwoorden: oude/ongeldige waarden en losse vervolgvragen gaan niet mee', () => {
  const a = schoneAntwoorden({ fase: 'xx', nps: 8, payout: 'nog_niet', payout_delen: 'ja', robot_interesse: 'nee', robot_belmoment: ['avond'], mentor_score: 3 }, { flow: 'membership' });
  assert.deepEqual(a, { nps: 8, payout: 'nog_niet', robot_interesse: 'nee' });
});

test('signaalVoor: de regels uit de opdracht, hoogste zwaarte wint', () => {
  assert.equal(signaalVoor({ nps: 9, begeleiding_contact: 'nee', mentor_score: 5, knelpunt: ['tijd'] }), null);
  assert.equal(signaalVoor({ nps: 7 }), null);
  assert.equal(signaalVoor({ begeleiding_contact: 'ja', nps: 9 }).zwaarte, 'oranje');
  assert.equal(signaalVoor({ nps: 6 }).zwaarte, 'geel');
  assert.equal(signaalVoor({ nps: 4 }).zwaarte, 'geel');
  assert.equal(signaalVoor({ nps: 3 }).zwaarte, 'rood');
  assert.equal(signaalVoor({ nps: 0 }).zwaarte, 'rood');
  assert.equal(signaalVoor({ mentor_score: 2, nps: 9 }).zwaarte, 'oranje');
  assert.equal(signaalVoor({ mentor_score: 3, nps: 9 }), null);
  assert.equal(signaalVoor({ knelpunt: ['volgende_stap'], nps: 9 }).zwaarte, 'geel');
  const s = signaalVoor({ nps: 2, begeleiding_contact: 'ja', mentor_score: 1, knelpunt: ['volgende_stap'] });
  assert.equal(s.zwaarte, 'rood');
  assert.equal(s.redenen.length, 4);
});

test('signaalBewijs: leesbaar, met labels', () => {
  const b = signaalBewijs({
    antwoorden: { nps: 3, mentor_score: 2, begeleiding_contact: 'ja', fase: 'demo', knelpunt: ['emotie'], hulp: 'feedback', verbeter: 'Meer live' },
    redenen: ['x'], campagneSlug: 'checkin-2026-11', toewijzingId: 't1', isTest: true,
  });
  assert.equal(b['Aanbevelen (0-10)'], 3);
  assert.equal(b['Contact over traject'], 'Ja, graag');
  assert.deepEqual(b['Loopt tegenaan'], ['Discipline & emoties']);
  assert.equal(b.test, true);
});

test('maand X van Y en mentor-initialen', () => {
  assert.deepEqual(maandVan('2026-04-01', 12, new Date('2026-10-27T10:00:00Z')), { maand: 7, maanden: 12 });
  assert.deepEqual(maandVan('2026-10-28', 12, new Date('2026-10-27T10:00:00Z')), { maand: 1, maanden: 12 });
  assert.deepEqual(maandVan('2024-01-01', 12, new Date('2026-10-27T10:00:00Z')), { maand: 12, maanden: 12 });
  assert.equal(maandVan(null, 12), null);
  assert.equal(maandVan('2026-01-01', 0), null);
  assert.deepEqual(persoonKort('Seppe Huysmans'), { voornaam: 'Seppe', initialen: 'SH' });
  assert.equal(persoonKort(''), null);
});

test('zichtbaarheid = dezelfde regel als hlms_checkin_zichtbaar() in het LMS', () => {
  assert.equal(isZichtbaar('live', false), true);
  assert.equal(isZichtbaar('test', true), true);
  for (const s of ['concept', 'gepauzeerd', 'gesloten', null]) assert.equal(isZichtbaar(s, true), false);
  assert.equal(isZichtbaar('test', false), false);
});

test('elke keuzesleutel heeft labels voor elke waarde (CRM-overzicht, CSV, bewijs)', () => {
  for (const k of ['fase', 'doel_3m', 'payout', 'helpt', 'knelpunt', 'hulp', 'robot_interesse', 'robot_belmoment']) {
    assert.ok(LABELS[k], k);
  }
  assert.equal(CHECKIN_SLEUTELS.length, 14);
});

// ── Een nep-LMS met dezelfde semantiek als de databankfuncties ─────────────

function nepLms({ campagneStatus = 'live', isTest = false, product = 'mentorship', verstuurd = false, rpcFout = null } = {}) {
  const campagne = { id: 'c1', slug: 'checkin-2026-11', status: campagneStatus, opties: { payout_vraag: true, trustpilot_vraag: false, autopilot_stap: true }, inhoud_versie: 1 };
  const student = {
    id: 's1', voornaam: 'Lotte', achternaam: 'Peeters', email: 'lotte@example.com', telefoon: '+32470000000',
    product_soort: product, start_datum: '2026-04-01', traject_maanden: 12, calls_gedaan: 21, calls_totaal: 48, mentor_id: 'm1',
  };
  const t = {
    id: 'tw1', campagne_id: 'c1', student_id: 's1', code: 'K7QM4RPD', sessie: '11111111-2222-3333-4444-555555555555',
    is_test: isTest, status: verstuurd ? 'verstuurd' : 'niet_gestart', huidige_stap: 0, antwoorden: {}, opties: null,
    verstuurd_op: verstuurd ? '2026-10-27T09:00:00Z' : null, signaal_id: null,
  };
  const log = { signalen: [], rpc: [] };
  const met = () => ({ ...t, campagne: { ...campagne }, student: { ...student } });
  const db = {
    log, t, campagne,
    from(tabel) {
      const filters = [];
      const q = {
        select() { return q; },
        eq(k, v) { filters.push([k, v]); return q; },
        maybeSingle() {
          if (tabel === 'hlms_checkin_toewijzing') {
            const hit = filters.every(([k, v]) => t[k] === v);
            return Promise.resolve({ data: hit ? met() : null, error: null });
          }
          if (tabel === 'hlms_personeel') return Promise.resolve({ data: { naam: 'Seppe Huysmans' }, error: null });
          if (tabel === 'hlms_student') return Promise.resolve({ data: { ...student }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
      };
      return q;
    },
    async rpc(naam, args) {
      log.rpc.push(naam);
      if (rpcFout) return { data: null, error: rpcFout };
      if (args.p_sessie !== t.sessie) return { data: { onbekend: true }, error: null };
      const zichtbaar = campagne.status === 'live' || (campagne.status === 'test' && t.is_test);
      if (naam === 'hlms_checkin_bewaren') {
        if (t.status === 'verstuurd') return { data: { verstuurd: true }, error: null };
        if (!zichtbaar) return { data: { dicht: true }, error: null };
        t.antwoorden = { ...t.antwoorden, ...args.p_patch };
        t.status = 'bezig'; t.huidige_stap = args.p_stap; t.opties ||= campagne.opties;
        return { data: { ok: true, antwoorden: { ...t.antwoorden } }, error: null };
      }
      if (naam === 'hlms_checkin_versturen') {
        if (t.status === 'verstuurd') return { data: { ok: true, al: true, signaal_id: t.signaal_id }, error: null };
        if (!zichtbaar) return { data: { dicht: true }, error: null };
        if (args.p_signaal) { log.signalen.push(args.p_signaal); t.signaal_id = 'sig-' + log.signalen.length; }
        t.antwoorden = args.p_antwoorden; t.status = 'verstuurd'; t.verstuurd_op = new Date().toISOString();
        return { data: { ok: true, al: false, signaal_id: t.signaal_id }, error: null };
      }
      return { data: null, error: { message: 'onbekende functie' } };
    },
  };
  return db;
}

function nepRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

function maak(lms, { kaarten = [] } = {}) {
  const handler = maakHandler({
    lms: () => lms,
    rateLimit: async () => ({ limited: false }),
    naAutomation: async (p) => { kaarten.push(p); },
    nu: () => new Date('2026-10-27T10:00:00Z'),
  });
  return async (body, headers = {}) => {
    const res = nepRes();
    await handler({ method: 'POST', headers: { origin: 'https://www.deforexopleiding.nl', ...headers }, body }, res);
    return res;
  };
}

const VOL_1OP1 = {
  fase: 'demo', doel_3m: 'routine', uren_per_week: 5, nps: 9, helpt: ['mentor'], knelpunt: ['tijd'],
  hulp: 'feedback', mentor_score: 5, begeleiding_contact: 'nee', robot_interesse: 'nee',
};

test('open: live → dossier zonder e-mail, telefoon of achternaam', async () => {
  const api = maak(nepLms());
  const r = await api({ action: 'open', code: 'k7qm-4rpd' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.voornaam, 'Lotte');
  assert.equal(r.body.flow, '1op1');
  assert.equal(r.body.traject_naam, '1-op-1 Mentorship');
  assert.equal(r.body.maand, 7);
  assert.deepEqual(r.body.sessies, { gedaan: 21, totaal: 48 });
  assert.deepEqual(r.body.mentor, { voornaam: 'Seppe', initialen: 'SH' });
  assert.equal(r.body.afgerond, false);
  const tekst = JSON.stringify(r.body);
  for (const lek of ['lotte@example.com', '+32470000000', 'Peeters', 'Huysmans', 's1']) assert.ok(!tekst.includes(lek), lek);
  assert.equal(r.headers['access-control-allow-origin'], 'https://www.deforexopleiding.nl');
});

test('open: vóór Run komt er niemand in — zelfde 404 als een onbekende code', async () => {
  const onbekend = await maak(nepLms())({ action: 'open', code: 'ZZZZZZZZ' });
  const ongeldig = await maak(nepLms())({ action: 'open', code: 'O0' });
  const concept = await maak(nepLms({ campagneStatus: 'concept', isTest: true }))({ action: 'open', code: 'K7QM4RPD' });
  const testGewoon = await maak(nepLms({ campagneStatus: 'test', isTest: false }))({ action: 'open', code: 'K7QM4RPD' });
  for (const r of [onbekend, ongeldig, concept, testGewoon]) {
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.body, onbekend.body);
  }
  const testTest = await maak(nepLms({ campagneStatus: 'test', isTest: true }))({ action: 'open', code: 'K7QM4RPD' });
  assert.equal(testTest.statusCode, 200);
});

test('open: gepauzeerd → 410; al verstuurd → afgerond (alleen-lezen)', async () => {
  const p = await maak(nepLms({ campagneStatus: 'gepauzeerd' }))({ action: 'open', code: 'K7QM4RPD' });
  assert.equal(p.statusCode, 410);
  const v = await maak(nepLms({ verstuurd: true }))({ action: 'open', code: 'K7QM4RPD' });
  assert.equal(v.statusCode, 200);
  assert.equal(v.body.afgerond, true);
});

test('open: membership heeft geen sessieteller en geen mentor', async () => {
  const r = await maak(nepLms({ product: 'membership' }))({ action: 'open', code: 'K7QM4RPD' });
  assert.equal(r.body.flow, 'membership');
  assert.equal(r.body.sessies, null);
  assert.equal(r.body.mentor, null);
});

test('open: zonder LMS-configuratie → 503, nooit een crash', async () => {
  const handler = maakHandler({ lms: () => null, rateLimit: async () => ({ limited: false }) });
  const res = nepRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'open', code: 'K7QM4RPD' } }, res);
  assert.equal(res.statusCode, 503);
});

test('open: rate limit → 429', async () => {
  const handler = maakHandler({ lms: () => nepLms(), rateLimit: async () => ({ limited: true }) });
  const res = nepRes();
  await handler({ method: 'POST', headers: {}, body: { action: 'open', code: 'K7QM4RPD' } }, res);
  assert.equal(res.statusCode, 429);
});

test('save: whitelist, en na versturen niets meer wijzigen (409)', async () => {
  const lms = nepLms();
  const api = maak(lms);
  const s = lms.t.sessie;
  assert.equal((await api({ action: 'save', sessie: s, huidige_stap: 2, antwoorden: { fase: 'demo' } })).statusCode, 200);
  assert.equal(lms.t.status, 'bezig');
  const fout = await api({ action: 'save', sessie: s, huidige_stap: 2, antwoorden: { fase: 'demo', email: 'x' } });
  assert.equal(fout.statusCode, 400);
  assert.deepEqual(fout.body.velden, ['email']);
  assert.equal((await api({ action: 'save', sessie: 'geen-uuid', huidige_stap: 1, antwoorden: {} })).statusCode, 404);
  assert.equal((await api({ action: 'save', sessie: s, huidige_stap: 99, antwoorden: {} })).statusCode, 400);
  await api({ action: 'save', sessie: s, huidige_stap: 4, antwoorden: VOL_1OP1 });
  assert.equal((await api({ action: 'submit', sessie: s })).statusCode, 200);
  const na = await api({ action: 'save', sessie: s, huidige_stap: 1, antwoorden: { fase: 'basis' } });
  assert.equal(na.statusCode, 409);
  assert.equal(lms.t.antwoorden.fase, 'demo');
});

test('save: gepauzeerd → 410 (antwoorden blijven staan)', async () => {
  const lms = nepLms();
  const api = maak(lms);
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 1, antwoorden: { fase: 'demo' } });
  lms.campagne.status = 'gepauzeerd';
  const r = await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 2, antwoorden: { fase: 'basis' } });
  assert.equal(r.statusCode, 410);
  assert.equal(lms.t.antwoorden.fase, 'demo');
});

test('save: robot_interesse raakt de automation; andere sleutels niet', async () => {
  const lms = nepLms();
  const kaarten = [];
  const api = maak(lms, { kaarten });
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 1, antwoorden: { fase: 'demo' } });
  assert.equal(kaarten.length, 0);
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 4, antwoorden: { robot_interesse: 'ja_interesse', robot_belmoment: ['avond'] } });
  assert.equal(kaarten.length, 1);
  assert.equal(kaarten[0].toewijzing.id, 'tw1');
  assert.equal(kaarten[0].answers.robot_interesse, 'ja_interesse');
  assert.equal(kaarten[0].student.email, 'lotte@example.com'); // voor Daves kaart, niet voor de browser
});

test('submit: onvolledig → 400 met de ontbrekende sleutels', async () => {
  const lms = nepLms();
  const api = maak(lms);
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 1, antwoorden: { fase: 'demo' } });
  const r = await api({ action: 'submit', sessie: lms.t.sessie });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.body.missing, ['doel_3m', 'nps', 'knelpunt', 'hulp', 'begeleiding_contact', 'mentor_score', 'robot_interesse']);
  assert.equal(lms.t.status, 'bezig');
});

test('submit twee keer: zelfde antwoord, één signaal, geen dubbele kaart', async () => {
  const lms = nepLms();
  const kaarten = [];
  const api = maak(lms, { kaarten });
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 4, antwoorden: { ...VOL_1OP1, nps: 2, begeleiding_contact: 'ja' } });
  const a = await api({ action: 'submit', sessie: lms.t.sessie });
  const b = await api({ action: 'submit', sessie: lms.t.sessie });
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200);
  assert.equal(b.body.already, true);
  assert.equal(lms.log.signalen.length, 1);
  assert.equal(lms.log.signalen[0].zwaarte, 'rood');
  assert.equal(lms.t.status, 'verstuurd');
});

test('geen automation → geen kaart; begeleiding ja + automation nee → alleen signaal', async () => {
  const lms = nepLms();
  const kaarten = [];
  const api = maak(lms, { kaarten });
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 4, antwoorden: { ...VOL_1OP1, begeleiding_contact: 'ja' } });
  await api({ action: 'submit', sessie: lms.t.sessie });
  assert.equal(lms.log.signalen.length, 1);
  assert.equal(lms.log.signalen[0].zwaarte, 'oranje');
  // De kaart-sync draait (idempotent), maar met "nee" maakt hij niets: zie de
  // sync-toets hieronder voor de beslissing zelf.
  assert.ok(kaarten.every((k) => k.answers.robot_interesse === 'nee'));
});

test('alles goed → geen signaal', async () => {
  const lms = nepLms();
  const api = maak(lms);
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 4, antwoorden: VOL_1OP1 });
  await api({ action: 'submit', sessie: lms.t.sessie });
  assert.equal(lms.log.signalen.length, 0);
});

test('submit: DB-fout bij versturen → geen ok (geen vals bedankscherm)', async () => {
  const kapot = nepLms({ rpcFout: { message: 'connection reset' } });
  kapot.t.antwoorden = { ...VOL_1OP1 };
  const r = await maak(kapot)({ action: 'submit', sessie: kapot.t.sessie });
  assert.equal(r.statusCode, 500);
  assert.notEqual(r.body.ok, true);
  assert.equal(kapot.t.status, 'niet_gestart');
});

test('submit: migratie niet gedraaid → 503', async () => {
  const kapot = nepLms({ rpcFout: { code: 'PGRST202', message: 'Could not find the function' } });
  kapot.t.antwoorden = { ...VOL_1OP1 };
  const r = await maak(kapot)({ action: 'submit', sessie: kapot.t.sessie });
  assert.equal(r.statusCode, 503);
});

test('CORS: alleen de website, nooit *', async () => {
  const api = maak(nepLms());
  const r = await api({ action: 'open', code: 'ZZZZZZZZ' }, { origin: 'https://evil.example' });
  assert.equal(r.headers['access-control-allow-origin'], undefined);
});

// ── De automation-kaart (CRM) ──────────────────────────────────────────────

function nepCrm() {
  const taken = [];
  const pogingen = [];
  return {
    taken,
    from(t) {
      const filters = [];
      let op = 'select'; let waarden = null;
      const veld = (r, k) => (k.includes('->>') ? (r[k.split('->>')[0]] || {})[k.split('->>')[1]] : r[k]);
      const rijen = t === 'opvolging_taken' ? taken : pogingen;
      const voer = () => {
        if (op === 'insert') {
          if (rijen.some((r) => r.reden === waarden.reden && r.bron_ref?.checkin_toewijzing_id === waarden.bron_ref?.checkin_toewijzing_id)) {
            return { data: null, error: { code: '23505' } };
          }
          const rij = { id: 'taak-' + (rijen.length + 1), ...waarden };
          rijen.push(rij);
          return { data: { id: rij.id }, error: null };
        }
        const geraakt = rijen.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') { for (const r of geraakt) Object.assign(r, waarden); return { data: null, error: null }; }
        return { data: geraakt.map((r) => ({ ...r })), error: null };
      };
      const q = {
        select() { return q; },
        insert(v) { op = 'insert'; waarden = v; return q; },
        update(v) { op = 'update'; waarden = v; return q; },
        eq(k, v) { filters.push((r) => veld(r, k) === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(veld(r, k))); return q; },
        limit() { return q; },
        maybeSingle() { const r = voer(); return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: null }); },
        then(ok, nok) { return Promise.resolve(voer()).then(ok, nok); },
      };
      return q;
    },
  };
}

const TW = { id: 'tw1', campagne_id: 'c1', student_id: 's1', is_test: false };
const ST = { id: 's1', voornaam: 'Lotte', achternaam: 'Peeters', email: 'lotte@example.com', telefoon: '0470 00 00 00' };
const NU = new Date('2026-10-27T10:00:00Z');

test('kaart: ja → één kaart met eigen sleutel; nog eens → bijwerken, geen tweede', async () => {
  const db = nepCrm();
  const a = await syncCheckinAutomationKaart(db, { toewijzing: TW, student: ST, trajectLabel: '1-op-1 Mentorship', answers: { robot_interesse: 'ja_interesse', robot_belmoment: ['avond'] }, nu: NU });
  assert.equal(a.actie, 'maak');
  const b = await syncCheckinAutomationKaart(db, { toewijzing: TW, student: ST, answers: { robot_interesse: 'ja_interesse', robot_belmoment: [] }, nu: NU });
  assert.equal(b.actie, 'bijwerken');
  assert.equal(db.taken.length, 1);
  const k = db.taken[0];
  assert.equal(k.reden, 'automation_interesse');
  assert.equal(k.bron_ref.checkin_toewijzing_id, 'tw1');
  assert.equal(k.bron_ref.bron, 'checkin');
  assert.equal(k.bron_ref.onboarding_id, undefined);
  assert.equal(k.naam, 'Lotte Peeters');
  assert.equal(k.lijst, 'automation'); // de eigen sectie Automation (#1904)
  assert.match(k.notitie, /studentencheck-in/);
});

test('kaart: nee vóór contact sluit; testtoewijzing nooit een kaart', async () => {
  const db = nepCrm();
  await syncCheckinAutomationKaart(db, { toewijzing: TW, student: ST, answers: { robot_interesse: 'ja_interesse' }, nu: NU });
  const n = await syncCheckinAutomationKaart(db, { toewijzing: TW, student: ST, answers: { robot_interesse: 'nee' }, nu: NU });
  assert.equal(n.actie, 'sluit');
  assert.equal(db.taken[0].status, 'gearchiveerd');
  const leeg = nepCrm();
  const t = await syncCheckinAutomationKaart(leeg, { toewijzing: { ...TW, is_test: true }, student: ST, answers: { robot_interesse: 'ja_interesse' }, nu: NU });
  assert.deepEqual(t, { actie: 'niets', waarom: 'testtoewijzing', taak_id: null });
  assert.equal(leeg.taken.length, 0);
  // "nee" zonder kaart → niets.
  const nee = nepCrm();
  assert.equal((await syncCheckinAutomationKaart(nee, { toewijzing: TW, student: ST, answers: { robot_interesse: 'nee' }, nu: NU })).actie, 'niets');
  assert.equal(nee.taken.length, 0);
});

test('kaart: de checkin-kaart en de onboarding-kaart botsen niet op de unieke index', () => {
  const rij = checkinKaartRij({ toewijzing: TW, student: ST, belmoment: [], nuMs: NU.getTime() });
  assert.equal(rij.bron_ref.onboarding_id, undefined);
  const sql = lees('docs/sql-migrations/2026-10-27-studentencheck-in.sql');
  assert.match(sql, /create unique index if not exists opvolging_taken_automation_checkin_uniek[\s\S]*bron_ref->>'checkin_toewijzing_id'/i);
});

test('portal: geen mail/WhatsApp-code in het endpoint (er gaat niets naar studenten)', () => {
  const bron = lees('api/checkin-portal.js');
  for (const verboden of ['mailer', 'sendMail', 'whatsapp', 'metaPostMessage', 'ghl']) {
    assert.ok(!new RegExp(`import[^\\n]*${verboden}`, 'i').test(bron), verboden);
  }
});

// ── De sectie Automation (#1904) toont check-in-kaarten als zodanig ────────
import { bouwOverzicht } from '../api/_lib/automation-overzicht.js';

test('Automation: een check-in-kaart heeft herkomst checkin, traject en mentor uit de kaart, link naar het LMS-dossier', () => {
  const rij = checkinKaartRij({ toewijzing: TW, student: ST, trajectLabel: '1-op-1 Mentorship', mentorNaam: 'Seppe Huysmans', belmoment: ['avond'], nuMs: NU.getTime() });
  assert.equal(rij.bron_ref.traject_label, '1-op-1 Mentorship');
  assert.equal(rij.bron_ref.mentor_naam, 'Seppe Huysmans');
  const ov = bouwOverzicht({ kaarten: [{ id: 'k1', created_at: NU.toISOString(), ...rij }], pogingen: [], nuMs: NU.getTime() });
  const k = [].concat(...Object.values(ov.tabs)).find((x) => x.id === 'k1');
  assert.equal(k.herkomst, 'checkin');
  assert.equal(k.traject, '1-op-1 Mentorship');
  assert.equal(k.mentor, 'Seppe Huysmans');
  assert.equal(k.lms_student_id, 's1');
  assert.equal(k.onboarding_id, null);
  const view = lees('modules/klanten-v2/views/automation-v2.js');
  assert.match(view, /k\.herkomst === 'checkin'/);
  assert.match(view, /lms\.deforexopleiding\.nl\/dossier\//);
});
