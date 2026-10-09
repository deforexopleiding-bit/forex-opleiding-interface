// tests/onboarding-annuleren.test.js — annuleren vanuit het LMS, met EXACT
// dezelfde uitvoering als de CRM-knop (Maxim, 6 oktober 2026). Alles hier
// draait tegen nep-databanken en een nagebootst Teamleader: er wordt nooit
// een echte klant geannuleerd.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const url = (p) => pathToFileURL(path.resolve(process.cwd(), p)).href;
const lees = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8');

const OB = '00000000-0000-4000-8000-0000000000aa';

/** Een nep-databank: rijen per tabel, en een logboek van elke schrijfactie. */
function nepDb(tabellen) {
  const log = { updates: [], inserts: [] };
  return {
    log,
    from(tabel) {
      const st = { filters: [], patch: null, insert: null };
      const rijen = () => (tabellen[tabel] || []).filter((r) => st.filters.every(([op, k, v]) =>
        op === 'eq' ? r[k] === v : op === 'in' ? v.includes(r[k]) : op === 'is' ? (r[k] ?? null) === v : op === 'neq' ? r[k] !== v : true));
      const uitkomst = () => {
        if (st.patch) { log.updates.push({ tabel, patch: st.patch, filters: st.filters }); return { data: rijen().map((r) => ({ id: r.id })), error: null }; }
        if (st.insert) { log.inserts.push({ tabel, rij: st.insert }); return { data: { id: tabel + '-nieuw' }, error: null }; }
        return { data: rijen(), error: null };
      };
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { st.filters.push(['eq', k, v]); return q; },
        neq(k, v) { st.filters.push(['neq', k, v]); return q; },
        in(k, v) { st.filters.push(['in', k, v]); return q; },
        is(k, v) { st.filters.push(['is', k, v]); return q; },
        update(p) { st.patch = p; return q; },
        insert(r) { st.insert = r; return q; },
        maybeSingle: async () => ({ data: uitkomst().data?.[0] ?? null, error: null }),
        single: async () => { const u = uitkomst(); return { data: Array.isArray(u.data) ? u.data[0] : u.data, error: null }; },
        then: (ok, nok) => Promise.resolve(uitkomst()).then(ok, nok),
      };
      return q;
    },
  };
}

async function laad({ ob, lmsStudent = { id: 'st-1', eind_datum: '2027-06-30' } }) {
  const crm = nepDb({
    onboardings: [ob],
    invoices: [
      { id: 'f1', customer_id: 'k1', tl_invoice_id: 'tl-f1', invoice_number: 'F-1', amount_total: 500, credited_amount: 0, status: 'outstanding' },
      { id: 'f2', customer_id: 'k1', tl_invoice_id: 'tl-f2', invoice_number: 'F-2', amount_total: 500, credited_amount: 0, status: 'paid' },
    ],
    deals: [{ id: 'd1', customer_id: 'k1', tl_deal_id: 'tl-d1', tl_quotation_id: 'tl-q1', quote_reference: 'OFF-1', archived_at: null }],
    subscriptions: [{ id: 's1', deal_id: 'd1', status: 'active', teamleader_subscription_id: 'tl-s1', amount: 100, vat_percentage: 21 }],
    onboarding_automation_runs: [{ id: 'run-1', onboarding_id: OB, status: 'active' }, { id: 'run-2', onboarding_id: OB, status: 'completed' }],
    onboarding_mentor_updates: [],
    onboarding_cancellations: [],
  });
  const lms = nepDb({ hlms_student: lmsStudent ? [lmsStudent] : [], hlms_signaal: [], hlms_signaal_gebeurtenis: [] });
  const tl = []; const meldingen = []; const spiegel = [];
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: crm, createUserClient: () => ({}) } });
  mock.module(url('api/_lib/teamleader-token.js'), {
    namedExports: {
      tlFetch: async (p, o) => { tl.push({ p, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ data: { id: 'x' } }), text: async () => '' }; },
      getActiveToken: async () => 'token',
    },
  });
  mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async (m) => { meldingen.push(m); return { ok: true }; } } });
  mock.module(url('api/_lib/onboarding-spiegel.js'), { namedExports: { spiegelNaActie: async (id) => { spiegel.push(id); } } });
  mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms } });
  const mod = await import(url('api/_lib/onboarding-annuleren.js') + '?t=' + Math.random());
  return { mod, crm, lms, tl, meldingen, spiegel };
}

