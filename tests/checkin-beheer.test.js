// tests/checkin-beheer.test.js — de CRM-sectie "Studentencheck-in" en de Run-knop.
//
// Bedoeld gedrag (opdracht 27 okt 2026, deel E):
//   · doelgroep = auth + einddatum ≥ vandaag + mentorship/membership; uit:
//     lopende of recente CRM-onboarding (via koppeling én via e-mail), testaccounts;
//   · Run: enkel met "ACTIVEER", enkel met checkin.run, de server rekent de
//     doelgroep zelf (een lijst uit de browser telt niet), tweede Run = niets;
//   · Run blijft grijs zonder geslaagde testinzending;
//   · KPI's en NPS-score zonder testtoewijzingen; per mentor; payouts; CSV.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  doelgroep, doelgroepSamenvatting, rijenVan, kpi, perMentor, payouts, csv, runStand, schoneOpties, testaccounts, npsBand,
} from '../api/_lib/checkin-beheer.js';
import { maakHandler, BEVESTIGING } from '../api/checkin-beheer.js';

const NU = new Date('2026-10-27T10:00:00Z');
const st = (over) => ({ id: over.id, auth_id: 'a-' + over.id, email: over.id + '@x.be', voornaam: over.id, achternaam: 'X', product_soort: 'mentorship', eind_datum: '2027-01-01', mentor_id: 'm1', crm_onboarding_id: null, ...over });

test('doelgroep: de basisregel', () => {
  const studenten = [
    st({ id: 's1' }),
    st({ id: 's2', product_soort: 'membership' }),
    st({ id: 's3', auth_id: null }),                          // geen login
    st({ id: 's4', eind_datum: '2026-10-26' }),               // verlopen
    st({ id: 's5', eind_datum: '2026-10-27' }),               // vandaag = nog actief
    st({ id: 's6', product_soort: 'trial' }),                 // ander product
  ];
  const { ontvangers, uitgesloten } = doelgroep({ studenten, onboardings: [], testEmails: [], nu: NU });
  assert.deepEqual(ontvangers.map((s) => s.id), ['s1', 's2', 's5']);
  assert.equal(uitgesloten.length, 0);
});

test('doelgroep: lopende of recente onboarding (koppeling of e-mail) en testaccounts vallen eruit', () => {
  const studenten = [
    st({ id: 'loopt', crm_onboarding_id: 'o1' }),
    st({ id: 'recent', email: 'recent@x.be' }),
    st({ id: 'oud', crm_onboarding_id: 'o3' }),
    st({ id: 'test', email: 'Maxim.Delombaerde96@gmail.com' }),
    st({ id: 'testonb', crm_onboarding_id: 'o4' }),
    st({ id: 'archief', crm_onboarding_id: 'o5' }),
  ];
  const onboardings = [
    { id: 'o1', status: 'bezig', started_at: '2026-06-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z' },
    { id: 'o2', status: 'afgerond', started_at: '2026-10-20T00:00:00Z', created_at: '2026-10-19T00:00:00Z', email: 'RECENT@x.be' },
    { id: 'o3', status: 'afgerond', started_at: '2026-08-01T00:00:00Z', created_at: '2026-08-01T00:00:00Z' },
    { id: 'o4', status: 'aangemeld', is_test: true, created_at: '2026-10-26T00:00:00Z' }, // testonboarding telt niet
    { id: 'o5', status: 'gearchiveerd', created_at: '2026-07-01T00:00:00Z' },
  ];
  const { ontvangers, uitgesloten } = doelgroep({ studenten, onboardings, testEmails: testaccounts(''), nu: NU });
  assert.deepEqual(ontvangers.map((s) => s.id).sort(), ['archief', 'oud', 'testonb']);
  assert.deepEqual(Object.fromEntries(uitgesloten.map((u) => [u.student.id, u.reden])), {
    loopt: 'onboarding_loopt', recent: 'onboarding_recent', test: 'testaccount',
  });
  const sam = doelgroepSamenvatting({ ontvangers, uitgesloten }, new Map([['m1', 'Seppe']]));
  assert.equal(sam.totaal, 3);
  assert.deepEqual(sam.per_product, { mentorship: 3, membership: 0 });
  assert.deepEqual(sam.per_mentor, [{ naam: 'Seppe', aantal: 3 }]);
  assert.equal(sam.uitgesloten.length, 3);
  assert.ok(sam.uitgesloten.every((u) => u.reden_label));
});

