// tests/wa-klantnummer.test.js
//
// Het tweede 360dialog-nummer: KLANTNUMMER (onboarding + finance/dunning) (2026-10-07).
//   1. kiesKlantModule: actieve onboarding zonder openstaande aanmaning → onboarding,
//      anders finance; batch-loader fail-soft;
//   2. transport: zonder D360_API_KEY_KLANTNUMMER verandert er NIETS (finance via Meta,
//      onboarding geweigerd); met key gaan de oude klantlijnen via het klantnummer;
//      lead-modules nooit via het klantnummer;
//   3. module-context: op het gedeelde nummer kiest de klant de module;
//   4. inbox-lijst-filter + template-script (--nummer=klantnummer) + module-config-SQL.
//   (De datafix-SQL heeft een eigen test: wa-klantgesprekken-datafix.test.js.)

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const KLANT = '1399327383258229';
const OUD_FIN = '1194351613761790';
const OUD_ONB = '1163203046877082';
const HOOFD = '1273723375834177';

// ── Nep-databank ────────────────────────────────────────────────────────────
const db = { tabellen: {}, faal: null };
function from(tabel) {
  const q = { filters: [] };
  const match = (r) => q.filters.every(([op, c, v]) =>
    op === 'eq' ? String(r[c]) === String(v)
      : op === 'in' ? v.map(String).includes(String(r[c])) : true);
  const run = () => {
    if (db.faal === tabel) return { data: null, error: { message: 'kapot' } };
    return { data: (db.tabellen[tabel] || []).filter(match), error: null };
  };
  const k = {
    select: () => k,
    eq: (c, v) => { q.filters.push(['eq', c, v]); return k; },
    in: (c, v) => { q.filters.push(['in', c, v]); return k; },
    not: () => k, gt: () => k, order: () => k, limit: () => k,
    maybeSingle: () => ({ then: (ok, nok) => Promise.resolve({ ...run(), data: run().data?.[0] || null }).then(ok, nok) }),
    then: (ok, nok) => Promise.resolve(run()).then(ok, nok),
  };
  return k;
}
const sb = { from };
mock.module('../api/supabase.js', { namedExports: { supabaseAdmin: sb, supabase: sb, createUserClient: () => sb } });

process.env.D360_API_KEY_HOOFDNUMMER = 'test-key-hoofd';
process.env.D360_PHONE_NUMBER_ID_HOOFDNUMMER = HOOFD;
process.env.D360_PHONE_NUMBER_ID_KLANTNUMMER = KLANT;
delete process.env.D360_API_KEY_KLANTNUMMER;

const K = await import('../api/_lib/klant-module.js');
const W = await import('../api/_lib/meta-whatsapp.js');
const N = await import('../api/_lib/wa-nummers.js');
const MC = await import('../api/_lib/module-context.js');

const metKey = async (fn) => {
  process.env.D360_API_KEY_KLANTNUMMER = 'test-key-klant';
  try { return await fn(); } finally { delete process.env.D360_API_KEY_KLANTNUMMER; }
};

// ── 1. Beslissing ───────────────────────────────────────────────────────────
test('kiesKlantModule: actieve onboarding zonder aanmaning → onboarding; met aanmaning → finance', () => {
  const ob = [{ status: 'actief' }];
  assert.equal(K.kiesKlantModule({ onboardings: ob }), 'onboarding');
  assert.equal(K.kiesKlantModule({ onboardings: ob, runs: [{ status: 'active' }] }), 'finance');
  assert.equal(K.kiesKlantModule({ onboardings: ob, runs: [{ status: 'paused' }] }), 'finance');
  assert.equal(K.kiesKlantModule({ onboardings: ob, runs: [{ status: 'completed' }] }), 'onboarding');
  assert.equal(K.kiesKlantModule({ onboardings: ob, pipeline: { stage_slug: 'aangemaand' } }), 'finance');
  assert.equal(K.kiesKlantModule({ onboardings: ob, pipeline: { stage_slug: 'opgelost' } }), 'onboarding');
  assert.equal(K.kiesKlantModule({ onboardings: ob, pipeline: { stage_slug: 'afschrijven' } }), 'onboarding');
  assert.equal(K.kiesKlantModule({}), 'finance');
});

