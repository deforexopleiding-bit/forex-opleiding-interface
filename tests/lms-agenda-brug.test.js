// tests/lms-agenda-brug.test.js
//
// Borgt het contract van de agendabrug CRM ↔ LMS (docs/lms-agenda-brug.md):
// alleen gepubliceerde events, een mislukte bevraging gooit (leeg ≠ mislukt),
// mentoren worden exact op e-mail gevonden en wie aanwezig was blijft staan.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BrugFout, geheimKlopt, leesVenster, haalAgendaEvents, wijzigBezetting,
} from '../api/_lib/lms-agenda-brug.js';

const EV_ID = '11111111-1111-4111-8111-111111111111';
const TM_ID = '22222222-2222-4222-8222-222222222222';

/**
 * Nep-supabase-client die PER TABEL antwoordt en elke keten registreert in
 * `calls`, zodat de test kan nagaan wat er gevraagd en geschreven is.
 * Waarde per tabel: array/object/null, een Error (bevraging mislukt), of een
 * functie (call) => { data, error } voor fijnmazige antwoorden.
 */
function nepClient(perTabel = {}) {
  const calls = [];
  const client = {
    calls,
    from(tabel) {
      const call = { tabel, ops: [] };
      calls.push(call);
      const reken = () => {
        const bron = perTabel[tabel];
        if (typeof bron === 'function') return bron(call);
        if (bron instanceof Error) return { data: null, error: { message: bron.message } };
        return { data: bron ?? null, error: null };
      };
      const keten = {};
      for (const m of ['select', 'eq', 'gte', 'lt', 'in', 'order', 'insert', 'delete']) {
        keten[m] = (...args) => { call.ops.push([m, ...args]); return keten; };
      }
      keten.maybeSingle = () => { call.ops.push(['maybeSingle']); return keten; };
      keten.then = (resolve, reject) => Promise.resolve(reken()).then(resolve, reject);
      return keten;
    },
  };
  return client;
}

const heeftOp = (call, m) => call.ops.find((o) => o[0] === m);
const mentor = (o) => ({
  id: TM_ID, name: 'Mo Mentor', email: ' Mo_Mentor@DFO.nl ', user_id: 'u-1',
  type: 'mentor', is_active: true, ...o,
});
const publishedEvent = { id: EV_ID, title: 'Live trading', status: 'published' };

async function verwachtFout(p, status, code) {
  await assert.rejects(p, (e) => {
    assert.ok(e instanceof BrugFout, 'hoort een BrugFout te zijn: ' + e?.message);
    assert.equal(e.status, status);
    assert.equal(e.code, code);
    return true;
  });
}

// ── geheim ──────────────────────────────────────────────────────────────────

test('geheim: leeg verwacht is altijd dicht', () => {
  assert.equal(geheimKlopt('', ''), false);
  assert.equal(geheimKlopt('iets', ''), false);
  assert.equal(geheimKlopt('iets', undefined), false);
});

test('geheim: fout of leeg aangeboden wordt geweigerd', () => {
  assert.equal(geheimKlopt('fout', 'goed-geheim'), false);
  assert.equal(geheimKlopt('', 'goed-geheim'), false);
  assert.equal(geheimKlopt(undefined, 'goed-geheim'), false);
  assert.equal(geheimKlopt('goed-geheim-maar-langer', 'goed-geheim'), false);
});

test('geheim: juist geheim wordt geaccepteerd', () => {
  assert.equal(geheimKlopt('goed-geheim', 'goed-geheim'), true);
});

// ── venster ─────────────────────────────────────────────────────────────────

test('venster: ongeldig of ontbrekend → ongeldig_venster', () => {
  for (const q of [{}, { van: 'x', tot: '2026-10-01' }, { van: '2026-10-01' }]) {
    assert.throws(() => leesVenster(q), (e) => e.code === 'ongeldig_venster' && e.status === 400);
  }
});

test('venster: omgekeerd of leeg → ongeldig_venster', () => {
  assert.throws(() => leesVenster({ van: '2026-10-02', tot: '2026-10-01' }), (e) => e.code === 'ongeldig_venster');
  assert.throws(() => leesVenster({ van: '2026-10-01', tot: '2026-10-01' }), (e) => e.code === 'ongeldig_venster');
});

