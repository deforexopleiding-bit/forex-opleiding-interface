// tests/student-annuleren.test.js — "Student annuleren" vanuit het
// studentdossier in het LMS (Maxim, 21 oktober 2026): op student-niveau, met
// aanvinkbare keuzes en "Doorzetten naar incasso". Alles tegen nep-databanken
// en een nagebootst Teamleader: er wordt nooit een echte klant geannuleerd.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const url = (p) => pathToFileURL(path.resolve(process.cwd(), p)).href;
const lees = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8');

const ST = '00000000-0000-4000-8000-0000000000s1';
const STUDENT = '11111111-1111-4111-8111-111111111111';
const KLANT = '22222222-2222-4222-8222-222222222222';
const ANDERE = '33333333-3333-4333-8333-333333333333';

/**
 * Een nep-databank die onthoudt: inserts komen erbij (met id en created_at),
 * updates en deletes worden toegepast. Kent ook `steps->>sleutel`-filters,
 * `.or()` op onboardings en `.ilike()`.
 */
function nepDb(tabellen, { rpc = null } = {}) {
  const log = { updates: [], inserts: [], deletes: [], rpc: [] };
  let teller = 0;
  const waarde = (r, k) => {
    const m = /^(\w+)->>(\w+)$/.exec(k);
    return m ? (r[m[1]]?.[m[2]] ?? null) : r[k];
  };
  const db = {
    log, tabellen,
    rpc: async (naam, args) => { log.rpc.push({ naam, args }); return rpc ? rpc(naam, args) : { data: null, error: null }; },
    from(tabel) {
      tabellen[tabel] ||= [];
      const st = { filters: [], patch: null, insert: null, del: false, order: [] };
      const past = (r) => st.filters.every(([op, k, v]) => {
        const w = waarde(r, k);
        if (op === 'eq') return String(w ?? '') === String(v ?? '') && w != null;
        if (op === 'neq') return w !== v;
        if (op === 'in') return v.map(String).includes(String(w));
        if (op === 'is') return (w ?? null) === v;
        if (op === 'ilike') return String(w || '').toLowerCase() === String(v).toLowerCase();
        if (op === 'or') return v.split(',').some((d) => { const [kk, , vv] = d.split('.'); return String(r[kk] ?? '') === vv; });
        return true;
      });
      const rijen = () => {
        const uit = tabellen[tabel].filter(past);
        for (const [k] of [...st.order].reverse()) uit.sort((a, b) => String(a[k]).localeCompare(String(b[k])));
        return uit;
      };
      const uitkomst = () => {
        if (st.insert) {
          const rij = { id: tabel + '-' + (++teller), created_at: '2026-10-21T10:00:' + String(teller).padStart(2, '0') + 'Z', ...st.insert };
          tabellen[tabel].push(rij);
          log.inserts.push({ tabel, rij });
          return { data: [rij], error: null };
        }
        if (st.del) {
          const weg = rijen();
          tabellen[tabel] = tabellen[tabel].filter((r) => !weg.includes(r));
          log.deletes.push({ tabel, filters: st.filters });
          return { data: weg, error: null };
        }
        if (st.patch) {
          const geraakt = rijen();
          for (const r of geraakt) Object.assign(r, structuredClone(st.patch));
          log.updates.push({ tabel, patch: structuredClone(st.patch), filters: st.filters });
          return { data: geraakt.map((r) => ({ id: r.id })), error: null };
        }
        return { data: rijen().map((r) => ({ ...r })), error: null };
      };
      const q = {
        select() { return q; }, limit() { return q; },
        order(k) { st.order.push([k]); return q; },
        eq(k, v) { st.filters.push(['eq', k, v]); return q; },
        neq(k, v) { st.filters.push(['neq', k, v]); return q; },
        in(k, v) { st.filters.push(['in', k, v]); return q; },
        is(k, v) { st.filters.push(['is', k, v]); return q; },
        ilike(k, v) { st.filters.push(['ilike', k, v]); return q; },
        or(v) { st.filters.push(['or', null, v]); return q; },
        update(p) { st.patch = p; return q; },
        insert(r) { st.insert = r; return q; },
        delete() { st.del = true; return q; },
        maybeSingle: async () => ({ data: uitkomst().data?.[0] ?? null, error: null }),
        single: async () => ({ data: uitkomst().data?.[0] ?? null, error: null }),
        then: (ok, nok) => Promise.resolve(uitkomst()).then(ok, nok),
      };
      return q;
    },
  };
  return db;
}

