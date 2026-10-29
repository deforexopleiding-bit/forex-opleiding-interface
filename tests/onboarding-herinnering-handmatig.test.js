// tests/onboarding-herinnering-handmatig.test.js — "Herinnering nu versturen"
// vanaf het onboardingbord in het LMS (Maxim, 29 okt 2026).
//
// De regels (puur) en de weg van de brug: voorvertoning → versturen, met een
// nepdatabank en een nepmailer. Er vertrekt GEEN echte mail.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  besluitHandmatig, besluitHerinnering, waaromLabel, isMailRij, HANDMATIG_PREFIX, CONCEPT_TEKSTEN,
} from '../api/_lib/onboarding-herinneringen.js';

const url = (p) => new URL('../' + p, import.meta.url).href;

//  Offerte getekend op 1 oktober → bedenktijd vervalt 15 okt → dag 15 = 16 okt.
const rij = (over = {}) => ({
  id: 'ob1', status: 'aangemeld', customer_name: 'Bram', created_at: '2026-10-01T09:00:00Z', start_date: '2026-11-20',
  bedenktijd: { status: 'vervallen', vervalt_op: '2026-10-15T10:00:00.000Z' }, ...over,
});
const log = (...x) => x.map(([soort, dag, status = 'verstuurd']) => ({ soort, status, aangemaakt_op: dag + 'T08:05:00Z' }));
const goed = Object.fromEntries(Object.keys(CONCEPT_TEKSTEN).map((s) => [s, { goedgekeurd: true }]));
const hm = (dag, r = rij(), extra = {}) => besluitHandmatig(r, { vandaag: dag, teksten: goed, ...extra });

test('NOOIT TIJDENS DE BEDENKTIJD: dag 14 niet, dag 15 wel; "lopend" nooit', () => {
  assert.deepEqual(hm('2026-10-15'), { actie: 'niets', waarom: 'bedenktijd', sinds: '2026-10-16' });
  assert.deepEqual(hm('2026-10-16'), { actie: 'mail', tekst: 'herinnering_1', soort: 'herinnering_1' });
  assert.equal(hm('2026-11-30', rij({ bedenktijd: { status: 'lopend', vervalt_op: '2026-12-30T10:00:00Z' } })).waarom, 'bedenktijd_loopt');
  assert.equal(hm('2026-11-30', rij({ created_at: null, bedenktijd: null })).waarom, 'geen_aanmelddatum');
});

test('DE WEIGERINGEN: test, gearchiveerd, geannuleerd, afgerond, incasso, "Geen herinneringen", wil annuleren', () => {
  const dag = '2026-10-20';
  assert.equal(hm(dag, rij({ is_test: true })).waarom, 'test');
  assert.equal(hm(dag, rij({ status: 'gearchiveerd' })).waarom, 'gearchiveerd');
  assert.equal(hm(dag, rij({ status: 'geannuleerd' })).waarom, 'geannuleerd');
  assert.equal(hm(dag, rij({ status: 'afgerond' })).waarom, 'klaar');
  assert.equal(hm(dag, rij({ handmatig_afgerond_op: '2026-10-18T10:00:00Z' })).waarom, 'klaar');
  assert.equal(hm(dag, rij({ in_incasso: true })).waarom, 'incasso');
  assert.equal(hm(dag, rij({ geen_herinneringen_op: '2026-10-18T10:00:00Z' })).waarom, 'geen_herinneringen');
  assert.equal(hm(dag, rij(), { wilAnnuleren: true }).waarom, 'wil_annuleren');
  for (const w of ['test', 'klaar', 'geen_herinneringen', 'wil_annuleren', 'bedenktijd', 'recent', 'tekst_niet_goedgekeurd', 'geen_email', 'niet_gevonden']) {
    assert.ok(waaromLabel({ waarom: w, sinds: '2026-10-18', tekst: 'herinnering_1' }).length > 5, w);
  }
});