test('venster: meer dan 200 dagen → venster_te_groot', () => {
  assert.throws(
    () => leesVenster({ van: '2026-01-01T00:00:00Z', tot: '2026-07-21T00:00:00Z' }),
    (e) => e.code === 'venster_te_groot' && e.status === 400,
  );
});

test('venster: geldig venster geeft ISO-strings terug', () => {
  const v = leesVenster({ van: '2026-10-01T00:00:00Z', tot: '2026-11-01T00:00:00Z' });
  assert.deepEqual(v, { van: '2026-10-01T00:00:00.000Z', tot: '2026-11-01T00:00:00.000Z' });
});

// ── lezen ───────────────────────────────────────────────────────────────────

const VENSTER = { van: '2026-10-01T00:00:00.000Z', tot: '2026-11-01T00:00:00.000Z' };

test('lezen: alleen published in [van, tot), oplopend, met bezetting', async () => {
  const db = nepClient({
    events: [{
      id: EV_ID, title: 'Live trading', starts_at: '2026-10-05T18:00:00Z', ends_at: null,
      location: 'Utrecht', capacity: 30, niveau: 'beginner', signups_closed: true, status: 'published',
    }],
    event_mentors: [{
      event_id: EV_ID, team_member_id: TM_ID, was_present: true,
      team_members: { id: TM_ID, name: 'Mo Mentor', email: ' Mo@DFO.nl ' },
    }],
    team_members: [mentor()],
  });
  const r = await haalAgendaEvents(db, VENSTER);

  const evCall = db.calls.find((c) => c.tabel === 'events');
  assert.deepEqual(heeftOp(evCall, 'eq'), ['eq', 'status', 'published']);
  assert.deepEqual(heeftOp(evCall, 'gte'), ['gte', 'starts_at', VENSTER.van]);
  assert.deepEqual(heeftOp(evCall, 'lt'), ['lt', 'starts_at', VENSTER.tot]);
  assert.deepEqual(heeftOp(evCall, 'order'), ['order', 'starts_at', { ascending: true }]);

  const emCall = db.calls.find((c) => c.tabel === 'event_mentors');
  assert.deepEqual(heeftOp(emCall, 'in'), ['in', 'event_id', [EV_ID]]);

  assert.deepEqual(r.events, [{
    id: EV_ID, titel: 'Live trading', start: '2026-10-05T18:00:00Z', eind: null,
    locatie: 'Utrecht', capaciteit: 30, niveau: 'beginner', aanmeldingen_dicht: true,
    crm_pad: '/modules/events-detail.html?id=' + EV_ID,
    bezetting: [{ team_member_id: TM_ID, naam: 'Mo Mentor', email: 'mo@dfo.nl', was_aanwezig: true }],
  }]);
  assert.deepEqual(r.mentoren, [{ team_member_id: TM_ID, naam: 'Mo Mentor', email: 'mo_mentor@dfo.nl' }]);
});

test('lezen: mislukte events-bevraging gooit, nooit een lege lijst', async () => {
  const db = nepClient({ events: new Error('connection reset'), team_members: [mentor()] });
  await assert.rejects(haalAgendaEvents(db, VENSTER), /connection reset/);
});

test('lezen: mislukte event_mentors- of team_members-bevraging gooit ook', async () => {
  const ev = [{ id: EV_ID, title: 'x', starts_at: '2026-10-05T18:00:00Z', status: 'published' }];
  await assert.rejects(
    haalAgendaEvents(nepClient({ events: ev, event_mentors: new Error('timeout'), team_members: [] }), VENSTER),
    /event_mentors/,
  );
  await assert.rejects(
    haalAgendaEvents(nepClient({ events: [], team_members: new Error('down') }), VENSTER),
    /team_members/,
  );
});

test('lezen: geen events → event_mentors wordt niet bevraagd', async () => {
  const db = nepClient({ events: [], team_members: [mentor()] });
  const r = await haalAgendaEvents(db, VENSTER);
  assert.deepEqual(r.events, []);
  assert.equal(db.calls.some((c) => c.tabel === 'event_mentors'), false);
});

