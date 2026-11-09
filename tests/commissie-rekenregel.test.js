// tests/commissie-rekenregel.test.js
//
// De rekenregel van de mentorcommissie (beslissing Maxim, 9 nov 2026), puur:
//   elke betaalde factuur van de sale = commissie × betaald / basis, nooit meer
//   dan de commissie min wat al vrijgegeven of uitbetaald is; afgesloten
//   maanden blijven zoals ze zijn (geen inhaal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  factuurStukken, rekenSaleCommissie, geplandeTermijnen, teSchrijvenStukken, STUK_PREFIX, isStukSleutel,
} from '../api/_lib/commissie-rekenregel.js';
import { maakAfsluiting } from '../api/_lib/commissie-maand.js';

const VANDAAG = '2026-11-09';
// Rapport okt (bonus september) definitief → t/m september afgesloten.
const AFS = maakAfsluiting([{ period_month: '2026-10-01', status: 'goedgekeurd', generated_at: '2026-11-06T10:00:00Z' }]);
const addMonthsIso = (iso, n) => { const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const basisP = { perTermijnIncl: (s) => Number(s.amount) || 0, cyclusMaanden: () => 1, addMonthsIso, afsluiting: AFS, vandaag: VANDAAG };
let n = 0;
const f = (bedrag, betaald, paid_date, extra = {}) => ({
  id: `f${++n}`, amount_total: bedrag, amount_paid: betaald, credited_amount: 0,
  status: betaald >= bedrag ? 'paid' : (betaald > 0 ? 'partially_paid' : 'open'),
  paid_date, due_date: paid_date || extra.due_date || '2026-12-01', tl_subscription_id: null, ...extra,
});
const reken = (extra) => rekenSaleCommissie({ commissie: 108, basis: 7200, betalingen: new Map(), subs: [], ...basisP, ...extra });
const som = (r) => Math.round(r.stukken.reduce((t, s) => t + s.bedrag, 0) * 100) / 100;

test('aanbetaling telt voor haar eigen bedrag (geen vast termijnbedrag)', () => {
  const r = reken({ facturen: [f(2400, 2400, '2026-10-15'), f(400, 400, '2026-11-02')] });
  assert.deepEqual(r.stukken.map((s) => s.bedrag), [36, 6], '108 × 2400/7200 = 36; 108 × 400/7200 = 6');
  assert.equal(r.stukken[0].maand, '2026-10');
});

test('abonnementen met verschillende bedragen en een losse factuur: elk voor zijn bedrag', () => {
  const r = rekenSaleCommissie({ commissie: 59.25, basis: 3950.01, betalingen: new Map(), subs: [], ...basisP,
    facturen: [f(1000, 1000, '2026-10-01'), f(300, 300, '2026-10-20'), f(250, 250, '2026-11-01')] });
  assert.deepEqual(r.stukken.map((s) => s.bedrag), [15, 4.5, 3.75]);
});

test('de 13e factuur (buiten het schema) telt, maar nooit boven de commissie', () => {
  const facturen = Array.from({ length: 20 }, (_, i) => f(400, 400, `2026-${10 + Math.floor(i / 10)}-${String((i % 10) + 1).padStart(2, '0')}`));
  const r = reken({ facturen });
  assert.equal(som(r), 108, '20 × 6 = 120 → begrensd op 108');
  assert.equal(r.stukken.length, 18);
});

test('gecrediteerde factuur telt nooit als betaald (ook niet als de rij nog paid zegt)', () => {
  const r = reken({ facturen: [f(400, 400, '2026-10-05', { credited_amount: 400 }), f(400, 400, '2026-10-06')] });
  assert.equal(som(r), 6);
  assert.equal(r.termijnen.find((t) => t.status === 'gecrediteerd').amount, 0);
});

test('afgesloten maanden: wat in een rapport zat telt niet opnieuw; betaald in een afgesloten maand = geen inhaal', () => {
  const al = f(2400, 2400, '2026-08-13');
  const laat = f(400, 400, '2026-09-28'); // september afgesloten, zat in geen rapport
  const r = reken({ facturen: [al, laat, f(400, 400, '2026-10-20')], bevrorenFacturen: new Set([al.id]), bevrorenBedrag: 6 });
  assert.equal(som(r), 6, 'enkel oktober');
  assert.equal(r.termijnen.find((t) => t.invoice_id === laat.id).status, 'afgesloten');
  assert.equal(r.termijnen.find((t) => t.invoice_id === laat.id).amount, 0);
  assert.ok(!r.termijnen.some((t) => t.invoice_id === al.id), 'bevroren factuur blijft in de oude berekening');
});

test('nooit meer dan de commissie min wat al vrijgegeven of uitbetaald is (het hoogste van rapport en grootboek)', () => {
  const facturen = Array.from({ length: 10 }, (_, i) => f(400, 400, `2026-10-${String(i + 1).padStart(2, '0')}`));
  assert.equal(som(reken({ facturen, bevrorenBedrag: 90 })), 18, '108 − 90');
  assert.equal(som(reken({ facturen, bevrorenBedrag: 20, legacyAfgesloten: 100 })), 8, '108 − max(20, 100)');
});

test('voorschot (oude trajectregels al uitgekeerd) wordt eerst verrekend', () => {
  const r = reken({ facturen: [f(400, 400, '2026-10-01'), f(400, 400, '2026-10-02'), f(400, 400, '2026-10-03'), f(400, 400, '2026-11-01')], voorschot: 18 });
  assert.deepEqual(r.stukken.map((s) => s.bedrag), [6], 'drie termijnen verrekend, de vierde telt');
  assert.equal(r.termijnen.filter((t) => t.status === 'verrekend').length, 3);
});

test('deelbetaling: per betaling in haar maand; zonder datum telt ze niet', () => {
  const inv = f(400, 400, '2026-11-02');
  const st = factuurStukken(inv, [{ amount: 100, payment_date: '2026-10-10' }, { amount: 300, payment_date: '2026-11-02' }]);
  assert.deepEqual(st, [{ datum: '2026-10-10', bedrag: 100 }, { datum: '2026-11-02', bedrag: 300 }]);
  assert.deepEqual(factuurStukken({ ...f(400, 150, null), status: 'partially_paid', paid_date: null }, []), []);
  assert.deepEqual(factuurStukken({ ...f(400, 150, null), status: 'partially_paid', paid_date: '2026-10-03' }, []), [{ datum: '2026-10-03', bedrag: 150 }]);
});

test('incasso: betalingen vanaf de datum tellen niet en er wordt niets verwacht', () => {
  const r = reken({ facturen: [f(400, 400, '2026-10-01'), f(400, 400, '2026-10-25'), f(6760, 0, null, { due_date: '2026-10-26' })], incassoSinds: '2026-10-19' });
  assert.equal(som(r), 6);
  assert.equal(r.nieuw_verwacht, 0);
});

test('verwacht: open facturen + geplande termijnen vanaf deze maand, gedekt per maand', () => {
  const sub = { id: 's', status: 'active', term_count: 6, amount: 400, start_date: '2026-09-01', teamleader_subscription_id: 'tl' };
  const gepland = geplandeTermijnen({ subs: [sub], facturen: [f(400, 0, null, { due_date: '2026-11-01', tl_subscription_id: 'tl' })], ...basisP, vanafYm: '2026-11' });
  assert.deepEqual(gepland.map((g) => g.due_date), ['2026-12-01', '2027-01-01', '2027-02-01'], 'nov gedekt door de factuur; sep/okt voorbij');
});

test('grootboek: één stuk per factuur + betaaldatum, oude vrijgaven in open maanden eerst verrekend, idempotent', () => {
  const stukken = [{ invoice_id: 'a', datum: '2026-10-06', maand: '2026-10', bedrag: 4.5 }, { invoice_id: 'b', datum: '2026-11-09', maand: '2026-11', bedrag: 4.5 }];
  const gesloten = (m) => !!m && m <= '2026-09';
  const eerst = teSchrijvenStukken({ parentId: 'p', stukken, kinderen: [], gesloten });
  assert.deepEqual(eerst.map((x) => [x.sleutel, x.bedrag]), [[STUK_PREFIX('p', 'a', '2026-10-06') + '450', 4.5], [STUK_PREFIX('p', 'b', '2026-11-09') + '450', 4.5]]);
  assert.ok(isStukSleutel(eerst[0].sleutel));
  const kinderen = eerst.map((x) => ({ idempotency_key: x.sleutel, amount: x.bedrag, status: 'vrijgegeven', released_at: x.released_month + '-01' }));
  assert.deepEqual(teSchrijvenStukken({ parentId: 'p', stukken, kinderen, gesloten }), [], 'tweede keer: niets');
  // Oude vrijgave (andere sleutel) van 6 in oktober (open): dekt eerst.
  const oud = [{ idempotency_key: 'p:paidamount:40000', amount: 6, status: 'vrijgegeven', released_at: '2026-10-01' }];
  assert.deepEqual(teSchrijvenStukken({ parentId: 'p', stukken, kinderen: oud, gesloten }).map((x) => x.bedrag), [3], '9 − 6');
  // Oude vrijgave in een AFGESLOTEN maand dekt niets van de open maanden.
  const oudDicht = [{ idempotency_key: 'p:paidamount:40000', amount: 6, status: 'vrijgegeven', released_at: '2026-07-01' }];
  assert.equal(teSchrijvenStukken({ parentId: 'p', stukken, kinderen: oudDicht, gesloten }).length, 2);
  // Nooit meer dan wat er op de parent overblijft.
  assert.deepEqual(teSchrijvenStukken({ parentId: 'p', stukken, kinderen: [], gesloten, rest: 5 }).map((x) => x.bedrag), [4.5, 0.5]);
});