test('NIET ALS ER DE LAATSTE 3 DAGEN AL EEN HERINNERING VERTROK (en dat wordt gemeld)', () => {
  const l = log(['herinnering_1', '2026-10-16']);
  assert.deepEqual(hm('2026-10-19', rij(), { log: l }), { actie: 'niets', waarom: 'recent', sinds: '2026-10-16' });
  assert.match(waaromLabel({ waarom: 'recent', sinds: '2026-10-16' }), /2026-10-16/);
  assert.deepEqual(hm('2026-10-20', rij(), { log: l }), { actie: 'mail', tekst: 'herinnering_2', soort: 'herinnering_2' });
  //  Een mislukte poging telt niet.
  assert.equal(hm('2026-10-17', rij(), { log: log(['herinnering_1', '2026-10-16', 'mislukt']) }).tekst, 'herinnering_1');
  //  Ook een eerdere herinnering met de hand telt mee.
  assert.equal(hm('2026-10-30', rij(), { log: log(['herinnering_1', '2026-10-16'], ['herinnering_2', '2026-10-23'], [HANDMATIG_PREFIX + '2026-10-28', '2026-10-28']) }).waarom, 'recent');
});

test('WELKE TEKST: 1 als er nog geen vertrok, anders 2 (ook een tweede keer), een oud dossier de laatste', () => {
  assert.equal(hm('2026-10-20').tekst, 'herinnering_1');
  //  De oude automation mailde al op dag 15 (overgenomen) → herinnering 2.
  assert.equal(hm('2026-10-25', rij(), { log: log(['herinnering_1', '2026-10-16', 'overgenomen']) }).tekst, 'herinnering_2');
  //  Beide al gehad: herinnering 2 nog eens, met een eigen soort per dag (de grendel).
  assert.deepEqual(hm('2026-11-05', rij(), { log: log(['herinnering_1', '2026-10-16'], ['herinnering_2', '2026-10-23']) }),
    { actie: 'mail', tekst: 'herinnering_2', soort: HANDMATIG_PREFIX + '2026-11-05' });
  //  Oud dossier (start > 30 dagen geleden): de laatste, één keer.
  const oud = rij({ start_date: '2026-09-01', created_at: '2026-08-15T09:00:00Z', bedenktijd: { status: 'vervallen', vervalt_op: '2026-08-29T10:00:00Z' } });
  assert.deepEqual(hm('2026-10-29', oud), { actie: 'mail', tekst: 'laatste', soort: 'laatste' });
  assert.equal(hm('2026-10-29', oud, { log: log(['laatste', '2026-10-20']) }).waarom, 'laatste_al_verstuurd');
  //  De tekst moet goedgekeurd zijn (de hoofdschakelaar geldt hier niet).
  assert.deepEqual(hm('2026-10-20', rij(), { teksten: { herinnering_1: { goedgekeurd: false } } }),
    { actie: 'niets', waarom: 'tekst_niet_goedgekeurd', tekst: 'herinnering_1' });
});

test('DE CADANS ZIET WAT MET DE HAND VERTROK: niet dezelfde dag, en herinnering 1 niet nog eens', () => {
  assert.equal(isMailRij({ soort: HANDMATIG_PREFIX + '2026-10-20', status: 'verstuurd' }), true);
  assert.equal(isMailRij({ soort: 'signaal_geen_reactie', status: 'verstuurd' }), false);
  const l = log(['herinnering_1', '2026-10-20']);
  assert.equal(besluitHerinnering(rij(), { vandaag: '2026-10-20', log: l }).waarom, 'vandaag_al_gemaild');
  assert.equal(besluitHerinnering(rij(), { vandaag: '2026-10-21', log: l }).waarom, 'wacht_op_dag_22');
  assert.equal(besluitHerinnering(rij(), { vandaag: '2026-10-27', log: log(['herinnering_1', '2026-10-16'], [HANDMATIG_PREFIX + '2026-10-27', '2026-10-27']) }).waarom, 'vandaag_al_gemaild');
});

/* ── De brug, met een nepdatabank ──────────────────────────────────────── */

