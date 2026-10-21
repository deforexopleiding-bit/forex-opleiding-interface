// tests/onboarding-incasso-kaart.test.js — naar incasso geeft Dave een kaart,
// terug actief sluit hem (Maxim, 7 oktober 2026). Alleen nep-databanken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openIncassoKaart, sluitIncassoKaart, INCASSO_SOORT } from '../api/_lib/onboarding-incasso-kaart.js';
import { zetNaarIncasso, activeerUitIncasso } from '../api/_lib/onboarding-incasso.js';

function nepLms({ open = [], insertFout = null } = {}) {
  const log = { inserts: [], updates: [], filters: [] };
  return {
    log,
    from(t) {
      const q = { _t: t, _upd: null, _ins: null };
      Object.assign(q, {
        select() { return q; }, eq(k, v) { log.filters.push([t, 'eq', k, v]); return q; },
        in(k, v) { log.filters.push([t, 'in', k, v]); return q; },
        or(f) { log.filters.push([t, 'or', f]); return q; },
        insert(v) { q._ins = v; log.inserts.push({ t, v }); return q; },
        update(v) { q._upd = v; log.updates.push({ t, v }); return q; },
        single() { return Promise.resolve(insertFout ? { data: null, error: insertFout } : { data: { id: 'sig-nieuw' }, error: null }); },
        then(ok) {
          if (q._ins || q._upd) return Promise.resolve({ error: null }).then(ok);
          return Promise.resolve({ data: open.map((id) => ({ id })), error: null }).then(ok);
        },
      });
      return q;
    },
  };
}

test('OPENEN: bak admin, soort incasso_opvolging, student + onboarding, met tijdlijn', async () => {
  const lms = nepLms();
  const r = await openIncassoKaart({ onboardingId: 'ob1', studentId: 'st1', naam: 'Ebenezer Adjei', reden: 'Geen contact', door: 'Maxim', lms });
  assert.equal(r.ok, true);
  assert.equal(r.signaal_id, 'sig-nieuw');
  const k = lms.log.inserts.find((i) => i.t === 'hlms_signaal').v;
  assert.equal(k.bak, 'admin');
  assert.equal(k.soort, INCASSO_SOORT);
  assert.equal(k.student_id, 'st1');
  assert.equal(k.crm_onboarding_id, 'ob1');
  assert.match(k.bewijs.reden, /Ebenezer Adjei.*Maxim.*Geen contact.*niet geannuleerd/);
  assert.ok(lms.log.inserts.find((i) => i.t === 'hlms_signaal_gebeurtenis' && i.v.soort === 'geopend'));
  assert.ok(lms.log.filters.some((f) => f[1] === 'or' && /student_id\.eq\.st1/.test(f[2])));
});

test('OPENEN: geen tweede kaart als er al een open staat; 23505 telt ook als "al open"', async () => {
  const lms = nepLms({ open: ['sig-oud'] });
  const r = await openIncassoKaart({ onboardingId: 'ob1', reden: 'x', door: 'y', lms });
  assert.deepEqual([r.ok, r.al_open, r.signaal_id], [true, true, 'sig-oud']);
  assert.equal(lms.log.inserts.length, 0);
  const r2 = await openIncassoKaart({ onboardingId: 'ob1', reden: 'x', door: 'y', lms: nepLms({ insertFout: { code: '23505', message: 'dup' } }) });
  assert.equal(r2.al_open, true);
});

test('FAIL-SOFT: zonder LMS of bij een fout een ok:false, nooit een throw', async () => {
  assert.equal((await openIncassoKaart({ onboardingId: 'ob1', reden: 'x', door: 'y', lms: null })).ok, false);
  const r = await openIncassoKaart({ onboardingId: 'ob1', reden: 'x', door: 'y', lms: nepLms({ insertFout: { code: '42501', message: 'geweigerd' } }) });
  assert.deepEqual([r.ok, r.error], [false, 'geweigerd']);
});

