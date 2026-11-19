// tests/brieven-lms.test.js — de brieven van het bord samen met Wanbetalers › Brieven (16 nov 2026).
//
// WAT HIER STIL KAN BREKEN
//  1. Brief 1/2 verwisseld (tussen = 1, pre = 2) of de verzenddatum in UTC in plaats van Brussel.
//  2. Oude brieven (vóór 16 nov) automatisch gekoppeld — Maxim wil die NIET omzetten.
//  3. Gokken bij twee open dossiers.
//  4. Een rol buiten administratie/hoofdmentor/admin die een brief maakt, of brief 2 vóór brief 1 verstuurd is.
//  5. Een onvolledig adres dat stil faalt.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  briefNrVan, briefTypeVoorNr, datumBrussel, standVoorLms, koppelEnSpiegel, spiegelVerwijderd, crmBrievenUrl,
} from '../api/_lib/brieven-lms.js';
import { maakHandler, magBriefMaken } from '../api/lms-brieven.js';

process.env.DFO_LMS_AGENDA_SECRET = 'geheim-proef';

/** Een kleine nep-Supabase: elke query wordt door `antwoord(tabel, q)` beantwoord en bewaard. */
function nepDb(antwoord) {
  const log = [];
  const bouw = (tabel) => {
    const q = { tabel, filters: [], update: null };
    const b = {
      select() { return b; },
      eq(k, v) { q.filters.push(['eq', k, v]); return b; },
      in(k, v) { q.filters.push(['in', k, v]); return b; },
      ilike(k, v) { q.filters.push(['ilike', k, v]); return b; },
      is(k, v) { q.filters.push(['is', k, v]); return b; },
      not(k, o, v) { q.filters.push(['not', k, o, v]); return b; },
      or(v) { q.filters.push(['or', v]); return b; },
      order() { return b; },
      limit() { return b; },
      update(u) { q.update = u; return b; },
      maybeSingle() { q.enkel = true; return b; },
      then(ok, nok) {
        log.push(q);
        return Promise.resolve(antwoord(tabel, q)).then(ok, nok);
      },
    };
    return b;
  };
  return {
    log,
    rpcs: [],
    from: bouw,
    rpc(naam, args) { this.rpcs.push({ naam, args }); return Promise.resolve(antwoord('rpc:' + naam, args)); },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://opslag/brief.pdf?token=x' }, error: null }) }) },
  };
}

test('brief 1 = tussenbrief, brief 2 = pre-incassobrief; de generator krijgt het juiste type', () => {
  assert.equal(briefNrVan('incasso_tussen_be'), 1);
  assert.equal(briefNrVan('incasso_tussen_nl'), 1);
  assert.equal(briefNrVan('incasso_pre_be'), 2);
  assert.equal(briefNrVan('incasso_pre_nl'), 2);
  assert.equal(briefNrVan('wik_oud'), null);
  assert.equal(briefTypeVoorNr(1), 'tussen');
  assert.equal(briefTypeVoorNr(2), 'wik');
});

test('de verzenddatum is die van Brussel, niet UTC', () => {
  assert.equal(datumBrussel('2026-11-16T13:28:07.02+00:00'), '2026-11-16');
  assert.equal(datumBrussel('2026-11-16T23:30:00+00:00'), '2026-11-17');
  assert.equal(datumBrussel(null), null);
});

test('de stand voor het LMS: verstuurd met datum en wie, of leeg', () => {
  const mensen = new Map([['u1', { email: 'maxim@x', naam: 'Maxim' }]]);
  const brief = { id: 'b1', template_code: 'incasso_tussen_nl', generated_at: '2026-11-16T11:32:00Z', generated_by_user_id: 'u1', sent_at: '2026-11-16T13:28:07Z', sent_by_user_id: 'u1' };
  const s = standVoorLms(brief, mensen);
  assert.deepEqual([s.brief_id, s.verstuurd_op, s.verstuurd_door_email, s.aangemaakt_door_naam], ['b1', '2026-11-16', 'maxim@x', 'Maxim']);
  const leeg = standVoorLms({ ...brief, sent_at: null }, mensen);
  assert.equal(leeg.verstuurd_op, null);
  assert.equal(leeg.verstuurd_door_email, null);
});

test('de link naar Brieven zoekt meteen op de naam', () => {
  assert.match(crmBrievenUrl('Jalila Gassa'), /\/modules\/klanten-v2\/\?v2preview=wanbetalers&v2tab=Brieven&brzoek=Jalila%20Gassa$/);
});

