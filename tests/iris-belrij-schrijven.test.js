// tests/iris-belrij-schrijven.test.js
//
// Taak 6, deel 1 — wat de vuller ECHT met de databank doet.
//
// De toetsen in iris-belrij-bronnen.test.js gaan over de regels (puur) en over
// wat er wel en niet in de code staat. Dat is niet genoeg: "er staat een
// try/catch in" is geen bewijs dat één fout contact de rest niet blokkeert, en
// "er staat geen .delete() in" is geen bewijs dat een bestaande rij heel blijft.
//
// Hier staat een kleine nep-databank die de filters die de vuller gebruikt
// echt toepast, zodat de uitkomst gemeten wordt in plaats van gegrepen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schrijfPersoon, vulBelrij } from '../api/_lib/iris/belrij-vullen.js';
import { uitBeltaak, uitSignaal, uitOpvolging, voegSamen, BRON_PRIORITEIT } from '../api/_lib/iris/belrij-bronnen.js';

/* ── nep-databank ─────────────────────────────────────────────────────────── */
//
// Genoeg PostgREST om de vuller te laten draaien: eq / in / is / not / order /
// limit / maybeSingle / single / insert / update / upsert, en awaiten geeft de
// gefilterde rijen. Niet meer dan dat — een halve databank nabouwen zou een
// toets opleveren die zijn eigen nabouw toetst.

