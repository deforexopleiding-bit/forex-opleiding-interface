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
  optiesVan, maandVan, persoonKort, isZichtbaar, LABELS, CHECKIN_SLEUTELS, VRAAG,
} from '../api/_lib/checkin-portal.js';
import { antwoordenLeesbaar, csv } from '../api/_lib/checkin-beheer.js';
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
  const basis = ['fase', 'doel_3m', 'trade_stand', 'trades_vorige_maand', 'journal_gebruik', 'zekerheid', 'grootste_knelpunt',
    'gebruik', 'gebruik_waarom_niet', 'live_moment', 'nps', 'knelpunt', 'hulp', 'vooruithelpen', 'feedbackpanel', 'begeleiding_contact'];
  assert.deepEqual(verplicht('1op1'), [...basis, 'mentor_score', 'sessie_ritme', 'feedback_concreet', 'robot_interesse']);
  assert.deepEqual(verplicht('membership'), [...basis, 'robot_interesse']);
  assert.deepEqual(verplicht('membership', { autopilot_stap: false }), basis);
  const gebruik = { live_sessies: 'vaak', sunday_markups: 'soms', opgenomen_trainingen: 'vaak', trade_recaps: 'vaak', lessen_pdfs: 'vaak', discord: 'soms', journal_lms: 'vaak', the_lab: 'soms' };
  const vol = { fase: 'demo', doel_3m: 'routine', nps: 0, knelpunt: ['tijd'], hulp: 'niets', begeleiding_contact: 'nee', robot_interesse: 'nee', ...NIEUW_GEMEEN, gebruik };
  assert.deepEqual(ontbrekend('membership', {}, vol), []);
  //  1-op-1: de mentorvragen én het onderdeel 1-op-1 in het gebruik-raster.
  assert.deepEqual(ontbrekend('1op1', {}, vol), ['gebruik', 'mentor_score', 'sessie_ritme', 'feedback_concreet']);
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
  assert.equal(CHECKIN_SLEUTELS.length, 29); // + robot_contact_tel/-email (Autopilot v3, 28 okt) + 13 (uitbreiding 29 okt)
  for (const k of ['trade_stand', 'trades_vorige_maand', 'journal_gebruik', 'zekerheid', 'grootste_knelpunt', 'gebruik', 'gebruik_niveau',
    'gebruik_waarom_niet', 'live_moment', 'sessie_ritme', 'feedback_concreet', 'vooruithelpen', 'feedbackpanel']) assert.ok(LABELS[k], k);
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

