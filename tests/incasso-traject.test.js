// tests/incasso-traject.test.js
//
// HET INCASSO-OVERZICHT (Maxim, 3 nov 2026) — api/_lib/incasso-traject*.js
// en de machine-route api/lms-incasso.js.
//
// WAT HIER STIL KAN BREKEN
//   1. Een TWEEDE incassostatus: de fase moet afgeleid zijn uit de #1957-status.
//   2. Aanmaningen: bij Mag naar incasso lopen ze door (status actief), vanaf
//      Doorgezet staan ze stil (status bij_incasso → uitsluiting #1958).
//   3. Bestaande klanten worden NIET verplaatst: zonder traject = Nog te bepalen,
//      en het laden van het overzicht schrijft niets.
//   4. Een minderjarige naar incasso.
//   5. Openstaand = getekende offertes (incl. BTW) − betaald in TL − betaald in GHL,
//      zonder creditnota's of de conceptfactuur van het bureau.
//   6. Teamleader wordt nooit gewijzigd (geen enkele schrijfactie op invoices/subscriptions).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maakNepDb } from './_nep-db.js';
import {
  faseVan, aanmaningenLopen, checklistStand, openstaand, isMinderjarig, magActie, cijfersPerFase, CHECKLIST,
} from '../api/_lib/incasso-traject.js';
import { laadIncassoOverzicht, voerIncassoActieUit, stelVoorVanuitOnboarding, sluitOnboardingVoorstel } from '../api/_lib/incasso-traject-server.js';
import { zetStatus } from '../api/_lib/klant-incassostatus.js';
import { laadIncassoUitsluiting } from '../api/_lib/incasso-termijnfacturen.js';
import { somGeslaagd } from '../api/_lib/ghl-betalingen.js';
import { maakHandler } from '../api/lms-incasso.js';

const K = '11111111-1111-4111-8111-111111111111';
const K2 = '22222222-2222-4222-8222-222222222222';
const NU = new Date('2026-11-03T10:00:00+01:00');
const ADMIN = { email: 'maxim@x', naam: 'Maxim', rollen: ['admin'] };
const SEPPE = { email: 'seppe@x', naam: 'Seppe', rollen: ['administratie'] };
const HM = { email: 'hm@x', naam: 'Danny', rollen: ['hoofdmentor'] };

function basis(extra = {}) {
  return {
    customers: [
      { id: K, first_name: 'Proef', last_name: 'Klant', email: 'proef@x', date_of_birth: '1990-01-01', ghl_contact_id: 'ghl-1', is_test: false },
      { id: K2, first_name: 'Jonge', last_name: 'Klant', email: 'jong@x', date_of_birth: '2010-05-05', is_test: false },
    ],
    onboardings: [
      { id: 'onb-1', customer_id: K, customer_name: 'Proef Klant', incasso_op: '2026-10-06T10:00:00Z', incasso_terug_op: null, incasso_reden: 'betaalt niet', dfo_lms_student_id: 'stu-1', is_test: false },
    ],
    deals: [
      { id: 'd1', customer_id: K, total_amount: 4958.68, tl_quotation_status: 'accepted', discount_percentage: 0, sale_type: 'domestic' },
      { id: 'd2', customer_id: K, total_amount: 300, tl_quotation_status: 'no_quotation' },
    ],
    deal_line_items: [{ deal_id: 'd1', quantity: 1, unit_price: 4958.68, vat_percentage: 21, price_includes_vat: false }],
    invoices: [
      { id: 'i1', customer_id: K, status: 'paid', amount_total: 500, amount_paid: 500, credited_amount: 0 },
      { id: 'i2', customer_id: K, status: 'credited', amount_total: 500, amount_paid: 500, credited_amount: 500 },
      { id: 'i3', customer_id: K, invoice_number: 'CONCEPT-x', status: 'concept', amount_total: 5000, amount_paid: 0, credited_amount: 0 },
    ],
    mentor_commissie_incasso: [],
    incasso_trajecten: [],
    dunning_incasso_dossiers: [],
    dunning_incasso_bureaus: [{ id: 'b-nl', name: 'NL', country: 'NL', is_active: true }],
    dunning_pipeline_customers: [],
    profiles: [{ id: 'p-maxim', email: 'maxim@x' }],
    subscriptions: [],
    audit_log: [],
    ...extra,
  };
}