test('een nieuwe brief in het CRM voor een klant met één open betalingsdossier: gekoppeld en gespiegeld', async () => {
  const crm = nepDb((t) => {
    if (t === 'dunning_briefs') return { data: { id: 'b1', customer_id: 'k1', template_code: 'incasso_pre_be', generated_at: '2026-11-16T11:33:00Z', sent_at: '2026-11-16T13:28:07Z', sent_by_user_id: 'u1', generated_by_user_id: 'u1', lms_dossier_id: null, lms_brief_nr: null }, error: null };
    if (t === 'customers') return { data: { id: 'k1', email: 'jalila@x' }, error: null };
    if (t === 'onboardings') return { data: [{ id: 'o1', dfo_lms_student_id: 's1' }], error: null };
    if (t === 'profiles') return { data: [{ id: 'u1', email: 'maxim@x', full_name: 'Maxim' }], error: null };
    return { data: null, error: null };
  });
  const lms = nepDb((t) => {
    if (t === 'hlms_student') return { data: [{ id: 's1' }], error: null };
    if (t === 'hlms_admin_dossier') return { data: [{ id: 'd1', fase: 'brief_1' }], error: null };
    if (t === 'rpc:hlms_admin_brief_crm') return { data: 'gekoppeld', error: null };
    return { data: null, error: null };
  });
  const uit = await koppelEnSpiegel('b1', { bron: 'crm' }, { crm, lms });
  assert.equal(uit.status, 'gekoppeld');
  assert.equal(uit.dossier_id, 'd1');
  const upd = crm.log.find((q) => q.update);
  assert.deepEqual(upd.update, { lms_dossier_id: 'd1', lms_brief_nr: 2 });
  assert.equal(lms.rpcs.length, 1);
  assert.deepEqual([lms.rpcs[0].args.p_nr, lms.rpcs[0].args.p_bron, lms.rpcs[0].args.p_crm.verstuurd_op], [2, 'crm', '2026-11-16']);
});

test('oude brieven (vóór 16 nov) en twee open dossiers worden nooit automatisch gekoppeld', async () => {
  const oud = nepDb((t) => (t === 'dunning_briefs'
    ? { data: { id: 'b0', customer_id: 'k1', template_code: 'incasso_pre_nl', generated_at: '2026-09-10T10:00:00Z', lms_dossier_id: null }, error: null }
    : { data: null, error: null }));
  const lms = nepDb(() => ({ data: [], error: null }));
  assert.equal((await koppelEnSpiegel('b0', {}, { crm: oud, lms })).status, 'te_oud');
  assert.equal(lms.rpcs.length, 0);

  const twee = nepDb((t) => {
    if (t === 'dunning_briefs') return { data: { id: 'b2', customer_id: 'k2', template_code: 'incasso_tussen_nl', generated_at: '2026-11-17T09:00:00Z', lms_dossier_id: null }, error: null };
    if (t === 'customers') return { data: { id: 'k2', email: 'x@y' }, error: null };
    if (t === 'onboardings') return { data: [], error: null };
    return { data: null, error: null };
  });
  const lms2 = nepDb((t) => (t === 'hlms_student' ? { data: [{ id: 's2' }], error: null } : { data: [{ id: 'dA' }, { id: 'dB' }], error: null }));
  const u = await koppelEnSpiegel('b2', {}, { crm: twee, lms: lms2 });
  assert.deepEqual([u.status, u.reden], ['geen_dossier', 'meerdere_dossiers']);
  assert.equal(lms2.rpcs.length, 0);
});

test('verwijderd in het CRM: het bord krijgt "verwijderd" voor elke gekoppelde brief', async () => {
  const lms = nepDb(() => ({ data: 'verwijderd', error: null }));
  const uit = await spiegelVerwijderd([{ id: 'b1', lms_dossier_id: 'd1', lms_brief_nr: 1 }, { id: 'b2', lms_dossier_id: null }], { lms });
  assert.deepEqual(uit, [{ id: 'b1', status: 'verwijderd' }]);
  assert.deepEqual(lms.rpcs[0].args.p_crm, { brief_id: 'b1', verwijderd: true });
});

test('mag een dossier nu brief N in het CRM krijgen?', () => {
  assert.equal(magBriefMaken({ spoor: 'betaling', fase: 'contact', brieven: {} }, 1), null);
  assert.equal(magBriefMaken({ spoor: 'betaling', fase: 'brief_1', brieven: { 1: { klaar_op: 'x' } } }, 1), null);
  assert.match(magBriefMaken({ spoor: 'betaling', fase: 'brief_1', brieven: { 1: {} } }, 2), /eerst brief 1/);
  assert.equal(magBriefMaken({ spoor: 'betaling', fase: 'brief_1', brieven: { 1: { verstuurd_op: '2026-11-16' } } }, 2), null);
  assert.match(magBriefMaken({ spoor: 'opstart', fase: 'bellen' }, 1), /betalingsspoor/);
  assert.match(magBriefMaken({ spoor: 'betaling', fase: 'incasso', brieven: {} }, 1), /Bellen en contact/);
  assert.match(magBriefMaken({ spoor: 'betaling', fase: 'contact', gesloten_op: 'x' }, 1), /gesloten/);
});

