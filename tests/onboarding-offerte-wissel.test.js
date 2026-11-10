// tests/onboarding-offerte-wissel.test.js — "Deze offerte vervangt de lopende
// onboarding" (Maxim, 10 nov 2026). Aanleiding: Laurens Rasti, nieuwe offerte
// terwijl de onboarding uit de oude nog liep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  onboardingLoopt, redenNietVervangbaar, hoortBijOfferte, kanOfferteVervangen,
  studentPatchVoorWissel, controleerWissel, vervangOnboardingDoorOfferte, isDealKolomOntbreekt,
} from '../api/_lib/onboarding-offerte-wissel.js';

const KLANT = 'ff5e4766-6c4c-4a0c-84e7-000000000001';
const OB_ID = '0475a0f0-2685-4e8a-af25-000000000001';
const OUDE_DEAL = '233822a8-8852-4a24-9c2b-000000000001';
const NIEUWE_DEAL = 'b5d81a3c-02ba-46e7-ad71-000000000001';
const TR_12 = '11111111-1111-4111-8111-111111111112';
const TR_6 = '11111111-1111-4111-8111-111111111106';
const STUDENT = 'e0b47680-0000-4000-8000-000000000001';
const NU = new Date('2026-11-10T12:00:00Z');

const lopend = (x = {}) => ({ id: OB_ID, customer_id: KLANT, status: 'aangemeld', archived_at: null, created_at: '2026-11-07T10:00:00Z', ...x });
const getekend = (x = {}) => ({ id: NIEUWE_DEAL, customer_id: KLANT, tl_quotation_status: 'accepted', tl_quotation_accepted_at: '2026-11-10T10:42:47Z', ...x });
const traject6 = { id: TR_6, key: '1op1_6m', type: '1op1', label: '1-op-1 6 maanden', duur_maanden: 6, calls: 12, is_active: true };
const traject12 = { id: TR_12, key: '1op1_12m', type: '1op1', label: '1-op-1 12 maanden', duur_maanden: 12, calls: 24, is_active: true };

test('LOOPT: aangemeld, bezig en wizard voltooid lopen; afgesloten, geannuleerd, incasso niet', () => {
  assert.equal(onboardingLoopt(lopend()), true);
  assert.equal(onboardingLoopt(lopend({ status: 'bezig' })), true);
  assert.equal(onboardingLoopt(lopend({ status: 'afgerond' })), true, 'wizard voltooid, eerste call nog niet');
  assert.equal(onboardingLoopt(lopend({ status: 'afgerond', handmatig_afgerond_op: '2026-11-10T10:47:57Z' })), false);
  assert.equal(onboardingLoopt(lopend({ status: 'afgerond', auto_afgerond_op: 'x', auto_afgerond_sessie_id: 's' })), false);
  assert.equal(onboardingLoopt(lopend({ status: 'geannuleerd' })), false);
  assert.equal(onboardingLoopt(lopend({ archived_at: '2026-11-01T00:00:00Z' })), false);
  assert.equal(onboardingLoopt(lopend({ incasso_op: '2026-11-01T00:00:00Z' })), false);
  assert.equal(redenNietVervangbaar(lopend({ status: 'afgerond', handmatig_afgerond_op: 'x' })).code, 'afgesloten');
  assert.equal(redenNietVervangbaar(lopend()), null);
});

test('HOORT BIJ OFFERTE: deal_id beslist; zonder deal_id telt aangemeld-na-tekenen', () => {
  assert.equal(hoortBijOfferte(lopend({ deal_id: OUDE_DEAL }), getekend()), false);
  assert.equal(hoortBijOfferte(lopend({ deal_id: NIEUWE_DEAL }), getekend()), true);
  // Laurens: onboarding 7 nov, nieuwe offerte getekend 10 nov → niet van deze offerte.
  assert.equal(hoortBijOfferte(lopend(), getekend()), false);
  // Aangemeld nadat deze offerte getekend werd → wel (gewone gang van zaken vóór de kolom).
  assert.equal(hoortBijOfferte(lopend({ created_at: '2026-11-10T11:00:00Z' }), getekend()), true);
});

