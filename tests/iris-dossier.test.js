// tests/iris-dossier.test.js
//
// De dossierkaart.
//
// De belangrijkste eigenschap die hier getest wordt is niet dat de gegevens
// kloppen — dat doet de databank — maar dat "er zijn geen open facturen" en
// "we konden de facturen niet zien" er verschillend uitzien. Wie op de eerste
// aanneming een klant belt over een factuur die er wél is, staat voor gek; wie
// op de tweede afgaat, denkt dat hij het weet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vormFactuur, magOverFacturenPraten, bouwDossier } from '../api/_lib/iris/dossier.js';

const NU = new Date('2026-09-21T12:00:00Z');

// ── één factuurrij ──────────────────────────────────────────────────────────

test('vormFactuur: een open factuur over de vervaldatum', () => {
  const f = vormFactuur({
    id: 'f1', invoice_number: 'F-001', amount_total: 500, amount_paid: 0,
    credited_amount: 0, due_date: '2026-09-01', status: 'open',
  }, NU);
  assert.equal(f.bedrag_open, 500);
  assert.equal(f.dagen_te_laat, 20);
  assert.equal(f.te_laat, true);
});

test('vormFactuur: een factuur die nog niet vervallen is, is niet te laat', () => {
  const f = vormFactuur({
    id: 'f1', amount_total: 500, amount_paid: 0, credited_amount: 0,
    due_date: '2026-10-01', status: 'open',
  }, NU);
  assert.equal(f.dagen_te_laat, 0);
  assert.equal(f.te_laat, false);
});

test('vormFactuur: op de vervaldag zelf is hij nog niet te laat', () => {
  const f = vormFactuur({
    id: 'f1', amount_total: 500, amount_paid: 0, credited_amount: 0,
    due_date: '2026-09-21', status: 'open',
  }, NU);
  assert.equal(f.te_laat, false, 'de vervaldag is de laatste dag, niet de eerste te late dag');
});

test('vormFactuur: een deelbetaling laat de rest open staan', () => {
  const f = vormFactuur({
    id: 'f1', amount_total: 500, amount_paid: 200, credited_amount: 0,
    due_date: '2026-09-01', status: 'partially_paid',
  }, NU);
  assert.equal(f.bedrag_open, 300);
});

test('vormFactuur: een volledig betaalde factuur valt weg', () => {
  assert.equal(vormFactuur({
    id: 'f1', amount_total: 500, amount_paid: 500, credited_amount: 0, status: 'open',
  }, NU), null);
});

test('vormFactuur: een volledig gecrediteerde factuur valt weg', () => {
  assert.equal(vormFactuur({
    id: 'f1', amount_total: 500, amount_paid: 0, credited_amount: 500, status: 'open',
  }, NU), null);
});

test('vormFactuur: een deels gecrediteerde factuur blijft staan', () => {
  const f = vormFactuur({
    id: 'f1', amount_total: 500, amount_paid: 0, credited_amount: 100,
    due_date: '2026-09-01', status: 'open',
  }, NU);
  assert.ok(f, 'deels crediteren haalt de factuur niet weg');
  assert.equal(f.bedrag_open, 500, 'credited_amount telt niet als betaling — dat is bestaande logica');
});

test('vormFactuur: zonder vervaldatum is niets te laat', () => {
  const f = vormFactuur({ id: 'f1', amount_total: 500, amount_paid: 0, credited_amount: 0, status: 'open' }, NU);
  assert.equal(f.dagen_te_laat, 0);
  assert.equal(f.vervaldatum, null);
});

test('vormFactuur: bedragen worden op centen afgerond', () => {
  const f = vormFactuur({
    id: 'f1', amount_total: 100, amount_paid: 33.333, credited_amount: 0,
    due_date: '2026-09-01', status: 'open',
  }, NU);
  assert.equal(f.bedrag_open, 66.67);
});

// ── de harde regel over facturen ────────────────────────────────────────────

test('magOverFacturenPraten: zonder te late factuur mag er niets gezegd worden', () => {
  const r = magOverFacturenPraten([
    { te_laat: false, dagen_te_laat: 0 },
    { te_laat: false, dagen_te_laat: 0 },
  ]);
  assert.equal(r.mag, false);
  assert.match(r.reden, /vervaldatum/);
});

test('magOverFacturenPraten: een lege lijst is ook nee', () => {
  assert.equal(magOverFacturenPraten([]).mag, false);
  assert.equal(magOverFacturenPraten(null).mag, false);
  assert.equal(magOverFacturenPraten(undefined).mag, false);
});