const NIEUW_GEMEEN = {
  trade_stand: 'demo', trades_vorige_maand: '1_5', journal_gebruik: 'soms',
  zekerheid: { h4_impuls: 4, fib_71: 3, bevestiging_15m: 4, risk: 5, discipline: 3 }, grootste_knelpunt: 'tijd',
  live_moment: 'weekavond', vooruithelpen: ['feedback_eigen_trades'], feedbackpanel: 'ja',
};
const VOL_1OP1 = {
  fase: 'demo', doel_3m: 'routine', uren_per_week: 5, nps: 9, helpt: ['mentor'], knelpunt: ['tijd'],
  hulp: 'feedback', mentor_score: 5, begeleiding_contact: 'nee', robot_interesse: 'nee',
  ...NIEUW_GEMEEN,
  gebruik: { live_sessies: 'vaak', sunday_markups: 'soms', opgenomen_trainingen: 'vaak', trade_recaps: 'vaak', lessen_pdfs: 'vaak', discord: 'soms', journal_lms: 'vaak', the_lab: 'soms', een_op_een: 'vaak' },
  sessie_ritme: 'goed', feedback_concreet: 'ja',
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
  assert.deepEqual(r.body.missing, ['doel_3m', 'trade_stand', 'trades_vorige_maand', 'journal_gebruik', 'zekerheid', 'grootste_knelpunt',
    'gebruik', 'live_moment', 'nps', 'knelpunt', 'hulp', 'vooruithelpen', 'feedbackpanel', 'begeleiding_contact',
    'mentor_score', 'sessie_ritme', 'feedback_concreet', 'robot_interesse']);
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

// ═══ Autopilot v3: ander nummer of e-mail (28 okt 2026) ═══════════════════

test('Autopilot v3: robot_contact_tel/-email in de whitelist, alleen met de Autopilot-stap', () => {
  const p = valideerPatch({ robot_contact_tel: '0470 12 34 56', robot_contact_email: 'lotte@example.com' });
  assert.equal(p.ok, true);
  assert.deepEqual(p.schoon, { robot_contact_tel: '0470 12 34 56', robot_contact_email: 'lotte@example.com' });
  assert.deepEqual(valideerPatch({ robot_contact_tel: '0470abc', robot_contact_email: 'geen' }).fouten, ['robot_contact_tel', 'robot_contact_email']);
  const uit = { payout_vraag: true, trustpilot_vraag: false, autopilot_stap: false };
  assert.deepEqual(valideerPatch({ robot_contact_tel: '0470' }, { opties: uit }).fouten, ['robot_contact_tel']);
  // Niet verplicht.
  assert.equal(verplicht('membership').includes('robot_contact_tel'), false);
  // Alleen bij ja; leeg = niet opgegeven.
  assert.deepEqual(schoneAntwoorden({ robot_interesse: 'nee', robot_contact_tel: '0470', robot_contact_email: 'a@b.be' }), { robot_interesse: 'nee' });
  assert.deepEqual(schoneAntwoorden({ robot_interesse: 'ja_interesse', robot_contact_tel: '', robot_contact_email: 'a@b.be' }), { robot_interesse: 'ja_interesse', robot_contact_email: 'a@b.be' });
  // Leesbaar in het CRM-detail en de CSV.
  const rijen = antwoordenLeesbaar({ robot_interesse: 'ja_interesse', robot_contact_tel: '0470' });
  assert.ok(rijen.some((r) => r.sleutel === 'robot_contact_tel' && r.vraag === VRAAG.robot_contact_tel && r.antwoord === '0470'));
  assert.match(csv([]), /Ander nummer \(Autopilot\)/);
});

test('Autopilot v3: een save met alleen een ander nummer werkt de kaart bij', async () => {
  const lms = nepLms();
  const kaarten = [];
  const api = maak(lms, { kaarten });
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 4, antwoorden: { robot_interesse: 'ja_interesse' } });
  await api({ action: 'save', sessie: lms.t.sessie, huidige_stap: 4, antwoorden: { robot_contact_tel: '0499 11 22 33' } });
  assert.equal(kaarten.length, 2);
  assert.equal(kaarten[1].answers.robot_contact_tel, '0499 11 22 33');
});

test('Autopilot v3: Daves kaart belt het opgegeven nummer; leeg → terug naar het bekende', async () => {
  const db = nepCrm();
  await syncCheckinAutomationKaart(db, { toewijzing: TW, student: ST, answers: { robot_interesse: 'ja_interesse', robot_contact_tel: '0499 11 22 33', robot_contact_email: 'ander@example.com' }, nu: NU });
  const k = db.taken[0];
  assert.equal(k.telefoon, '+32499112233');
  assert.equal(k.bron_ref.contact_tel, '0499 11 22 33');
  assert.equal(k.bron_ref.contact_email, 'ander@example.com');
  assert.equal(k.bron_ref.telefoon_bekend, '0470 00 00 00');
  assert.match(k.notitie, /BEL OP HET OPGEGEVEN NUMMER: 0499 11 22 33/);
  assert.match(k.notitie, /ander@example\.com/);
  await syncCheckinAutomationKaart(db, { toewijzing: TW, student: ST, answers: { robot_interesse: 'ja_interesse' }, nu: NU });
  assert.equal(db.taken.length, 1);
  assert.equal(k.telefoon, '+32470000000');
  assert.equal(k.bron_ref.contact_tel, null);
  assert.doesNotMatch(k.notitie, /OPGEGEVEN/);
});