function nepRes() {
  const r = { code: 0, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const vraag = (body, extra = {}) => ({ method: 'POST', headers: { 'x-dfo-secret': 'geheim-proef' }, body, query: {}, ...extra });

test('de machine-route: rollen, volgorde, het juiste brieftype, en een onvolledig adres zegt wat er mist', async () => {
  const lms = nepDb((t) => (t === 'hlms_admin_dossier'
    ? { data: { id: 'd1', spoor: 'betaling', fase: 'contact', gesloten_op: null, brieven: {}, student_id: '33333333-3333-3333-3333-333333333333', crm_onboarding_id: '44444444-4444-4444-4444-444444444444' }, error: null }
    : { data: null, error: null }));
  const crm = nepDb((t) => {
    if (t === 'onboardings') return { data: { customer_id: 'k1' }, error: null };
    if (t === 'profiles') return { data: [{ id: 'u9' }], error: null };
    return { data: null, error: null };
  });
  const aanroepen = [];
  const genereer = async (o) => { aanroepen.push(o); return { ok: true, brief_id: 'b9', template_code: 'incasso_tussen_be', country: 'BE', lms: { status: 'gekoppeld' } }; };
  const h = maakHandler({ crm, lms, genereer });
  const seppe = { email: 'seppe@x', naam: 'Seppe', rollen: ['administratie'] };

  let res = nepRes();
  await h(vraag({ actie: 'maak', dossier_id: '11111111-1111-1111-1111-111111111111', nr: 1, actor: { rollen: ['mentor'] } }), res);
  assert.equal(res.code, 403);

  res = nepRes();
  await h(vraag({ actie: 'maak', dossier_id: '11111111-1111-1111-1111-111111111111', nr: 1, actor: seppe, naam: 'Proef' }), res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.deepEqual([aanroepen[0].customerId, aanroepen[0].briefType, aanroepen[0].generatedByUserId], ['k1', 'tussen', 'u9']);
  assert.deepEqual(aanroepen[0].lmsKoppeling, { dossierId: 'd1', nr: 1, bron: 'lms', aangemaaktDoorEmail: 'seppe@x' });
  assert.match(res.body.data.crm_url, /v2tab=Brieven/);

  res = nepRes();
  await h(vraag({ actie: 'maak', dossier_id: '11111111-1111-1111-1111-111111111111', nr: 2, actor: seppe }), res);
  assert.equal(res.code, 409);
  assert.match(res.body.message, /Brief 2 kan alleen na brief 1/);

  const zonderAdres = maakHandler({ crm, lms, genereer: async () => ({ ok: false, code: 'ADDRESS_INCOMPLETE', missing: ['postcode'] }) });
  res = nepRes();
  await zonderAdres(vraag({ actie: 'maak', dossier_id: '11111111-1111-1111-1111-111111111111', nr: 1, actor: seppe }), res);
  assert.equal(res.code, 422);
  assert.match(res.body.message, /ontbreekt: postcode/);

  res = nepRes();
  await h({ method: 'POST', headers: { 'x-dfo-secret': 'fout' }, body: {}, query: {} }, res);
  assert.equal(res.code, 403);
});

test('dezelfde brief opnieuw: niets dubbel, het CRM zegt dat hij er al staat', async () => {
  const lms = nepDb(() => ({ data: { id: 'd1', spoor: 'betaling', fase: 'brief_1', brieven: { 1: { crm: { brief_id: 'b9' } } } }, error: null }));
  let gemaakt = 0;
  const h = maakHandler({ crm: nepDb(() => ({ data: null, error: null })), lms, genereer: async () => { gemaakt += 1; return { ok: true }; } });
  const res = nepRes();
  await h(vraag({ actie: 'maak', dossier_id: '11111111-1111-1111-1111-111111111111', nr: 1, actor: { rollen: ['admin'] } }), res);
  assert.equal(res.body.code, 'al_in_crm');
  assert.equal(gemaakt, 0);
});

test('de PDF-link: alleen voor bordbrieven, 5 minuten', async () => {
  const crm = nepDb(() => ({ data: { id: 'b1', pdf_path: 'k1/x.pdf', lms_dossier_id: 'd1' }, error: null }));
  const h = maakHandler({ crm, lms: null });
  const res = nepRes();
  await h({ method: 'GET', headers: { 'x-dfo-secret': 'geheim-proef' }, query: { pdf: '22222222-2222-2222-2222-222222222222' } }, res);
  assert.equal(res.code, 200);
  assert.match(res.body.data.url, /^https:\/\/opslag\//);
});