test('KNOP: alleen bij een getekende offerte van dezelfde klant en een lopende onboarding uit een andere offerte', () => {
  assert.equal(kanOfferteVervangen(lopend(), getekend()), true);
  assert.equal(kanOfferteVervangen(lopend(), getekend({ tl_quotation_status: 'sent' })), false);
  assert.equal(kanOfferteVervangen(lopend(), getekend({ customer_id: 'iemand-anders' })), false);
  assert.equal(kanOfferteVervangen(lopend({ deal_id: NIEUWE_DEAL }), getekend()), false);
  assert.equal(kanOfferteVervangen(lopend({ status: 'afgerond', handmatig_afgerond_op: 'x' }), getekend()), false);
});

test('STUDENT: nieuw traject → soort, maanden, calls, start, eind; overrides blijven staan', () => {
  const r = studentPatchVoorWissel({ student: { overrides: {} }, traject: traject6, startDate: '2027-03-01' });
  assert.equal(r.fout, null);
  assert.deepEqual(r.patch, { product_soort: 'mentorship', traject_maanden: 6, start_datum: '2027-03-01', calls_totaal: 12, eind_datum: '2027-09-01' });
  const m = studentPatchVoorWissel({
    student: { overrides: { eind_datum: { waarde: '2028-01-01', door: 'admin-edit' }, calls_totaal: { waarde: 30 } } },
    traject: traject6, startDate: '2027-03-01',
  });
  assert.equal('eind_datum' in m.patch, false);
  assert.equal('calls_totaal' in m.patch, false);
  assert.deepEqual(m.behouden.sort(), ['calls_totaal', 'eind_datum']);
  const mem = studentPatchVoorWissel({ student: null, traject: { type: 'membership', duur_maanden: 12, calls: 0 }, startDate: '2027-03-01' });
  assert.equal(mem.patch.product_soort, 'membership');
  assert.equal(mem.patch.calls_totaal, 0);
  assert.match(studentPatchVoorWissel({ student: null, traject: { type: 'iets' }, startDate: '2027-03-01' }).fout, /product_soort/);
});

test('CONTROLE: andere klant, niet getekend, te vroege nieuwe start → geweigerd; ongewijzigde start mag', () => {
  const ok = (x) => controleerWissel({ ob: lopend({ start_date: '2027-03-11' }), deal: getekend(), traject: traject6, startDate: '2027-03-01', nu: NU, ...x });
  assert.equal(ok().ok, true);
  assert.equal(ok({ deal: getekend({ customer_id: 'x' }) }).code, 'andere_klant');
  assert.equal(ok({ deal: getekend({ tl_quotation_status: 'sent' }) }).code, 'niet_getekend');
  assert.equal(ok({ startDate: '2026-11-11' }).ok, false);
  assert.equal(ok({ ob: lopend({ start_date: '2026-11-11' }), startDate: '2026-11-11' }).ok, true, 'start die al vastlag, mag blijven');
  assert.equal(ok({ ob: lopend({ deal_id: NIEUWE_DEAL }) }).code, 'al_deze_offerte');
  assert.equal(ok({ traject: { ...traject6, is_active: false } }).code, 'traject_niet_actief');
});