// ── Uitbreiding 29 okt 2026 (Maxim keurde goed) ────────────────────────────
import {
  gebruikOnderdelen, zwakkeStappen, ZEKERHEID_STAPPEN, MAX_EEN_DING,
} from '../api/_lib/checkin-portal.js';
import { csv as beheerCsv, CSV_VRAGEN, csvKop } from '../api/_lib/checkin-beheer.js';

test('UITBREIDING: whitelist voor de nieuwe sleutels — waarden, objecten, 1-op-1-only, max 2, max 500 tekens', () => {
  const ok = (patch, flow = '1op1') => valideerPatch(patch, { flow }).ok;
  assert.ok(ok({ trade_stand: 'funded', trades_vorige_maand: '15_plus', journal_gebruik: 'nooit', live_moment: 'zondagochtend', feedbackpanel: 'nee' }));
  assert.ok(!ok({ trade_stand: 'live' }));
  assert.ok(!ok({ trades_vorige_maand: 0 }), 'een getal is geen keuze');
  //  Zekerheid: 1..5, deelobject mag tijdens het invullen.
  assert.ok(ok({ zekerheid: { h4_impuls: 1, risk: 5 } }));
  assert.ok(!ok({ zekerheid: { h4_impuls: 0 } }));
  assert.ok(!ok({ zekerheid: { h4_impuls: 3, onbekend: 3 } }));
  assert.ok(!ok({ zekerheid: [3, 3] }));
  //  Gebruik: 1-op-1 enkel in de mentorship-flow.
  assert.ok(ok({ gebruik: { een_op_een: 'vaak' } }));
  assert.ok(!ok({ gebruik: { een_op_een: 'vaak' } }, 'membership'));
  assert.ok(!ok({ gebruik: { discord: 'altijd' } }));
  assert.ok(ok({ gebruik_waarom_niet: { discord: 'wist_niet' } }));
  assert.ok(!ok({ gebruik_waarom_niet: { discord: 'saai' } }));
  //  Sessieritme en concrete feedback alleen 1-op-1.
  assert.ok(ok({ sessie_ritme: 'te_weinig', feedback_concreet: 'soms' }));
  assert.ok(!ok({ sessie_ritme: 'goed' }, 'membership'));
  assert.ok(!ok({ feedback_concreet: 'soms' }, 'membership'));
  //  Vooruithelpen: max 2, vaste volgorde.
  assert.deepEqual(valideerPatch({ vooruithelpen: ['studiebuddy', 'live_meetraden'] }, { flow: '1op1' }).schoon.vooruithelpen, ['live_meetraden', 'studiebuddy']);
  assert.ok(!ok({ vooruithelpen: ['studiebuddy', 'live_meetraden', 'kortere_videos'] }));
  assert.ok(ok({ een_ding_veranderen: 'x'.repeat(MAX_EEN_DING) }));
  assert.ok(!ok({ een_ding_veranderen: 'x'.repeat(MAX_EEN_DING + 1) }));
  assert.equal(gebruikOnderdelen('membership').includes('een_op_een'), false);
});

test('UITBREIDING: "waarom niet" enkel voor onderdelen op nooit, en dan per onderdeel verplicht', () => {
  const g = Object.fromEntries(gebruikOnderdelen('membership').map((o) => [o, 'vaak']));
  const a = { gebruik: { ...g, discord: 'nooit', the_lab: 'nooit' }, gebruik_waarom_niet: { discord: 'tijdstip_past_niet', live_sessies: 'wist_niet' } };
  assert.deepEqual(schoneAntwoorden(a, { flow: 'membership' }).gebruik_waarom_niet, { discord: 'tijdstip_past_niet' });
  assert.ok(ontbrekend('membership', {}, a).includes('gebruik_waarom_niet'), 'the_lab staat op nooit zonder reden');
  const b = { ...a, gebruik_waarom_niet: { discord: 'tijdstip_past_niet', the_lab: 'niet_nuttig' } };
  assert.ok(!ontbrekend('membership', {}, b).includes('gebruik_waarom_niet'));
  //  Niets op nooit: niets te vragen.
  assert.ok(!ontbrekend('membership', {}, { gebruik: g }).includes('gebruik_waarom_niet'));
  //  Zekerheid moet volledig zijn.
  assert.ok(ontbrekend('membership', {}, { zekerheid: { h4_impuls: 3 } }).includes('zekerheid'));
  assert.ok(!ontbrekend('membership', {}, { zekerheid: Object.fromEntries(ZEKERHEID_STAPPEN.map((s) => [s, 3])) }).includes('zekerheid'));
});