function deps(db, over = {}) {
  const pijp = [];
  return {
    crm: db.client, zetStatus, nu: NU,
    motor: async () => ({ total_released: 0 }),
    setStage: async (cid, fase) => { pijp.push([cid, fase]); return { ok: true }; },
    ensurePipeline: async () => ({ ok: true }),
    pijp,
    ...over,
  };
}
const actie = (db, invoer, d) => voerIncassoActieUit(d || deps(db), invoer);

// ── Puur ─────────────────────────────────────────────────────────────────

test('fase = afgeleid uit de #1957-status (geen tweede status)', () => {
  assert.equal(faseVan({ traject: null, status: 'actief' }), 'te_bepalen');
  assert.equal(faseVan({ traject: {}, status: 'actief' }), 'mag_naar_incasso');
  assert.equal(faseVan({ traject: { checklist: {} }, status: 'bij_incasso' }), 'doorgezet');
  assert.equal(faseVan({ traject: { checklist: { dossier_verstuurd: { op: '2026-11-03' } } }, status: 'bij_incasso' }), 'bij_incasso');
  assert.equal(faseVan({ traject: {}, status: 'incasso_regeling' }), 'regeling');
  assert.equal(faseVan({ traject: { gesloten_op: 'x' }, status: 'actief' }), 'afgesloten');
  assert.equal(faseVan({ traject: null, status: 'bij_incasso' }), 'doorgezet', 'status zonder traject: afvinklijst onbekend');
});

test('aanmaningen: lopen door bij Mag naar incasso, staan stil vanaf Doorgezet', () => {
  assert.equal(aanmaningenLopen('mag_naar_incasso'), true);
  assert.equal(aanmaningenLopen('te_bepalen'), true);
  for (const f of ['doorgezet', 'bij_incasso', 'regeling']) assert.equal(aanmaningenLopen(f), false, f);
});

test('afvinklijst: dossier verstuurd pas als de vier andere af zijn', () => {
  assert.equal(CHECKLIST.length, 5);
  assert.equal(checklistStand({}).dossierMag, false);
  const vier = { bureau_gekozen: 1, facturen_gekrediteerd: 1, restfactuur: 1, abonnement_gestopt: 1 };
  assert.deepEqual([checklistStand(vier).af, checklistStand(vier).dossierMag], [4, true]);
});

test('openstaand: getekende offerte incl. BTW − TL − GHL; creditnota en concept tellen niet', () => {
  const db = basis();
  const regels = new Map([['d1', db.deal_line_items]]);
  const g = openstaand({ deals: db.deals, regelsPerDeal: regels, facturen: db.invoices, ghlBetaald: 200 });
  assert.equal(g.offerte, 6000);       // 4958,68 × 1,21; de niet getekende deal telt niet
  assert.equal(g.betaald_tl, 500);     // i2 is gecrediteerd, i3 is de bureaufactuur (concept)
  assert.equal(g.betaald_ghl, 200);
  assert.equal(g.openstaand, 5300);
  assert.equal(openstaand({ deals: db.deals, regelsPerDeal: regels, facturen: db.invoices }).betaald_ghl, null, 'GHL niet gelezen ≠ 0');
  assert.equal(openstaand({ deals: [], facturen: [] }).openstaand, null, 'zonder getekende offerte: onbekend');
});

test('GHL: enkel geslaagde betalingen; deels terugbetaald telt het netto', () => {
  assert.equal(somGeslaagd([{ status: 'succeeded', amount: 100 }, { status: 'failed', amount: 50 }, { status: 'refunded', amount: 70 }, { status: 'partially_refunded', amount: 80, amountRefunded: 30 }]), 150);
});

test('minderjarig op de dag zelf', () => {
  assert.equal(isMinderjarig('2008-11-04', '2026-11-03'), true);
  assert.equal(isMinderjarig('2008-11-03', '2026-11-03'), false);
  assert.equal(isMinderjarig(null, '2026-11-03'), false);
});