function basis({ extraKlant = false, metOnboarding = false, eindDatum = '2027-03-25' } = {}) {
  const crm = {
    customers: [{ id: KLANT, first_name: 'Arno', last_name: 'Proefmans', email: 'arno@voorbeeld.test', is_test: false }],
    onboardings: [],
    invoices: [
      { id: 'f-open', customer_id: KLANT, tl_invoice_id: 'tl-open', invoice_number: 'F-1', amount_total: 600, credited_amount: 0, status: 'open' },
      { id: 'f-open2', customer_id: KLANT, tl_invoice_id: 'tl-open2', invoice_number: 'F-2', amount_total: 600, credited_amount: 0, status: 'open' },
      { id: 'f-betaald', customer_id: KLANT, tl_invoice_id: 'tl-b', invoice_number: 'F-3', amount_total: 600, credited_amount: 0, status: 'paid' },
    ],
    deals: [
      { id: 'd-aanvaard', customer_id: KLANT, tl_deal_id: 'tl-d1', tl_quotation_id: 'tl-q1', quote_reference: '1545', archived_at: null, source: 'tl_import' },
      { id: 'd-open', customer_id: KLANT, tl_deal_id: 'tl-d2', tl_quotation_id: 'tl-q2', quote_reference: 'OFF-2', archived_at: null, source: 'sales' },
    ],
    subscriptions: [{ id: 'sub-1', deal_id: 'd-aanvaard', status: 'active', teamleader_subscription_id: 'tl-s1', amount: 417.32, vat_percentage: 21, description: 'Alpha 12 maanden' }],
    onboarding_automation_runs: [],
    onboarding_mentor_updates: [],
    onboarding_cancellations: [],
    dunning_pipeline_customers: [],
    dunning_pipeline_log: [],
  };
  if (extraKlant) crm.customers.push({ id: ANDERE, first_name: 'Arno', last_name: 'Proefmans (2)', email: 'oud@voorbeeld.test', is_test: false });
  if (metOnboarding) {
    crm.onboardings.push({ id: 'ob-1', customer_id: KLANT, customer_name: 'Arno Proefmans', mentor_user_id: null, status: 'bezig', dfo_lms_student_id: STUDENT, is_test: false });
    crm.onboarding_automation_runs.push({ id: 'run-1', onboarding_id: 'ob-1', status: 'active' });
  }
  if (extraKlant) crm.onboardings.push({ id: 'ob-oud', customer_id: ANDERE, status: 'gearchiveerd', bubble_user_id: 'b-1', is_test: false });
  const lms = {
    hlms_student: [{ id: STUDENT, voornaam: 'Arno', achternaam: 'Proefmans', email: 'arno@voorbeeld.test', bubble_user_id: 'b-1', mentor_id: 'pers-mentor-proef', eind_datum: eindDatum }],
    hlms_signaal: [], hlms_signaal_gebeurtenis: [],
  };
  return { crm, lms };
}