const TESTKLANT = () => ({ id: OB, customer_id: 'k1', customer_name: 'Testklant Annuleren', mentor_user_id: 'm1',
  bubble_user_id: 'b1', dfo_lms_student_id: 'st-1', status: 'bezig', is_test: true });

test('DEZELFDE CASCADE + DE NIEUWE STAPPEN: automaties stop, LMS-toegang dicht, Discord nee → taak', async (t) => {
  t.after(() => mock.reset());
  const w = await laad({ ob: TESTKLANT() });
  const { status, body } = await w.mod.voerAnnuleringUit({
    onboardingId: OB, reden: 'Wil niet meer starten', doorUserId: 'crm-maxim', doorLabel: 'Maxim',
    discordVerwijderd: false, via: 'lms',
  });
  assert.equal(status, 200);
  // a-c) Teamleader: alleen de onbetaalde factuur, het abonnement, de offerte en de deal.
  assert.deepEqual(w.tl.map((c) => c.p).sort(), ['/deals.lose', '/invoices.credit', '/quotations.delete', '/subscriptions.deactivate']);
  assert.equal(w.tl.find((c) => c.p === '/invoices.credit').body.id, 'tl-f1');
  // d) Bubble: vervallen (9 okt 2026) — er is geen Bubble-stap meer.
  assert.equal(body.steps.bubble_membership_end, undefined);
  assert.doesNotMatch(lees('api/_lib/onboarding-annuleren.js'), /bubble\.js|bubblePatch/);
  // e) Status geannuleerd.
  assert.ok(w.crm.log.updates.some((u) => u.tabel === 'onboardings' && u.patch.status === 'geannuleerd'));
  // h) Alleen de LOPENDE automatie gestopt.
  const aut = w.crm.log.updates.find((u) => u.tabel === 'onboarding_automation_runs');
  assert.equal(aut.patch.status, 'cancelled');
  assert.deepEqual(aut.filters.find((f) => f[1] === 'status'), ['eq', 'status', 'active']);
  assert.equal(body.steps.automaties_gestopt.aantal, 1);
  // i) LMS-toegang: eind_datum op gisteren, vorige waarde bewaard.
  const lmsUpd = w.lms.log.updates.find((u) => u.tabel === 'hlms_student');
  assert.match(lmsUpd.patch.eind_datum, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.steps.lms_toegang.vorige_eind_datum, '2027-06-30');
  // j) Discord nee: tijdlijn + een open kaart bij de administratie.
  const tijdlijn = w.crm.log.inserts.find((i) => i.tabel === 'onboarding_mentor_updates');
  assert.match(tijdlijn.rij.note, /Uit de Discord verwijderd: nee/);
  const kaart = w.lms.log.inserts.find((i) => i.tabel === 'hlms_signaal');
  assert.equal(kaart.rij.soort, 'discord_verwijderen');
  assert.equal(kaart.rij.bak, 'admin');
  assert.equal(kaart.rij.status, 'nieuw');
  // f) De record kreeg ook de nieuwe stappen.
  assert.ok(w.crm.log.updates.some((u) => u.tabel === 'onboarding_cancellations' && u.patch.steps.lms_toegang));
  // De spiegel haalt hem weg uit het LMS.
  assert.deepEqual(w.spiegel, [OB]);
});