test('rechten: Seppe stelt voor en volgt op, selecteren doen Maxim en de hoofdmentor', () => {
  assert.equal(magActie(SEPPE.rollen, 'voorstel'), true);
  assert.equal(magActie(SEPPE.rollen, 'doorzetten'), false);
  assert.equal(magActie(SEPPE.rollen, 'kies_fase'), false);
  assert.equal(magActie(SEPPE.rollen, 'vink'), true);
  assert.equal(magActie(HM.rollen, 'doorzetten'), true);
  assert.equal(magActie(HM.rollen, 'vink'), false);
  assert.equal(magActie(['mentor'], 'voorstel'), false);
});

// ── Overzicht ────────────────────────────────────────────────────────────

test('bestaande klant op incasso: Nog te bepalen, en het overzicht schrijft NIETS', async () => {
  const db = maakNepDb();
  db.reset(basis());
  const ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU, ghl: async () => ({ ok: true, bedrag: 100 }) });
  assert.equal(ov.rijen.length, 1);
  const r = ov.rijen[0];
  assert.equal(r.fase, 'te_bepalen');
  assert.equal(r.bronnen[0].bron, 'onboarding');
  assert.equal(r.geld.openstaand, 5400);
  assert.equal(r.aanmaningen_lopen, true);
  assert.match(r.crm_url, /klanten-v2\/\?id=11111111-.*tab=incasso/);
  assert.equal(ov.cijfers.perFase.te_bepalen.aantal, 1);
  assert.equal(db.log.filter((l) => l.op !== 'select').length, 0, 'lezen schrijft niets');
});

test('zonder migratie: overzicht werkt (alles Nog te bepalen), acties geven 503', async () => {
  const db = maakNepDb();
  db.reset(basis(), ['incasso_trajecten']);
  const ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU });
  assert.equal(ov.migratie.trajecten, false);
  assert.equal(ov.rijen[0].fase, 'te_bepalen');
  const u = await actie(db, { actie: 'kies_fase', customer_id: K, fase: 'doorgezet', notitie: 'al lang open', actor: ADMIN });
  assert.equal(u.status, 503);
});

// ── De flow ──────────────────────────────────────────────────────────────

test('voorstel (Seppe na brief 2) → doorzetten (Maxim): status bij_incasso, aanmaningen stil', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [] }));
  let u = await actie(db, { actie: 'voorstel', customer_id: K, herkomst: 'brief_2', notitie: 'geen reactie', actor: SEPPE });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(db.rows('mentor_commissie_incasso').length, 0, 'voorstel zet GEEN status: aanmaningen lopen door');
  let uitsl = await laadIncassoUitsluiting(db.client, { customerIds: [K] });
  assert.equal(uitsl.klanten.has(K), false);

  u = await actie(db, { actie: 'doorzetten', customer_id: K, actor: SEPPE });
  assert.equal(u.status, 403, 'Seppe selecteert niet zelf');
  const d = deps(db);
  u = await actie(db, { actie: 'doorzetten', customer_id: K, actor: ADMIN }, d);
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const st = db.rows('mentor_commissie_incasso');
  assert.equal(st.length, 1);
  assert.equal(st[0].status, 'bij_incasso');
  assert.equal(st[0].gezet_door, 'p-maxim');
  uitsl = await laadIncassoUitsluiting(db.client, { customerIds: [K] });
  assert.equal(uitsl.klanten.has(K), true, 'vanaf Doorgezet sluit #1958 de klant uit van aanmaningen');
  assert.deepEqual(d.pijp, [[K, 'incasso']]);
  assert.equal(db.rows('audit_log').length, 1);
});

