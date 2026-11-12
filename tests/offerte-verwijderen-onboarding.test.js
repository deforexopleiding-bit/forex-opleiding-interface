// tests/offerte-verwijderen-onboarding.test.js — "Definitief verwijderen
// (TL + CRM)" van een offerte waarschuwt bij een onboarding (Maxim, 12 nov
// 2026). Aanleiding: Laurens Rasti, 10 nov — de oude offerte werd verwijderd om
// te wisselen, de onboarding bleef open. Geen blocker: verwijderen kan, maar
// pas na een uitdrukkelijke bevestiging, en die bevestiging komt vóór
// Teamleader. Alles op nepgegevens; er gaat niets naar Teamleader of een klant.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Nepwereld ────────────────────────────────────────────────────────────
const wereld = {
  deal: null,
  onboardings: [],
  dealKolom: true,
  log: { tl: [], deletes: [], audit: [], mails: [] },
};

function bouwer(tabel) {
  const st = { tabel, sel: '', filters: {}, op: 'select', rij: null };
  const resultaat = () => {
    if (st.op === 'insert') {
      if (tabel === 'agent_audit_log') wereld.log.audit.push(st.rij);
      return { data: null, error: null };
    }
    if (st.op === 'delete') { wereld.log.deletes.push({ tabel, ...st.filters }); return { data: null, error: null }; }
    if (tabel === 'profiles') return { data: { id: 'u1', role: 'super_admin', is_active: true, email: 'test@voorbeeld.test' }, error: null };
    if (tabel === 'deals') return { data: wereld.deal, error: null };
    if (['invoices', 'bonuses', 'setter_ledger_entries', 'payment_arrangements'].includes(tabel)) return { data: [], error: null };
    if (tabel === 'onboardings') {
      if (!wereld.dealKolom && (/deal_id/.test(st.sel) || 'deal_id' in st.filters)) {
        return { data: null, error: { code: '42703', message: 'column onboardings.deal_id does not exist' } };
      }
      if (/handmatig|incasso/.test(st.sel)) return { data: wereld.onboardings.map((o) => ({ ...o })), error: null };
      let lijst = wereld.onboardings;
      if ('customer_id' in st.filters) lijst = lijst.filter((o) => o.customer_id === st.filters.customer_id);
      if ('deal_id' in st.filters) lijst = lijst.filter((o) => o.deal_id === st.filters.deal_id);
      return { data: lijst.map((o) => ({ ...o })), error: null };
    }
    return { data: [], error: null };
  };
  const q = {
    select(s) { st.sel = s || ''; return q; },
    eq(k, v) { st.filters[k] = v; return q; },
    in() { return q; }, is() { return q; }, not() { return q; }, order() { return q; },
    overlaps() { return q; }, limit() { return q; },
    insert(r) { st.op = 'insert'; st.rij = r; return q; },
    delete() { st.op = 'delete'; return q; },
    maybeSingle() { return Promise.resolve(resultaat()); },
    single() { return Promise.resolve(resultaat()); },
    then(ok, nok) { return Promise.resolve(resultaat()).then(ok, nok); },
  };
  return q;
}

const supabaseAdmin = { from: (t) => bouwer(t) };
mock.module('../api/supabase.js', {
  namedExports: {
    supabaseAdmin,
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'test@voorbeeld.test' } }, error: null }) } }),
  },
});
mock.module('../api/_lib/roles.js', {
  namedExports: {
    getEffectiveRoles: async () => ['super_admin'],
    hasAnyRole: (r, w) => r.some((x) => w.includes(x)),
    computeHighestRole: () => 'super_admin',
  },
});
mock.module('../api/_lib/teamleader-token.js', {
  namedExports: {
    getActiveToken: async () => 'nep-token',
    tlFetch: async (pad) => { wereld.log.tl.push(pad); return { ok: true, status: 204, text: async () => '' }; },
  },
});
mock.module('../api/mailer.js', {
  namedExports: { sendMail: async (m) => { wereld.log.mails.push(m); return { ok: true }; }, wrapEmailHtml: (h) => h },
});

