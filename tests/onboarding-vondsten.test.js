// tests/onboarding-vondsten.test.js — drie vondsten uit de onboarding-portal-
// oplevering (27 okt 2026):
//   (a) loadOnboardingForCustomer las niet-bestaande kolommen (traject_label,
//       mentor_name) → elke aanroep gaf een DB-fout en dus null;
//   (b) het detail-endpoint las de wizard op id=1 (1-op-1) ook voor membership;
//   (c) de klassieke onboarding-step-save liet geannuleerde onboardings opslaan.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const url = (p) => new URL('../' + p, import.meta.url).href;
const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ── Nep-databank voor de step-save-handler ────────────────────────────────
const stand = { ob: null, updates: [] };
mock.module(url('api/supabase.js'), { namedExports: {
  supabaseAdmin: {
    from() {
      let upd = null;
      const q = {
        select() { return q; }, eq() { return q; },
        update(v) { upd = v; return q; },
        maybeSingle() { return Promise.resolve({ data: stand.ob, error: null }); },
        then(ok) { if (upd) stand.updates.push(upd); return Promise.resolve({ error: null }).then(ok); },
      };
      return q;
    },
  },
  supabase: null, createUserClient: () => null,
} });
mock.module(url('api/_lib/rate-limit.js'), { namedExports: { checkRateLimit: async () => ({ limited: false }) } });
mock.module(url('api/_lib/onboarding-spiegel.js'), { namedExports: { spiegelNaActie: async () => {} } });

const { default: stepSave } = await import(url('api/onboarding-step-save.js'));
const { loadOnboardingForCustomer } = await import(url('api/_lib/template-variables.js'));
const { _resetVlagCache } = await import(url('api/_lib/onboarding-link.js'));

function nepRes() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const TOKEN = '11111111-2222-4333-8444-555555555555';
const save = async (ob) => {
  stand.ob = ob; stand.updates = [];
  const res = nepRes();
  await stepSave({ method: 'POST', query: { t: TOKEN }, body: { answers: { ervaring_trading: 'geen' }, current_step: 2 }, headers: {}, socket: {} }, res);
  return res;
};

test('(c) klassieke step-save: geannuleerd, gearchiveerd of archived_at → 409, niets opgeslagen', async () => {
  for (const ob of [
    { id: 'o', status: 'geannuleerd', answers: {} },
    { id: 'o', status: 'gearchiveerd', answers: {} },
    { id: 'o', status: 'bezig', answers: {}, archived_at: '2026-10-20T10:00:00Z' },
  ]) {
    const r = await save(ob);
    assert.equal(r.code, 409, JSON.stringify(ob));
    assert.equal(r.body.error, 'Onboarding is gesloten.');
    assert.equal(stand.updates.length, 0);
  }
  assert.equal((await save({ id: 'o', status: 'afgerond', answers: {} })).code, 409);
  const ok = await save({ id: 'o', status: 'bezig', answers: { a: 1 } });
  assert.equal(ok.code, 200);
  assert.deepEqual(stand.updates[0].answers, { a: 1, ervaring_trading: 'geen' });
});

test('(b) detail-endpoint leest de wizard van het eigen flowtype, niet id=1', () => {
  const d = lees('api/onboarding-detail.js');
  assert.match(d, /\.eq\('flow_type', resolveFlowType\(row\.traject\?\.type\)\)/);
  assert.doesNotMatch(d, /\.eq\('id', 1\)/);
});

// ── (a) loadOnboardingForCustomer ─────────────────────────────────────────
function leesDb({ ob, tm = null, pr = null, vlag = false }) {
  const selects = [];
  return {
    selects,
    from(t) {
      const q = {
        select(s) { selects.push(`${t}: ${s}`); return q; },
        eq() { return q; }, is() { return q; }, order() { return q; }, limit() { return q; },
        update() { return q; },
        maybeSingle() {
          if (t === 'onboardings') return Promise.resolve({ data: ob, error: null });
          if (t === 'team_members') return Promise.resolve({ data: tm, error: null });
          if (t === 'profiles') return Promise.resolve({ data: pr, error: null });
          if (t === 'app_settings') return Promise.resolve({ data: { value: vlag }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(ok) { return Promise.resolve({ data: [], error: null }).then(ok); },
      };
      return q;
    },
  };
}

test('(a) loadOnboardingForCustomer: enkel bestaande kolommen; traject, mentor en link afgeleid', async () => {
  _resetVlagCache();
  const db = leesDb({
    ob: { id: 'o', token: 'tok', startcode: 'ABCD2345', start_date: '2026-11-03', status: 'bezig', mentor_user_id: 'u1', traject: { label: '1-op-1 — 12 maanden' } },
    tm: { name: 'Seppe' }, vlag: true,
  });
  const o = await loadOnboardingForCustomer(db, 'c1');
  const obSelect = db.selects.find((s) => s.startsWith('onboardings:'));
  assert.doesNotMatch(obSelect, /traject_label|mentor_name/);
  assert.match(obSelect, /traject:onboarding_trajecten\(label\)/);
  assert.equal(o.traject_label, '1-op-1 — 12 maanden');
  assert.equal(o.mentor_name, 'Seppe');
  assert.equal(o.traject, undefined);
  assert.equal(o.persoonlijke_link, 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345');
  _resetVlagCache();
  // Geen team_members-naam → profiles.full_name; geen mentor → leeg.
  const viaProfiel = await loadOnboardingForCustomer(leesDb({ ob: { id: 'o', token: 't', mentor_user_id: 'u2', traject: null }, pr: { full_name: 'Lien' } }), 'c1');
  assert.equal(viaProfiel.mentor_name, 'Lien');
  assert.equal(viaProfiel.traject_label, null);
  _resetVlagCache();
  assert.equal(await loadOnboardingForCustomer(leesDb({ ob: null }), 'c1'), null);
  assert.equal(await loadOnboardingForCustomer(null, 'c1'), null);
  _resetVlagCache();
});