async function laad(stand, { rpc = null, mentor = { user_id: 'crm-mentor-proef' }, gebruiker = { id: 'crm-maxim', naam: 'Maxim' } } = {}) {
  const crm = nepDb(stand.crm);
  const lms = nepDb(stand.lms, { rpc: rpc || (async () => ({ data: { annulering: 'nieuw' }, error: null })) });
  const tl = []; const meldingen = []; const spiegel = [];
  mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: crm, createUserClient: () => ({}) } });
  mock.module(url('api/_lib/teamleader-token.js'), {
    namedExports: {
      tlFetch: async (p, o) => { tl.push({ p, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({ data: { id: 'cn-1' } }), text: async () => '' }; },
      getActiveToken: async () => 'token',
    },
  });
  mock.module(url('api/_lib/notify.js'), { namedExports: { createNotification: async (m) => { meldingen.push(m); return { ok: true, count: 1 }; }, resolveOntvangersVoorRecht: async () => ({ ok: true, userIds: [] }) } });
  mock.module(url('api/_lib/onboarding-spiegel.js'), { namedExports: { spiegelNaActie: async (id) => { spiegel.push(id); } } });
  mock.module(url('api/_lib/dfo-lms-db.js'), { namedExports: { getDfoLmsClient: () => lms, isUniqueViolation: (e) => e?.code === '23505' } });
  // De ECHTE wanbetalers-pipeline, vers geladen zodat hij deze nep-CRM gebruikt.
  const t = '?t=' + Math.random();
  const pipeline = await import(url('api/_lib/dunning-pipeline.js') + t);
  mock.module(url('api/_lib/dunning-pipeline.js'), { namedExports: { ...pipeline } });
  mock.module(url('api/_lib/lms-mentor-brug.js'), {
    namedExports: { crmMentorVoorLmsId: async () => mentor, crmGebruikerVoorEmail: async (e) => (e === 'maxim@dfo.test' ? gebruiker : null) },
  });
  const mod = await import(url('api/_lib/onboarding-annuleren.js') + t);
  return { mod, crm, lms, tl, meldingen, spiegel, t };
}

const ALLES_UIT = { facturen_crediteren: [], abonnementen_stoppen: [], offertes_annuleren: [], automaties_stoppen: false, lms_toegang_dicht: false, incasso: false };

test('VOORBEELD: één klant via e-mail, alles zichtbaar, de juiste vinkjes standaard', async (t) => {
  t.after(() => mock.reset());
  const w = await laad(basis());
  const { status, body } = await w.mod.studentAnnuleringVoorbeeld({ studentId: STUDENT });
  assert.equal(status, 200);
  assert.equal(body.klant.status, 'gevonden');
  assert.equal(body.klant.customer_id, KLANT);
  assert.equal(body.klant.via, 'email');
  assert.equal(body.naam_bevestiging, 'Arno Proefmans');
  // Elke openstaande factuur apart, NIET aangevinkt; de betaalde niet in de lijst.
  assert.deepEqual(body.invoices.map((i) => [i.id, i.standaard]), [['f-open', false], ['f-open2', false]]);
  assert.equal(body.invoices_niet_te_crediteren, 1);
  // Abonnement standaard stop; de aanvaarde/TL-import-offerte standaard NIET, de open wel.
  assert.deepEqual(body.subscriptions.map((s) => [s.id, s.standaard]), [['sub-1', true]]);
  assert.deepEqual(body.offertes.map((o) => [o.id, o.standaard]), [['d-aanvaard', false], ['d-open', true]]);
  assert.equal(body.lms_toegang.standaard, true);
  assert.equal(body.lms_toegang.eind_datum, '2027-03-25');
  // Leest alleen.
  assert.equal(w.tl.length + w.crm.log.inserts.length + w.crm.log.updates.length + w.lms.log.updates.length, 0);
});

test('TWIJFEL: e-mail en bubble geven twee klanten → niets uitvoeren, kandidaten terug; kiezen kan alleen een kandidaat', async (t) => {
  t.after(() => mock.reset());
  const w = await laad(basis({ extraKlant: true }));
  const v = await w.mod.studentAnnuleringVoorbeeld({ studentId: STUDENT });
  assert.equal(v.body.klant.status, 'onzeker');
  assert.equal(v.body.klaar, false);
  assert.deepEqual(v.body.klant.kandidaten.map((k) => k.customer_id).sort(), [KLANT, ANDERE].sort());
  assert.deepEqual(v.body.invoices, []);

  const uit = await w.mod.voerAnnuleringUit({ studentId: STUDENT, opties: ALLES_UIT, reden: 'Annuleren', doorUserId: 'crm-maxim' });
  assert.equal(uit.status, 409);
  assert.equal(uit.body.code, 'klant_kiezen');
  assert.equal(w.tl.length + w.crm.log.inserts.length + w.crm.log.updates.length + w.lms.log.updates.length + w.lms.log.rpc.length, 0);

  const vreemd = await w.mod.studentAnnuleringVoorbeeld({ studentId: STUDENT, customerId: '44444444-4444-4444-8444-444444444444' });
  assert.equal(vreemd.status, 422);
  const gekozen = await w.mod.studentAnnuleringVoorbeeld({ studentId: STUDENT, customerId: KLANT });
  assert.equal(gekozen.body.klant.status, 'gekozen');
  assert.equal(gekozen.body.invoices.length, 2);
});

