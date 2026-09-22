// tests/iris-signalen.test.js
//
// De mentorsignalen uit het LMS.
//
// De keuze die hier vastgepind wordt: het signaaltype is VRIJE TEKST en geen
// enum. De opdracht noemt drie types die er nog niet zijn (uitstel,
// reageert_niet, halt), en de mentormodule wordt parallel gebouwd. Een
// CHECK-constraint zou betekenen dat de synchronisatie breekt op de dag dat er
// een vierde bijkomt — en dat is een stilvallende synchronisatie waar niemand
// iets van merkt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TERUGBLIK_DAGEN,
  VOORSTEL_PER_TYPE,
  bronSleutel,
  voorstelVoor,
  vormSignaal,
  filterNieuw,
  haalSignalen,
} from '../api/_lib/iris/signalen.js';

// ── de bron-sleutel ─────────────────────────────────────────────────────────

test('de sleutel draagt het bronsysteem', () => {
  assert.equal(bronSleutel('lms', 'abc'), 'lms:abc');
  assert.equal(bronSleutel('crm', 'abc'), 'crm:abc');
});

test('dezelfde id in twee systemen botst niet', () => {
  assert.notEqual(bronSleutel('lms', 'x'), bronSleutel('crm', 'x'));
});

// ── het voorstel bij een type ───────────────────────────────────────────────

test('elk bekend type heeft een voorstel in mensentaal', () => {
  for (const [type, v] of Object.entries(VOORSTEL_PER_TYPE)) {
    assert.ok(v.voorstel && v.voorstel.length > 5, `${type} heeft geen bruikbaar voorstel`);
    assert.ok(v.toelichting && v.toelichting.length > 15, `${type} heeft geen toelichting`);
  }
});

test('de drie types uit de opdracht staan erin', () => {
  for (const t of ['uitstel', 'reageert_niet', 'halt']) {
    assert.ok(VOORSTEL_PER_TYPE[t], `${t} ontbreekt`);
  }
});

test('een ONBEKEND type krijgt een voorstel, niet niets', () => {
  // Een kaart zonder voorstel is een kaart waar niemand iets mee doet.
  const v = voorstelVoor('iets_wat_het_lms_morgen_toevoegt');
  assert.ok(v.voorstel);
  assert.equal(v.onbekend, true);
  assert.match(v.toelichting, /geen fout/);
});

test('een leeg type breekt niets', () => {
  for (const t of ['', null, undefined]) {
    const v = voorstelVoor(t);
    assert.ok(v.voorstel);
    assert.equal(v.onbekend, true);
  }
});

test('hoofdletters in het type maken niet uit', () => {
  assert.equal(voorstelVoor('UITSTEL').voorstel, VOORSTEL_PER_TYPE.uitstel.voorstel);
});

test('"halt" stelt GEEN handeling voor — dat is een gesprek', () => {
  assert.equal(VOORSTEL_PER_TYPE.halt.actie, null);
  assert.match(VOORSTEL_PER_TYPE.halt.toelichting, /gesprek/);
});

test('uitstel noemt de regel over de einddatum', () => {
  // Of de einddatum meeschuift hangt van de reden af: bij ziekte of vakantie
  // wel, bij betaling of geen contact niet.
  assert.match(VOORSTEL_PER_TYPE.uitstel.toelichting, /ziekte|vakantie/);
});

// ── de vorm ─────────────────────────────────────────────────────────────────

test('een LMS-rij wordt de vorm die iris_signalen verwacht', () => {
  const s = vormSignaal({
    id: 's1', type: 'uitstel', mentor_naam: 'Seppe',
    toelichting: 'student wil drie weken uitstellen wegens examens',
    created_at: '2026-09-20T10:00:00Z',
  });
  assert.equal(s.bron_id, 'lms:s1');
  assert.equal(s.bron_systeem, 'dfo_lms');
  assert.equal(s.type, 'uitstel');
  assert.equal(s.mentor_naam, 'Seppe');
  assert.equal(s.signaal_op, '2026-09-20T10:00:00Z');
});