test('DISCORD JA: geen taak; de CRM-knop (zonder vraag) maakt ook geen taak', async (t) => {
  t.after(() => mock.reset());
  const w = await laad({ ob: TESTKLANT() });
  await w.mod.voerAnnuleringUit({ onboardingId: OB, reden: 'Annuleren', doorUserId: 'u', discordVerwijderd: true, via: 'lms' });
  assert.equal(w.lms.log.inserts.filter((i) => i.tabel === 'hlms_signaal').length, 0);
  assert.match(w.crm.log.inserts.find((i) => i.tabel === 'onboarding_mentor_updates').rij.note, /Discord verwijderd: ja/);
});

test('IDEMPOTENT: al geannuleerd → niets opnieuw', async (t) => {
  t.after(() => mock.reset());
  const w = await laad({ ob: { ...TESTKLANT(), status: 'geannuleerd' } });
  const r = await w.mod.voerAnnuleringUit({ onboardingId: OB, reden: 'x', doorUserId: 'u' });
  assert.equal(r.body.already_cancelled, true);
  assert.equal(w.tl.length, 0);
  assert.equal(w.crm.log.updates.length + w.lms.log.updates.length, 0);
});

test('LMS-TOEGANG: een al verlopen einddatum wordt niet verlengd naar gisteren', async (t) => {
  t.after(() => mock.reset());
  const w = await laad({ ob: TESTKLANT(), lmsStudent: { id: 'st-1', eind_datum: '2020-01-01' } });
  const { body } = await w.mod.voerAnnuleringUit({ onboardingId: OB, reden: 'Annuleren', doorUserId: 'u' });
  assert.equal(body.steps.lms_toegang.reason, 'al-verlopen');
  assert.equal(w.lms.log.updates.length, 0);
});

test('PURE REGELS: gisteren in Brussel, toegang dicht, naam intypen', async () => {
  const { gisterenBrussel, moetToegangDicht } = await import(url('api/_lib/onboarding-annuleren.js') + '?p=1');
  assert.equal(gisterenBrussel(new Date('2026-10-06T22:30:00Z')), '2026-10-06'); // 00:30 op 7 okt in Brussel
  assert.equal(moetToegangDicht(null, '2026-10-05'), true);
  assert.equal(moetToegangDicht('2026-10-05', '2026-10-05'), false);
  assert.equal(moetToegangDicht('2027-01-01', '2026-10-05'), true);
  const { naamKlopt } = await import(url('api/lms-onboarding-annuleren.js'));
  assert.equal(naamKlopt('  ebenezer   adjei ', 'Ebenezer Adjei'), true);
  assert.equal(naamKlopt('Ebenezer', 'Ebenezer Adjei'), false);
  assert.equal(naamKlopt('', ''), false);
});

test('GEEN TWEEDE IMPLEMENTATIE: beide knoppen roepen dezelfde uitvoering aan', () => {
  const crmKnop = lees('api/onboarding-cancel.js');
  const lmsKnop = lees('api/lms-onboarding-annuleren.js');
  assert.match(crmKnop, /voerAnnuleringUit\(/);
  assert.match(lmsKnop, /voerAnnuleringUit\(/);
  for (const b of [crmKnop, lmsKnop]) {
    assert.doesNotMatch(b, /tlFetch|bubblePatch|invoices\.credit|from\('onboardings'\)\s*\.update/);
  }
  // De LMS-route: naam, Discord en een aanwijsbare CRM-gebruiker zijn verplicht.
  assert.match(lmsKnop, /naam_klopt_niet/);
  assert.match(lmsKnop, /discord_verplicht/);
  assert.match(lmsKnop, /geen_crm_gebruiker/);
});

test('DE MOTOR stopt ook zelf een run van een geannuleerde onboarding', () => {
  const motor = lees('api/_lib/onboarding-automation-engine.js');
  assert.match(motor, /=== 'geannuleerd'\) \{\s*await supabaseAdmin\.from\('onboarding_automation_runs'\)\s*\.update\(\{ status: 'cancelled'/);
});