function nepDb(tabellen, uniek = {}) {
  const t = (n) => (tabellen[n] = tabellen[n] || []);
  function bouwer(naam) {
    const f = [];
    let soort = 'select'; let waarde = null; let enkel = false; let terug = false; let lim = null;
    const pas = (r) => f.every(([op, k, v]) => (op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : true));
    const voer = () => {
      const rijen = t(naam);
      if (soort === 'insert') {
        const nieuw = Array.isArray(waarde) ? waarde : [waarde];
        for (const n of nieuw) {
          const sleutel = uniek[naam];
          if (sleutel && rijen.some((r) => sleutel.every((k) => r[k] === n[k]))) return { data: null, error: { code: '23505', message: 'dubbel' } };
          rijen.push({ aangemaakt_op: new Date().toISOString(), ...n, id: n.id || 'id' + rijen.length });
        }
        return { data: enkel ? nieuw[0] : nieuw, error: null };
      }
      if (soort === 'update') {
        const geraakt = rijen.filter(pas);
        for (const r of geraakt) Object.assign(r, waarde);
        return { data: terug ? geraakt : null, error: null };
      }
      let uit = rijen.filter(pas);
      if (lim) uit = uit.slice(0, lim);
      return { data: enkel ? (uit[0] || null) : uit, error: null };
    };
    const b = {
      select() { terug = true; return b; },
      insert(v) { soort = 'insert'; waarde = v; return b; },
      update(v) { soort = 'update'; waarde = v; return b; },
      eq(k, v) { f.push(['eq', k, v]); return b; },
      in(k, v) { f.push(['in', k, v]); return b; },
      or() { return b; }, is() { return b; }, order() { return b; },
      limit(n) { lim = n; return b; },
      maybeSingle() { enkel = true; return b; },
      single() { enkel = true; return b; },
      then(ok, nok) { return Promise.resolve(voer()).then(ok, nok); },
    };
    return b;
  }
  return { from: bouwer, tabellen };
}

const OB = '11111111-1111-4111-8111-111111111111';
const OB_TEST = '22222222-2222-4222-8222-222222222222';
const OB_RECENT = '33333333-3333-4333-8333-333333333333';
const OB_GEEN = '44444444-4444-4444-8444-444444444444';

