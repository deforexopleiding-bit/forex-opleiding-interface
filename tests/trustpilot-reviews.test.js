// tests/trustpilot-reviews.test.js — CRM-module "Trustpilot-reviews" (16 nov 2026).
//
// Bedoeld gedrag:
//   · doelgroep = login + eind_datum ≥ vandaag + mentorship/membership, geen
//     personeel, geen testaccount (zelfde regel als het LMS);
//   · wie een statusrij heeft staat er altijd in (ook na verlopen toegang);
//   · testaccounts tellen NERGENS mee; te verloten = floor(geplaatst / 10);
//   · "Kopieer namen" = enkel geplaatst, "Volledige naam (Trustpilot-naam)";
//   · CSV van alles; reset ENKEL voor een testrij (is_test in de WHERE).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { bouwRijen, tegels, lotingNamen, csv, personeelAuthIds, vandaagBrussel } from '../api/_lib/trustpilot-overzicht.js';
import { maakHandler, RECHT_RESET } from '../api/trustpilot-reviews.js';

const VANDAAG = '2026-11-16';
const s = (id, over = {}) => ({ id, auth_id: 'a-' + id, email: id + '@x.be', voornaam: id.toUpperCase(), achternaam: 'Test', product_soort: 'membership', eind_datum: '2027-01-01', mentor_id: null, ...over });

test('vandaag in Brussel en personeel met geldige rol', () => {
  assert.equal(vandaagBrussel(new Date('2026-11-15T23:30:00Z')), '2026-11-16');
  const p = personeelAuthIds([
    { auth_id: 'a1', rol: 'mentor', geldig_tot: null },
    { auth_id: 'a2', rol: 'admin', geldig_tot: '2026-01-01T00:00:00Z' },
    { auth_id: 'a3', rol: 'student', geldig_tot: null },
  ], new Date('2026-11-16T10:00:00Z'));
  assert.deepEqual([...p], ['a1']);
});

test('rijen: doelgroep, eigen rijen, personeel en test eruit', () => {
  const studenten = [
    s('anna'),
    s('bert', { product_soort: 'mentorship', mentor_id: 'm1' }),
    s('oud', { eind_datum: '2026-10-01' }),                    // verlopen, geen rij → weg
    s('oudgeplaatst', { eind_datum: '2026-10-01' }),           // verlopen MET rij → blijft
    s('mo', { auth_id: 'a-staff' }),                           // personeel → niet in doelgroep
    s('maxim', { email: 'Maxim.Delombaerde96@gmail.com' }),     // testaccount
    s('trial', { product_soort: 'trial' }),
  ];
  const statussen = [
    { student_id: 'oudgeplaatst', status: 'geplaatst', trustpilot_naam: 'O. G.', bevestigd_op: '2026-11-20T10:00:00Z', keer_getoond: 1 },
    { student_id: 'bert', status: 'later', keer_getoond: 2, keer_later: 1, laatst_later_op: '2026-11-17T10:00:00Z' },
    { student_id: 'maxim', status: 'geplaatst', trustpilot_naam: 'Max', bevestigd_op: '2026-11-21T10:00:00Z', is_test: true },
  ];
  const rijen = bouwRijen({
    studenten, statussen, mentorNamen: new Map([['m1', 'Seppe']]),
    testEmails: ['maxim.delombaerde96@gmail.com'], personeel: new Set(['a-staff']), vandaag: VANDAAG,
  });
  const per = Object.fromEntries(rijen.map((r) => [r.student_id, r]));
  assert.deepEqual(Object.keys(per).sort(), ['anna', 'bert', 'maxim', 'oudgeplaatst']);
  assert.equal(per.bert.mentor, 'Seppe');
  assert.equal(per.bert.traject, '1-op-1');
  assert.equal(per.anna.status, 'nog_niet_gezien');
  assert.equal(per.oudgeplaatst.in_doelgroep, false);
  assert.equal(per.maxim.is_test, true);
  assert.equal(per.maxim.in_doelgroep, false);
  assert.equal(rijen[0].student_id, 'maxim', 'gesorteerd op bevestigd op');

  const t = tegels(rijen, 10);
  assert.deepEqual(
    { d: t.doelgroep, n: t.nog_niet_gezien, l: t.later, nm: t.niet_meer_tonen, g: t.geplaatst, v: t.te_verloten, r: t.nog_tot_volgende },
    { d: 2, n: 1, l: 1, nm: 0, g: 1, v: 0, r: 9 },
  );
  assert.deepEqual(lotingNamen(rijen), ['OUDGEPLAATST Test (O. G.)'], 'testaccount niet in de loting');
});

test('te verloten = floor(geplaatst / per_aantal)', () => {
  const rijen = Array.from({ length: 23 }, (_, i) => ({ status: 'geplaatst', is_test: false, in_doelgroep: true, naam: 'S' + i, trustpilot_naam: 'T' + i, bevestigd_op: '2026-11-2' + (i % 9) }));
  const t = tegels(rijen, 10);
  assert.equal(t.te_verloten, 2);
  assert.equal(t.nog_tot_volgende, 7);
  assert.equal(tegels(rijen.slice(0, 20), 10).nog_tot_volgende, 10);
  assert.equal(lotingNamen(rijen).length, 23);
});