test('UITVOEREN MET KEUZES: alleen wat aangevinkt is; mentor krijgt de melding en het verslag zegt dat (bugfix)', async (t) => {
  t.after(() => mock.reset());
  const w = await laad(basis({ metOnboarding: true }));
  const { status, body } = await w.mod.voerAnnuleringUit({
    studentId: STUDENT,
    opties: { facturen_crediteren: ['f-open2'], abonnementen_stoppen: ['sub-1'], offertes_annuleren: ['d-open', 'vreemde-id'], automaties_stoppen: true, lms_toegang_dicht: true, incasso: false },
    reden: 'Wil stoppen', doorUserId: 'crm-maxim', doorLabel: 'Maxim', discordVerwijderd: true, via: 'lms',
  });
  assert.equal(status, 200);
  // TL: één factuur, het abonnement, alleen de open offerte.
  assert.deepEqual(w.tl.map((c) => c.p + ':' + c.body.id).sort(),
    ['/deals.lose:tl-d2', '/invoices.credit:tl-open2', '/quotations.delete:tl-q2', '/subscriptions.deactivate:tl-s1']);
  assert.equal(body.steps.invoices_credit.results.find((r) => r.invoice_id === 'f-open').reason, 'niet-gekozen');
  // De open onboarding van deze student: geannuleerd, automatie gestopt, spiegel.
  assert.equal(w.crm.tabellen.onboardings[0].status, 'geannuleerd');
  assert.equal(body.steps.automaties_gestopt.aantal, 1);
  assert.deepEqual(w.spiegel, ['ob-1']);
  // LMS-toegang dicht, account blijft (alleen eind_datum).
  const lmsUpd = w.lms.log.updates.find((u) => u.tabel === 'hlms_student');
  assert.deepEqual(Object.keys(lmsUpd.patch), ['eind_datum']);
  assert.equal(body.steps.lms_toegang.vorige_eind_datum, '2027-03-25');
  // LMS-markering via de functie, zonder incasso.
  assert.equal(w.lms.log.rpc[0].naam, 'hlms_student_annuleren');
  assert.equal(w.lms.log.rpc[0].args.p_incasso, false);
  assert.equal(w.lms.log.rpc[0].args.p_student, STUDENT);
  // Mentor via het LMS (geen mentor op de onboarding) — en het RECORD zegt ok.
  assert.equal(w.meldingen.find((m) => m.toUserId).toUserId, 'crm-mentor-proef');
  const rec = w.crm.tabellen.onboarding_cancellations[0];
  assert.equal(rec.steps.notify_mentor.ok, true);
  assert.equal(rec.steps.status, 'klaar');
  assert.equal(rec.steps.niveau, 'student');
  assert.deepEqual(rec.steps.opties.offertes_annuleren, ['d-open']);
  assert.equal(rec.onboarding_id, 'ob-1');
  assert.equal(rec.customer_id, KLANT);
  // Geen incasso gekozen → pipeline ongemoeid.
  assert.equal(w.crm.tabellen.dunning_pipeline_customers.length, 0);
});

