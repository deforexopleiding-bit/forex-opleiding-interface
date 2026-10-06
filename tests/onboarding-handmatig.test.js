// tests/onboarding-handmatig.test.js — met de hand afronden, het bewijs
// "waarschijnlijk al gestart", de 14-dagenregel voor de intake-pot en de
// stand "overgeslagen" (Maxim, 6 oktober 2026).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  onboardingAfgesloten, afgeslotenOp, afgeslotenDoor, lmsStandVoor,
} from '../api/_lib/onboarding-einde.js';
import {
  vulHandmatigAan, rondOnboardingHandmatigAf, isHandmatigKolomOntbreekt,
} from '../api/_lib/onboarding-handmatig.js';
import { alGestartBewijs, heeftBewijs } from '../api/_lib/onboarding-al-gestart.js';
import {
  dagenTotStart, snelleStart, hoortVanzelfInPot, INTAKE_POT_MIN_DAGEN, intakePotMinDagen,
} from '../api/_lib/onboarding-intake-spiegel.js';
import { intakeGesprekStand } from '../api/_lib/intake-gesprek-stand.js';

test('EINDE: met de hand afgerond telt als afgesloten, los van de wizardstatus', () => {
  const ob = { status: 'bezig', handmatig_afgerond_op: '2026-10-06T10:00:00Z' };
  assert.equal(onboardingAfgesloten(ob), true);
  assert.equal(afgeslotenOp(ob), '2026-10-06T10:00:00Z');
  assert.equal(afgeslotenDoor(ob), 'handmatig');
  assert.equal(lmsStandVoor(ob), 'afgerond');
  // De sessie wint als bron als ze er allebei zijn: aparte kolommen.
  assert.equal(afgeslotenDoor({ status: 'afgerond', auto_afgerond_op: 'x', handmatig_afgerond_op: 'y' }), 'sessie');
  // Wizard voltooid zonder iets: niet afgesloten.
  assert.equal(onboardingAfgesloten({ status: 'afgerond' }), false);
  assert.equal(lmsStandVoor({ status: 'afgerond' }), 'wizard_voltooid');
  // Een geannuleerde blijft geannuleerd.
  assert.equal(onboardingAfgesloten({ status: 'geannuleerd', handmatig_afgerond_op: 'y' }), false);
});