test('CSV: kop, status-label, puntkomma, geen formules', () => {
  const uit = csv([{ naam: '=Hack', email: 'a@x.be', traject: 'Membership', mentor: null, status: 'geplaatst', trustpilot_naam: 'A; B', bevestigd_op: '2026-11-20', keer_getoond: 1, is_test: false, in_doelgroep: true }]);
  const regels = uit.replace(/^﻿/, '').trim().split(/\r\n/);
  assert.match(regels[0], /^Naam;E-mail;Traject;Mentor;Status;Trustpilot-naam;Bevestigd op/);
  assert.match(regels[1], /^'=Hack;a@x\.be;Membership;;Geplaatst;"A; B";2026-11-20/);
});

function nepRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}

function nepLms() {
  const campagne = { id: 'c1', slug: 'trustpilot-kerst-2026', naam: 'Kerst', status: 'concept', start_op: '2026-11-15T23:00:00Z', einde_op: '2026-12-25T22:59:59Z', opties: { per_aantal: 10, prijs: '25k funded account' }, test_emails: ['maxim.delombaerde96@gmail.com'] };
  const tabellen = {
    hlms_trustpilot_campagne: [campagne],
    hlms_trustpilot_status: [
      { id: 'r1', campagne_id: 'c1', student_id: 'anna', status: 'geplaatst', trustpilot_naam: 'Anna T', bevestigd_op: '2026-11-20T10:00:00Z', is_test: false },
      { id: 'r2', campagne_id: 'c1', student_id: 'maxim', status: 'later', is_test: true },
    ],
    hlms_student: [s('anna'), s('maxim', { email: 'maxim.delombaerde96@gmail.com' })],
    hlms_rol: [], hlms_personeel: [],
  };
  const log = { deletes: [] };
  return {
    log, tabellen,
    from(t) {
      const filters = []; let del = false;
      const q = {
        select() { return q; }, order() { return q; }, range() { return q; }, limit() { return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        not(k, o, v) { filters.push((r) => r[k] !== v); return q; },
        gte(k, v) { filters.push((r) => String(r[k]) >= v); return q; },
        delete() { del = true; return q; },
        then(ok, nok) {
          const bron = tabellen[t] || [];
          const hits = bron.filter((r) => filters.every((f) => f(r)));
          if (del) { log.deletes.push({ t, hits: hits.map((h) => h.id) }); tabellen[t] = bron.filter((r) => !hits.includes(r)); }
          return Promise.resolve({ data: hits.map((r) => ({ ...r })), error: null }).then(ok, nok);
        },
      };
      return q;
    },
  };
}

function api(lms, rechten = ['checkin.view', 'checkin.run']) {
  const h = maakHandler({ lms: () => lms, ingelogd: async () => ({ id: 'u', email: 'maxim@deforexopleiding.nl' }), mag: async (_r, recht) => rechten.includes(recht), nu: () => new Date('2026-11-16T10:00:00Z') });
  return async (method, body = null, query = {}) => { const res = nepRes(); await h({ method, body, query, headers: {} }, res); return res; };
}

test('endpoint: overzicht, CSV en rechten', async () => {
  const lms = nepLms();
  const r = await api(lms)('GET');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.campagne.status, 'concept');
  assert.equal(r.body.tegels.geplaatst, 1);
  assert.equal(r.body.tegels.doelgroep, 1);
  assert.deepEqual(r.body.loting, ['ANNA Test (Anna T)']);
  assert.equal(r.body.rechten.reset, true);
  const c = await api(lms)('GET', null, { csv: '1' });
  assert.match(c.headers['content-type'], /text\/csv/);
  assert.equal((await api(lms, [])('GET')).statusCode, 403);
});

test('reset: enkel een testrij, enkel met checkin.run', async () => {
  const lms = nepLms();
  assert.equal((await api(lms, ['checkin.view'])('POST', { actie: 'reset_test', student_id: '00000000-0000-0000-0000-000000000001' })).statusCode, 403);
  // Een echte student (anna, geen uuid in de nep → zelfde pad): de WHERE draagt is_test = true.
  lms.tabellen.hlms_trustpilot_status.forEach((r) => { r.student_id = r.student_id === 'anna' ? '00000000-0000-0000-0000-00000000000a' : '00000000-0000-0000-0000-00000000000b'; });
  const echt = await api(lms)('POST', { actie: 'reset_test', student_id: '00000000-0000-0000-0000-00000000000a' });
  assert.equal(echt.statusCode, 409);
  assert.equal(lms.tabellen.hlms_trustpilot_status.length, 2, 'een echte rij blijft staan');
  const test1 = await api(lms)('POST', { actie: 'reset_test', student_id: '00000000-0000-0000-0000-00000000000b' });
  assert.equal(test1.statusCode, 200);
  assert.equal(lms.tabellen.hlms_trustpilot_status.length, 1);
  assert.equal(RECHT_RESET, 'checkin.run');
  const src = readFileSync(new URL('../api/trustpilot-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /\.delete\(\)\.eq\('campagne_id', campagne\.id\)\.eq\('student_id', body\.student_id\)\.eq\('is_test', true\)/);
});

test('CRM: module in Leren & Events met checkin.view, view en script', () => {
  const shell = readFileSync(new URL('../modules/shared/design-system/app-shell.js', import.meta.url), 'utf8');
  assert.match(shell, /id: 'trustpilot',\s+naam: 'Trustpilot-reviews'.*permKey: 'checkin\.view'/);
  const idx = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');
  assert.match(idx, /views\/trustpilot-v2\.js/);
  const view = readFileSync(new URL('../modules/klanten-v2/views/trustpilot-v2.js', import.meta.url), 'utf8');
  assert.match(view, /VIEWS\['trustpilot\/'\]/);
  assert.match(view, /Kopieer namen voor de loting/);
  assert.match(view, /Accounts te verloten/);
});