const W = await import('../api/_lib/onboarding-offerte-wissel.js');
const { default: verwijder } = await import('../api/sales-hard-delete-quotation.js');

const KLANT = 'ff5e4766-0000-4000-8000-000000000001';
const DEAL = '233822a8-0000-4000-8000-000000000001';
const ANDERE_DEAL = 'b5d81a3c-0000-4000-8000-000000000001';
const deal = (x = {}) => ({ id: DEAL, customer_id: KLANT, tl_deal_id: 'tl-d', tl_quotation_id: 'tl-q', tl_quotation_status: 'accepted', quote_reference: 'OFF-TEST', ...x });
const ob = (x = {}) => ({ id: 'ob-1', customer_id: KLANT, customer_name: 'Test Klant', status: 'aangemeld', start_date: '2027-03-11', archived_at: null, deal_id: null, ...x });

function reset({ onboardings = [], dealKolom = true, d = deal() } = {}) {
  wereld.deal = d; wereld.onboardings = onboardings; wereld.dealKolom = dealKolom;
  wereld.log = { tl: [], deletes: [], audit: [], mails: [] };
}

function nepRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const post = async (body) => { const res = nepRes(); await verwijder({ method: 'POST', headers: {}, body }, res); return res; };

// ── De regel, puur ────────────────────────────────────────────────────────
test('REGEL: lopende onboarding van de klant, of deal_id = deze offerte → waarschuwing; met naam, status en start', () => {
  const r = W.onboardingsBijVerwijderen([ob()], deal());
  assert.deepEqual(r, [{ id: 'ob-1', naam: 'Test Klant', status: 'aangemeld', start_date: '2027-03-11', reden: 'lopend' }]);
  assert.equal(W.onboardingsBijVerwijderen([ob({ status: 'bezig', deal_id: DEAL })], deal())[0].reden, 'beide');
  // Afgesloten maar wel op deze offerte: toch waarschuwen.
  assert.equal(W.onboardingsBijVerwijderen([ob({ status: 'afgerond', handmatig_afgerond_op: 'x', deal_id: DEAL })], deal())[0].reden, 'deze_offerte');
  // Afgesloten en op een andere offerte: niets.
  assert.deepEqual(W.onboardingsBijVerwijderen([ob({ status: 'afgerond', handmatig_afgerond_op: 'x', deal_id: ANDERE_DEAL })], deal()), []);
  // Geannuleerd / gearchiveerd / in incasso: niets, ook niet op deze offerte.
  assert.deepEqual(W.onboardingsBijVerwijderen([ob({ status: 'geannuleerd', deal_id: DEAL })], deal()), []);
  assert.deepEqual(W.onboardingsBijVerwijderen([ob({ archived_at: '2026-11-01', deal_id: DEAL })], deal()), []);
  assert.deepEqual(W.onboardingsBijVerwijderen([ob({ incasso_op: '2026-11-01' })], deal()), []);
  // Een lopende onboarding van een ANDERE klant (via deal_id-query mee) telt als lopend niet.
  assert.deepEqual(W.onboardingsBijVerwijderen([ob({ customer_id: 'ander' })], deal()), []);
  assert.deepEqual(W.onboardingsBijVerwijderen([], deal()), []);
});

