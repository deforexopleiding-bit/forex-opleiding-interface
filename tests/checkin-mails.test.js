// tests/checkin-mails.test.js — "Jouw DFO-check-in" ook per mail (Maxim, 28 okt 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  besluitCheckinMail, genegeerd, normaliseerInstellingen, codeFmt, link, CONCEPT_TEKSTEN, SOORTEN, GENEGEERD_NA_DAGEN,
} from '../api/_lib/checkin-mails.js';
import { bouwOpmaakMail } from '../api/_lib/onboarding-mail-opmaak.js';
import { maakHandler, RECHT_GOEDKEUREN, RECHT_BEWERK } from '../api/checkin-mails.js';
import { MAX_PER_LOOP } from '../api/cron/checkin-mails.js';

const campagne = { id: 'c1', status: 'live', live_op: '2026-11-02T09:00:00Z' };
const t = (over = {}) => ({ id: 't1', code: 'ABCD2345', is_test: false, status: 'niet_gestart', verstuurd_op: null, ...over });
const log = (...x) => x.map(([soort, dag, status = 'verstuurd']) => ({ soort, status, aangemaakt_op: dag + 'T10:00:00Z' }));
const besluit = (vandaag, over = {}, l = [], c = campagne) => besluitCheckinMail({ toewijzing: t(over), campagne: c, vandaag, log: l, email: 'x@y.nl' });

test('ENKEL IN EEN LIVE CAMPAGNE (na de Run): concept, test, gepauzeerd, gesloten → niets', () => {
  for (const status of ['concept', 'test', 'gepauzeerd', 'gesloten']) {
    assert.deepEqual(besluit('2026-11-02', {}, [], { ...campagne, status }), { actie: 'niets', waarom: 'campagne_niet_live' }, status);
  }
  assert.deepEqual(besluit('2026-11-02'), { actie: 'mail', soort: 'uitnodiging' });
});

test('NOOIT: testtoewijzing, al verstuurd, geen adres', () => {
  assert.equal(besluit('2026-11-02', { is_test: true }).waarom, 'test');
  assert.equal(besluit('2026-11-02', { verstuurd_op: '2026-11-02T12:00:00Z' }).waarom, 'verstuurd');
  assert.equal(besluit('2026-11-02', { status: 'verstuurd' }).waarom, 'verstuurd');
  assert.equal(besluitCheckinMail({ toewijzing: t(), campagne, vandaag: '2026-11-02', log: [] }).waarom, 'geen_email');
});

test('HERINNERINGEN: 5 en 10 dagen na de uitnodiging, en daarna niets meer', () => {
  const u = log(['uitnodiging', '2026-11-02']);
  assert.equal(besluit('2026-11-06', {}, u).waarom, 'wacht_5_dagen');
  assert.deepEqual(besluit('2026-11-07', {}, u), { actie: 'mail', soort: 'herinnering_5' });
  const u5 = log(['uitnodiging', '2026-11-02'], ['herinnering_5', '2026-11-07']);
  assert.equal(besluit('2026-11-11', {}, u5).waarom, 'wacht_10_dagen');
  assert.deepEqual(besluit('2026-11-12', {}, u5), { actie: 'mail', soort: 'herinnering_10' });
  assert.equal(besluit('2026-11-20', {}, log(['uitnodiging', '2026-11-02'], ['herinnering_5', '2026-11-07'], ['herinnering_10', '2026-11-12'])).waarom, 'alles_gehad');
  //  Een mislukte telt niet als gehad.
  assert.deepEqual(besluit('2026-11-03', {}, log(['uitnodiging', '2026-11-02', 'mislukt'])), { actie: 'mail', soort: 'uitnodiging' });
  //  Verstuurd tussendoor: geen herinnering meer.
  assert.equal(besluit('2026-11-07', { verstuurd_op: '2026-11-05T08:00:00Z' }, u).waarom, 'verstuurd');
});