test('lezen: mentor zonder geldig e-mailadres staat niet in de kiezer', async () => {
  const db = nepClient({
    events: [],
    team_members: [
      mentor(),
      mentor({ id: 'zonder', email: null }),
      mentor({ id: 'leeg', email: '  ' }),
      mentor({ id: 'kapot', email: 'geen-mail' }),
    ],
  });
  const r = await haalAgendaEvents(db, VENSTER);
  assert.deepEqual(r.mentoren.map((m) => m.team_member_id), [TM_ID]);
});

// ── schrijven: invoer + weigeringen ─────────────────────────────────────────

const geldig = (o) => ({ actie: 'toevoegen', event_id: EV_ID, mentor_email: 'mo_mentor@dfo.nl', ...o });

test('schrijven: ongeldige actie, uuid of e-mail → ongeldig_verzoek', async () => {
  const db = nepClient({ events: publishedEvent, team_members: [mentor()] });
  await verwachtFout(wijzigBezetting(db, geldig({ actie: 'wissen' })), 400, 'ongeldig_verzoek');
  await verwachtFout(wijzigBezetting(db, geldig({ event_id: 'abc' })), 400, 'ongeldig_verzoek');
  await verwachtFout(wijzigBezetting(db, geldig({ mentor_email: 'geen-mail' })), 400, 'ongeldig_verzoek');
  await verwachtFout(wijzigBezetting(db, null), 400, 'ongeldig_verzoek');
  assert.equal(db.calls.length, 0, 'bij ongeldige invoer wordt de database niet aangeraakt');
});

test('schrijven: onbekend event → event_onbekend', async () => {
  const db = nepClient({ events: null, team_members: [mentor()] });
  await verwachtFout(wijzigBezetting(db, geldig()), 404, 'event_onbekend');
});

test('schrijven: concept-event wordt geweigerd', async () => {
  const db = nepClient({ events: { ...publishedEvent, status: 'draft' }, team_members: [mentor()] });
  await verwachtFout(wijzigBezetting(db, geldig()), 409, 'event_niet_gepubliceerd');
  assert.equal(db.calls.some((c) => c.tabel === 'event_mentors'), false);
});

test('schrijven: onbekende mentor → mentor_onbekend (exacte vergelijking, _ is geen joker)', async () => {
  const db = nepClient({ events: publishedEvent, team_members: [mentor({ email: 'moXmentor@dfo.nl' })] });
  await verwachtFout(wijzigBezetting(db, geldig()), 404, 'mentor_onbekend');
  const tmCall = db.calls.find((c) => c.tabel === 'team_members');
  assert.equal(heeftOp(tmCall, 'ilike'), undefined);
});

test('schrijven: dubbele mentor → mentor_dubbel (niet gokken)', async () => {
  const db = nepClient({
    events: publishedEvent,
    team_members: [mentor(), mentor({ id: 'ander', email: 'MO_MENTOR@dfo.nl' })],
  });
  await verwachtFout(wijzigBezetting(db, geldig()), 409, 'mentor_dubbel');
});

// ── schrijven: toevoegen ────────────────────────────────────────────────────

test('toevoegen: schrijft de juiste rij en meldt de mentor', async () => {
  const db = nepClient({ events: publishedEvent, team_members: [mentor()], event_mentors: null });
  const meldingen = [];
  const r = await wijzigBezetting(db, geldig({ door: { naam: 'Hanna Hoofdmentor', email: 'h@dfo.nl' } }), {
    notify: async (m) => { meldingen.push(m); return { ok: true, count: 1 }; },
  });

  assert.equal(r.status, 201);
  assert.equal(r.code, 'toegevoegd');
  const ins = db.calls.find((c) => c.tabel === 'event_mentors' && heeftOp(c, 'insert'));
  assert.deepEqual(heeftOp(ins, 'insert')[1], { event_id: EV_ID, team_member_id: TM_ID, added_by_user_id: null });

  assert.equal(meldingen.length, 1);
  assert.equal(meldingen[0].toUserId, 'u-1');
  assert.equal(meldingen[0].type, 'event.mentor_assigned');
  assert.match(meldingen[0].body, /via de LMS-agenda door Hanna Hoofdmentor/);
});

test('toevoegen: mislukte melding breekt de koppeling niet', async () => {
  const db = nepClient({ events: publishedEvent, team_members: [mentor()], event_mentors: null });
  const r = await wijzigBezetting(db, geldig(), { notify: async () => { throw new Error('boem'); } });
  assert.equal(r.code, 'toegevoegd');
});