test('afvinklijst → Bij incasso met bureau, bedrag en check over 14 dagen → regeling → betaald', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [] }));
  await actie(db, { actie: 'voorstel', customer_id: K, actor: SEPPE });
  await actie(db, { actie: 'doorzetten', customer_id: K, actor: ADMIN });

  let u = await actie(db, { actie: 'vink', customer_id: K, item: 'dossier_verstuurd', bedrag: 5300, actor: SEPPE });
  assert.equal(u.status, 409, 'dossier pas na de rest');
  u = await actie(db, { actie: 'vink', customer_id: K, item: 'bureau_gekozen', actor: SEPPE });
  assert.equal(u.status, 400, 'bureau verplicht');
  for (const item of ['bureau_gekozen', 'facturen_gekrediteerd', 'restfactuur', 'abonnement_gestopt']) {
    u = await actie(db, { actie: 'vink', customer_id: K, item, bureau_id: 'b-nl', actor: SEPPE });
    assert.equal(u.status, 200, item + ' ' + JSON.stringify(u.body));
  }
  u = await actie(db, { actie: 'vink', customer_id: K, item: 'dossier_verstuurd', bedrag: 5300, actor: SEPPE });
  assert.equal(u.status, 200);
  const t = db.rows('incasso_trajecten')[0];
  assert.equal(t.bureau_id, 'b-nl');
  assert.equal(t.overgedragen_bedrag, 5300);
  assert.equal(t.volgende_check, '2026-11-17');
  let ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU });
  assert.equal(ov.rijen[0].fase, 'bij_incasso');

  u = await actie(db, { actie: 'regeling', customer_id: K, notitie: '12 x 50', actor: ADMIN });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU });
  assert.equal(ov.rijen[0].fase, 'regeling');
  assert.equal(ov.rijen[0].status.status, 'incasso_regeling');

  u = await actie(db, { actie: 'afsluiten', customer_id: K, als: 'betaald', notitie: 'alles binnen', actor: SEPPE });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU });
  assert.equal(ov.rijen[0].fase, 'afgesloten');
  assert.equal(ov.rijen[0].status.status, 'afgesloten');
  // Nooit Teamleader of facturen aangeraakt.
  assert.equal(db.log.filter((l) => l.op !== 'select' && ['invoices', 'subscriptions', 'deals'].includes(l.tabel)).length, 0);
});

test('teruggekomen: status terug naar actief, traject dicht', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [] }));
  await actie(db, { actie: 'voorstel', customer_id: K, actor: SEPPE });
  await actie(db, { actie: 'doorzetten', customer_id: K, actor: HM });
  const u = await actie(db, { actie: 'afsluiten', customer_id: K, als: 'teruggekomen', notitie: 'bureau stuurt terug', actor: SEPPE });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(db.rows('mentor_commissie_incasso').filter((r) => !r.opgeheven_op).length, 0);
  assert.equal(db.rows('incasso_trajecten')[0].gesloten_als, 'teruggekomen');
});

test('Nog te bepalen: Maxim kiest de fase; de hoofdmentor ook, Seppe niet', async () => {
  const db = maakNepDb();
  db.reset(basis());
  let u = await actie(db, { actie: 'kies_fase', customer_id: K, fase: 'bij_incasso', bureau_id: 'b-nl', bedrag: 1200, datum: '2026-10-21', notitie: 'zit al bij het bureau', actor: SEPPE });
  assert.equal(u.status, 403);
  u = await actie(db, { actie: 'kies_fase', customer_id: K, fase: 'bij_incasso', bureau_id: 'b-nl', bedrag: 1200, datum: '2026-10-21', notitie: 'zit al bij het bureau', actor: ADMIN });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const st = db.rows('mentor_commissie_incasso')[0];
  assert.equal(st.status, 'bij_incasso');
  assert.equal(st.sinds, '2026-10-21');
  const ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU });
  assert.equal(ov.rijen[0].fase, 'bij_incasso');
  assert.equal(ov.rijen[0].volgende_check, '2026-11-03', 'eerste check meteen');
  u = await actie(db, { actie: 'kies_fase', customer_id: K, fase: 'doorgezet', notitie: 'nog eens', actor: ADMIN });
  assert.equal(u.status, 409, 'maar één keer');
});

test('kies_fase Mag naar incasso zet geen status; mislukte status maakt het traject ongedaan', async () => {
  const db = maakNepDb();
  db.reset(basis());
  let u = await actie(db, { actie: 'kies_fase', customer_id: K, fase: 'mag_naar_incasso', notitie: 'eerst bellen', actor: ADMIN });
  assert.equal(u.status, 200);
  assert.equal(db.rows('mentor_commissie_incasso').length, 0);

  db.reset(basis());
  const stuk = deps(db, { zetStatus: async () => { throw Object.assign(new Error('Migratie ontbreekt'), { status: 503, code: 'MIGRATIE_ONTBREEKT' }); } });
  u = await actie(db, { actie: 'kies_fase', customer_id: K, fase: 'regeling', notitie: 'regeling loopt', actor: ADMIN }, stuk);
  assert.equal(u.status, 503);
  assert.equal(db.rows('incasso_trajecten').length, 0, 'geen half traject');
});

