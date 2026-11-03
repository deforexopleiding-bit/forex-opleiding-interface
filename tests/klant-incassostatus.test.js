// tests/klant-incassostatus.test.js
//
// PR 3 — één incassostatus per klant met historiek (api/_lib/klant-incassostatus.js):
//   * zetten sluit de vorige rij en opent een nieuwe (wie, wanneer, reden);
//   * opheffen = terug naar actief; afgesloten vraagt betaald/oninbaar;
//   * incasso_sinds blijft het begin van de keten;
//   * commissieStop: bij_incasso staat stil, regeling telt, oninbaar niets;
//   * zonder de nieuwe kolommen: enkel bij_incasso (het oude gedrag);
//   * labels voor de mentor zonder vrije tekst.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maakNepDb } from './_nep-db.js';
import { zetStatus, huidigeStatus, commissieStop, mentorLabel, laadIncassoRijen } from '../api/_lib/klant-incassostatus.js';

const K = '11111111-1111-4111-8111-111111111111';
const db = maakNepDb();
const rijen = () => db.rows('mentor_commissie_incasso');

test('status zetten: historiek, wie en reden; incasso_sinds blijft het begin', async () => {
  db.reset({ mentor_commissie_incasso: [] });
  await zetStatus(db.client, { customerId: K, status: 'bij_incasso', sinds: '2026-10-01', reden: 'naar bureau', actorId: 'maxim' });
  await zetStatus(db.client, { customerId: K, status: 'incasso_regeling', sinds: '2026-11-03', reden: 'regeling 12 × 50', actorId: 'maxim' });
  assert.equal(rijen().length, 2);
  const [oud, nieuw] = rijen();
  assert.ok(oud.opgeheven_op, 'vorige rij gesloten');
  assert.equal(oud.opgeheven_door, 'maxim');
  assert.match(oud.opheffen_reden, /Incasso-regeling: regeling/);
  assert.equal(nieuw.status, 'incasso_regeling');
  assert.equal(nieuw.incasso_sinds, '2026-10-01');
  assert.equal(nieuw.gezet_door, 'maxim');
  assert.equal(huidigeStatus(rijen(), K).status, 'incasso_regeling');
});

test('opheffen → actief; afgesloten zonder betaald/oninbaar geweigerd; dubbel geweigerd', async () => {
  db.reset({ mentor_commissie_incasso: [] });
  await zetStatus(db.client, { customerId: K, status: 'bij_incasso', sinds: '2026-10-01', reden: 'bureau' });
  await assert.rejects(zetStatus(db.client, { customerId: K, status: 'bij_incasso', sinds: '2026-10-02', reden: 'nog eens' }), (e) => e.code === 'AL_GEZET');
  await assert.rejects(zetStatus(db.client, { customerId: K, status: 'afgesloten', sinds: '2026-12-01', reden: 'klaar' }), (e) => e.code === 'AFGESLOTEN_ALS');
  await assert.rejects(zetStatus(db.client, { customerId: K, status: 'bij_incasso', sinds: '2026-10-01', reden: 'x' }), (e) => e.code === 'REDEN');
  await zetStatus(db.client, { customerId: K, status: 'actief', reden: 'betaald na aanmaning' });
  assert.equal(huidigeStatus(rijen(), K).status, 'actief');
  assert.equal(rijen().length, 1, 'opheffen opent geen nieuwe rij');
});

test('commissieStop: bij_incasso staat stil, regeling en betaald tellen, oninbaar vanaf het begin', () => {
  assert.equal(commissieStop({ status: 'bij_incasso', sinds: '2026-10-01' }), '2026-10-01');
  assert.equal(commissieStop({ status: 'incasso_regeling', sinds: '2026-11-01' }), null);
  assert.equal(commissieStop({ status: 'afgesloten', afgesloten_als: 'betaald', sinds: '2026-12-01' }), null);
  assert.equal(commissieStop({ status: 'afgesloten', afgesloten_als: 'oninbaar', sinds: '2026-12-01', incasso_sinds: '2026-10-01' }), '2026-10-01');
  assert.equal(commissieStop({ sinds: '2026-10-01' }), '2026-10-01', 'zonder kolom = bij_incasso');
  assert.equal(commissieStop({ status: 'bij_incasso', sinds: '2026-10-01', opgeheven_op: '2026-11-01' }), null);
});

test('zonder de nieuwe kolommen: rijen lezen als bij_incasso, regeling zetten geweigerd', async () => {
  db.reset({ mentor_commissie_incasso: [] });
  // Nep: een select met de statuskolommen faalt zoals PostgREST (42703).
  const orig = db.client.from;
  db.client.from = (t) => {
    const k = orig(t);
    const sel = k.select;
    k.select = (cols) => (String(cols || '').includes('afgesloten_als')
      ? { in: () => ({ is: () => Promise.resolve({ data: null, error: { code: '42703', message: 'column mentor_commissie_incasso.status does not exist' } }), then: (r) => r({ data: null, error: { code: '42703', message: 'column mentor_commissie_incasso.status does not exist' } }) }) }
      : sel(cols));
    return k;
  };
  try {
    const r = await laadIncassoRijen(db.client, [K]);
    assert.equal(r.statusKolommen, false);
    await assert.rejects(zetStatus(db.client, { customerId: K, status: 'incasso_regeling', sinds: '2026-11-01', reden: 'regeling' }), (e) => e.code === 'MIGRATIE_ONTBREEKT');
    await zetStatus(db.client, { customerId: K, status: 'bij_incasso', sinds: '2026-10-01', reden: 'bureau' });
    assert.equal(rijen()[0].status, undefined, 'zonder kolom geen status weggeschreven');
  } finally { db.client.from = orig; }
});

test('mentorlabel: geen vrije tekst, wel reden en verwachting', () => {
  const m = mentorLabel({ marking: { status: 'bij_incasso', sinds: '2026-10-01', reden: 'GEHEIM' } });
  assert.equal(m.code, 'bij_incasso');
  assert.equal(m.tekst, 'Bij incasso sinds 01-10-2026');
  assert.ok(!JSON.stringify(m).includes('GEHEIM'));
  assert.equal(mentorLabel({ marking: { status: 'incasso_regeling', sinds: '2026-11-01' } }).code, 'regeling');
  assert.equal(mentorLabel({ marking: { status: 'afgesloten', afgesloten_als: 'oninbaar' } }).code, 'weggevallen');
  assert.equal(mentorLabel({ marking: { status: 'afgesloten', afgesloten_als: 'betaald' } }), null);
  assert.equal(mentorLabel({ saleGeannuleerd: true }).code, 'geannuleerd');
});
