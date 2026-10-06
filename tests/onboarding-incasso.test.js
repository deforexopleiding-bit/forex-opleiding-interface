// tests/onboarding-incasso.test.js — naar incasso-opvolging, NIET annuleren
// (Maxim, 6 oktober 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inIncasso, zetNaarIncasso, activeerUitIncasso, isIncassoKolomOntbreekt } from '../api/_lib/onboarding-incasso.js';
import { hoortZichtbaarTeZijn } from '../api/_lib/onboarding-spiegel.js';
import { crmStandVoorIntake } from '../api/_lib/onboarding-intake-spiegel.js';

test('IN INCASSO: gezet en (nog) niet terug; opnieuw erin na een terugkeer telt ook', () => {
  assert.equal(inIncasso({ incasso_op: '2026-10-06T10:00:00Z' }), true);
  assert.equal(inIncasso({ incasso_op: '2026-10-06T10:00:00Z', incasso_terug_op: '2026-10-08T10:00:00Z' }), false);
  assert.equal(inIncasso({ incasso_op: '2026-10-09T10:00:00Z', incasso_terug_op: '2026-10-08T10:00:00Z' }), true);
  assert.equal(inIncasso({}), false);
});

test('UIT DE ACTIEVE LIJSTEN: niet in de LMS-spiegel, vervallen in de intake-pot', () => {
  const ob = { status: 'bezig', archived_at: null, incasso_op: '2026-10-06T10:00:00Z' };
  assert.equal(hoortZichtbaarTeZijn(ob), false);
  assert.equal(crmStandVoorIntake(ob), 'vervallen');
  assert.equal(hoortZichtbaarTeZijn({ ...ob, incasso_terug_op: '2026-10-07T10:00:00Z' }), true);
});

function nepDb(onboarding, { kolomOntbreekt = false } = {}) {
  const log = { updates: [], inserts: [] };
  return {
    log,
    from(t) {
      let upd = null;
      const q = {
        select(k) { q._k = k; return q; }, eq() { return q; }, in() { return q; },
        update(v) { upd = v; return q; },
        insert(v) { log.inserts.push({ t, v }); return Promise.resolve({ error: null }); },
        maybeSingle() { return Promise.resolve({ data: onboarding, error: null }); },
        then(ok) {
          if (kolomOntbreekt && (upd || /incasso_/.test(q._k || ''))) {
            return Promise.resolve({ data: null, error: { code: '42703', message: 'column onboardings.incasso_op does not exist' } }).then(ok);
          }
          if (upd) { log.updates.push(upd); Object.assign(onboarding, upd); return Promise.resolve({ data: [onboarding], error: null }).then(ok); }
          return Promise.resolve({ data: [onboarding], error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

test('NAAR INCASSO: reden verplicht, zet alleen de incasso-velden — status blijft', async () => {
  const ob = { id: 'o1', status: 'bezig', archived_at: null };
  const db = nepDb(ob);
  assert.equal((await zetNaarIncasso({ onboardingId: 'o1', reden: 'kort', door: 'x', db })).status, 400);
  const r = await zetNaarIncasso({ onboardingId: 'o1', reden: 'Bedenktijd voorbij, geen contact', door: 'Maxim', db });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(db.log.updates[0]).sort(), ['incasso_door', 'incasso_op', 'incasso_reden']);
  assert.equal(ob.status, 'bezig');
  assert.match(db.log.inserts[0].v.note, /niet geannuleerd/);
  // Al in incasso: niets opnieuw.
  assert.equal((await zetNaarIncasso({ onboardingId: 'o1', reden: 'nog eens erin', door: 'x', db })).body.al_in_incasso, true);
});

test('NAAR INCASSO: geannuleerd mag niet; vóór de migratie een duidelijke 503', async () => {
  assert.equal((await zetNaarIncasso({ onboardingId: 'o1', reden: 'geen contact meer', door: 'x', db: nepDb({ id: 'o1', status: 'geannuleerd' }) })).status, 409);
  const r = await zetNaarIncasso({ onboardingId: 'o1', reden: 'geen contact meer', door: 'x', db: nepDb({ id: 'o1', status: 'bezig' }, { kolomOntbreekt: true }) });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'migratie_ontbreekt');
  assert.equal(isIncassoKolomOntbreekt({ code: '42501', message: 'x' }), false);
});

test('TERUG ACTIEF: eerst de startdatum via de bestaande route; weigert die, dan blijft hij in incasso', async () => {
  const ob = { id: 'o1', status: 'bezig', archived_at: null, incasso_op: '2026-10-06T10:00:00Z' };
  const db = nepDb(ob);
  const teVroeg = async () => ({ status: 400, body: { error: 'start_date te vroeg', code: 'START_DATE_TOO_EARLY' } });
  const r1 = await activeerUitIncasso({ onboardingId: 'o1', startDatum: '2026-10-07', door: 'x', db, zetStartdatum: teVroeg });
  assert.equal(r1.status, 400);
  assert.equal(db.log.updates.length, 0);
  const gezet = [];
  const lukt = async (p) => { gezet.push(p); return { status: 200, body: { ok: true } }; };
  const r2 = await activeerUitIncasso({ onboardingId: 'o1', startDatum: '2026-11-02', door: 'Maxim', db, zetStartdatum: lukt });
  assert.equal(r2.status, 200);
  assert.equal(gezet[0].startDatum, '2026-11-02');
  assert.ok(db.log.updates[0].incasso_terug_op);
  // De geschiedenis blijft: incasso_op wordt niet gewist.
  assert.equal(ob.incasso_op, '2026-10-06T10:00:00Z');
  assert.equal(inIncasso(ob), false);
});

test('GEEN TWEEDE ANNULEERPAD: het incassobestand raakt facturen, abonnementen, Bubble en status niet', () => {
  const bron = readFileSync(new URL('../api/_lib/onboarding-incasso.js', import.meta.url), 'utf8');
  assert.doesNotMatch(bron, /from\('(invoices|subscriptions|deals)'\)/);
  assert.doesNotMatch(bron, /bubblePatch|tlFetch|createNotification|sendEmail|sendWhatsApp/);
  assert.doesNotMatch(bron, /status:\s*'geannuleerd'/);
});