test('LEZEN: klant + deal_id samen, zonder dubbels; zonder kolom deal_id enkel op klant; leesfout = geen waarschuwing + fout', async () => {
  reset({ onboardings: [ob({ deal_id: DEAL })] });
  let r = await W.leesOnboardingsBijVerwijderen(supabaseAdmin, deal());
  assert.equal(r.onboardings.length, 1);
  assert.equal(r.onboardings[0].reden, 'beide');
  reset({ onboardings: [ob()], dealKolom: false });
  r = await W.leesOnboardingsBijVerwijderen(supabaseAdmin, deal());
  assert.equal(r.onboardings.length, 1);
  assert.equal(r.fout, null);
  const kapot = { from: () => ({ select: () => ({ eq: async () => ({ data: null, error: { message: 'boem' } }) }) }) };
  r = await W.leesOnboardingsBijVerwijderen(kapot, deal());
  assert.deepEqual(r.onboardings, []);
  assert.match(r.fout, /boem/);
});

// ── Het endpoint ──────────────────────────────────────────────────────────
test('POST zonder bevestiging bij een lopende onboarding → 409, en NIETS naar Teamleader of de databank', async () => {
  reset({ onboardings: [ob()] });
  const res = await post({ deal_id: DEAL, confirm: 'VERWIJDER' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'ONBOARDING_BEVESTIGING_NODIG');
  assert.equal(res.body.onboardings[0].naam, 'Test Klant');
  assert.match(res.body.detail, /Deze offerte vervangt de lopende onboarding/);
  assert.deepEqual(wereld.log.tl, []);
  assert.deepEqual(wereld.log.deletes, []);
  assert.deepEqual(wereld.log.mails, []);
});

test('POST met bevestiging → verwijderd; de audit zegt welke onboarding open bleef', async () => {
  reset({ onboardings: [ob()] });
  const res = await post({ deal_id: DEAL, confirm: 'VERWIJDER', onboarding_bevestigd: true });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(wereld.log.tl, ['/quotations.delete']);
  assert.equal(wereld.log.deletes.length, 1);
  const a = wereld.log.audit.find((x) => x.action === 'quotation.hard_delete');
  assert.equal(a.payload.onboardings_open_gelaten[0].id, 'ob-1');
});

test('POST zonder onboarding: geen extra bevestiging nodig (ongewijzigd gedrag)', async () => {
  reset({ onboardings: [] });
  const res = await post({ deal_id: DEAL, confirm: 'VERWIJDER' });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  const a = wereld.log.audit.find((x) => x.action === 'quotation.hard_delete');
  assert.equal(a.payload.onboardings_open_gelaten, undefined);
});

test('POST: het VERWIJDER-token blijft voorgaan op alles', async () => {
  reset({ onboardings: [ob()] });
  const res = await post({ deal_id: DEAL, confirm: 'verwijder', onboarding_bevestigd: true });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(wereld.log.tl, []);
});

// ── De schermen ───────────────────────────────────────────────────────────
test('BRON: preflight geeft de waarschuwing; beide verwijderschermen tonen haar met een verplicht vinkje en sturen de bevestiging', () => {
  const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  const pf = lees('api/sales-hard-delete-preflight.js');
  assert.match(pf, /onboarding_waarschuwing,/);
  assert.match(pf, /leesOnboardingsBijVerwijderen\(supabaseAdmin, deal\)/);
  for (const f of ['modules/klanten-v2/views/offerte-detail-v2.js', 'modules/offerte-detail-v2.html']) {
    const s = lees(f);
    assert.match(s, /onboarding_waarschuwing/, f);
    assert.match(s, /vinkje: obW \?/, f);
    assert.match(s, /onboarding_bevestigd: !!obW/, f);
    assert.match(s, /ONBOARDING_BEVESTIGING_NODIG/, f);
  }
  // De oude losse pagina's: deal_id mee, en bij een lopende onboarding de weg naar de vervang-knop.
  for (const f of ['modules/offerte-detail.html', 'modules/offerte-detail-v2.html']) {
    const s = lees(f);
    assert.match(s, /payload\.deal_id = dealId/, f);
    assert.match(s, /d\?\.kan_vervangen/, f);
    assert.match(s, /Deze offerte vervangt de lopende onboarding/, f);
    assert.match(s, /v2preview=sales&v2tab=Offertes&deal_id=/, f);
  }
});