test('UITBREIDING: extra redenen op dezelfde kaart — weet niet waar te beginnen, ≤ 2 op ≥ 3 stappen, ritme en feedback', () => {
  assert.equal(signaalVoor({ nps: 9, grootste_knelpunt: 'strategie' }), null);
  assert.deepEqual(signaalVoor({ nps: 9, grootste_knelpunt: 'weet_niet_waar_beginnen' }), { zwaarte: 'geel', redenen: ['Weet niet waar te beginnen'] });
  //  ≤ 2 op twee stappen: nog geen signaal; op drie wel.
  assert.equal(signaalVoor({ nps: 9, zekerheid: { h4_impuls: 2, fib_71: 1, risk: 5 } }), null);
  const s = signaalVoor({ nps: 9, zekerheid: { h4_impuls: 2, fib_71: 1, bevestiging_15m: 2, risk: 5, discipline: 3 } });
  assert.equal(s.zwaarte, 'geel');
  assert.match(s.redenen[0], /≤ 2 op 3 stappen/);
  assert.deepEqual(zwakkeStappen({ h4_impuls: 2, fib_71: 1, bevestiging_15m: 2, risk: 5 }), ['h4_impuls', 'fib_71', 'bevestiging_15m']);
  assert.equal(signaalVoor({ nps: 9, sessie_ritme: 'te_weinig' }).zwaarte, 'oranje');
  assert.equal(signaalVoor({ nps: 9, feedback_concreet: 'nee' }).zwaarte, 'oranje');
  //  Eén kaart met alle redenen.
  assert.equal(signaalVoor({ nps: 2, grootste_knelpunt: 'weet_niet_waar_beginnen', feedback_concreet: 'nee' }).redenen.length, 3);
  const b = signaalBewijs({ antwoorden: { nps: 9, grootste_knelpunt: 'weet_niet_waar_beginnen', een_ding_veranderen: 'Meer live' }, redenen: ['x'] });
  assert.equal(b['Grootste knelpunt'], 'Ik weet niet waar te beginnen');
  assert.equal(b['Eén ding veranderen'], 'Meer live');
});

test('UITBREIDING: de CSV heeft elke sleutel als kolom, de objecten per deel; oude inzendingen blijven leesbaar', () => {
  assert.ok(CSV_VRAGEN.includes('zekerheid.fib_71') && CSV_VRAGEN.includes('gebruik.discord') && CSV_VRAGEN.includes('gebruik_waarom_niet.discord'));
  assert.equal(csvKop('zekerheid.fib_71'), 'Zekerheid per stap (1-5) – Fibonacci & de 71%-zone');
  const nieuw = { naam: 'A', ruw: { ...VOL_1OP1, gebruik: { ...VOL_1OP1.gebruik, discord: 'nooit' }, gebruik_waarom_niet: { discord: 'wist_niet' } } };
  const oud = { naam: 'B', ruw: { fase: 'demo', nps: 8 } };
  const regels = beheerCsv([nieuw, oud]).trim().split('\r\n');
  const kop = regels[0].split(';');
  const kol = (r, naam) => regels[r].split(';')[kop.indexOf(naam)];
  assert.equal(kol(1, csvKop('zekerheid.risk')), '5');
  assert.equal(kol(1, csvKop('gebruik.discord')), 'Nooit');
  assert.equal(kol(1, csvKop('gebruik_waarom_niet.discord')), 'Wist niet dat het bestond');
  assert.equal(kol(2, csvKop('zekerheid.risk')), '');
  assert.equal(kol(2, 'Aanbevelen (0-10)'), '8');
});