test('minderjarig: geen voorstel, geen doorzetten, enkel afsluiten', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [] }));
  let u = await actie(db, { actie: 'voorstel', customer_id: K2, actor: SEPPE });
  assert.equal(u.status, 422);
  u = await actie(db, { actie: 'kies_fase', customer_id: K2, fase: 'doorgezet', notitie: 'test test', actor: ADMIN });
  assert.equal(u.status, 422);
  u = await actie(db, { actie: 'voorstel', customer_id: K, minderjarig: true, actor: SEPPE });
  assert.equal(u.status, 422, 'de vlag uit het LMS-dossier telt ook');
  u = await actie(db, { actie: 'kies_fase', customer_id: K2, fase: 'afgesloten', als: 'niet_naar_incasso', notitie: 'minderjarig', actor: ADMIN });
  assert.equal(u.status, 200);
});

test('niet naar incasso: traject dicht, geen status, aanmaningen lopen door', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [] }));
  await actie(db, { actie: 'voorstel', customer_id: K, actor: SEPPE });
  const u = await actie(db, { actie: 'niet_naar_incasso', customer_id: K, notitie: 'heeft betaald beloofd', actor: HM });
  assert.equal(u.status, 200);
  assert.equal(db.rows('mentor_commissie_incasso').length, 0);
  assert.equal(db.rows('incasso_trajecten')[0].gesloten_als, 'niet_naar_incasso');
});

test('onboarding op incasso = voorstel; terug actief vóór doorzetten = voorstel vervalt', async () => {
  const db = maakNepDb();
  db.reset(basis());
  assert.equal((await stelVoorVanuitOnboarding(db.client, { onboardingId: 'onb-1', door: 'Dave', reden: 'geen reactie' })).ok, true);
  const t = db.rows('incasso_trajecten')[0];
  assert.equal(t.herkomst, 'onboarding');
  assert.equal(db.rows('mentor_commissie_incasso').length, 0);
  await sluitOnboardingVoorstel(db.client, { onboardingId: 'onb-1', door: 'Dave' });
  assert.equal(db.rows('incasso_trajecten')[0].gesloten_als, 'niet_naar_incasso');
});

test('cijfers per fase voor de weekmeeting', () => {
  const c = cijfersPerFase([
    { fase: 'bij_incasso', geld: { openstaand: 100 }, overgedragen_bedrag: 90, volgende_check: '2026-11-01' },
    { fase: 'bij_incasso', geld: { openstaand: 50 }, overgedragen_bedrag: 40, volgende_check: '2026-11-10' },
    { fase: 'doorgezet', geld: { openstaand: null } },
  ], '2026-11-03');
  assert.deepEqual(c.perFase.bij_incasso, { aantal: 2, openstaand: 150, overgedragen: 130 });
  assert.equal(c.perFase.doorgezet.aantal, 1);
  assert.equal(c.checkTeLaat, 1);
});

// ── Machine-route ────────────────────────────────────────────────────────