test('isActieveOnboarding: gearchiveerd/geannuleerd/echt afgerond = niet actief; wizard-afgerond = wél', () => {
  assert.equal(K.isActieveOnboarding({ status: 'actief' }), true);
  assert.equal(K.isActieveOnboarding({ status: 'afgerond' }), true); // alleen wizard voltooid
  assert.equal(K.isActieveOnboarding({ status: 'actief', archived_at: '2026-10-01' }), false);
  assert.equal(K.isActieveOnboarding({ status: 'geannuleerd' }), false);
  assert.equal(K.isActieveOnboarding({ status: 'gearchiveerd' }), false);
  assert.equal(K.isActieveOnboarding({ status: 'afgerond', handmatig_afgerond_op: '2026-10-01' }), false);
  assert.equal(K.isActieveOnboarding(null), false);
});

test('bepaalKlantModules: batch per klant; leesfout → alles finance (fail-soft)', async () => {
  db.faal = null;
  db.tabellen = {
    onboardings: [{ customer_id: 'a', status: 'actief' }, { customer_id: 'b', status: 'actief' }, { customer_id: 'c', status: 'geannuleerd' }],
    dunning_workflow_runs: [{ customer_id: 'b', status: 'active' }],
    dunning_pipeline_customers: [],
  };
  const m = await K.bepaalKlantModules(sb, ['a', 'b', 'c', 'd', null, 'a']);
  assert.deepEqual(Object.fromEntries(m), { a: 'onboarding', b: 'finance', c: 'finance', d: 'finance' });
  assert.equal(await K.bepaalKlantModule(sb, null), 'finance');
  db.faal = 'dunning_workflow_runs';
  assert.equal((await K.bepaalKlantModules(sb, ['a'])).get('a'), 'finance');
  db.faal = null;
});

// ── 2. Transport / key-grendel ──────────────────────────────────────────────
test('registry: klantnummer bedient onboarding/finance/dunning, nooit lead-modules; hoofdnummer omgekeerd', () => {
  const k = N.nummerOpSleutel('klantnummer');
  assert.ok(k);
  for (const m of ['onboarding', 'finance', 'dunning']) assert.equal(N.moduleMagViaNummer(m, k), true, m);
  for (const m of ['leadsonderhoud', 'welkom', 'events', 'opvolging']) assert.equal(N.moduleMagViaNummer(m, k), false, m);
  const h = N.nummerOpSleutel('hoofdnummer');
  for (const m of ['onboarding', 'finance', 'dunning']) assert.equal(N.moduleMagViaNummer(m, h), false, m);
  assert.equal(k.inkomend_resolver, 'klant');
  assert.equal(k.e164, '+31644606876');
  assert.equal(N.nummerOpTelefoon('31644606876'), k);
  assert.equal(N.nummerOpTelefoon('+31 6 44562426'), h);
  assert.deepEqual([...k.vervangt_phone_number_ids].sort(), [OUD_FIN, OUD_ONB].sort());
});

test('zonder klantnummer-key: niets verandert (finance via Meta, onboarding geweigerd, lijn-ID blijft)', async () => {
  assert.equal((await W.kiesVerzendroute({ phoneNumberId: OUD_FIN })).provider, 'meta');
  assert.equal((await W.kiesVerzendroute({ module: 'finance' })).provider, 'meta');
  await assert.rejects(() => W.kiesVerzendroute({ module: 'onboarding' }), W.WaGeenNummerError);
  await assert.rejects(() => W.kiesVerzendroute({ phoneNumberId: OUD_ONB, module: 'onboarding' }), W.WaGeenNummerError);
  assert.equal(await W.huidigeLijnId(OUD_FIN), OUD_FIN);
  assert.equal(await W.huidigeLijnId(OUD_ONB), OUD_ONB);
});