function nepDb(tabellen = {}, { faalOp = null } = {}) {
  const data = {};
  for (const [t, rijen] of Object.entries(tabellen)) data[t] = rijen.map((r) => ({ ...r }));
  let teller = 0;
  const nieuwId = (t) => `${t}-${++teller}`;

  const from = (tabel) => {
    data[tabel] = data[tabel] || [];
    const st = { filters: [], max: null, kolommen: null };

    const pas = () => {
      let uit = data[tabel];
      for (const f of st.filters) {
        if (f.op === 'eq')  uit = uit.filter((r) => r[f.k] === f.v);
        if (f.op === 'in')  uit = uit.filter((r) => f.v.includes(r[f.k]));
        if (f.op === 'is')  uit = uit.filter((r) => (r[f.k] ?? null) === f.v);
        if (f.op === 'not') uit = uit.filter((r) => (r[f.k] ?? null) !== f.v);
        if (f.op === 'json') uit = uit.filter((r) => String((r[f.k] || {})[f.sub] ?? '') === f.v);
      }
      return st.max == null ? uit : uit.slice(0, st.max);
    };

    const fout = (soort) => (faalOp && faalOp(tabel, soort, st) ? { message: `nep-fout op ${tabel}.${soort}` } : null);

    const k = {
      select: (kol) => { st.kolommen = kol; return k; },
      eq: (kol, v) => { st.filters.push({ op: 'eq', k: kol, v }); return k; },
      in: (kol, v) => { st.filters.push({ op: 'in', k: kol, v }); return k; },
      is: (kol, v) => { st.filters.push({ op: 'is', k: kol, v }); return k; },
      not: (kol, _o, v) => { st.filters.push({ op: 'not', k: kol, v }); return k; },
      filter: (pad, _o, v) => {
        const [kol, sub] = String(pad).split('->>');
        st.filters.push({ op: 'json', k: kol, sub, v });
        return k;
      },
      gte: () => k, lte: () => k, gt: () => k, lt: () => k,
      order: () => k,
      limit: (n) => { st.max = n; return k; },
      maybeSingle: async () => {
        const e = fout('select'); if (e) return { data: null, error: e };
        return { data: pas()[0] || null, error: null };
      },
      single: async () => {
        const e = fout('select'); if (e) return { data: null, error: e };
        return { data: pas()[0] || null, error: null };
      },
      insert: (rijen) => {
        const lijst = Array.isArray(rijen) ? rijen : [rijen];
        const e = fout('insert');
        const gezet = e ? [] : lijst.map((r) => { const n = { id: nieuwId(tabel), ...r }; data[tabel].push(n); return n; });
        return maakKlaar(gezet, e);
      },
      update: (velden) => {
        const e = fout('update');
        const raak = e ? [] : pas();
        if (!e) for (const r of raak) Object.assign(r, velden);
        return maakKlaar(raak, e);
      },
      upsert: (rijen, { onConflict } = {}) => {
        const sleutels = String(onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
        const e = fout('upsert');
        const uit = [];
        if (!e) {
          for (const r of (Array.isArray(rijen) ? rijen : [rijen])) {
            const bestaand = sleutels.length
              ? data[tabel].find((x) => sleutels.every((s) => x[s] === r[s]))
              : null;
            if (bestaand) { Object.assign(bestaand, r); uit.push(bestaand); }
            else { const n = { id: nieuwId(tabel), ...r }; data[tabel].push(n); uit.push(n); }
          }
        }
        return maakKlaar(uit, e);
      },
      then: (res, rej) => Promise.resolve(((() => { const e = fout('select'); return e ? { data: null, error: e } : { data: pas(), error: null }; }))()).then(res, rej),
    };

    // insert/update/upsert mogen zowel direct geawait worden als met .select().
    function maakKlaar(rijen, error) {
      const kl = {
        select: () => kl,
        single: async () => ({ data: error ? null : (rijen[0] || null), error: error || null }),
        maybeSingle: async () => ({ data: error ? null : (rijen[0] || null), error: error || null }),
        eq: (kol, v) => { st.filters.push({ op: 'eq', k: kol, v }); return kl; },
        in: (kol, v) => { st.filters.push({ op: 'in', k: kol, v }); return kl; },
        then: (res, rej) => Promise.resolve({ data: error ? null : rijen, error: error || null }).then(res, rej),
      };
      return kl;
    }

    return k;
  };

  return { from, _data: data };
}

const CONTACT = '11111111-1111-1111-1111-111111111111';
const CONTACT_B = '22222222-2222-2222-2222-222222222222';

const beltaak = (id, klant) => ({ id, customer_id: klant, action_type: 'MANUAL_FOLLOWUP', status: 'PENDING', payload: { kind: 'call', title: 'Bel klant' } });

/* ── één persoon wegschrijven ─────────────────────────────────────────────── */

test('een nieuwe persoon krijgt één rij met zijn redenen eronder', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const rij = voegSamen([
    uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT }),
    uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' }),
  ])[0];

  const uit = await schrijfPersoon(db, rij);

  assert.equal(uit.nieuw, 1);
  assert.equal(db._data.iris_belrij.length, 1);
  assert.equal(db._data.iris_belrij[0].contact_id, CONTACT);
  assert.equal(db._data.iris_belrij[0].prioriteit, BRON_PRIORITEIT.wanbetaler);
  assert.equal(db._data.iris_belrij_redenen.length, 2);
  assert.deepEqual(
    db._data.iris_belrij_redenen.map((r) => r.bron_sleutel).sort(),
    ['pending_action:t1', 'signaal:s1']
  );
});

test('twee ronden met dezelfde bronnen geven GEEN tweede rij en GEEN tweede reden', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];

  await schrijfPersoon(db, rij);
  const tweede = await schrijfPersoon(db, rij);

  assert.equal(tweede.nieuw, 0);
  assert.equal(tweede.bijgewerkt, 1);
  assert.equal(db._data.iris_belrij.length, 1, 'er staat een tweede open rij voor dezelfde persoon');
  assert.equal(db._data.iris_belrij_redenen.length, 1);
});

test('een prioriteit die een mens hoger zette blijft staan', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 95, bron: 'hand', reden: 'hand' }],
    iris_belrij_redenen: [],
  });
  const rij = voegSamen([uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' })])[0];

  await schrijfPersoon(db, rij);

  assert.equal(db._data.iris_belrij[0].prioriteit, 95);
  assert.equal(db._data.iris_belrij[0].bron, 'hand', 'de bron van een handmatige rij is overschreven');
  assert.equal(db._data.iris_belrij[0].reden, 'hand', 'de reden van een handmatige rij is overschreven');
});