test('testaccounts: standaard Maxims twee logins; env vervangt', () => {
  assert.deepEqual(testaccounts(''), ['maxim@deforexopleiding.nl', 'maxim.delombaerde96@gmail.com']);
  assert.deepEqual(testaccounts(' A@b.be , geen-mail '), ['a@b.be']);
});

function tw(over) {
  return {
    id: over.id, student_id: 's-' + over.id, code: 'K7QM4RPD', is_test: false, status: 'verstuurd',
    antwoorden: {}, popup_gezien_op: '2026-10-27T08:00:00Z', gestart_op: '2026-10-27T08:01:00Z', verstuurd_op: '2026-10-27T08:05:00Z',
    student: { id: 's-' + over.id, voornaam: over.id, achternaam: 'X', email: over.id + '@x.be', product_soort: 'mentorship', mentor_id: over.mentor || 'm1' },
    ...over,
  };
}

test('rijen + KPI: NPS-score = promotors − criticasters, zonder testtoewijzingen', () => {
  const toewijzingen = [
    tw({ id: 'a', antwoorden: { nps: 10, mentor_score: 5, payout: 'ja_eerste', payout_delen: 'ja', robot_interesse: 'ja_interesse', fase: 'funded' } }),
    tw({ id: 'b', antwoorden: { nps: 9, mentor_score: 4 } }),
    tw({ id: 'c', antwoorden: { nps: 3, mentor_score: 1, begeleiding_contact: 'ja' }, signaal_id: 'sig1', mentor: 'm2' }),
    tw({ id: 'd', status: 'bezig', verstuurd_op: null, antwoorden: { nps: 0 } }),
    tw({ id: 'e', status: 'niet_gestart', verstuurd_op: null, gestart_op: null, popup_gezien_op: null }),
    tw({ id: 't', is_test: true, antwoorden: { nps: 0 } }),
  ];
  const rijen = rijenVan({
    toewijzingen,
    mentorNamen: new Map([['m1', 'Seppe'], ['m2', 'Lien']]),
    signalen: new Map([['sig1', { id: 'sig1', status: 'nieuw', zwaarte: 'rood' }]]),
    kaarten: new Map([['a', { id: 'taak-1', status: 'open' }]]),
  });
  const k = kpi(rijen);
  assert.equal(k.toegewezen, 5);
  assert.equal(k.popup_gezien, 4);
  assert.equal(k.gestart, 4);
  assert.equal(k.verstuurd, 3);
  assert.equal(k.verstuurd_pct, 60);
  assert.equal(k.nps_aantal, 3);
  assert.equal(k.nps_score, 33); // (2 promotors − 1 criticaster) / 3
  assert.equal(k.nps_gemiddeld, 7.3);
  assert.equal(k.begeleidingssignalen, 1);
  assert.equal(k.automation_interesse, 1);
  const a = rijen.find((r) => r.id === 'a');
  assert.equal(a.kaart.id, 'taak-1');
  assert.equal(a.fase_label, 'Funded of eigen kapitaal');
  assert.ok(a.antwoorden.some((x) => x.vraag === 'Aanbevelen (0-10)' && x.antwoord === '10 / 10'));
  const c = rijen.find((r) => r.id === 'c');
  assert.equal(c.signaal.zwaarte, 'rood');
  assert.equal(c.mentor, 'Lien');
  assert.equal(npsBand(7), 'passief');

  const pm = perMentor(rijen);
  assert.deepEqual(pm.find((m) => m.mentor === 'Seppe'), { mentor_id: 'm1', mentor: 'Seppe', toegewezen: 4, verstuurd: 2, nps_gemiddeld: 9.5, mentor_score_gemiddeld: 4.5, antwoorden_nps: 2 });
  assert.deepEqual(pm.find((m) => m.mentor === 'Lien').mentor_score_gemiddeld, 1);

  assert.deepEqual(payouts(rijen).map((p) => p.id), ['a']);
});