test('met klantnummer-key: oude klantlijnen en modules gaan via het klantnummer; leads blijven op het hoofdnummer', async () => {
  await metKey(async () => {
    for (const oud of [OUD_FIN, OUD_ONB, KLANT]) {
      const r = await W.kiesVerzendroute({ phoneNumberId: oud });
      assert.equal(r.provider, '360dialog', oud);
      assert.equal(r.nummer.sleutel, 'klantnummer');
    }
    for (const m of ['finance', 'onboarding', 'dunning']) {
      assert.equal((await W.kiesVerzendroute({ module: m })).nummer.sleutel, 'klantnummer', m);
    }
    assert.equal((await W.kiesVerzendroute({ module: 'leadsonderhoud' })).nummer.sleutel, 'hoofdnummer');
    await assert.rejects(() => W.kiesVerzendroute({ phoneNumberId: KLANT, module: 'events' }), W.WaGeenNummerError);
    await assert.rejects(() => W.kiesVerzendroute({ phoneNumberId: HOOFD, module: 'onboarding' }), W.WaGeenNummerError);
    assert.equal(await W.huidigeLijnId(OUD_FIN), KLANT);
    assert.equal(await W.huidigeLijnId(OUD_ONB), KLANT);
    const fam = await W.lijnFamilie(KLANT);
    assert.deepEqual([...fam.alle].sort(), [KLANT, OUD_FIN, OUD_ONB].sort());
  });
});

test('360-webhook: ?nummer=klantnummer kiest het klantnummer; zonder parameter alleen het enige nummer MET key', async () => {
  const { kiesNummer } = await import('../api/whatsapp-360-webhook.js');
  assert.equal(kiesNummer({ nummer: 'klantnummer' }).sleutel, 'klantnummer');
  assert.equal(kiesNummer({}).sleutel, 'hoofdnummer'); // klantnummer heeft nog geen key
  await metKey(async () => assert.equal(kiesNummer({}), null)); // twee nummers → parameter verplicht
});

// ── 3. Module-context ───────────────────────────────────────────────────────
test('module-context: gedeeld klantnummer → klant kiest; zonder klant → finance; module-hint wint', async () => {
  db.tabellen = {
    whatsapp_module_config: [
      { module: 'finance', phone_number_id: KLANT, is_active: true },
      { module: 'onboarding', phone_number_id: KLANT, is_active: true },
      { module: 'leadsonderhoud', phone_number_id: HOOFD, is_active: true },
    ],
    onboardings: [{ customer_id: 'stud', status: 'actief' }, { customer_id: 'wanb', status: 'actief' }],
    dunning_workflow_runs: [],
    dunning_pipeline_customers: [{ customer_id: 'wanb', stage_slug: 'aangemaand' }],
  };
  await metKey(async () => {
    assert.equal((await MC.getModuleContextByPhoneNumberId(sb, KLANT, { customerId: 'stud' })).module, 'onboarding');
    assert.equal((await MC.getModuleContextByPhoneNumberId(sb, KLANT, { customerId: 'wanb' })).module, 'finance');
    assert.equal((await MC.getModuleContextByPhoneNumberId(sb, KLANT)).module, 'finance');
    assert.equal((await MC.getModuleContextByPhoneNumberId(sb, KLANT, { module: 'onboarding' })).module, 'onboarding');
    // Oud lijn-ID zonder eigen rij → via de opvolger, klant beslist nog steeds.
    assert.equal((await MC.getModuleContextByPhoneNumberId(sb, OUD_FIN, { customerId: 'stud' })).module, 'onboarding');
    // Hoofdnummer ongemoeid: customerId speelt daar geen rol.
    assert.equal((await MC.getModuleContextByPhoneNumberId(sb, HOOFD, { customerId: 'stud' })).module, 'leadsonderhoud');
  });
});