test('DE BRUG: voorvertoning wie wel/niet, één bevestiging, eerst claimen dan mailen, door wie in het logboek', async () => {
  const mails = [];
  mock.module(url('api/mailer.js'), {
    namedExports: { sendOnboardingMail: async (m) => { mails.push(m); return { success: true }; }, sendMail: async () => ({ success: true }) },
  });
  mock.module(url('api/_lib/onboarding-link.js'), {
    namedExports: {
      linkVoorOnboarding: async () => ({ link: 'https://www.deforexopleiding.nl/onboarding?code=ABCD-EFGH', startcode: 'ABCDEFGH' }),
      portalBasis: () => 'https://www.deforexopleiding.nl/onboarding',
    },
  });
  const vandaag = '2026-10-29';
  const teksten = Object.fromEntries(Object.entries(CONCEPT_TEKSTEN).map(([s, c]) => [s, {
    ...c, goedgekeurd_op: '2026-10-29T10:00:00Z', goedgekeurd_onderwerp: c.onderwerp, goedgekeurd_tekst: c.tekst,
  }]));
  const db = nepDb({
    app_settings: [{ key: 'onboarding_herinneringen', value: { aan: false, teksten } }],
    onboarding_herinneringen: [{ onboarding_id: OB_RECENT, soort: 'herinnering_1', status: 'verstuurd', aangemaakt_op: vandaag + 'T07:00:00Z' }],
    onboarding_automations: [],
    customers: [{ id: 'c1', email: 'bram@voorbeeld.nl', first_name: 'Bram' }, { id: 'c3', email: 'lies@voorbeeld.nl' }, { id: 'c4', email: '' }],
    onboardings: [{ id: OB, token: 't', startcode: 'ABCDEFGH', traject_id: null }],
  }, { onboarding_herinneringen: ['onboarding_id', 'soort'] });
  const lms = nepDb({ hlms_signaal: [] });
  const basis = { created_at: '2026-09-01T09:00:00Z', start_date: '2026-12-20', bedenktijd: { status: 'vervallen', vervalt_op: '2026-09-15T10:00:00Z' }, status: 'aangemeld' };
  const rijen = [
    { id: OB, customer_id: 'c1', customer_name: 'Bram', ...basis },
    { id: OB_RECENT, customer_id: 'c3', customer_name: 'Lies', ...basis },
    { id: OB_GEEN, customer_id: 'c4', customer_name: 'Zonder', ...basis },
  ];
  const srv = await import(url('api/_lib/onboarding-herinneringen-server.js') + '?t=' + Math.random());

  //  Voorvertoning: niets geschreven, niets gemaild.
  const plan = await srv.planHandmatig({ db, lms, rijen, ids: [OB, OB_TEST, OB_RECENT, OB_GEEN], vandaag });
  const v = srv.handmatigVoorLms(plan.items);
  assert.deepEqual(v.map((i) => [i.naam, i.mag, i.waarom]), [
    ['Bram', true, null], [null, false, 'niet_gevonden'], ['Lies', false, 'recent'], ['Zonder', false, 'geen_email'],
  ]);
  assert.equal(v[0].email, 'bram@voorbeeld.nl');
  assert.equal(v[0].tekst_label, 'Herinnering 1 (dag na de bedenktijd)');
  assert.equal(mails.length, 0);
  assert.equal(db.tabellen.onboarding_herinneringen.length, 1);

  //  Versturen: enkel Bram, met wie het deed; een tweede klik doet niets meer.
  const uit = await srv.stuurHandmatig({ db, lms, rijen, ids: [OB, OB_RECENT, OB_GEEN], vandaag, door: 'Maxim via het LMS (maxim@x)' });
  assert.equal(uit.migratie_ontbreekt, undefined);
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'bram@voorbeeld.nl');
  const regel = db.tabellen.onboarding_herinneringen.find((r) => r.onboarding_id === OB);
  assert.deepEqual([regel.soort, regel.status, regel.handmatig, regel.door, regel.tekst, regel.naar],
    ['herinnering_1', 'verstuurd', true, 'Maxim via het LMS (maxim@x)', 'herinnering_1', 'bram@voorbeeld.nl']);
  await srv.stuurHandmatig({ db, lms, rijen, ids: [OB], vandaag, door: 'Maxim' });
  assert.equal(mails.length, 1, 'binnen 3 dagen geen tweede mail');
  mock.reset();
});

test('DE BRUG: zonder migratie (kolommen handmatig/door/tekst) vertrekt er niets; de route kent herinnering_nu', () => {
  const route = readFileSync(new URL('../api/lms-onboarding-sessie.js', import.meta.url), 'utf8');
  assert.match(route, /if \(actie === 'herinnering_nu'\) return herinneringNu\(res, body\)/);
  assert.match(route, /body\?\.bevestigd !== true/);
  assert.match(route, /migratie_ontbreekt/);
  assert.match(route, /HERINNERING_NU_MAX = 100/);
  const srv = readFileSync(new URL('../api/_lib/onboarding-herinneringen-server.js', import.meta.url), 'utf8');
  assert.match(srv, /if \(!plan\.logboek \|\| !plan\.kolommen\) return \{ \.\.\.plan, migratie_ontbreekt: true \}/);
  //  Eerst claimen, dan mailen.
  assert.ok(srv.indexOf("claim(db, it.rij.id, b.soort, { handmatig: true, door, tekst: b.tekst })") < srv.indexOf('stuurHerinnering(db, it.rij, plan.inst.teksten[b.tekst])'));
  const sql = readFileSync(new URL('../docs/sql-migrations/2026-10-29-onboarding-herinnering-handmatig.sql', import.meta.url), 'utf8');
  for (const k of ['handmatig', 'door', 'tekst']) assert.match(sql, new RegExp(`add column if not exists ${k}\\b`));
  //  De rijen voor het LMS dragen wie en welke tekst.
  assert.match(readFileSync(new URL('../api/_lib/onboarding-overzicht-rijen.js', import.meta.url), 'utf8'), /handmatig: h\.handmatig === true, door: h\.door \|\| null, tekst: h\.tekst \|\| null/);
});