test('zonder gevraagde actie komt het voorstel uit de tabel', () => {
  const s = vormSignaal({ id: 's1', type: 'reageert_niet' });
  assert.equal(s.gevraagde_actie, VOORSTEL_PER_TYPE.reageert_niet.voorstel);
});

test('een meegegeven gevraagde actie wint van ons voorstel', () => {
  // Het LMS weet meer van de situatie dan onze vertaaltabel.
  const s = vormSignaal({ id: 's1', type: 'uitstel', gevraagde_actie: 'bel Chesney eerst' });
  assert.equal(s.gevraagde_actie, 'bel Chesney eerst');
});

test('afwijkende veldnamen uit het LMS worden opgevangen', () => {
  // De mentormodule bestaat nog niet; we weten niet precies hoe de kolommen
  // gaan heten. Meerdere namen proberen is goedkoper dan breken.
  assert.equal(vormSignaal({ id: 's1', signaal_type: 'halt' }).type, 'halt');
  assert.equal(vormSignaal({ id: 's1', type: 'x', omschrijving: 'tekst' }).toelichting, 'tekst');
  assert.equal(vormSignaal({ id: 's1', type: 'x', notitie: 'tekst' }).toelichting, 'tekst');
  assert.equal(vormSignaal({ id: 's1', type: 'x', mentor: 'Karel' }).mentor_naam, 'Karel');
});

test('een rij zonder type wordt "onbekend", niet null', () => {
  assert.equal(vormSignaal({ id: 's1' }).type, 'onbekend');
});

test('zonder tijdstempel valt hij terug op nu', () => {
  const s = vormSignaal({ id: 's1', type: 'x' });
  assert.ok(!Number.isNaN(Date.parse(s.signaal_op)));
});

// ── het verzamelverschil ────────────────────────────────────────────────────

test('wat al bekend is, blijft weg', () => {
  const nieuw = filterNieuw([{ id: 'a' }, { id: 'b' }], new Set(['lms:a']), 'dfo_lms');
  assert.deepEqual(nieuw.map((r) => r.id), ['b']);
});

test('rijen zonder id worden overgeslagen', () => {
  assert.equal(filterNieuw([{ id: 'a' }, {}, null], new Set(), 'dfo_lms').length, 1);
});

test('niets bekend betekent alles nieuw', () => {
  assert.equal(filterNieuw([{ id: 'a' }, { id: 'b' }], null, 'dfo_lms').length, 2);
});

// ── ophalen ─────────────────────────────────────────────────────────────────

test('zonder LMS-koppeling is dat een gemelde reden, geen crash', async () => {
  const r = await haalSignalen({ crmDb: {}, lmsClient: null });
  assert.equal(r.nieuw, 0);
  assert.match(r.fout, /niet geconfigureerd/);
});

test('zonder CRM-client gebeurt er ook niets', async () => {
  const r = await haalSignalen({ crmDb: null, lmsClient: {} });
  assert.equal(r.nieuw, 0);
  assert.ok(r.fout);
});

test('een LMS dat niet bereikbaar is, legt de post NIET stil', async () => {
  const lms = {
    from: () => {
      const b = { select: () => b, gte: () => b, order: () => b, limit: async () => ({ data: null, error: { message: 'weg' } }) };
      return b;
    },
  };
  const r = await haalSignalen({ crmDb: {}, lmsClient: lms });
  assert.equal(r.nieuw, 0);
  assert.match(r.fout, /weg/);
  // Geen uitzondering: de aanroeper loopt door.
});

test('geen signalen is geen fout', async () => {
  const lms = {
    from: () => {
      const b = { select: () => b, gte: () => b, order: () => b, limit: async () => ({ data: [], error: null }) };
      return b;
    },
  };
  const r = await haalSignalen({ crmDb: {}, lmsClient: lms });
  assert.equal(r.opgehaald, 0);
  assert.equal(r.fout, null);
});

// ── de terugblik ────────────────────────────────────────────────────────────

test('we kijken een maand terug — lang genoeg voor een traag signaal', () => {
  assert.equal(TERUGBLIK_DAGEN, 30);
});