// ── Nep-databanken ─────────────────────────────────────────────────────────
function nepCrm({ ob, deal, trajecten, dealKolom = true, updateFout = null }) {
  const log = { updates: [], inserts: [] };
  return {
    log,
    from(t) {
      const st = { t, filter: {}, upd: null, kol: '' };
      const rij = () => {
        if (t === 'onboardings') return ob;
        if (t === 'deals') return deal && deal.id === st.filter.id ? deal : null;
        if (t === 'onboarding_trajecten') return trajecten.find((x) => x.id === st.filter.id) || null;
        return null;
      };
      const q = {
        select(k) { st.kol = k || ''; return q; },
        eq(k, v) { st.filter[k] = v; return q; },
        in() { return q; },
        is() { return q; },
        update(v) { st.upd = v; return q; },
        insert(v) { log.inserts.push({ t, v }); return Promise.resolve({ error: null }); },
        maybeSingle() {
          if (t === 'onboardings' && !dealKolom && /deal_id/.test(st.kol)) {
            return Promise.resolve({ data: null, error: { code: '42703', message: 'column onboardings.deal_id does not exist' } });
          }
          if (t === 'onboardings' && /handmatig|incasso/.test(st.kol)) return Promise.resolve({ data: ob, error: null });
          return Promise.resolve({ data: rij(), error: null });
        },
        then(okf) {
          if (st.upd) {
            if (!dealKolom && 'deal_id' in st.upd) return Promise.resolve({ error: { code: 'PGRST204', message: "Could not find the 'deal_id' column" } }).then(okf);
            if (updateFout) return Promise.resolve({ error: { message: updateFout } }).then(okf);
            log.updates.push({ t, v: st.upd });
            Object.assign(ob, st.upd);
            return Promise.resolve({ error: null }).then(okf);
          }
          return Promise.resolve({ data: [ob], error: null }).then(okf);
        },
      };
      return q;
    },
  };
}

function nepLms(student) {
  const log = { updates: [] };
  return {
    log,
    from() {
      const st = { upd: null };
      const q = {
        select() { return q; },
        eq() { return q; },
        update(v) { st.upd = v; return q; },
        maybeSingle() { return Promise.resolve({ data: student, error: null }); },
        then(okf) { if (st.upd) { log.updates.push(st.upd); Object.assign(student || {}, st.upd); } return Promise.resolve({ error: null }).then(okf); },
      };
      return q;
    },
  };
}

function scenario({ dealKolom = true, updateFout = null, student } = {}) {
  const ob = lopend({ traject_id: TR_12, start_date: '2027-03-11', deal_id: dealKolom ? OUDE_DEAL : undefined, dfo_lms_student_id: STUDENT, token: 'tok', startcode: 'ABCD2345', answers: { a: 1 } });
  const db = nepCrm({ ob, deal: getekend({ quote_reference: 'OFF-42' }), trajecten: [traject12, traject6], dealKolom, updateFout });
  const lmsStudent = student === undefined
    ? { id: STUDENT, product_soort: 'mentorship', traject_maanden: 12, calls_totaal: 24, start_datum: '2027-03-11', eind_datum: '2028-03-11', overrides: {} }
    : student;
  const lms = nepLms(lmsStudent);
  const gespiegeld = [];
  const spiegel = async (id) => { gespiegeld.push(id); return { resultaat: 'geschreven' }; };
  const run = () => vervangOnboardingDoorOfferte({
    onboardingId: OB_ID, dealId: NIEUWE_DEAL, trajectId: TR_6, startDate: '2027-03-01',
    doorUserId: null, door: 'maxim@test', db, lms, spiegel, nu: NU,
  });
  return { ob, db, lms, lmsStudent, gespiegeld, run };
}

test('WISSEL: zet traject/start/deal op de BESTAANDE onboarding, zet het LMS bij, spiegelt, audit + tijdlijn — en verstuurt niets', async () => {
  const s = scenario();
  const r = await s.run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(s.ob.traject_id, TR_6);
  assert.equal(s.ob.start_date, '2027-03-01');
  assert.equal(s.ob.deal_id, NIEUWE_DEAL);
  // Token, startcode en antwoorden blijven.
  assert.equal(s.ob.token, 'tok');
  assert.equal(s.ob.startcode, 'ABCD2345');
  assert.deepEqual(s.ob.answers, { a: 1 });
  assert.equal(s.ob.status, 'aangemeld');
  // Het LMS.
  assert.deepEqual(s.lms.log.updates[0], { product_soort: 'mentorship', traject_maanden: 6, start_datum: '2027-03-01', calls_totaal: 12, eind_datum: '2027-09-01' });
  // Audit met before/after en een tijdlijnregel.
  const audit = s.db.log.inserts.find((i) => i.t === 'audit_log').v;
  assert.equal(audit.action, 'onboarding.offerte_wissel');
  assert.equal(audit.before_json.traject_id, TR_12);
  assert.equal(audit.before_json.deal_id, OUDE_DEAL);
  assert.equal(audit.after_json.start_date, '2027-03-01');
  assert.equal(audit.before_json.lms_student.calls_totaal, 24);
  assert.equal(audit.after_json.lms_student.calls_totaal, 12);
  assert.ok(s.db.log.inserts.find((i) => i.t === 'onboarding_mentor_updates'));
  assert.deepEqual(s.gespiegeld, [OB_ID]);
  assert.deepEqual(r.body.verstuurd, []);
  // Nooit naar de klant-tabellen geschreven.
  assert.equal(s.db.log.inserts.some((i) => /whatsapp|mail|automation/i.test(i.t)), false);
});