test('CSV: kop + één regel per rij, puntkomma, formules geneutraliseerd', () => {
  const rijen = rijenVan({ toewijzingen: [tw({ id: 'a', antwoorden: { nps: 8, verbeter: '=HYPERLINK("x")', knelpunt: ['tijd', 'risico'] } })] });
  const tekst = csv(rijen);
  const regels = tekst.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(regels.length, 2);
  assert.match(regels[0], /^Naam;E-mail;Product;Mentor;Status;Verstuurd op;/);
  assert.match(regels[1], /'=HYPERLINK/);
  assert.match(regels[1], /Risicobeheer \| Tijd & planning|Tijd & planning \| Risicobeheer/);
});

test('Run blijft grijs zonder geslaagde testinzending', () => {
  assert.equal(runStand({ status: 'concept' }, []).mag, false);
  assert.equal(runStand({ status: 'test' }, [{ is_test: true, verstuurd_op: null }]).mag, false);
  assert.equal(runStand({ status: 'test' }, [{ is_test: false, verstuurd_op: '2026-10-27' }]).mag, false);
  assert.equal(runStand({ status: 'test' }, [{ is_test: true, verstuurd_op: '2026-10-27' }]).mag, true);
  assert.equal(runStand({ status: 'live' }, [{ is_test: true, verstuurd_op: '2026-10-27' }]).mag, false);
});

test('opties: alleen de drie booleans', () => {
  assert.deepEqual(schoneOpties({ trustpilot_vraag: true, autopilot_stap: 'ja', hack: 1 }), { trustpilot_vraag: true });
});

// ── Het endpoint (nep-LMS + nep-CRM) ───────────────────────────────────────

function nepLms({ status = 'test', testVerstuurd = true } = {}) {
  const campagne = { id: 'c1', slug: 'checkin-2026-11', naam: 'Check-in', status, inhoud_versie: 1, opties: {}, aangemaakt_op: '2026-10-27' };
  const studenten = [
    { id: 's1', auth_id: 'a1', email: 's1@x.be', voornaam: 'Anna', achternaam: 'A', product_soort: 'mentorship', eind_datum: '2027-01-01', mentor_id: 'm1', crm_onboarding_id: null },
    { id: 's2', auth_id: 'a2', email: 's2@x.be', voornaam: 'Bert', achternaam: 'B', product_soort: 'membership', eind_datum: '2027-01-01', mentor_id: null, crm_onboarding_id: 'o1' },
    { id: 'sm', auth_id: 'am', email: 'maxim.delombaerde96@gmail.com', voornaam: 'Maxim', achternaam: 'D', product_soort: 'membership', eind_datum: '2027-09-01', mentor_id: null, crm_onboarding_id: null },
  ];
  const toewijzingen = [];
  if (status !== 'concept') toewijzingen.push({ id: 'tt', campagne_id: 'c1', student_id: 'sm', code: 'TESTCODE', is_test: true, status: testVerstuurd ? 'verstuurd' : 'bezig', antwoorden: {}, verstuurd_op: testVerstuurd ? '2026-10-27T09:00:00Z' : null, student: studenten[2] });
  const log = { rpc: [] };
  const db = {
    log, campagne, toewijzingen,
    from(t) {
      const filters = [];
      let op = 'select'; let waarden = null;
      const q = {
        select() { return q; }, order() { return q; }, range() { return q; }, limit() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        neq(k, v) { filters.push((r) => r[k] !== v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        not(k, o, v) { filters.push((r) => r[k] !== v); return q; },
        gte(k, v) { filters.push((r) => String(r[k]) >= v); return q; },
        update(v) { op = 'update'; waarden = v; return q; },
        then(ok, nok) {
          const bron = t === 'hlms_checkin_campagne' ? [campagne] : t === 'hlms_checkin_toewijzing' ? toewijzingen
            : t === 'hlms_student' ? studenten : t === 'hlms_personeel' ? [{ id: 'm1', naam: 'Seppe' }] : [];
          const hits = bron.filter((r) => filters.every((f) => f(r)));
          if (op === 'update') for (const r of hits) Object.assign(r, waarden);
          return Promise.resolve({ data: hits.map((r) => ({ ...r })), error: null }).then(ok, nok);
        },
      };
      return q;
    },
    async rpc(naam, args) {
      log.rpc.push({ naam, args });
      if (naam === 'hlms_checkin_run') {
        if (campagne.status === 'live') return { data: { al_live: true, aangemaakt: 0 }, error: null };
        if (!toewijzingen.some((x) => x.is_test && x.verstuurd_op)) return { data: null, error: { message: 'er is nog geen geslaagde testinzending', hint: 'checkin_geen_testinzending' } };
        for (const id of args.p_studenten) toewijzingen.push({ id: 'tw-' + id, campagne_id: 'c1', student_id: id, code: 'CODE' + id, is_test: false, status: 'niet_gestart', antwoorden: {}, student: studenten.find((s) => s.id === id) });
        campagne.status = 'live';
        return { data: { al_live: false, aangemaakt: args.p_studenten.length }, error: null };
      }
      if (naam === 'hlms_checkin_test_toewijzen') { campagne.status = 'test'; return { data: { aangemaakt: args.p_studenten.length }, error: null }; }
      return { data: null, error: { message: 'onbekend' } };
    },
  };
  return db;
}

function nepCrm() {
  const onboardings = [{ id: 'o1', status: 'bezig', started_at: '2026-10-20T00:00:00Z', created_at: '2026-10-20T00:00:00Z', is_test: false, customer: { email: 's2@x.be' } }];
  return {
    from(t) {
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; }, not() { return q; }, limit() { return q; }, range() { return q; },
        then(ok, nok) { return Promise.resolve({ data: t === 'onboardings' ? onboardings : [], error: null }).then(ok, nok); },
      };
      return q;
    },
  };
}

function nepRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

function api(lms, { rechten = ['checkin.view', 'checkin.run'], user = { id: 'u1', email: 'maxim@deforexopleiding.nl' } } = {}) {
  const h = maakHandler({ lms: () => lms, crm: nepCrm(), ingelogd: async () => user, mag: async (_req, r) => rechten.includes(r), nu: () => NU });
  return async (method, body = null, query = {}) => { const res = nepRes(); await h({ method, body, query, headers: {} }, res); return res; };
}

test('GET: overzicht met campagne, Run-stand en de testcode', async () => {
  const r = await api(nepLms())('GET');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.campagne.status, 'test');
  assert.equal(r.body.run.mag, true);
  assert.equal(r.body.test[0].link, 'https://www.deforexopleiding.nl/checkin?code=TEST-CODE');
  assert.equal(r.body.kpi.toegewezen, 0); // test telt niet
  assert.equal(r.body.rechten.run, true);
});

