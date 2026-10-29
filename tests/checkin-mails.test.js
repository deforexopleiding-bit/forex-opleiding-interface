// tests/checkin-mails.test.js — "Jouw DFO-check-in" ook per mail (Maxim, 28 okt 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  besluitCheckinMail, genegeerd, normaliseerInstellingen, codeFmt, link, CONCEPT_TEKSTEN, SOORTEN, GENEGEERD_NA_DAGEN,
} from '../api/_lib/checkin-mails.js';
import { bouwCheckinMail, ontleed, controleer, isOpmaakTekst } from '../api/_lib/checkin-mail-opmaak.js';
import { maakCheckinMail } from '../api/_lib/checkin-mails-server.js';
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

test('TEKSTEN: concept in de vaste opmaak, standaard UIT en niet goedgekeurd', () => {
  const i = normaliseerInstellingen(null);
  assert.equal(i.aan, false);
  for (const s of SOORTEN) {
    assert.equal(i.teksten[s].goedgekeurd, false, s);
    assert.ok(isOpmaakTekst(CONCEPT_TEKSTEN[s].tekst), s);
    assert.deepEqual(controleer(CONCEPT_TEKSTEN[s].tekst), [], s);
  }
  assert.equal(CONCEPT_TEKSTEN.uitnodiging.onderwerp, 'Jouw check-in staat klaar, {{voornaam}}');
  assert.equal(ontleed(CONCEPT_TEKSTEN.uitnodiging.tekst).tegel.length, 3);
  for (const s of ['herinnering_5', 'herinnering_10']) assert.equal(ontleed(CONCEPT_TEKSTEN[s].tekst).tegel, undefined, s + ': geen tegels');
  assert.match(ontleed(CONCEPT_TEKSTEN.herinnering_5.tekst).kop, /^Je check-in staat nog open$/);
  assert.match(ontleed(CONCEPT_TEKSTEN.herinnering_10.tekst).kop, /^Laatste herinnering: je check-in$/);
  assert.equal(codeFmt('abcd2345'), 'ABCD-2345');
  assert.equal(link('ABCD2345'), 'https://www.deforexopleiding.nl/checkin?code=ABCD-2345');
});

test('OUDE OPMAAK: een eerder goedgekeurde platte tekst telt niet meer → nieuw concept, niet goedgekeurd', () => {
  const oud = 'Hi {{student.voornaam}},\n\n{{checkin.code}}\n[knop: Start mijn check-in]';
  const ruw = { aan: true, teksten: { uitnodiging: { onderwerp: 'Oud', tekst: oud, goedgekeurd_op: '2026-10-29T11:41:19Z', goedgekeurd_onderwerp: 'Oud', goedgekeurd_tekst: oud } } };
  const i = normaliseerInstellingen(ruw);
  assert.equal(i.aan, true);
  assert.equal(i.teksten.uitnodiging.goedgekeurd, false);
  assert.equal(i.teksten.uitnodiging.tekst, CONCEPT_TEKSTEN.uitnodiging.tekst);
  //  Een goedgekeurde tekst in de nieuwe opmaak blijft wel goedgekeurd.
  const nieuw = CONCEPT_TEKSTEN.herinnering_5;
  const ok = normaliseerInstellingen({ teksten: { herinnering_5: { ...nieuw, goedgekeurd_op: 'x', goedgekeurd_onderwerp: nieuw.onderwerp, goedgekeurd_tekst: nieuw.tekst } } });
  assert.equal(ok.teksten.herinnering_5.goedgekeurd, true);
});