test('INCASSO: crediteren + incasso geweigerd zonder iets te raken; incasso alleen → facturen open, pipeline op incasso, merkteken in het LMS', async (t) => {
  t.after(() => mock.reset());
  const w = await laad(basis());
  const fout = await w.mod.voerAnnuleringUit({
    studentId: STUDENT, opties: { ...ALLES_UIT, incasso: true, facturen_crediteren: ['f-open'] },
    reden: 'Betaalt niet', doorUserId: 'crm-maxim',
  });
  assert.equal(fout.status, 400);
  assert.equal(fout.body.code, 'incasso_en_crediteren');
  assert.equal(w.tl.length + w.crm.log.inserts.length + w.lms.log.rpc.length, 0);

  const { status, body } = await w.mod.voerAnnuleringUit({
    studentId: STUDENT, opties: { ...ALLES_UIT, incasso: true, abonnementen_stoppen: ['sub-1'], lms_toegang_dicht: true },
    reden: 'Betaalt niet', doorUserId: 'crm-maxim', doorLabel: 'Maxim', discordVerwijderd: false, via: 'lms',
  });
  assert.equal(status, 200);
  assert.equal(w.tl.filter((c) => c.p === '/invoices.credit').length, 0);
  assert.ok(body.steps.invoices_credit.results.every((r) => r.skipped && r.reason === 'incasso'));
  assert.equal(w.crm.tabellen.dunning_pipeline_customers[0].stage_slug, 'incasso');
  assert.equal(w.crm.tabellen.dunning_pipeline_customers[0].stage_changed_by, 'crm-maxim');
  assert.equal(body.steps.incasso_pipeline.ok, true);
  assert.equal(w.lms.log.rpc[0].args.p_incasso, true);
  // Joost NIET stil: geen stilte-rij, geen joost-pauze.
  assert.equal((w.lms.tabellen.hlms_crm_stilte || []).length, 0);
  assert.equal((w.crm.tabellen.joost_conversation_state || []).length, 0);
  // Discord nee → kaart bij de administratie.
  assert.equal(w.lms.tabellen.hlms_signaal[0].soort, 'discord_verwijderen');
});

test('IDEMPOTENT: tweede keer niets; twee gelijktijdige kliks crediteren één keer', async (t) => {
  t.after(() => mock.reset());
  const w = await laad(basis());
  const opties = { ...ALLES_UIT, facturen_crediteren: ['f-open'], abonnementen_stoppen: ['sub-1'] };
  const p = { studentId: STUDENT, opties, reden: 'Annuleren', doorUserId: 'crm-maxim' };
  const [a, b] = await Promise.all([w.mod.voerAnnuleringUit(p), w.mod.voerAnnuleringUit(p)]);
  assert.equal([a, b].filter((r) => r.body.already_cancelled).length, 1);
  assert.equal(w.tl.filter((c) => c.p === '/invoices.credit').length, 1);
  assert.equal(w.tl.filter((c) => c.p === '/subscriptions.deactivate').length, 1);
  assert.equal(w.crm.tabellen.onboarding_cancellations.length, 1);

  const derde = await w.mod.voerAnnuleringUit(p);
  assert.equal(derde.body.already_cancelled, true);
  assert.equal(w.tl.length, 2);
  const v = await w.mod.studentAnnuleringVoorbeeld({ studentId: STUDENT });
  assert.equal(v.body.already_cancelled, true);
});

test('EERDERE CREDIT: wat een onboarding-annulering al crediteerde, komt niet opnieuw in de lijst', async (t) => {
  t.after(() => mock.reset());
  const stand = basis();
  stand.crm.onboarding_cancellations.push({ id: 'oud', customer_id: KLANT, steps: { invoices_credit: { results: [{ invoice_id: 'f-open', ok: true }] } } });
  const w = await laad(stand);
  const v = await w.mod.studentAnnuleringVoorbeeld({ studentId: STUDENT });
  assert.deepEqual(v.body.invoices.map((i) => i.id), ['f-open2']);
});

test('LMS-MIGRATIE NOG NIET GEDRAAID: markering overgeslagen, de rest gaat door; bij incasso een zichtbare fout', async (t) => {
  t.after(() => mock.reset());
  const w = await laad(basis(), { rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }) });
  const { body } = await w.mod.voerAnnuleringUit({ studentId: STUDENT, opties: { ...ALLES_UIT, incasso: true }, reden: 'Annuleren', doorUserId: 'u' });
  assert.equal(body.steps.lms_markering.ok, false);
  assert.match(body.steps.lms_markering.error, /migratie/);
  assert.equal(body.steps.incasso_pipeline.ok, true);
});

test('INCASSO-KERN NOG NIET IN HET LMS: de markering staat er, de stap meldt zichtbaar dat het merkteken ontbreekt', async (t) => {
  t.after(() => mock.reset());
  const w = await laad(basis(), { rpc: async () => ({ data: { annulering: 'nieuw', incasso: false, merkteken: 'kern_ontbreekt', incasso_kaart: 'kern_ontbreekt' }, error: null }) });
  const { body } = await w.mod.voerAnnuleringUit({ studentId: STUDENT, opties: { ...ALLES_UIT, incasso: true }, reden: 'Annuleren', doorUserId: 'u' });
  assert.equal(body.steps.lms_markering.ok, false);
  assert.match(body.steps.lms_markering.error, /hlms_incasso_een_waarheid/);
});