test('rechten: zonder checkin.view niets; met enkel view geen Run', async () => {
  assert.equal((await api(nepLms(), { rechten: [] })('GET')).statusCode, 403);
  const lms = nepLms();
  const r = await api(lms, { rechten: ['checkin.view'] })('POST', { actie: 'run', campagne_id: 'c1', bevestiging: BEVESTIGING });
  assert.equal(r.statusCode, 403);
  assert.equal(lms.log.rpc.length, 0);
  assert.equal((await api(lms, { user: null })('GET')).statusCode, 401);
});

test('Run: zonder ACTIVEER niets; met ACTIEVER (tikfout) niets', async () => {
  const lms = nepLms();
  for (const bevestiging of [undefined, 'activeer', 'ACTIEVER']) {
    const r = await api(lms)('POST', { actie: 'run', campagne_id: 'c1', bevestiging });
    assert.equal(r.statusCode, 400);
  }
  assert.equal(lms.log.rpc.length, 0);
  assert.equal(lms.campagne.status, 'test');
});

test('Run: server rekent de doelgroep zelf (lijst uit de browser telt niet), tweede Run = niets', async () => {
  const lms = nepLms();
  const r = await api(lms)('POST', { actie: 'run', campagne_id: 'c1', bevestiging: BEVESTIGING, studenten: ['s1', 's2', 'sm', 'hacker'] });
  assert.equal(r.statusCode, 200);
  const args = lms.log.rpc[0].args;
  // s2 heeft een lopende onboarding, sm is het testaccount.
  assert.deepEqual(args.p_studenten, ['s1']);
  assert.equal(args.p_door, 'maxim@deforexopleiding.nl');
  assert.equal(args.p_regel.ontvangers, 1);
  assert.equal(lms.campagne.status, 'live');
  const tweede = await api(lms)('POST', { actie: 'run', campagne_id: 'c1', bevestiging: BEVESTIGING });
  assert.equal(tweede.body.al_live, true);
  assert.equal(lms.log.rpc.length, 1);
  assert.equal(lms.toewijzingen.filter((x) => x.student_id === 's1').length, 1);
});

