// tests/onboarding-heropenen.test.js — een MET DE HAND afgeronde onboarding
// heropenen (Maxim, 10 nov 2026; aanleiding Laurens Rasti).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { besluitHeropenen, heropenOnboardingHandmatig } from '../api/_lib/onboarding-handmatig.js';
import { wizardDoorKlantVoltooid } from '../api/_lib/onboarding-einde.js';

const OP = '2026-11-10T10:47:57.844+00:00';
const hand = (x = {}) => ({ id: 'o1', status: 'afgerond', completed_at: OP, handmatig_afgerond_op: OP, handmatig_afgerond_door: 'maxim via het LMS', handmatig_afgerond_reden: 'Traject loopt al: .', ...x });
const b = (ob) => besluitHeropenen(ob, { wizardDoorKlantVoltooid });

test('BESLUIT: met de hand afgerond, wizard nooit gestart → aangemeld, completed_at + handmatig_* leeg', () => {
  const r = b(hand());
  assert.equal(r.ok, true);
  assert.deepEqual(r.patch, { handmatig_afgerond_op: null, handmatig_afgerond_door: null, handmatig_afgerond_reden: null, status: 'aangemeld', completed_at: null });
});

test('BESLUIT: wizard gestart → bezig', () => {
  assert.equal(b(hand({ started_at: '2026-11-08T09:00:00Z' })).patch.status, 'bezig');
});

test('BESLUIT: klant voltooide de wizard zelf vóór het afronden → status afgerond + wizardmoment blijven', () => {
  const r = b(hand({ completed_at: '2026-11-09T09:00:00Z', started_at: '2026-11-08T09:00:00Z' }));
  assert.equal(r.ok, true);
  assert.equal(r.wizardBehouden, true);
  assert.equal('status' in r.patch, false);
  assert.equal('completed_at' in r.patch, false);
  assert.equal(r.patch.handmatig_afgerond_op, null);
});

test('BESLUIT: niet voor afsluiting door een sessie / automatisch, niet voor niet-afgerond of geannuleerd', () => {
  assert.equal(b(hand({ auto_afgerond_op: OP, auto_afgerond_sessie_id: 's1' })).code, 'automatisch_afgerond');
  assert.equal(b(hand({ auto_afgerond_op: OP })).code, 'automatisch_afgerond');
  assert.equal(b(hand({ handmatig_afgerond_op: null })).code, 'niet_handmatig_afgerond');
  assert.equal(b(hand({ status: 'geannuleerd' })).code, 'niet_actief');
  assert.equal(b(null).status, 404);
});

function nepDb(ob, { geenRijBijUpdate = false } = {}) {
  const log = { updates: [], inserts: [] };
  return {
    log,
    from(t) {
      let upd = null;
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; }, not() { return q; }, is() { return q; },
        update(v) { upd = v; return q; },
        insert(v) { log.inserts.push({ t, v }); return Promise.resolve({ error: null }); },
        maybeSingle() { return Promise.resolve({ data: { ...ob }, error: null }); },
        then(ok) {
          if (upd) {
            if (geenRijBijUpdate) return Promise.resolve({ data: [], error: null }).then(ok);
            log.updates.push(upd); Object.assign(ob, upd);
            return Promise.resolve({ data: [{ id: ob.id }], error: null }).then(ok);
          }
          return Promise.resolve({ data: [ob], error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

test('HEROPENEN: reden verplicht; audit_log met wie/reden/before/after; tijdlijn; spiegel meteen', async () => {
  const ob = hand();
  const db = nepDb(ob);
  const gespiegeld = [];
  const spiegel = async (id) => { gespiegeld.push(id); return { resultaat: 'geschreven' }; };
  assert.equal((await heropenOnboardingHandmatig({ onboardingId: 'o1', reden: 'kort', door: 'x', db, spiegel })).status, 400);
  const r = await heropenOnboardingHandmatig({ onboardingId: 'o1', reden: 'per vergissing afgerond bij offertewissel', door: 'Maxim', doorUserId: null, db, spiegel });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(ob.status, 'aangemeld');
  assert.equal(ob.completed_at, null);
  assert.equal(ob.handmatig_afgerond_op, null);
  const audit = db.log.inserts.find((i) => i.t === 'audit_log').v;
  assert.equal(audit.action, 'onboarding.heropend');
  assert.equal(audit.before_json.status, 'afgerond');
  assert.equal(audit.before_json.handmatig_afgerond_op, OP);
  assert.equal(audit.after_json.status, 'aangemeld');
  assert.match(audit.reason_text, /Heropend door Maxim\. Reden: per vergissing/);
  assert.ok(db.log.inserts.find((i) => i.t === 'onboarding_mentor_updates'));
  assert.deepEqual(gespiegeld, ['o1']);
});

test('HEROPENEN: twee kliks tegelijk → de tweede verandert niets', async () => {
  const db = nepDb(hand(), { geenRijBijUpdate: true });
  const r = await heropenOnboardingHandmatig({ onboardingId: 'o1', reden: 'dubbele klik test', door: 'x', db, spiegel: async () => ({}) });
  assert.equal(r.status, 409);
  assert.equal(db.log.inserts.length, 0);
});

test('BRON: zelfde pad en rechten als handmatig afronden (CRM-scherm + LMS-brug)', () => {
  const ep = readFileSync(new URL('../api/onboarding-handmatig-afronden.js', import.meta.url), 'utf8');
  assert.match(ep, /body\.actie === 'heropenen' \? heropenOnboardingHandmatig : rondOnboardingHandmatigAf/);
  assert.match(ep, /scope\.seesAll/);
  const brug = readFileSync(new URL('../api/lms-onboarding-sessie.js', import.meta.url), 'utf8');
  assert.match(brug, /actie === 'heropenen'[\s\S]{0,400}heropenOnboardingHandmatig/);
});