function nepRes() {
  return { code: 0, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
}

test('machine-route: geheim verplicht, GET geeft het overzicht, POST een actie', async () => {
  const oud = { ...process.env };
  process.env.DFO_LMS_PUSH_SECRET = 'geheim-123';
  try {
    const db = maakNepDb();
    db.reset(basis());
    const h = maakHandler({ crm: db.client, lms: null, ghl: async () => ({ ok: false, reden: 'ghl_geen_scope' }), motor: null, pipeline: null, nu: NU });
    let res = nepRes();
    await h({ method: 'GET', headers: { 'x-dfo-secret': 'fout' }, query: {} }, res);
    assert.equal(res.code, 403);
    res = nepRes();
    await h({ method: 'GET', headers: { 'x-dfo-secret': 'geheim-123' }, query: {} }, res);
    assert.equal(res.code, 200);
    assert.equal(res.body.data.rijen[0].fase, 'te_bepalen');
    assert.equal(res.body.data.ghl.reden, 'ghl_geen_scope');
    res = nepRes();
    await h({ method: 'POST', headers: { 'x-dfo-secret': 'geheim-123' }, body: { actie: 'kies_fase', customer_id: K, fase: 'mag_naar_incasso', notitie: 'eerst bellen', actor: ADMIN } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
  } finally {
    process.env = oud;
  }
});

// ── Het bord (5 nov 2026) ────────────────────────────────────────────────

test('bord: doorzetten zonder voorstel maakt het traject en zet de check op +14; tweede keer = al', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [] }));
  let u = await actie(db, { actie: 'doorzetten', customer_id: K, lms_student_id: 'stu-9', naam: 'Proef Klant', actor: ADMIN });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const t = db.rows('incasso_trajecten')[0];
  assert.equal(t.lms_student_id, 'stu-9');
  assert.equal(t.volgende_check, '2026-11-17');
  assert.equal(db.rows('mentor_commissie_incasso')[0].status, 'bij_incasso');
  const ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU });
  assert.equal(ov.rijen[0].fase, 'doorgezet');
  assert.equal(ov.rijen[0].volgende_check, '2026-11-17');
  u = await actie(db, { actie: 'doorzetten', customer_id: K, actor: ADMIN });
  assert.equal(u.status, 200);
  assert.equal(u.body.data.al, true);
  assert.equal(db.rows('incasso_trajecten').length, 1);
});

test('bord: mislukte status bij doorzetten zonder voorstel laat geen half traject', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [] }));
  const stuk = deps(db, { zetStatus: async () => { throw Object.assign(new Error('Migratie ontbreekt'), { status: 503, code: 'MIGRATIE_ONTBREEKT' }); } });
  const u = await actie(db, { actie: 'doorzetten', customer_id: K, actor: ADMIN }, stuk);
  assert.equal(u.status, 503);
  assert.equal(db.rows('incasso_trajecten').length, 0);
});

test('bord: Betaald vanuit Mag naar incasso sluit het traject zonder status; doorschuiven kijkt vooruit', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [] }));
  await actie(db, { actie: 'voorstel', customer_id: K, actor: SEPPE });
  let u = await actie(db, { actie: 'doorschuiven', customer_id: K, datum: '2026-11-03', actor: SEPPE });
  assert.equal(u.status, 400, 'vandaag is geen doorschuiven');
  u = await actie(db, { actie: 'doorschuiven', customer_id: K, datum: '2026-11-06', actor: SEPPE });
  assert.equal(u.status, 200);
  assert.equal(db.rows('incasso_trajecten')[0].volgende_check, '2026-11-06');
  u = await actie(db, { actie: 'afsluiten', customer_id: K, als: 'betaald', notitie: 'overschrijving gezien', actor: SEPPE });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(db.rows('incasso_trajecten')[0].gesloten_als, 'betaald');
  assert.equal(db.rows('mentor_commissie_incasso').length, 0, 'geen incassostatus gezet');
});

test('status zonder traject (met de hand gezet): de eerste opvolgactie maakt het traject, de status blijft', async () => {
  const db = maakNepDb();
  db.reset(basis({ onboardings: [], mentor_commissie_incasso: [
    { id: 'm1', customer_id: K, deal_id: null, sinds: '2026-11-05', reden: 'bureau', bron: 'handmatig', gezet_op: '2026-11-05T10:00:00Z', opgeheven_op: null, status: 'bij_incasso', afgesloten_als: null, incasso_sinds: '2026-11-05' },
  ] }));
  let ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU });
  assert.equal(ov.rijen[0].fase, 'doorgezet');
  let u = await actie(db, { actie: 'vink', customer_id: K, item: 'restfactuur', actor: SEPPE });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  assert.equal(db.rows('incasso_trajecten').length, 1);
  assert.equal(db.rows('incasso_trajecten')[0].herkomst, 'bestaand');
  u = await actie(db, { actie: 'notitie', customer_id: K, notitie: 'bureau gebeld', actor: SEPPE });
  assert.equal(u.status, 200);
  assert.equal(db.rows('incasso_trajecten').length, 1, 'geen tweede traject');
  assert.equal(db.rows('mentor_commissie_incasso').length, 1, 'status onaangeroerd');
  ov = await laadIncassoOverzicht({ crm: db.client, lms: null, nu: NU });
  assert.equal(ov.rijen[0].fase, 'doorgezet');
});