test('SLUITEN: alle open incasso-kaarten van de klant afgehandeld, met reden en tijdlijn', async () => {
  const lms = nepLms({ open: ['a', 'b'] });
  const r = await sluitIncassoKaart({ onboardingId: 'ob1', studentId: 'st1', startDatum: '2026-11-02', door: 'Maxim', lms });
  assert.deepEqual([r.ok, r.gesloten], [true, 2]);
  const u = lms.log.updates[0].v;
  assert.equal(u.status, 'afgehandeld');
  assert.match(u.gesloten_reden, /Terug actief.*Maxim.*2026-11-02/);
  assert.equal(lms.log.inserts.filter((i) => i.v.soort === 'afgehandeld').length, 2);
  assert.equal((await sluitIncassoKaart({ onboardingId: 'ob1', door: 'x', lms: nepLms() })).gesloten, 0);
});

function nepDb(onboarding) {
  return {
    from() {
      let upd = null;
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; },
        update(v) { upd = v; return q; },
        insert() { return Promise.resolve({ error: null }); },
        maybeSingle() { return Promise.resolve({ data: onboarding, error: null }); },
        then(ok) { if (upd) Object.assign(onboarding, upd); return Promise.resolve({ data: [onboarding], error: null }).then(ok); },
      };
      return q;
    },
  };
}

test('NAAR INCASSO opent de kaart met student + naam; TERUG ACTIEF sluit hem', async () => {
  const ob = { id: 'o1', status: 'bezig', archived_at: null, customer_name: 'ER Schilderwerken', dfo_lms_student_id: 'st9' };
  const geopend = [], gesloten = [];
  const kaart = {
    open: async (p) => { geopend.push(p); return { ok: true, signaal_id: 's1' }; },
    sluit: async (p) => { gesloten.push(p); return { ok: true, gesloten: 1 }; },
  };
  const r = await zetNaarIncasso({ onboardingId: 'o1', reden: 'Bedenktijd voorbij, geen contact', door: 'Maxim', db: nepDb(ob), kaart });
  assert.equal(r.status, 200);
  assert.equal(r.body.incasso_kaart.signaal_id, 's1');
  assert.deepEqual([geopend[0].studentId, geopend[0].naam, geopend[0].door], ['st9', 'ER Schilderwerken', 'Maxim']);
  const t = await activeerUitIncasso({ onboardingId: 'o1', startDatum: '2026-11-02', door: 'Maxim', db: nepDb(ob), kaart,
    zetStartdatum: async () => ({ status: 200, body: { ok: true } }) });
  assert.equal(t.status, 200);
  assert.equal(gesloten[0].startDatum, '2026-11-02');
  assert.equal(t.body.incasso_kaart.gesloten, 1);
});

test('LMS MISLUKT BIJ NAAR INCASSO (21 okt): 502, en in het CRM is NIETS gewijzigd', async () => {
  const ob = { id: 'o1', status: 'bezig', archived_at: null };
  const r = await zetNaarIncasso({ onboardingId: 'o1', reden: 'Bedenktijd voorbij', door: 'x', db: nepDb(ob),
    kaart: { open: async () => ({ ok: false, error: 'LMS-koppeling niet geconfigureerd' }) } });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'lms_incasso_mislukt');
  assert.match(r.body.error, /LMS-koppeling niet geconfigureerd.*niets gewijzigd/);
  assert.equal(ob.incasso_op ?? null, null);
});

test('AL IN INCASSO, LMS-KANT ONTBRAK: een tweede poging herstelt het LMS, het CRM blijft zoals het is', async () => {
  const ob = { id: 'o1', status: 'bezig', archived_at: null, incasso_op: '2026-10-07T10:20:14Z', dfo_lms_student_id: 'st1' };
  const geopend = [];
  const r = await zetNaarIncasso({ onboardingId: 'o1', reden: 'geen reactie mentor', door: 'Maxim', db: nepDb(ob),
    kaart: { open: async (p) => { geopend.push(p); return { ok: true, signaal_id: 's1' }; } } });
  assert.deepEqual([r.status, r.body.al_in_incasso, geopend.length, geopend[0].studentId], [200, true, 1, 'st1']);
  assert.equal(ob.incasso_op, '2026-10-07T10:20:14Z');
});