test('HET ONTWERP: kop, tegels, codekader, knop met de code-link, blok, Discord-vraag, groet, voet + tekstversie', () => {
  const m = maakCheckinMail(CONCEPT_TEKSTEN.uitnodiging, { voornaam: 'Anna', code: 'abcd2345' });
  assert.equal(m.onderwerp, 'Jouw check-in staat klaar, Anna');
  const h = m.html;
  assert.match(h, /^<!doctype html>/);
  assert.match(h, /display:none;max-height:0;overflow:hidden;opacity:0;">4 minuten\. Jouw antwoorden bepalen/);
  assert.match(h, /background:#05232B;padding:30px 36px 34px;/);
  assert.match(h, /DE FOREX <span style="color:#3FBF8F;">OPLEIDING<\/span>/);
  assert.match(h, /Hoe loopt jouw traject,<br>Anna\?/);
  assert.match(h, /een korte <b>check-in<\/b>\./);
  for (const x of ['4 min', 'Persoonlijk', 'Impact', 'jouw input = onze volgende stappen']) assert.ok(h.includes(x), x);
  assert.match(h, /border:2px dashed #3FBF8F;[^>]*>ABCD-2345<\/div>/);
  assert.match(h, /<a href="https:\/\/www\.deforexopleiding\.nl\/checkin\?code=ABCD-2345" style="display:inline-block;background:#3FBF8F;[^"]*">Start mijn check-in →<\/a>/);
  assert.match(h, /color:#E2A64A;">OP HET EINDE/);
  assert.match(h, /Wat wij zelf al jaren gebruiken/);
  assert.match(h, /<b style="color:#2B3A47;">Kleine vraag:<\/b> houd je check-in/);
  assert.match(h, /<b>Maxim<\/b> &amp; het team van De Forex Opleiding/);
  assert.match(h, /background:#F3F7F6;padding:16px 36px;[^>]*>Je krijgt deze mail omdat/);
  assert.doesNotMatch(h, /\{\{|<script|<link|<img|@import|https:\/\/fonts/i, 'geen plaatshouders, scripts, externe fonts of beelden');
  //  Tekstversie.
  assert.match(m.text, /^Hoe loopt jouw traject,\nAnna\?/);
  assert.match(m.text, /JOUW PERSOONLIJKE CODE: ABCD-2345/);
  assert.match(m.text, /Start mijn check-in: https:\/\/www\.deforexopleiding\.nl\/checkin\?code=ABCD-2345/);
  assert.match(m.text, /Kleine vraag: houd je check-in/);
  assert.doesNotMatch(m.text, /\*\*|<b>|\{\{/);
});

test('HERINNERINGEN: zelfde opmaak, andere kop, geen tegels en geen blok', () => {
  const m = maakCheckinMail(CONCEPT_TEKSTEN.herinnering_10, { voornaam: '', code: 'ABCD2345' });
  assert.equal(m.onderwerp, 'Laatste herinnering: je check-in, daar');
  assert.match(m.html, /Laatste herinnering: je check-in<\/div>/);
  assert.match(m.html, /border:2px dashed #3FBF8F;/);
  assert.match(m.html, /checkin\?code=ABCD-2345/);
  assert.doesNotMatch(m.html, /Persoonlijk<\/div>|OP HET EINDE/);
});

test('OPMAAK-REGELS: escapen, vet, oude plaatshouders, fouten bij Bewaren', () => {
  const m = bouwCheckinMail({ onderwerp: 'x {{student.voornaam}}', tekst: '[kop] <script>x</script> **{{student.voornaam}}**\n[knop] Ga {{checkin.code}}' }, { voornaam: 'Bo & Co', code: 'ABCD-2345', link: 'https://x/?code=ABCD-2345' });
  assert.equal(m.onderwerp, 'x Bo & Co');
  assert.match(m.html, /&lt;script&gt;x&lt;\/script&gt; <b>Bo &amp; Co<\/b>/);
  assert.match(m.html, /Ga ABCD-2345<\/a>/);
  assert.deepEqual(controleer('[kop] x'), ['De regel [knop] ontbreekt.']);
  assert.ok(controleer('[kop] x\n[knop] y\n[tegel] zonder streep\n[vreemd] z').some((f) => /titel \| uitleg/.test(f)));
  assert.ok(controleer('[kop] x\n[knop] y\n[vreemd] z').some((f) => /\[vreemd\]/.test(f)));
});

test('HET ENDPOINT: voorbeeld = exact de mail die vertrekt; Bewaren weigert een kapotte opmaak', async () => {
  const db = {
    from() {
      const q = { select() { return q; }, eq() { return q; }, maybeSingle: async () => ({ data: { value: null }, error: null }) };
      return q;
    },
  };
  const h = maakHandler({ ingelogd: async () => ({ id: 'u', email: 'a@b.nl' }), mag: async () => true, db });
  const res = nepRes();
  await h({ method: 'POST', headers: {}, body: { actie: 'voorbeeld', soort: 'uitnodiging' } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.html, maakCheckinMail(CONCEPT_TEKSTEN.uitnodiging, { voornaam: 'Maxim', code: 'K7QM4RPD' }).html);
  assert.deepEqual(res.body.fouten, []);
  const kapot = nepRes();
  await h({ method: 'POST', headers: {}, body: { actie: 'tekst', soort: 'uitnodiging', onderwerp: 'x', tekst: 'gewoon een platte tekst' } }, kapot);
  assert.equal(kapot.code, 400);
  assert.match(kapot.body.error, /\[kop\] ontbreekt/);
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