test('toevoegen: 23505 → stond_er_al, geen melding', async () => {
  const db = nepClient({
    events: publishedEvent, team_members: [mentor()],
    event_mentors: () => ({ data: null, error: { code: '23505', message: 'duplicate key' } }),
  });
  let gemeld = false;
  const r = await wijzigBezetting(db, geldig(), { notify: async () => { gemeld = true; } });
  assert.equal(r.status, 200);
  assert.equal(r.code, 'stond_er_al');
  assert.equal(gemeld, false);
});

test('toevoegen: andere insert-fout gooit', async () => {
  const db = nepClient({
    events: publishedEvent, team_members: [mentor()],
    event_mentors: () => ({ data: null, error: { code: '42501', message: 'rls' } }),
  });
  await assert.rejects(wijzigBezetting(db, geldig()), /rls/);
});

// ── schrijven: verwijderen ──────────────────────────────────────────────────

const verwijder = geldig({ actie: 'verwijderen' });

test('verwijderen: niet gekoppeld → stond_er_niet, geen delete', async () => {
  const db = nepClient({ events: publishedEvent, team_members: [mentor()], event_mentors: null });
  const r = await wijzigBezetting(db, verwijder);
  assert.equal(r.status, 200);
  assert.equal(r.code, 'stond_er_niet');
  assert.equal(db.calls.some((c) => heeftOp(c, 'delete')), false);
});

test('verwijderen: was_present = true blijft staan', async () => {
  const db = nepClient({
    events: publishedEvent, team_members: [mentor()],
    event_mentors: { event_id: EV_ID, team_member_id: TM_ID, was_present: true },
  });
  await verwachtFout(wijzigBezetting(db, verwijder), 409, 'was_aanwezig_blijft');
  assert.equal(db.calls.some((c) => heeftOp(c, 'delete')), false);
});

test('verwijderen: gekoppeld en niet aanwezig → verwijderd', async () => {
  const db = nepClient({
    events: publishedEvent, team_members: [mentor()],
    event_mentors: (call) => (heeftOp(call, 'delete')
      ? { data: null, error: null }
      : { data: { event_id: EV_ID, team_member_id: TM_ID, was_present: false }, error: null }),
  });
  const r = await wijzigBezetting(db, verwijder);
  assert.equal(r.status, 200);
  assert.equal(r.code, 'verwijderd');
  const del = db.calls.find((c) => heeftOp(c, 'delete'));
  assert.ok(del, 'er hoort een delete te zijn');
  assert.deepEqual(del.ops.filter((o) => o[0] === 'eq'), [
    ['eq', 'event_id', EV_ID], ['eq', 'team_member_id', TM_ID],
  ]);
});

// ── route: de weg is dicht zonder env-var of met een fout geheim ────────────

function nepRes() {
  const res = { statusCode: null, headers: {}, body: null };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('route: env ontbreekt → 503, fout geheim → 403, andere methode → 405', async () => {
  const { default: handler } = await import('../api/lms-agenda-events.js');
  const oud = process.env.DFO_LMS_AGENDA_SECRET;
  try {
    delete process.env.DFO_LMS_AGENDA_SECRET;
    let res = nepRes();
    await handler({ method: 'GET', headers: { 'x-dfo-secret': 'x' }, query: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.code, 'niet_geconfigureerd');
    assert.equal(res.headers['cache-control'], 'no-store');

    process.env.DFO_LMS_AGENDA_SECRET = 'goed-geheim';
    res = nepRes();
    await handler({ method: 'GET', headers: { 'x-dfo-secret': 'fout' }, query: {} }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'machine_toegang_dicht');

    res = nepRes();
    await handler({ method: 'DELETE', headers: { 'x-dfo-secret': 'goed-geheim' } }, res);
    assert.equal(res.statusCode, 405);
    assert.deepEqual(Object.keys(res.body), ['ok', 'code', 'message', 'data']);

    res = nepRes();
    await handler({ method: 'GET', headers: { 'x-dfo-secret': 'goed-geheim' }, query: { van: 'x' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'ongeldig_venster');
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'geen CORS');
  } finally {
    if (oud === undefined) delete process.env.DFO_LMS_AGENDA_SECRET;
    else process.env.DFO_LMS_AGENDA_SECRET = oud;
  }
});