function nepDb({ onboarding, kolomOntbreekt = false } = {}) {
  const log = { updates: [], inserts: [] };
  return {
    log,
    from(t) {
      let filter = {};
      let upd = null;
      const q = {
        select(kol) { q._kol = kol; return q; },
        eq(k, v) { filter[k] = v; return q; },
        in() { return q; },
        is(k, v) { filter['is_' + k] = v; return q; },
        update(v) { upd = v; return q; },
        insert(v) { log.inserts.push({ t, v }); return Promise.resolve({ error: null }); },
        maybeSingle() { return Promise.resolve({ data: onboarding, error: null }); },
        then(ok) {
          if (kolomOntbreekt && (upd || /handmatig/.test(q._kol || ''))) {
            return Promise.resolve({ data: null, error: { code: '42703', message: 'column onboardings.handmatig_afgerond_op does not exist' } }).then(ok);
          }
          if (upd) { log.updates.push(upd); Object.assign(onboarding, upd); return Promise.resolve({ data: [{ id: onboarding.id }], error: null }).then(ok); }
          return Promise.resolve({ data: [onboarding], error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

test('AFRONDEN: reden verplicht, schrijft drie velden en een tijdlijnregel', async () => {
  const ob = { id: 'o1', status: 'bezig', archived_at: null };
  const db = nepDb({ onboarding: ob });
  assert.equal((await rondOnboardingHandmatigAf({ onboardingId: 'o1', reden: 'kort', door: 'x', db })).status, 400);
  const r = await rondOnboardingHandmatigAf({ onboardingId: 'o1', reden: 'traject loopt al, calls in Bubble', door: 'Maxim', db });
  assert.equal(r.status, 200);
  assert.equal(db.log.updates.length, 1);
  assert.equal(db.log.updates[0].handmatig_afgerond_door, 'Maxim');
  assert.equal(db.log.updates[0].handmatig_afgerond_reden, 'traject loopt al, calls in Bubble');
  assert.match(db.log.inserts[0].v.note, /met de hand afgerond door Maxim\. Reden: traject loopt al/);
  // De wizardstatus blijft wat hij was.
  assert.equal(ob.status, 'bezig');
});

test('AFRONDEN: geannuleerd mag niet, en vóór de migratie een duidelijke 503', async () => {
  const geann = nepDb({ onboarding: { id: 'o1', status: 'geannuleerd' } });
  assert.equal((await rondOnboardingHandmatigAf({ onboardingId: 'o1', reden: 'traject loopt al', door: 'x', db: geann })).status, 409);
  const zonder = nepDb({ onboarding: { id: 'o1', status: 'bezig' }, kolomOntbreekt: true });
  const r = await rondOnboardingHandmatigAf({ onboardingId: 'o1', reden: 'traject loopt al', door: 'x', db: zonder });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, 'migratie_ontbreekt');
});

test('LEZEN VÓÓR DE MIGRATIE: niemand met de hand afgerond, geen fout', async () => {
  const rij = { id: 'o1', status: 'bezig' };
  await vulHandmatigAan(nepDb({ onboarding: rij, kolomOntbreekt: true }), [rij]);
  assert.equal(onboardingAfgesloten(rij), false);
  assert.equal(isHandmatigKolomOntbreekt({ code: '42703', message: 'handmatig_afgerond_op' }), true);
  assert.equal(isHandmatigKolomOntbreekt({ code: '42501', message: 'x' }), false);
});

test('BEWIJS: afgeronde sessies en calls van vóór het LMS, per student', async () => {
  const lms = {
    from(t) {
      const q = {
        select() { return q; }, in() { return q; }, eq() { return q; }, order() { return q; },
        then(ok) {
          const data = t === 'hlms_sessie'
            ? [{ student_id: 's1', start_tijd: '2026-09-01T10:00:00Z', titel: 'Opstart' },
               { student_id: 's1', start_tijd: '2026-09-15T10:00:00Z', titel: 'Call 2' }]
            : [{ id: 's1', calls_startsaldo: 0, calls_gedaan: 2 }, { id: 's2', calls_startsaldo: 4, calls_gedaan: 4 }];
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      return q;
    },
  };
  const m = await alGestartBewijs(['s1', 's2', 's3'], lms);
  assert.deepEqual(m.get('s1'), { afgeronde_sessies: 2, eerste_op: '2026-09-01T10:00:00Z', eerste_titel: 'Opstart', laatste_op: '2026-09-15T10:00:00Z', calls_startsaldo: 0, calls_gedaan: 2 });
  assert.equal(heeftBewijs(m.get('s1')), true);
  assert.equal(heeftBewijs(m.get('s2')), true);
  assert.equal(heeftBewijs(m.get('s3')), false);
  // Onleesbaar = onbekend (null), nooit "geen bewijs".
  const stuk = { from() { const q = { select() { return q; }, in() { return q; }, eq() { return q; }, order() { return q; }, then(ok) { return Promise.resolve({ data: null, error: { message: 'stuk' } }).then(ok); } }; return q; } };
  assert.equal(await alGestartBewijs(['s1'], stuk), null);
});

test('14-DAGENREGEL: snelle start niet in de pot, late of onbekende start wel', () => {
  assert.equal(INTAKE_POT_MIN_DAGEN, 14);
  const vanaf = '2026-10-06T00:00:00+02:00';
  const closen = '2026-10-07T09:00:00Z';
  assert.equal(dagenTotStart({ created_at: closen, start_date: '2026-10-21' }), 14);
  assert.equal(snelleStart({ created_at: closen, start_date: '2026-10-21' }, 14), true);
  assert.equal(hoortVanzelfInPot({ created_at: closen, start_date: '2026-10-21' }, vanaf, 14), false);
  assert.equal(hoortVanzelfInPot({ created_at: closen, start_date: '2026-10-22' }, vanaf, 14), true);
  assert.equal(hoortVanzelfInPot({ created_at: closen, start_date: null }, vanaf, 14), true);
  // 0 = altijd in de pot (het gedrag van vóór 6 oktober).
  assert.equal(hoortVanzelfInPot({ created_at: closen, start_date: '2026-10-08' }, vanaf, 0), true);
  assert.equal(intakePotMinDagen({ INTAKE_POT_MIN_DAGEN: '21' }), 21);
  assert.equal(intakePotMinDagen({ INTAKE_POT_MIN_DAGEN: 'x' }), 14);
});

test('OVERGESLAGEN: eigen stand, nooit "te laat", en een klare intake blijft ter goedkeuring', () => {
  const nu = Date.parse('2026-10-10T00:00:00Z');
  const basis = { aangemeld_op: '2026-10-06T00:00:00Z', crm_stand: 'open', goedgekeurd_op: null };
  const g = intakeGesprekStand({ ...basis, overgeslagen_op: '2026-10-07T10:00:00Z', overgeslagen_reden: 'Eerste sessie ingepland' }, new Map(), nu);
  assert.equal(g.stand, 'overgeslagen');
  assert.equal(g.te_laat, false);
  const klaar = intakeGesprekStand({ ...basis, afgerond_op: '2026-10-07T00:00:00Z', afgerond_door: 'm', overgeslagen_op: null }, new Map(), nu);
  assert.equal(klaar.stand, 'ter_goedkeuring');
});