test('een reden die niet meer wordt aangeleverd krijgt verwerkt_op en blijft staan', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'open', prioriteit: 50, bron: 'mentorsignaal' }],
    iris_belrij_redenen: [
      { id: 'r1', belrij_id: 'b1', bron: 'mentorsignaal', bron_sleutel: 'signaal:oud', reden: 'mentorsignaal', verwerkt_op: null },
    ],
  });
  const rij = voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0];

  const uit = await schrijfPersoon(db, rij);

  assert.equal(uit.redenen_verwerkt, 1);
  const oud = db._data.iris_belrij_redenen.find((r) => r.id === 'r1');
  assert.ok(oud, 'de oude reden is verwijderd in plaats van afgevinkt');
  assert.ok(oud.verwerkt_op, 'verwerkt_op is niet gezet');
});

test('een rij met status bezig wordt hergebruikt, niet gedupliceerd', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'bezig', prioriteit: 50, bron: 'wanbetaler' }],
    iris_belrij_redenen: [],
  });
  await schrijfPersoon(db, voegSamen([uitBeltaak(beltaak('t1', 'k1'), { contactId: CONTACT })])[0]);
  assert.equal(db._data.iris_belrij.length, 1);
});

test('een afgehandelde rij blokkeert geen nieuwe: gedaan is gedaan', async () => {
  const db = nepDb({
    iris_belrij: [{ id: 'b1', contact_id: CONTACT, status: 'gedaan', prioriteit: 50, bron: 'wanbetaler' }],
    iris_belrij_redenen: [],
  });
  const uit = await schrijfPersoon(db, voegSamen([uitSignaal({ id: 's1', contact_id: CONTACT, type: 'reageert_niet' })])[0]);
  assert.equal(uit.nieuw, 1);
  assert.equal(db._data.iris_belrij.length, 2);
});

test('zonder redenen gebeurt er niets', async () => {
  const db = nepDb({ iris_belrij: [], iris_belrij_redenen: [] });
  const uit = await schrijfPersoon(db, { contact_id: CONTACT, redenen: [] });
  assert.deepEqual(uit, { nieuw: 0, bijgewerkt: 0, redenen_nieuw: 0, redenen_verwerkt: 0 });
  assert.equal(db._data.iris_belrij.length, 0);
});

/* ── de hele ronde ────────────────────────────────────────────────────────── */

test('de ronde leest drie bronnen en maakt één rij per persoon', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1'), beltaak('t2', 'k2')],
    iris_contacten: [
      { id: CONTACT, customer_id: 'k1' },
      { id: CONTACT_B, customer_id: 'k2' },
    ],
    iris_signalen: [{ id: 's1', contact_id: CONTACT, type: 'reageert_niet', verwerkt_op: null, signaal_op: '2026-10-01T00:00:00Z' }],
    iris_opvolgingen: [{ id: 'o1', contact_id: CONTACT_B, gesprek_id: 'g1', status: 'verlopen', omschrijving: 'Wacht', tot: '2026-10-01T00:00:00Z' }],
    iris_gesprekken: [{ id: 'g1', contact_id: CONTACT_B }],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.kandidaten, 4);
  assert.equal(rap.personen, 2);
  assert.equal(rap.nieuw, 2);
  assert.equal(db._data.iris_belrij.length, 2);
  assert.equal(db._data.iris_belrij_redenen.length, 4);
  assert.deepEqual(rap.fouten, []);
});