test('Run zonder geslaagde testinzending → 409 van de databank', async () => {
  const lms = nepLms({ testVerstuurd: false });
  const r = await api(lms)('POST', { actie: 'run', campagne_id: 'c1', bevestiging: BEVESTIGING });
  assert.equal(r.statusCode, 409);
  assert.equal(lms.campagne.status, 'test');
});

test('doelgroep-voorbeeld: aantallen, uitgesloten met reden en de exacte LMS-teksten', async () => {
  const r = await api(nepLms())('POST', { actie: 'doelgroep', campagne_id: 'c1' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.samenvatting.totaal, 1);
  assert.deepEqual(r.body.samenvatting.uitgesloten.map((u) => u.reden).sort(), ['onboarding_loopt', 'testaccount']);
  assert.match(r.body.lms_tekst.popup.tekst, /Drie minuten/);
  assert.equal(r.body.bevestiging, 'ACTIVEER');
});

test('pauzeren en hervatten: enkel vanuit de juiste stand', async () => {
  const lms = nepLms({ status: 'live' });
  assert.equal((await api(lms)('POST', { actie: 'hervat', campagne_id: 'c1' })).statusCode, 409);
  assert.equal((await api(lms)('POST', { actie: 'pauzeer', campagne_id: 'c1' })).statusCode, 200);
  assert.equal(lms.campagne.status, 'gepauzeerd');
  assert.equal((await api(lms)('POST', { actie: 'hervat', campagne_id: 'c1' })).statusCode, 200);
  assert.equal(lms.campagne.status, 'live');
});

test('opties na Run = nieuwe inhoudsversie (wie begon houdt de zijne)', async () => {
  const lms = nepLms({ status: 'live' });
  const r = await api(lms)('POST', { actie: 'opties', campagne_id: 'c1', opties: { trustpilot_vraag: true } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.inhoud_versie, 2);
  assert.equal(lms.campagne.opties.trustpilot_vraag, true);
});

test('testtoewijzingen: enkel de testaccounts', async () => {
  const lms = nepLms({ status: 'concept' });
  const r = await api(lms)('POST', { actie: 'test', campagne_id: 'c1' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(lms.log.rpc[0].args.p_studenten, ['sm']);
  assert.deepEqual(r.body.zonder_studentrij, ['maxim@deforexopleiding.nl']);
});

test('CSV-export', async () => {
  const r = await api(nepLms())('GET', null, { csv: '1' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.match(r.body, /Naam;E-mail/);
});