// ── 4. Inbox-lijst, script, bron-checks, SQL ────────────────────────────────
test('filterGesprekkenOpKlantModule: splitst het gedeelde nummer per inbox; andere lijnen ongemoeid', async () => {
  db.tabellen = {
    onboardings: [{ customer_id: 'stud', status: 'actief' }],
    dunning_workflow_runs: [], dunning_pipeline_customers: [],
  };
  const rows = [{ id: 1, customer_id: 'stud' }, { id: 2, customer_id: 'ander' }, { id: 3, customer_id: null }];
  await metKey(async () => {
    const onb = await K.filterGesprekkenOpKlantModule(sb, rows, KLANT, 'onboarding');
    assert.deepEqual(onb.rows.map((r) => r.id), [1]);
    assert.equal(onb.gefilterd, true);
    const fin = await K.filterGesprekkenOpKlantModule(sb, rows, KLANT, 'finance');
    assert.deepEqual(fin.rows.map((r) => r.id), [2, 3]);
    const lead = await K.filterGesprekkenOpKlantModule(sb, rows, HOOFD, 'leadsonderhoud');
    assert.equal(lead.gefilterd, false);
    assert.equal(lead.rows.length, 3);
  });
});

test('template-script: --nummer=klantnummer, eigen key-env, klant-templates UTILITY', async () => {
  const S = await import('../scripts/360-templates-upload.mjs');
  assert.equal(S.leesArgs([]).nummer, 'hoofdnummer');
  assert.equal(S.leesArgs(['--nummer=klantnummer', '--dry-run']).nummer, 'klantnummer');
  assert.equal(S.NUMMERS.klantnummer.keyEnv, 'D360_API_KEY_KLANTNUMMER');
  assert.equal(S.NUMMERS.hoofdnummer.vast, S.VASTE_TEMPLATES);
  const alle = Object.values(S.VASTE_KLANT_TEMPLATES).flat();
  assert.equal(alle.length, 12);
  for (const n of alle) assert.equal(S.kiesCategorie({ naam: n, body: 'Je factuur {{1}} staat nog open.' }).categorie, 'UTILITY', n);
  assert.equal(S.kiesCategorie({ naam: 'x', bronnen: ['dunning_templates'], body: 'factuur' }).categorie, 'UTILITY');
  assert.deepEqual(S.joostTemplateNamen({ no_reply: { reminder_1_template_name: ' a ', reminder_2_template_name: 'b' } }), ['a', 'b']);
  assert.deepEqual(S.joostTemplateNamen(null), []);
});

test('callers geven customerId/module door aan de module-context', () => {
  const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  assert.match(lees('api/inbox-webhook.js'), /getModuleContextByPhoneNumberId\(supabaseAdmin, recvPhoneNumberId, \{ customerId: conv\.customerId \}\)/);
  for (const p of ['api/_lib/joost-suggest-core.js', 'api/_lib/onboarding-agent-core.js', 'api/_lib/simone-suggest-core.js',
    'api/inbox-send.js', 'api/inbox-send-template.js', 'api/inbox-template-list.js', 'api/inbox-quick-replies-list.js']) {
    assert.match(lees(p), /\{ customerId: conv\.customer_id \}/, p);
  }
  for (const p of ['api/_lib/onboarding-invite.js', 'api/_lib/onboarding-template-send.js']) {
    assert.match(lees(p), /\{ module: 'onboarding' \}/, p);
  }
  assert.match(lees('api/_lib/onboardingScope.js'), /resolveConversationModule\(phoneNumberId, customerId\)/);
  assert.match(lees('api/inbox-conversations-list.js'), /filterGesprekkenOpKlantModule\(/);
});

const sqlActief = (naam) => readFileSync(new URL('../docs/sql-migrations/' + naam, import.meta.url), 'utf8')
  .split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');

test('SQL lijn: finance + onboarding naar het klantnummer, business_account_id blijft de template-WABA', () => {
  const actief = sqlActief('2026-10-07-whatsapp-klantnummer-lijn.sql');
  assert.equal((actief.match(/\bupdate\s+public\.whatsapp_module_config/gi) || []).length, 2);
  assert.match(actief, new RegExp(KLANT));
  assert.match(actief, /990429800401598/);
  assert.match(actief, /module = 'finance' AND phone_number_id = '1194351613761790'/);
  assert.match(actief, /module = 'onboarding' AND phone_number_id = '1163203046877082'/);
  assert.doesNotMatch(actief, /\b(delete|drop|insert)\b/i);
});