test('WISSEL zonder kolom deal_id: gaat door en zegt het', async () => {
  const s = scenario({ dealKolom: false });
  const r = await s.run();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(s.ob.traject_id, TR_6);
  assert.ok(r.body.waarschuwingen.some((w) => /deal_id/.test(w)));
});

test('WISSEL: CRM-update mislukt → LMS wordt teruggezet', async () => {
  const s = scenario({ updateFout: 'boem' });
  const r = await s.run();
  assert.equal(r.status, 500);
  assert.equal(s.lms.log.updates.length, 2);
  assert.equal(s.lmsStudent.calls_totaal, 24);
  assert.equal(s.lmsStudent.eind_datum, '2028-03-11');
});

test('WISSEL: geen LMS-student → CRM wel, met waarschuwing; nooit een nieuwe student of uitnodiging', async () => {
  const s = scenario({ student: null });
  const r = await s.run();
  assert.equal(r.status, 200);
  assert.equal(r.body.lms.bijgewerkt, false);
  assert.ok(r.body.waarschuwingen.length >= 1);
});

test('WISSEL: een met de hand afgeronde onboarding wordt niet stil vervangen', async () => {
  const s = scenario();
  s.ob.status = 'afgerond';
  s.ob.handmatig_afgerond_op = '2026-11-10T10:47:57Z';
  const r = await s.run();
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'afgesloten');
  assert.equal(s.lms.log.updates.length, 0);
});

test('KOLOMFOUT herkend', () => {
  assert.equal(isDealKolomOntbreekt({ code: '42703', message: 'column onboardings.deal_id does not exist' }), true);
  assert.equal(isDealKolomOntbreekt({ code: '42703', message: 'column x does not exist' }), false);
});

test('BRON: endpoint met recht onboarding.create; create geeft kan_vervangen; offertepagina kent de knop; geen verzend-imports', () => {
  const ep = readFileSync(new URL('../api/onboarding-offerte-wissel.js', import.meta.url), 'utf8');
  assert.match(ep, /requirePermission\(req, 'onboarding.create'\)/);
  const lib = readFileSync(new URL('../api/_lib/onboarding-offerte-wissel.js', import.meta.url), 'utf8');
  for (const verboden of ['onboarding-invite', 'dfo-lms-uitnodiging', 'onboarding-automation-engine', 'mailer', 'meta-whatsapp']) {
    assert.equal(lib.includes(verboden), false, 'mag niets versturen: ' + verboden);
  }
  const create = readFileSync(new URL('../api/onboarding-create.js', import.meta.url), 'utf8');
  assert.match(create, /kan_vervangen: loopt/);
  assert.match(create, /deal_id: dealId/);
  const odv = readFileSync(new URL('../modules/klanten-v2/views/offerte-detail-v2.js', import.meta.url), 'utf8');
  assert.match(odv, /Deze offerte vervangt de lopende onboarding/);
  assert.match(odv, /\/api\/onboarding-offerte-wissel/);
  assert.match(odv, /payload\.deal_id = dealId/);
  const mig = readFileSync(new URL('../docs/sql-migrations/2026-11-10-onboardings-deal-id.sql', import.meta.url), 'utf8');
  assert.match(mig, /references public\.deals\(id\) on delete set null/);
});
