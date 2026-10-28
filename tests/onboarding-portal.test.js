// tests/onboarding-portal.test.js — de nieuwe klant-onboarding op de website
// (www.deforexopleiding.nl/onboarding) en de API erachter.
//
// Wat hier vastligt is het BEDOELDE gedrag uit de opdracht (27 okt 2026):
//   · startcode: 8 tekens uit een alfabet zonder 0/O/1/I, opgeslagen zonder
//     streepje, nooit "verbeterd", botsing → opnieuw (max 5);
//   · 'open' lekt niet of een code bestaat (ongeldig = onbekend, zelfde 404);
//   · 'save' schrijft alleen de whitelist, met typecontrole;
//   · 'complete' doet EXACT wat de klassieke wizard doet (gedeelde functie);
//   · CORS nooit '*', alleen exacte treffers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  genereer, normaliseer, formatteer, kenStartcodeToe, STARTCODE_ALFABET,
} from '../api/_lib/onboarding-startcode.js';
import {
  valideerPatch, portalAntwoorden, ontbrekend, mentorKort, automationVelden,
  resolvePortalOrigin, portalOrigins,
} from '../api/_lib/onboarding-portal.js';
import { rondWizardAf } from '../api/_lib/onboarding-afronden.js';
import { maakHandler } from '../api/onboarding-portal.js';
import { combineerWaiver, computeBedenktijd, leesLmsAfstand } from '../api/_lib/onboarding-bedenktijd.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ── Een kleine nep-databank (supabase-js-achtige ketting) ──────────────────
function nepDb(tabellen = {}, { fouten = {} } = {}) {
  const log = { updates: [], selects: [] };
  const db = {
    log,
    tabellen,
    from(t) {
      const rijen = (tabellen[t] ||= []);
      const filters = [];
      let op = 'select';
      let waarden = null;
      let metSelect = false;
      const pas = (r) => filters.every((f) => f(r));
      const uitvoeren = () => {
        const regel = fouten[`${t}.${op}`];
        const fout = typeof regel === 'function' ? regel(waarden) : regel;
        if (fout) return { data: null, error: fout };
        if (op === 'update') {
          const geraakt = rijen.filter(pas);
          for (const r of geraakt) Object.assign(r, waarden);
          log.updates.push({ t, waarden, n: geraakt.length });
          return { data: metSelect ? geraakt.map((r) => ({ ...r })) : null, error: null };
        }
        log.selects.push(t);
        return { data: rijen.filter(pas).map((r) => ({ ...r })), error: null };
      };
      const q = {
        select() { if (op === 'update') metSelect = true; return q; },
        update(v) { op = 'update'; waarden = v; return q; },
        eq(k, v) { filters.push((r) => r[k] === v); return q; },
        is(k, v) { filters.push((r) => (r[k] ?? null) === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
        order() { return q; },
        limit() { return q; },
        maybeSingle() {
          const r = uitvoeren();
          return Promise.resolve(r.error ? r : { data: (r.data || [])[0] || null, error: null });
        },
        then(ok, nok) { return Promise.resolve(uitvoeren()).then(ok, nok); },
      };
      return q;
    },
  };
  return db;
}

function nepRes() {
  const r = { statusCode: 200, headers: {}, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.end = () => r;
  return r;
}

const TOKEN = '11111111-2222-4333-8444-555555555555';
const CODE = 'ABCD2345';

function basis({ status = 'aangemeld', answers = {}, trajectType = '1op1', mentor = true } = {}) {
  return {
    onboardings: [{
      id: 'ob-1', token: TOKEN, startcode: CODE, status, customer_id: 'c-1',
      customer_name: 'Wim Peeters', traject_id: 't-1', mentor_user_id: mentor ? 'm-1' : null,
      start_date: '2026-11-03', current_step: 0, answers, started_at: null,
    }],
    customers: [{ id: 'c-1', first_name: 'Wim', last_name: 'Peeters', email: 'wim@example.com', phone: '+32470000000' }],
    onboarding_trajecten: [{ id: 't-1', type: trajectType, label: '1-op-1 — 12 maanden', duur_maanden: 12 }],
    profiles: [{ id: 'm-1', full_name: 'Seppe Hermans' }],
  };
}

function handlerMet(db, extra = {}) {
  const calls = { afronden: [], automation: [], spiegel: [] };
  const h = maakHandler({
    db: () => db,
    rateLimit: async () => ({ limited: false }),
    rondWizardAf: async (ob, o) => { calls.afronden.push({ ob, o }); return { ok: true }; },
    spiegel: async (id, bron) => { calls.spiegel.push({ id, bron }); },
    naAutomation: async (a) => { calls.automation.push(a); },
    nu: () => new Date('2026-10-27T10:00:00Z'),
    ...extra,
  });
  return { h, calls };
}

async function post(h, body, origin = 'https://www.deforexopleiding.nl') {
  const res = nepRes();
  await h({ method: 'POST', headers: { origin }, body }, res);
  return res;
}

// ═══ Startcode ═════════════════════════════════════════════════════════════

test('startcode: 8 tekens, alleen uit het alfabet zonder 0/O/1/I', () => {
  assert.equal(STARTCODE_ALFABET.length, 32);
  for (const ch of '0O1I') assert.ok(!STARTCODE_ALFABET.includes(ch), ch);
  for (let i = 0; i < 300; i++) {
    const c = genereer();
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  }
});

test('startcode: normaliseren — hoofdletters, spaties en streepjes eruit; nooit verbeteren', () => {
  assert.equal(normaliseer('abcd-2345'), CODE);
  assert.equal(normaliseer(' ab cd–23 45 '), CODE);
  assert.equal(normaliseer('ABCD2345'), CODE);
  // Een O of 0 is een tikfout: NIET stil naar iets anders mappen.
  assert.equal(normaliseer('ABCD-234O'), null);
  assert.equal(normaliseer('ABCD-2340'), null);
  assert.equal(normaliseer('ABCD-23I5'), null);
  assert.equal(normaliseer('ABCD-234'), null);
  assert.equal(normaliseer('ABCD-23456'), null);
  for (const x of [null, undefined, 12345678, {}, '']) assert.equal(normaliseer(x), null);
  assert.equal(formatteer(CODE), 'ABCD-2345');
  assert.equal(formatteer('abcd2345'), 'ABCD-2345');
  assert.equal(formatteer('fout'), '');
});

test('startcode toekennen: bestaande code blijft, botsing → nieuwe code, max 5 pogingen', async () => {
  // Bestaande code wordt nooit vervangen (staat al in verstuurde mails).
  const db1 = nepDb({ onboardings: [{ id: 'a', startcode: 'ZZZZ2222' }] });
  assert.equal(await kenStartcodeToe(db1, 'a'), 'ZZZZ2222');
  assert.equal(db1.log.updates.length, 0);

  // Twee botsingen, dan raak.
  const reeks = ['AAAA2222', 'BBBB3333', 'CCCC4444'];
  let i = 0;
  const code = await kenStartcodeToe(nepDbBotsing(2), 'a', { maak: () => reeks[i++] });
  assert.equal(code, 'CCCC4444');

  // Altijd botsing → na 5 pogingen null, geen crash.
  let j = 0;
  assert.equal(await kenStartcodeToe(nepDbBotsing(99), 'a', { maak: () => `DDDD${2222 + j++}`.slice(0, 8) }), null);
});

function nepDbBotsing(aantal) {
  let botsingen = 0;
  const rij = { id: 'a', startcode: null };
  return {
    from() {
      let upd = null;
      const q = {
        select() { return q; }, eq() { return q; }, is() { return q; },
        update(v) { upd = v; return q; },
        maybeSingle() { return Promise.resolve({ data: { ...rij }, error: null }); },
        then(ok) {
          if (upd) {
            if (botsingen < aantal) { botsingen++; return Promise.resolve({ data: null, error: { code: '23505', message: 'dup' } }).then(ok); }
            Object.assign(rij, upd);
            return Promise.resolve({ data: [{ ...rij }], error: null }).then(ok);
          }
          return Promise.resolve({ data: [{ ...rij }], error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

test('startcode toekennen: zonder kolom (migratie niet gedraaid) → null, geen throw', async () => {
  const db = nepDb({ onboardings: [{ id: 'a' }] }, {
    fouten: { 'onboardings.select': { code: '42703', message: 'column onboardings.startcode does not exist' } },
  });
  assert.equal(await kenStartcodeToe(db, 'a'), null);
});

test('migratie: zelfde alfabet als de code, partiële unieke index, backfill idempotent', () => {
  const sql = lees('docs/sql-migrations/2026-10-27-onboarding-portal.sql');
  assert.ok(sql.includes(`'${STARTCODE_ALFABET}'`));
  assert.match(sql, /create unique index if not exists onboardings_startcode_uniek[\s\S]*where startcode is not null/);
  assert.match(sql, /where startcode is null and status in \('aangemeld', 'bezig'\)/);
  assert.match(sql, /add column if not exists automation_interesse text/);
  assert.match(sql, /add column if not exists automation_belmoment text\[\]/);
  assert.match(sql, /'onboarding_portal_live', 'false'::jsonb\)\s*on conflict \(key\) do nothing/);
  // Geen drop buiten het rollback-commentaar.
  const zonderCommentaar = sql.split('\n').filter((r) => !/^\s*--/.test(r)).join('\n');
  assert.doesNotMatch(zonderCommentaar, /\bdrop\b/i);
});

// ═══ Whitelist / validatie ═════════════════════════════════════════════════

test('whitelist: alleen de portal-sleutels, alleen geldige waarden', () => {
  const goed = valideerPatch({
    coaching_locatie_voorkeur: 'enkel_online',
    ervaring_trading: 'gemiddeld',
    motivatie_primair: 'anders',
    commitment_uren_per_week: 10,
    beschikbaarheid: { zo: ['avond', 'ochtend', 'avond'], ma: [] },
    robot_interesse: 'ja_interesse',
    robot_belmoment: ['weekend', 'voormiddag'],
  });
  assert.equal(goed.ok, true);
  // Dubbels eruit en vaste volgorde.
  assert.deepEqual(goed.schoon.beschikbaarheid, { zo: ['ochtend', 'avond'], ma: [] });
  assert.deepEqual(goed.schoon.robot_belmoment, ['voormiddag', 'weekend']);

  const fout = [
    { akkoord_afronding: true },                       // onbekende sleutel
    { waiver_bedenktijd_digitaal: true },               // juridisch veld: nooit via de portal
    { ervaring_trading: 'middelbaar' },                 // oude waarde, niet in de lijst
    { robot_interesse: 'laterbespreken' },
    { commitment_uren_per_week: 0 },
    { commitment_uren_per_week: 11 },
    { commitment_uren_per_week: '5' },
    { commitment_uren_per_week: 4.5 },
    { beschikbaarheid: { maandag: ['avond'] } },
    { beschikbaarheid: { ma: ['nacht'] } },
    { beschikbaarheid: ['ma'] },
    { robot_belmoment: ['zondag'] },
    { robot_belmoment: 'avond' },
    { coaching_locatie_voorkeur: '<script>' },
  ];
  for (const p of fout) assert.equal(valideerPatch(p).ok, false, JSON.stringify(p));
  assert.equal(valideerPatch(null).ok, false);
  assert.equal(valideerPatch([]).ok, false);
});

test('verplicht per flow: 1-op-1 vraagt locatie + ≥1 moment, membership niet', () => {
  const vol1 = {
    coaching_locatie_voorkeur: 'enkel_online', ervaring_trading: 'geen', motivatie_primair: 'extra_inkomen',
    commitment_uren_per_week: 3, beschikbaarheid: { ma: ['avond'] }, robot_interesse: 'nee',
  };
  assert.deepEqual(ontbrekend('1op1', vol1), []);
  assert.deepEqual(ontbrekend('1op1', { ...vol1, beschikbaarheid: { ma: [], di: [] } }), ['beschikbaarheid']);
  assert.deepEqual(ontbrekend('1op1', { ...vol1, coaching_locatie_voorkeur: undefined }), ['coaching_locatie_voorkeur']);
  const mem = { ervaring_trading: 'geen', motivatie_primair: 'anders', commitment_uren_per_week: 1, robot_interesse: 'ja_interesse' };
  assert.deepEqual(ontbrekend('membership', mem), []);
  assert.deepEqual(ontbrekend('membership', {}), ['ervaring_trading', 'motivatie_primair', 'commitment_uren_per_week', 'robot_interesse']);
  // Een oude wizard-waarde telt niet als ingevuld: de klant kiest opnieuw.
  assert.deepEqual(ontbrekend('membership', { ...mem, robot_interesse: 'laterbespreken' }), ['robot_interesse']);
});

test('portalAntwoorden: alleen portal-sleutels met geldige waarden naar de browser', () => {
  const a = portalAntwoorden({
    ervaring_trading: 'gemiddeld', robot_interesse: 'laterbespreken',
    waiver_bedenktijd_digitaal: true, startbudget_euro: 5000,
  });
  assert.deepEqual(a, { ervaring_trading: 'gemiddeld' });
});

test('mentorKort: voornaam + initialen, null zonder naam', () => {
  assert.deepEqual(mentorKort('Seppe Hermans'), { voornaam: 'Seppe', initialen: 'SH' });
  assert.deepEqual(mentorKort('  maxim  de lombaerde '), { voornaam: 'maxim', initialen: 'ML' });
  assert.deepEqual(mentorKort('Dave'), { voornaam: 'Dave', initialen: 'D' });
  assert.equal(mentorKort(''), null);
  assert.equal(mentorKort(null), null);
});

test('automationVelden: ja/nee + moment van wijziging + belmoment', () => {
  const nu = new Date('2026-10-27T10:00:00Z');
  assert.equal(automationVelden({}, { ervaring_trading: 'geen' }, { ervaring_trading: 'geen' }, nu), null);
  assert.deepEqual(
    automationVelden({}, { robot_interesse: 'ja_interesse' }, { robot_interesse: 'ja_interesse' }, nu),
    { automation_interesse: 'ja', automation_belmoment: [], automation_interesse_op: nu.toISOString() });
  // Alleen het belmoment wijzigt: interesse_op blijft staan.
  assert.deepEqual(
    automationVelden({ robot_interesse: 'ja_interesse' }, { robot_interesse: 'ja_interesse', robot_belmoment: ['avond'] }, { robot_belmoment: ['avond'] }, nu),
    { automation_interesse: 'ja', automation_belmoment: ['avond'] });
  // Terug naar nee: belmoment leeg.
  assert.deepEqual(
    automationVelden({ robot_interesse: 'ja_interesse' }, { robot_interesse: 'nee', robot_belmoment: ['avond'] }, { robot_interesse: 'nee' }, nu),
    { automation_interesse: 'nee', automation_belmoment: [], automation_interesse_op: nu.toISOString() });
});

// ═══ CORS ══════════════════════════════════════════════════════════════════

test("CORS: standaard www + kaal domein, env overschrijft, previews van ons team, nooit '*'", () => {
  assert.deepEqual(portalOrigins(''), ['https://www.deforexopleiding.nl', 'https://deforexopleiding.nl']);
  assert.equal(resolvePortalOrigin('https://www.deforexopleiding.nl', ''), 'https://www.deforexopleiding.nl');
  assert.equal(resolvePortalOrigin('https://deforexopleiding.nl', ''), 'https://deforexopleiding.nl');
  assert.equal(resolvePortalOrigin('https://staging.example.com', 'https://staging.example.com, https://www.deforexopleiding.nl'), 'https://staging.example.com');
  assert.equal(resolvePortalOrigin('https://dfo-website-git-x-de-forex-opleiding-bv-s-projects.vercel.app', ''),
    'https://dfo-website-git-x-de-forex-opleiding-bv-s-projects.vercel.app');
  for (const o of ['https://kwaad.example', 'https://www.deforexopleiding.nl.kwaad.example', 'http://www.deforexopleiding.nl',
    'https://dfo-website-nep.vercel.app', '*', '', null, undefined]) {
    assert.equal(resolvePortalOrigin(o, ''), null, String(o));
  }
  // '*' in de env wordt genegeerd.
  assert.equal(resolvePortalOrigin('https://x.example', '*'), null);
});

test('CORS: preflight 204 met het origin; vreemd origin krijgt geen Allow-Origin', async () => {
  const { h } = handlerMet(nepDb(basis()));
  const ok = nepRes();
  await h({ method: 'OPTIONS', headers: { origin: 'https://www.deforexopleiding.nl' } }, ok);
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://www.deforexopleiding.nl');
  assert.match(ok.headers['access-control-allow-methods'], /POST/);
  assert.equal(ok.headers.vary, 'Origin');

  const vreemd = await post(h, { action: 'open', code: CODE }, 'https://kwaad.example');
  assert.equal(vreemd.headers['access-control-allow-origin'], undefined);
});

// ═══ open ══════════════════════════════════════════════════════════════════

test('open: geldig → dossier met minimale PII en de bestaande token als sessie', async () => {
  const { h } = handlerMet(nepDb(basis({ answers: { ervaring_trading: 'beginner', waiver_bedenktijd_digitaal: true } })));
  const r = await post(h, { action: 'open', code: 'abcd-2345' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, {
    sessie: TOKEN, voornaam: 'Wim', flow_type: '1op1', traject_naam: '1-op-1 Mentorship',
    start_datum: '2026-11-03', duur_maanden: 12, mentor: { voornaam: 'Seppe', initialen: 'SH' },
    status: 'aangemeld', current_step: 0, answers: { ervaring_trading: 'beginner' }, afgerond: false,
  });
  const json = JSON.stringify(r.body);
  for (const lek of ['wim@example.com', '+32470000000', 'Peeters', 'Hermans']) assert.ok(!json.includes(lek), lek);
});

test('open: membership-traject en geen mentor', async () => {
  const { h } = handlerMet(nepDb(basis({ trajectType: 'membership', mentor: false })));
  const r = await post(h, { action: 'open', code: CODE });
  assert.equal(r.body.flow_type, 'membership');
  assert.equal(r.body.traject_naam, 'Membership Program');
  assert.equal(r.body.mentor, null);
});

test('open: ongeldig formaat en onbekende code geven HETZELFDE 404 (geen enumeratie)', async () => {
  const { h } = handlerMet(nepDb(basis()));
  const a = await post(h, { action: 'open', code: 'ZZZZ-9999' });
  const b = await post(h, { action: 'open', code: 'O0O0' });
  const c = await post(h, { action: 'open' });
  for (const r of [a, b, c]) assert.equal(r.statusCode, 404);
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(a.body, c.body);
});

test('open: gearchiveerd/geannuleerd → 410 met nette tekst', async () => {
  for (const status of ['gearchiveerd', 'geannuleerd']) {
    const { h } = handlerMet(nepDb(basis({ status })));
    const r = await post(h, { action: 'open', code: CODE });
    assert.equal(r.statusCode, 410);
    assert.match(r.body.error, /afgesloten.*administratie@deforexopleiding\.nl/);
    assert.equal(r.body.sessie, undefined);
  }
});

test('open: afgerond → 200 met afgerond:true (klaar-scherm, alleen-lezen)', async () => {
  const { h } = handlerMet(nepDb(basis({ status: 'afgerond' })));
  const r = await post(h, { action: 'open', code: CODE });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.afgerond, true);
});

test('open: rate limit — 10/min en 40/uur per IP, daarna 429 zonder databankopvraging', async () => {
  const gevraagd = [];
  const db = nepDb(basis());
  const { h } = handlerMet(db, {
    rateLimit: async (o) => { gevraagd.push([o.bucket, o.maxHits, o.withinSeconds]); return { limited: o.bucket === 'onboarding-portal-open-uur' }; },
  });
  const r = await post(h, { action: 'open', code: CODE });
  assert.equal(r.statusCode, 429);
  assert.deepEqual(gevraagd, [['onboarding-portal-open', 10, 60], ['onboarding-portal-open-uur', 40, 3600]]);
  assert.equal(db.log.selects.length, 0);
});

test('open: kolom startcode bestaat nog niet → 503, geen crash', async () => {
  const db = nepDb(basis(), { fouten: { 'onboardings.select': { code: '42703', message: 'column onboardings.startcode does not exist' } } });
  const { h } = handlerMet(db);
  const r = await post(h, { action: 'open', code: CODE });
  assert.equal(r.statusCode, 503);
});

// ═══ save ══════════════════════════════════════════════════════════════════

test('save: merge, aangemeld → bezig + started_at, spiegel; zelfde gedrag als step-save', async () => {
  const db = nepDb(basis({ answers: { ervaring_trading: 'geen', startbudget_euro: 500 } }));
  const { h, calls } = handlerMet(db);
  const r = await post(h, { action: 'save', sessie: TOKEN, current_step: 2, answers: { motivatie_primair: 'extra_inkomen' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, current_step: 2 });
  const ob = db.tabellen.onboardings[0];
  // Oude sleutels blijven staan (shallow merge).
  assert.deepEqual(ob.answers, { ervaring_trading: 'geen', startbudget_euro: 500, motivatie_primair: 'extra_inkomen' });
  assert.equal(ob.status, 'bezig');
  assert.equal(ob.started_at, '2026-10-27T10:00:00.000Z');
  assert.equal(ob.current_step, 2);
  assert.deepEqual(calls.spiegel, [{ id: 'ob-1', bron: 'onboarding-portal-save' }]);
  assert.equal(calls.automation.length, 0);
});

test('save: niet-whitelisted sleutel of foute waarde → 400 en NIETS geschreven', async () => {
  const db = nepDb(basis());
  const { h } = handlerMet(db);
  for (const answers of [{ akkoord_afronding: true }, { ervaring_trading: 'expert' }, { commitment_uren_per_week: 99 }]) {
    const r = await post(h, { action: 'save', sessie: TOKEN, current_step: 1, answers });
    assert.equal(r.statusCode, 400, JSON.stringify(answers));
  }
  assert.equal(db.log.updates.length, 0);
  const r = await post(h, { action: 'save', sessie: TOKEN, current_step: -1, answers: {} });
  assert.equal(r.statusCode, 400);
});

test('save: afgerond → 409, afgesloten → 410, onbekende sessie → 404', async () => {
  for (const [status, code] of [['afgerond', 409], ['gearchiveerd', 410], ['geannuleerd', 410]]) {
    const db = nepDb(basis({ status }));
    const { h } = handlerMet(db);
    const r = await post(h, { action: 'save', sessie: TOKEN, current_step: 1, answers: { ervaring_trading: 'geen' } });
    assert.equal(r.statusCode, code, status);
    assert.equal(db.log.updates.length, 0);
  }
  const { h } = handlerMet(nepDb(basis()));
  assert.equal((await post(h, { action: 'save', sessie: 'geen-uuid', current_step: 1, answers: {} })).statusCode, 404);
  assert.equal((await post(h, { action: 'save', sessie: '99999999-2222-4333-8444-555555555555', current_step: 1, answers: {} })).statusCode, 404);
});

test('save: robot_interesse → automation-kolommen + haakje voor Dave (bij elke wijziging)', async () => {
  const db = nepDb(basis());
  const { h, calls } = handlerMet(db);
  await post(h, { action: 'save', sessie: TOKEN, current_step: 4, answers: { robot_interesse: 'ja_interesse' } });
  const ob = db.tabellen.onboardings[0];
  assert.equal(ob.automation_interesse, 'ja');
  assert.equal(ob.automation_interesse_op, '2026-10-27T10:00:00.000Z');
  assert.deepEqual(ob.automation_belmoment, []);
  assert.equal(ob.answers.robot_interesse, 'ja_interesse'); // answers blijft óók gevuld
  assert.equal(calls.automation.length, 1);
  assert.equal(calls.automation[0].onboarding.id, 'ob-1');
  assert.equal(calls.automation[0].answers.robot_interesse, 'ja_interesse');

  await post(h, { action: 'save', sessie: TOKEN, current_step: 4, answers: { robot_belmoment: ['avond'] } });
  assert.deepEqual(ob.automation_belmoment, ['avond']);
  assert.equal(calls.automation.length, 2);
});

test('save: zonder automation-kolommen (migratie niet gedraaid) slaagt de save toch', async () => {
  const db = nepDb(basis(), {
    fouten: { 'onboardings.update': (w) => ('automation_interesse' in w ? { code: '42703', message: 'column "automation_interesse" does not exist' } : null) },
  });
  const { h } = handlerMet(db);
  const r = await post(h, { action: 'save', sessie: TOKEN, current_step: 4, answers: { robot_interesse: 'nee' } });
  assert.equal(r.statusCode, 200);
  assert.equal(db.tabellen.onboardings[0].answers.robot_interesse, 'nee');
});

test('save: een fout in het Dave-haakje breekt de save niet', async () => {
  const db = nepDb(basis());
  const { h } = handlerMet(db, { naAutomation: async () => { throw new Error('opvolging stuk'); } });
  const r = await post(h, { action: 'save', sessie: TOKEN, current_step: 4, answers: { robot_interesse: 'ja_interesse' } });
  assert.equal(r.statusCode, 200);
});

test('save: rate limit 30/min', async () => {
  const gevraagd = [];
  const { h } = handlerMet(nepDb(basis()), { rateLimit: async (o) => { gevraagd.push([o.bucket, o.maxHits, o.withinSeconds]); return { limited: true }; } });
  const r = await post(h, { action: 'save', sessie: TOKEN, current_step: 1, answers: { ervaring_trading: 'geen' } });
  assert.equal(r.statusCode, 429);
  assert.deepEqual(gevraagd, [['onboarding-portal-save', 30, 60]]);
});

// ═══ complete ══════════════════════════════════════════════════════════════

const VOL_1OP1 = {
  coaching_locatie_voorkeur: 'bootcamp_dan_online', ervaring_trading: 'geen', motivatie_primair: 'extra_inkomen',
  commitment_uren_per_week: 5, beschikbaarheid: { ma: ['avond'] }, robot_interesse: 'nee',
};

test('complete: onvolledig → 400 met de ontbrekende sleutels, niets afgerond', async () => {
  const { h, calls } = handlerMet(nepDb(basis({ answers: { ervaring_trading: 'geen' } })));
  const r = await post(h, { action: 'complete', sessie: TOKEN });
  assert.equal(r.statusCode, 400);
  assert.deepEqual(r.body.missing, ['coaching_locatie_voorkeur', 'motivatie_primair', 'commitment_uren_per_week', 'beschikbaarheid', 'robot_interesse']);
  assert.equal(calls.afronden.length, 0);
});

test('complete: volledig → de GEDEELDE afronding (zelfde als de klassieke wizard)', async () => {
  const { h, calls } = handlerMet(nepDb(basis({ status: 'bezig', answers: VOL_1OP1 })));
  const r = await post(h, { action: 'complete', sessie: TOKEN });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true });
  assert.equal(calls.afronden.length, 1);
  assert.equal(calls.afronden[0].ob.id, 'ob-1');
  assert.equal(calls.afronden[0].ob.mentor_user_id, 'm-1');
  assert.equal(calls.afronden[0].o.bron, 'onboarding-portal');
});

test('complete: membership vraagt geen locatie/beschikbaarheid', async () => {
  const { h, calls } = handlerMet(nepDb(basis({ trajectType: 'membership', answers: {
    ervaring_trading: 'geen', motivatie_primair: 'anders', commitment_uren_per_week: 2, robot_interesse: 'nee' } })));
  const r = await post(h, { action: 'complete', sessie: TOKEN });
  assert.equal(r.statusCode, 200);
  assert.equal(calls.afronden.length, 1);
});

test('complete: idempotent — al afgerond → 200 {already:true}, geen tweede afronding', async () => {
  const { h, calls } = handlerMet(nepDb(basis({ status: 'afgerond', answers: VOL_1OP1 })));
  const r = await post(h, { action: 'complete', sessie: TOKEN });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, already: true });
  assert.equal(calls.afronden.length, 0);
});

test('complete: afgesloten → 410; rate limit 10/min', async () => {
  const { h } = handlerMet(nepDb(basis({ status: 'geannuleerd', answers: VOL_1OP1 })));
  assert.equal((await post(h, { action: 'complete', sessie: TOKEN })).statusCode, 410);
  const gevraagd = [];
  const { h: h2 } = handlerMet(nepDb(basis()), { rateLimit: async (o) => { gevraagd.push([o.bucket, o.maxHits, o.withinSeconds]); return { limited: true }; } });
  assert.equal((await post(h2, { action: 'complete', sessie: TOKEN })).statusCode, 429);
  assert.deepEqual(gevraagd, [['onboarding-portal-complete', 10, 60]]);
});

// ═══ De gedeelde afronding zelf ════════════════════════════════════════════

test('rondWizardAf: status + completed_at, automations on_wizard_completed, mentormelding, spiegel', async () => {
  const db = nepDb({ onboardings: [{ id: 'ob-1', status: 'bezig' }] });
  const gedaan = [];
  const r = await rondWizardAf({ id: 'ob-1', mentor_user_id: 'm-1', customer_name: 'Wim Peeters' }, {
    bron: 'onboarding-portal', nu: new Date('2026-10-27T10:00:00Z'),
    deps: {
      db,
      enroll: async (a) => { gedaan.push(['enroll', a]); },
      notify: async (a) => { gedaan.push(['notify', a]); },
      spiegel: async (id, bron) => { gedaan.push(['spiegel', id, bron]); },
    },
  });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(db.log.updates[0].waarden, {
    status: 'afgerond', completed_at: '2026-10-27T10:00:00.000Z', updated_at: '2026-10-27T10:00:00.000Z',
  });
  await new Promise((ok) => setImmediate(ok));
  assert.deepEqual(gedaan.find((g) => g[0] === 'enroll')[1], { onboardingId: 'ob-1', triggerType: 'on_wizard_completed' });
  const melding = gedaan.find((g) => g[0] === 'notify')[1];
  assert.equal(melding.toUserId, 'm-1');
  assert.equal(melding.type, 'onboarding.intake_done');
  assert.equal(melding.title, 'Intake afgerond · Wim Peeters');
  assert.equal(melding.linkUrl, '/modules/mentor-onboarding.html');
  assert.deepEqual(gedaan.find((g) => g[0] === 'spiegel'), ['spiegel', 'ob-1', 'onboarding-portal']);
});

test('rondWizardAf: zonder mentor geen melding; update-fout → ok:false en GEEN neveneffecten', async () => {
  const gedaan = [];
  const deps = {
    enroll: async () => gedaan.push('enroll'), notify: async () => gedaan.push('notify'),
    spiegel: async () => gedaan.push('spiegel'),
  };
  await rondWizardAf({ id: 'ob-1', mentor_user_id: null }, { bron: 'x', deps: { ...deps, db: nepDb({ onboardings: [{ id: 'ob-1' }] }) } });
  await new Promise((ok) => setImmediate(ok));
  assert.ok(!gedaan.includes('notify'));

  gedaan.length = 0;
  const r = await rondWizardAf({ id: 'ob-1', mentor_user_id: 'm-1' }, {
    bron: 'x', deps: { ...deps, db: nepDb({ onboardings: [] }, { fouten: { 'onboardings.update': { message: 'kapot' } } }) },
  });
  await new Promise((ok) => setImmediate(ok));
  assert.equal(r.ok, false);
  assert.deepEqual(gedaan, []);
});

test('beide paden (klassieke wizard + portal) roepen dezelfde afronding aan — geen kopie', () => {
  const klassiek = lees('api/onboarding-complete.js');
  const portal = lees('api/onboarding-portal.js');
  assert.match(klassiek, /import \{ rondWizardAf \} from '\.\/_lib\/onboarding-afronden\.js'/);
  assert.match(portal, /import \{ rondWizardAf \} from '\.\/_lib\/onboarding-afronden\.js'/);
  // De neveneffecten staan niet meer los in het klassieke endpoint.
  assert.doesNotMatch(klassiek, /enrollForTrigger|createNotification|spiegelNaActie/);
});

// ═══ Bedenktijd: de LMS-voorwaardenpoort telt mee ══════════════════════════

test('bedenktijd: LMS-vinkje (afstand) maakt de bedenktijd vervallen zonder wizard-waiver', () => {
  const offerte = '2026-10-20T10:00:00Z';
  const nu = Date.parse('2026-10-22T10:00:00Z');
  // Portal-klant: geen wizard-waiver, wel het LMS-vinkje.
  const w = combineerWaiver({ agreed: false, at: null }, '2026-10-21T08:00:00Z');
  const b = computeBedenktijd(w, offerte, nu);
  assert.equal(b.status, 'vervallen');
  assert.equal(b.reason, 'afstand');
  assert.equal(b.waived_at, '2026-10-21T08:00:00Z');
  assert.equal(b.waived_bron, 'lms');
  // Zonder vinkje: loopt nog.
  assert.equal(computeBedenktijd(combineerWaiver({ agreed: false, at: null }, null), offerte, nu).status, 'lopend');
  // Wizard-waiver wint als die er is (oud pad ongewijzigd).
  const ww = combineerWaiver({ agreed: true, at: '2026-10-20T12:00:00Z' }, '2026-10-21T08:00:00Z');
  assert.equal(ww.at, '2026-10-20T12:00:00Z');
  assert.equal(computeBedenktijd(ww, offerte, nu).waived_bron, 'wizard');
  // Geen waiver-blok in de wizard (null) + geen LMS → null blijft null.
  assert.equal(combineerWaiver(null, null), null);
});

test('bedenktijd: leesLmsAfstand neemt het eerste vinkje per student, faalzacht', async () => {
  const lms = { from: () => {
    const q = { select: () => q, eq: () => q, in: () => q, order: () => q,
      then: (ok) => Promise.resolve({ data: [
        { student_id: 's1', aangemaakt_op: '2026-10-01T00:00:00Z' },
        { student_id: 's1', aangemaakt_op: '2026-10-05T00:00:00Z' },
        { student_id: 's2', aangemaakt_op: '2026-10-03T00:00:00Z' },
      ], error: null }).then(ok) };
    return q;
  } };
  const m = await leesLmsAfstand(['s1', 's2', null, 's1'], lms);
  assert.equal(m.get('s1'), '2026-10-01T00:00:00Z');
  assert.equal(m.get('s2'), '2026-10-03T00:00:00Z');
  const stuk = { from: () => { throw new Error('LMS weg'); } };
  assert.equal((await leesLmsAfstand(['s1'], stuk)).size, 0);
  assert.equal((await leesLmsAfstand(['s1'], null)).size, 0);
});

test('bedenktijd: elke plek die hem berekent leest ook de LMS-voorwaardenpoort', () => {
  for (const p of ['api/_lib/onboarding-overzicht-rijen.js', 'api/onboardings-admin-list.js', 'api/onboarding-detail.js',
    'api/mentor-future-students-self.js', 'api/_lib/onboarding-spiegel.js']) {
    const s = lees(p);
    const n = (s.match(/computeBedenktijd\(/g) || []).length;
    const m = (s.match(/combineerWaiver\(/g) || []).length;
    assert.ok(n > 0, p);
    assert.equal(m, n, `${p}: ${n}× computeBedenktijd maar ${m}× combineerWaiver`);
  }
});

// ═══ Autopilot v3: ander nummer of e-mail (28 okt 2026) ═══════════════════

test('Autopilot v3: robot_contact_tel/-email optioneel in de whitelist, leeg mag (= wissen)', () => {
  const ok = valideerPatch({ robot_contact_tel: ' +32 (0)470 12.34-56 ', robot_contact_email: ' wim@example.com ' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.schoon, { robot_contact_tel: '+32 (0)470 12.34-56', robot_contact_email: 'wim@example.com' });
  assert.deepEqual(valideerPatch({ robot_contact_tel: '', robot_contact_email: '' }).schoon, { robot_contact_tel: '', robot_contact_email: '' });
  // Te lang, verkeerde tekens, geen cijfer, ongeldig e-mailadres, geen tekst → 400-sleutels.
  for (const [k, v] of [
    ['robot_contact_tel', '0'.repeat(31)], ['robot_contact_tel', '0470abc'], ['robot_contact_tel', '+-()'],
    ['robot_contact_tel', 470], ['robot_contact_email', 'geen-adres'], ['robot_contact_email', 'a@b'],
    ['robot_contact_email', 'x'.repeat(195) + '@ab.be'], ['robot_contact_email', null],
  ]) {
    assert.deepEqual(valideerPatch({ [k]: v }).fouten, [k], `${k}=${String(v).slice(0, 20)}`);
  }
  // Niet verplicht bij afronden.
  assert.deepEqual(ontbrekend('membership', { ervaring_trading: 'geen', motivatie_primair: 'anders', commitment_uren_per_week: 3, robot_interesse: 'ja_interesse' }), []);
  // Gaan mee terug naar de browser (de klant ziet wat hij invulde).
  assert.deepEqual(portalAntwoorden({ robot_contact_tel: '0470', robot_contact_email: 'a@b.be' }), { robot_contact_tel: '0470', robot_contact_email: 'a@b.be' });
});

test('Autopilot v3: een ander nummer/e-mail alleen → de automation-kaart volgt', () => {
  const nu = new Date('2026-10-28T10:00:00Z');
  const v = automationVelden({ robot_interesse: 'ja_interesse' }, { robot_interesse: 'ja_interesse', robot_contact_tel: '0470' }, { robot_contact_tel: '0470' }, nu);
  assert.deepEqual(v, { automation_interesse: 'ja', automation_belmoment: [] });
});