test('LMS MISLUKT BIJ TERUG ACTIEF (21 okt): 502, hij blijft in incasso', async () => {
  const ob = { id: 'o1', status: 'bezig', archived_at: null, incasso_op: '2026-10-06T10:00:00Z' };
  const r = await activeerUitIncasso({ onboardingId: 'o1', startDatum: '2026-11-02', door: 'x', db: nepDb(ob),
    zetStartdatum: async () => ({ status: 200, body: { ok: true } }),
    kaart: { sluit: async () => ({ ok: false, error: 'time-out' }) } });
  assert.equal(r.status, 502);
  assert.equal(r.body.code, 'lms_terug_mislukt');
  assert.equal(ob.incasso_terug_op ?? null, null);
});

function nepLmsMetKern({ rpcFout = null, data = { ok: true, signaal_id: 'sig-kern', gesloten: 2 } } = {}) {
  const lms = nepLms();
  lms.log.rpc = [];
  lms.rpc = (naam, args) => { lms.log.rpc.push({ naam, args }); return Promise.resolve(rpcFout ? { data: null, error: rpcFout } : { data, error: null }); };
  return lms;
}

test('VIA DE LMS-KERN (21 okt): naar en terug gaan via hlms_incasso_vanuit_crm, niet via losse inserts', async () => {
  const lms = nepLmsMetKern();
  const r = await openIncassoKaart({ onboardingId: 'ob1', studentId: 'st1', naam: 'Vera Proef', reden: 'geen reactie', door: 'Maxim via het LMS (m@x.be)', lms });
  assert.deepEqual([r.ok, r.signaal_id, r.via], [true, 'sig-kern', 'lms_kern']);
  assert.equal(lms.log.rpc[0].naam, 'hlms_incasso_vanuit_crm');
  assert.deepEqual([lms.log.rpc[0].args.p_actie, lms.log.rpc[0].args.p_student, lms.log.rpc[0].args.p_onboarding], ['naar', 'st1', 'ob1']);
  assert.equal(lms.log.inserts.length, 0);
  const s = await sluitIncassoKaart({ onboardingId: 'ob1', studentId: 'st1', startDatum: '2026-11-02', door: 'Maxim', lms });
  assert.deepEqual([s.ok, s.gesloten], [true, 2]);
  assert.deepEqual([lms.log.rpc[1].args.p_actie, lms.log.rpc[1].args.p_datum], ['terug', '2026-11-02']);
  assert.equal(lms.log.updates.length, 0);
});

test('VIA DE LMS-KERN: vóór de LMS-migratie (PGRST202) de oude weg; een echte fout is ok:false', async () => {
  const oud = nepLmsMetKern({ rpcFout: { code: 'PGRST202', message: 'not found' } });
  const r = await openIncassoKaart({ onboardingId: 'ob1', studentId: 'st1', reden: 'x', door: 'y', lms: oud });
  assert.deepEqual([r.ok, r.signaal_id], [true, 'sig-nieuw']);
  assert.ok(oud.log.inserts.find((i) => i.t === 'hlms_signaal'));
  const stuk = nepLmsMetKern({ rpcFout: { code: '22023', message: 'kies een nieuwe startdatum, minstens drie dagen vooruit' } });
  const s = await sluitIncassoKaart({ onboardingId: 'ob1', studentId: 'st1', startDatum: '2026-10-22', door: 'y', lms: stuk });
  assert.deepEqual([s.ok, s.error], [false, 'kies een nieuwe startdatum, minstens drie dagen vooruit']);
});