test('GENEGEERD: niet verstuurd 14 dagen na de Run — los van de mails', () => {
  assert.equal(GENEGEERD_NA_DAGEN, 14);
  assert.equal(genegeerd(t(), campagne, '2026-11-15'), false);
  assert.equal(genegeerd(t(), campagne, '2026-11-16'), true);
  assert.equal(genegeerd(t({ verstuurd_op: 'x' }), campagne, '2026-12-01'), false);
  assert.equal(genegeerd(t({ is_test: true }), campagne, '2026-12-01'), false);
  //  De schakelaar ging pas laat aan: wie al genegeerd is, krijgt geen uitnodiging meer.
  assert.deepEqual(besluit('2026-11-20'), { actie: 'niets', waarom: 'genegeerd' });
});

test('TEKSTEN: concept, standaard UIT; code en knop; "Jouw code" in het kader', () => {
  const i = normaliseerInstellingen(null);
  assert.equal(i.aan, false);
  for (const s of SOORTEN) {
    assert.equal(i.teksten[s].goedgekeurd, false, s);
    assert.match(CONCEPT_TEKSTEN[s].tekst, /^\{\{checkin\.code\}\}$/m, s);
    assert.match(CONCEPT_TEKSTEN[s].tekst, /^\[knop: [^\]]+\]$/m, s);
  }
  assert.equal(codeFmt('abcd2345'), 'ABCD-2345');
  assert.equal(link('ABCD2345'), 'https://www.deforexopleiding.nl/checkin?code=ABCD-2345');
  const m = bouwOpmaakMail({ subject: 'x', body: 'Hi\n{{checkin.code}}\n[knop: Start]', waarden: { '{{checkin.code}}': 'ABCD-2345' }, link: link('ABCD2345'), codeLabel: 'Jouw code', codeRegel: '{{checkin.code}}' });
  assert.match(m.html, /Jouw code/);
  assert.doesNotMatch(m.html, /Jouw startcode/);
  assert.match(m.html, /ABCD-2345/);
  assert.match(m.html, /checkin\?code=ABCD-2345/);
});

test('DE CRON: geheim, schakelaar, droogloop, logboek, eerst claimen, hoogstens 40 per loop, in vercel.json', () => {
  const src = readFileSync(new URL('../api/cron/checkin-mails.js', import.meta.url), 'utf8');
  assert.match(src, /CRON_SECRET/);
  assert.match(src, /!inst\.aan && !dry/);
  assert.match(src, /log === null && !dry/);
  assert.match(src, /tekst_niet_goedgekeurd/);
  assert.ok(src.indexOf('await claim(') < src.indexOf('await stuurCheckinMail('));
  assert.equal(MAX_PER_LOOP, 40);
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(v.crons.some((c) => c.path === '/api/cron/checkin-mails'));
  const sql = readFileSync(new URL('../docs/sql-migrations/2026-10-28-checkin-mails.sql', import.meta.url), 'utf8');
  assert.match(sql, /unique \(toewijzing_id, soort\)/);
  assert.match(sql, /enable row level security/);
});

function nepRes() {
  return { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

test('HET ENDPOINT: goedkeuren en schakelaar enkel met het goedkeur-recht; bewerken met checkin.run', async () => {
  const zonderGoed = maakHandler({ ingelogd: async () => ({ id: 'u', email: 'a@b.nl' }), mag: async (_r, recht) => recht !== RECHT_GOEDKEUREN, db: {} });
  for (const actie of ['goedkeuren', 'schakelaar']) {
    const res = nepRes();
    await zonderGoed({ method: 'POST', headers: {}, body: { actie, soort: 'uitnodiging', aan: true } }, res);
    assert.equal(res.code, 403, actie);
  }
  const alleenKijken = maakHandler({ ingelogd: async () => ({ id: 'u', email: 'a@b.nl' }), mag: async (_r, recht) => recht !== RECHT_BEWERK && recht !== RECHT_GOEDKEUREN, db: {} });
  const res = nepRes();
  await alleenKijken({ method: 'POST', headers: {}, body: { actie: 'tekst', soort: 'uitnodiging', onderwerp: 'x', tekst: 'y' } }, res);
  assert.equal(res.code, 403);
});