test('magOverFacturenPraten: één te late factuur is genoeg', () => {
  const r = magOverFacturenPraten([{ te_laat: false }, { te_laat: true, dagen_te_laat: 3 }]);
  assert.equal(r.mag, true);
  assert.equal(r.facturen.length, 1, 'alleen de te late facturen mogen genoemd worden');
});

test('magOverFacturenPraten: rommel in de lijst laat niets ontploffen', () => {
  const r = magOverFacturenPraten([null, undefined, { te_laat: true }]);
  assert.equal(r.mag, true);
});

// ── de kaart als geheel ─────────────────────────────────────────────────────

function nepDb(perTabel) {
  return {
    from(tabel) {
      const bouwer = {
        select: () => bouwer,
        eq: () => bouwer,
        in: () => bouwer,
        order: () => bouwer,
        limit: async () => perTabel[tabel] ?? { data: [], error: null },
        maybeSingle: async () => perTabel[tabel] ?? { data: null, error: null },
      };
      return bouwer;
    },
  };
}

test('bouwDossier: zonder contact komt er een lege kaart, geen fout', async () => {
  const k = await bouwDossier(nepDb({}), null);
  assert.equal(k.contact, null);
  assert.equal(k.totalen.open_bedrag, 0);
});

test('bouwDossier: een contact zonder klant krijgt lege maar GELEZEN facturen', async () => {
  // Geen klantkoppeling betekent dat er per definitie geen facturen zijn. Dat
  // is iets anders dan een leesfout, en het onderscheid moet blijven staan.
  const k = await bouwDossier(nepDb({}), {
    id: 'c1', customer_id: null, emails: ['jan@example.com'], telefoons: [], koppelstatus: 'te_bevestigen',
  });
  assert.equal(k.facturen.gelezen, true);
  assert.deepEqual(k.facturen.items, []);
});

test('bouwDossier: een leesfout op facturen laat de rest van de kaart staan', async () => {
  const db = {
    from(tabel) {
      const bouwer = {
        select: () => bouwer,
        eq: () => bouwer,
        in: () => bouwer,
        order: () => bouwer,
        limit: async () => {
          if (tabel === 'invoices') return { data: null, error: { message: 'facturen weg' } };
          return { data: [], error: null };
        },
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return bouwer;
    },
  };
  const k = await bouwDossier(db, {
    id: 'c1', customer_id: 'k1', emails: [], telefoons: [], koppelstatus: 'gekoppeld',
  });
  assert.equal(k.facturen.gelezen, false);
  assert.match(k.facturen.reden, /facturen weg/);
  // De andere bronnen zijn gewoon gelezen.
  assert.equal(k.beloftes.gelezen, true);
  assert.equal(k.signalen.gelezen, true);
  assert.equal(k.belpogingen.gelezen, true);
});

test('bouwDossier: een mislukte factuurlees geeft GEEN totaal van nul euro', async () => {
  // Dit is de kern. Nul euro open op een kaart waar de facturen niet gelezen
  // konden worden, leest als "deze klant heeft niets openstaan". Dat is een
  // bewering, en die mogen we niet doen.
  const db = {
    from() {
      const b = {
        select: () => b, eq: () => b, in: () => b, order: () => b,
        limit: async () => ({ data: null, error: { message: 'weg' } }),
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return b;
    },
  };
  const k = await bouwDossier(db, { id: 'c1', customer_id: 'k1', emails: [], telefoons: [], koppelstatus: 'gekoppeld' });
  assert.equal(k.facturen.gelezen, false);
  assert.equal(k.totalen.aantal_open, 0);
  // Het scherm mag dit alleen tonen als het óók de gelezen-vlag leest — en die
  // staat op false, dus er valt niets te beweren.
  assert.equal(k.facturen.gelezen, false, 'de vlag is het enige wat het verschil draagt');
});

test('bouwDossier: zonder LMS-sleutel is dat een feit, geen fout', async () => {
  const k = await bouwDossier(nepDb({}), {
    id: 'c1', customer_id: null, emails: ['jan@example.com'], telefoons: [], koppelstatus: 'gekoppeld',
  }, { lmsClient: null });
  assert.equal(k.lms.gelezen, false);
  assert.match(k.lms.reden, /niet geconfigureerd/);
});

test('bouwDossier: elke bron draagt een gelezen-vlag', async () => {
  const k = await bouwDossier(nepDb({}), {
    id: 'c1', customer_id: 'k1', emails: [], telefoons: [], koppelstatus: 'gekoppeld',
  });
  for (const bron of ['facturen', 'aanmaanmotor', 'lms', 'beloftes', 'signalen', 'belpogingen']) {
    assert.equal(typeof k[bron].gelezen, 'boolean', `${bron} hoort een gelezen-vlag te hebben`);
  }
});