test('een mentorsignaal met een type dat NIET naar de belrij hoort, komt er niet in', async () => {
  const db = nepDb({
    pending_actions: [], iris_contacten: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_signalen: [
      { id: 's-halt', contact_id: CONTACT, type: 'halt', verwerkt_op: null },
      { id: 's-uitstel', contact_id: CONTACT, type: 'uitstel', verwerkt_op: null },
      { id: 's-start', contact_id: CONTACT, type: 'start_niet_op', verwerkt_op: null },
    ],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.kandidaten, 1, 'halt of uitstel is op de belrij beland');
  assert.equal(db._data.iris_belrij_redenen[0].bron_sleutel, 'signaal:s-start');
});

test('een klant met twee contacten valt eruit in plaats van gokken', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1')],
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }, { id: CONTACT_B, customer_id: 'k1' }],
    iris_signalen: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.meerdere_contacten, 1);
  assert.equal(rap.zonder_contact, 1);
  assert.equal(db._data.iris_belrij.length, 0, 'er is gegokt welk contact het was');
});

test('één contact dat omvalt blokkeert de rest van de ronde niet', async () => {
  // De tweede persoon laat de insert in iris_belrij falen; de eerste en de derde
  // horen er gewoon te staan.
  let gezien = 0;
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1'), beltaak('t2', 'k2'), beltaak('t3', 'k3')],
    iris_contacten: [
      { id: CONTACT, customer_id: 'k1' },
      { id: CONTACT_B, customer_id: 'k2' },
      { id: '33333333-3333-3333-3333-333333333333', customer_id: 'k3' },
    ],
    iris_signalen: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  }, {
    faalOp: (tabel, soort) => (tabel === 'iris_belrij' && soort === 'insert' && ++gezien === 2),
  });

  const rap = await vulBelrij(db);

  assert.equal(rap.nieuw, 2, 'de ronde stopte bij de eerste fout');
  assert.equal(rap.fouten.length, 1);
  assert.match(rap.fouten[0], /belrij aanmaken/);
});

test('een ronde die buiten de tijd valt, kapt af en zegt dat', async () => {
  const db = nepDb({
    pending_actions: [beltaak('t1', 'k1'), beltaak('t2', 'k2')],
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }, { id: CONTACT_B, customer_id: 'k2' }],
    iris_signalen: [], iris_opvolgingen: [], iris_gesprekken: [],
    iris_belrij: [], iris_belrij_redenen: [],
  });

  let over = 1;
  const rap = await vulBelrij(db, { opTijd: () => over-- > 0 });

  assert.equal(rap.afgekapt, true);
  assert.equal(rap.nieuw, 1);
});

test('een lege ronde schrijft niets en meldt niets', async () => {
  const db = nepDb({
    pending_actions: [], iris_contacten: [], iris_signalen: [], iris_opvolgingen: [],
    iris_gesprekken: [], iris_belrij: [], iris_belrij_redenen: [],
  });
  const rap = await vulBelrij(db);
  assert.equal(rap.personen, 0);
  assert.equal(rap.nieuw, 0);
  assert.equal(db._data.iris_belrij.length, 0);
});

test('de ronde raakt pending_actions, iris_signalen en iris_opvolgingen niet aan', async () => {
  const taken = [beltaak('t1', 'k1')];
  const signalen = [{ id: 's1', contact_id: CONTACT, type: 'reageert_niet', verwerkt_op: null }];
  const opvolg = [{ id: 'o1', contact_id: CONTACT, status: 'verlopen', omschrijving: 'x', tot: '2026-10-01T00:00:00Z' }];
  const db = nepDb({
    pending_actions: taken, iris_signalen: signalen, iris_opvolgingen: opvolg,
    iris_contacten: [{ id: CONTACT, customer_id: 'k1' }],
    iris_gesprekken: [], iris_belrij: [], iris_belrij_redenen: [],
  });

  await vulBelrij(db);

  assert.deepEqual(db._data.pending_actions, taken.map((t) => ({ ...t })));
  assert.deepEqual(db._data.iris_signalen, signalen.map((s) => ({ ...s })));
  assert.deepEqual(db._data.iris_opvolgingen, opvolg.map((o) => ({ ...o })));
});