test('ONBOARDING-NIVEAU (de oude knoppen): het record krijgt de mentormelding ook juist (bug notify_mentor)', async (t) => {
  t.after(() => mock.reset());
  const stand = basis({ metOnboarding: true });
  stand.crm.onboardings[0].mentor_user_id = 'crm-mentor';
  const w = await laad(stand);
  const { body } = await w.mod.voerAnnuleringUit({ onboardingId: 'ob-1', reden: 'Annuleren', doorUserId: 'u' });
  assert.equal(body.steps.notify_mentor.ok, true);
  const rec = w.crm.tabellen.onboarding_cancellations[0];
  assert.equal(rec.steps.notify_mentor.ok, true);
  assert.equal(rec.steps.notify_mentor.user_id, 'crm-mentor');
  // Zonder opties: alles zoals vroeger — beide open facturen gecrediteerd.
  assert.equal(w.tl.filter((c) => c.p === '/invoices.credit').length, 2);
});

test('ROUTE: naam, Discord, opties en een CRM-gebruiker zijn verplicht; de juiste uitvoering', async (t) => {
  t.after(() => mock.reset());
  const w = await laad(basis());
  // De echte machinepoort is getoetst in lms-onboarding-sessie.test.js.
  mock.module(url('api/lms-onboarding-sessie.js'), { namedExports: { machineToegang: (h) => (h === 'geheim-voor-de-toets' ? 'ok' : 'dicht') } });
  const { default: handler } = await import(url('api/lms-student-annuleren.js') + w.t);
  const roep = async (body) => {
    const res = { code: 0, json: null, headers: {}, status(c) { this.code = c; return this; }, json(j) { this.body = j; return this; }, setHeader(k, v) { this.headers[k] = v; } };
    await handler({ method: 'POST', headers: { 'x-dfo-secret': 'geheim-voor-de-toets' }, body }, res);
    return res;
  };
  const basisBody = { stap: 'uitvoeren', student_id: STUDENT, reden: 'Wil stoppen', naam: 'arno  proefmans', discord_verwijderd: true, door_email: 'maxim@dfo.test', opties: ALLES_UIT };
  assert.equal((await roep({ ...basisBody, naam: 'Arno' })).body.code, 'naam_klopt_niet');
  assert.equal((await roep({ ...basisBody, discord_verwijderd: undefined })).body.code, 'discord_verplicht');
  assert.equal((await roep({ ...basisBody, opties: undefined })).body.code, 'opties_verplicht');
  assert.equal((await roep({ ...basisBody, door_email: 'onbekend@x.test' })).body.code, 'geen_crm_gebruiker');
  assert.equal(w.crm.tabellen.onboarding_cancellations.length, 0);
  const ok = await roep(basisBody);
  assert.equal(ok.code, 200);
  assert.equal(ok.body.code, 'geannuleerd');
  assert.equal(w.crm.tabellen.onboarding_cancellations[0].cancelled_by, 'crm-maxim');
  const nogmaals = await roep(basisBody);
  assert.equal(nogmaals.body.code, 'al_geannuleerd');
  const fout = await handler({ method: 'POST', headers: { 'x-dfo-secret': 'fout' }, body: basisBody }, { status(c) { this.code = c; return this; }, json() { return this; }, setHeader() {} });
  assert.equal(fout.code, 403);
});

test('GEEN TWEEDE IMPLEMENTATIE: de dossier-route roept dezelfde kern aan', () => {
  const route = lees('api/lms-student-annuleren.js');
  assert.match(route, /voerAnnuleringUit\(/);
  assert.doesNotMatch(route, /tlFetch|invoices\.credit|from\('onboardings'\)\s*\.update/);
  // De bekende fout: crmGebruikerVoorEmail geeft { id, naam }, geen full_name.
  assert.doesNotMatch(lees('api/lms-onboarding-annuleren.js'), /door\.full_name/);
});
