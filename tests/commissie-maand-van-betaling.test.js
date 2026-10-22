// tests/commissie-maand-van-betaling.test.js
//
// Commissie telt in de maand waarin de klant EFFECTIEF betaalt
// (api/_lib/commissie-maand.js + computeBonusOverview, de bron van het
// payout-rapport). Afgedekt: later betaald → betaalmaand; onbetaald
// achterstallig → huidige maand; al uitbetaald → nooit dubbel; betaald in een
// gesloten maand → inhaal (niet automatisch); deelbetaling; gecrediteerd.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { maakNepDb } from './_nep-db.js';
import {
  effectieveBetaaldatum, maakAfsluiting, plaatsTermijn, addYm,
} from '../api/_lib/commissie-maand.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

const db = maakNepDb();
mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: db.client, createUserClient: () => db.client } });
mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
const { computeBonusOverview } = await import(url('api/mentor-bonus-overview.js'));

const VANDAAG = '2026-10-22';
const rap = (periode, status, gen) => ({ period_month: periode + '-01', status, generated_at: gen + 'T06:00:00Z' });
// Rapporten t/m september definitief → bonusmaanden t/m augustus gesloten.
const AFS = maakAfsluiting([rap('2026-08', 'goedgekeurd', '2026-09-04'), rap('2026-09', 'goedgekeurd', '2026-10-01')]);

test('addYm en afsluiting: rapport periode P betaalt maand P-1', () => {
  assert.equal(addYm('2026-01', -1), '2025-12');
  assert.equal(addYm('2026-11', 2), '2027-01');
  assert.equal(AFS.laatsteGesloten, '2026-08');
  assert.equal(AFS.gesloten('2026-08'), true);
  assert.equal(AFS.gesloten('2026-09'), false);
  assert.equal(AFS.definitiefVoor('2026-08').periode, '2026-09');
});

test('later betaald dan de vervalmaand → telt in de betaalmaand', () => {
  const p = plaatsTermijn({ dueYmd: '2026-09-08', betaald: true, betaaldatum: '2026-10-14', vandaag: VANDAAG, afsluiting: AFS });
  assert.equal(p.maand, '2026-10');
  assert.equal(p.telt, true);
  assert.equal(p.verschoven, true);
  assert.equal(p.inhaal, false);
});

test('onbetaald en vervaldag voorbij → huidige maand, achterstallig sinds vervaldag', () => {
  const p = plaatsTermijn({ dueYmd: '2026-08-28', betaald: false, vandaag: VANDAAG, afsluiting: AFS });
  assert.equal(p.maand, '2026-10');
  assert.equal(p.status, 'achterstallig');
  assert.equal(p.achterstallig_sinds, '2026-08-28');
  assert.equal(p.telt, true);
});

test('onbetaald in de toekomst → gewoon de vervalmaand', () => {
  const p = plaatsTermijn({ dueYmd: '2026-12-01', betaald: false, vandaag: VANDAAG, afsluiting: AFS });
  assert.equal(p.maand, '2026-12');
  assert.equal(p.status, 'open');
});

test('al uitbetaald in het rapport van de vervalmaand → blijft daar, nooit dubbel', () => {
  // Vervalt 8 juli, betaald 13 aug, rapport augustus (= bonus juli) gemaakt 4 sep.
  const p = plaatsTermijn({ dueYmd: '2026-07-08', betaald: true, betaaldatum: '2026-08-13', vandaag: VANDAAG, afsluiting: AFS });
  assert.equal(p.maand, '2026-07');
  assert.equal(p.uitbetaald_in, '2026-08');
  assert.equal(p.telt, true);
});

test('betaald in een maand waarvan het rapport al definitief is → inhaal, telt nergens', () => {
  // Vervalt juni; het juni-rapport (periode juli) werd 7 aug gemaakt; de klant
  // betaalt 20 aug — maar augustus is al gesloten (rapport periode sep).
  const afs = maakAfsluiting([rap('2026-07', 'goedgekeurd', '2026-08-07'), rap('2026-08', 'goedgekeurd', '2026-09-04'), rap('2026-09', 'uitbetaald', '2026-10-01')]);
  const p = plaatsTermijn({ dueYmd: '2026-06-08', betaald: true, betaaldatum: '2026-08-20', vandaag: VANDAAG, afsluiting: afs });
  assert.equal(p.inhaal, true, 'juni-rapport (gemaakt 7 aug) had hem niet, augustus is al gesloten');
  assert.equal(p.telt, false);
  assert.equal(p.maand, '2026-08');
});

test('zonder definitieve rapporten is niets gesloten (concepten tellen niet)', () => {
  const afs = maakAfsluiting([rap('2026-09', 'concept', '2026-10-01')]);
  assert.equal(afs.laatsteGesloten, null);
  const p = plaatsTermijn({ dueYmd: '2026-06-08', betaald: true, betaaldatum: '2026-08-20', vandaag: VANDAAG, afsluiting: afs });
  assert.equal(p.maand, '2026-08');
  assert.equal(p.inhaal, false);
});

test('deelbetaling: betaaldatum = dag waarop de betalingen het bedrag dekken', () => {
  const inv = { amount_total: 300, amount_paid: 300, credited_amount: 0, status: 'paid', paid_date: '2026-11-30' };
  const d = effectieveBetaaldatum(inv, [
    { amount: 100, payment_date: '2026-09-20' },
    { amount: 200, payment_date: '2026-10-05' },
  ]);
  assert.equal(d, '2026-10-05');
  // Betalingen dekken niet alles (rest via TL-sync) → paid_date.
  assert.equal(effectieveBetaaldatum(inv, [{ amount: 100, payment_date: '2026-09-20' }]), '2026-11-30');
  // Deels gecrediteerd: te betalen = totaal − krediet.
  const deels = { amount_total: 300, amount_paid: 200, credited_amount: 100, status: 'partially_paid', paid_date: null };
  assert.equal(effectieveBetaaldatum(deels, [{ amount: 200, payment_date: '2026-10-09' }]), '2026-10-09');
  // Nog niet volledig betaald → geen datum.
  assert.equal(effectieveBetaaldatum({ amount_total: 300, amount_paid: 100, credited_amount: 0, status: 'partially_paid' }, [{ amount: 100, payment_date: '2026-10-01' }]), null);
});

test('gecrediteerd → telt nergens, ook niet als de rij nog "paid" zegt', () => {
  const inv = { amount_total: 300, amount_paid: 300, credited_amount: 300, status: 'paid', paid_date: '2026-10-01' };
  assert.equal(effectieveBetaaldatum(inv, []), null);
  const p = plaatsTermijn({ dueYmd: '2026-10-01', betaald: false, gecrediteerd: true, vandaag: VANDAAG, afsluiting: AFS });
  assert.equal(p.status, 'gecrediteerd');
  assert.equal(p.telt, false);
});

/* ── Integratie: computeBonusOverview (bron van het payout-rapport) ────── */
const K = '11111111-1111-4111-8111-111111111111';
const D = 'd1000000-0000-4000-8000-000000000001';
const A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const EV = 'e0000000-0000-4000-8000-0000000000e1';

function ymNu(off) {
  const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + off);
  return d.toISOString().slice(0, 7);
}
function zet({ facturen, rapporten = [], betalingen = [], adjs = [] }) {
  db.reset({
    events: [{ id: EV, title: 'Event', starts_at: '2026-01-10T09:00:00Z' }],
    customers: [{ id: K, first_name: 'Jan', last_name: 'P' }],
    deals: [{ id: D, customer_id: K }],
    subscriptions: [{ id: 's', deal_id: D, teamleader_subscription_id: 'tl', amount: 100, vat_percentage: 0, term_count: facturen.length,
      billing_cycle: 'per_month', start_date: facturen[0].due_date, status: 'active' }],
    invoices: facturen.map((f, i) => ({ id: 'f' + i, customer_id: K, deal_id: D, tl_subscription_id: 'tl', amount_total: 100, credited_amount: 0, ...f })),
    payments: betalingen,
    mentor_payouts: rapporten.map((r) => ({ ...r, mentor_user_id: A })),
    mentor_payout_adjustments: adjs.map((a) => ({ ...a, mentor_user_id: A })),
    mentor_ledger_entries: [{ id: 'p', mentor_user_id: A, event_id: EV, entry_type: 'bonus', customer_id: K, basis: 100 * facturen.length,
      amount: 3 * facturen.length, status: 'pending', parent_entry_id: null, source_quote_id: D, idempotency_key: 'k', created_at: '2026-01-10T00:00:00Z' }],
  });
}
const maand = (out, ym) => out.projection_12m.find((m) => m.month === ym);

test('overzicht: termijn van vorige maand pas deze maand betaald → paid in déze maand', async () => {
  const vorig = ymNu(-1), nu = ymNu(0);
  zet({ facturen: [{ due_date: `${vorig}-05`, amount_paid: 100, status: 'paid', paid_date: `${nu}-02` }] });
  const out = await computeBonusOverview(A);
  assert.equal(maand(out, vorig).paid, 0);
  assert.equal(maand(out, nu).paid, 3);
  assert.equal(out.verschoven.length, 1);
  assert.equal(out.verschoven[0].rapport_periode, ymNu(1));
});

test('overzicht: onbetaalde achterstallige termijn schuift naar huidige maand (achterstallig)', async () => {
  const twee = ymNu(-2), nu = ymNu(0);
  zet({ facturen: [{ due_date: `${twee}-05`, amount_paid: 0, status: 'open', paid_date: null }] });
  const out = await computeBonusOverview(A);
  assert.equal(maand(out, twee).expected, 0, 'niet meer in een voorbije maand');
  assert.equal(maand(out, nu).expected, 3);
  assert.equal(maand(out, nu).achterstallig, 3);
  assert.equal(out.achterstallig_totaal, 3);
});

test('overzicht: al uitbetaald in een definitief rapport → niet nog eens in de betaalmaand', async () => {
  // Vervalt 3 maanden terug, betaald 2 maanden terug, het rapport van de
  // vervalmaand (periode = vervalmaand+1) werd daarna gemaakt en goedgekeurd.
  const drie = ymNu(-3), twee = ymNu(-2), een = ymNu(-1);
  zet({
    facturen: [{ due_date: `${drie}-05`, amount_paid: 100, status: 'paid', paid_date: `${twee}-03` }],
    rapporten: [{ period_month: `${twee}-01`, status: 'uitbetaald', generated_at: `${een}-01T06:00:00Z` }],
  });
  const out = await computeBonusOverview(A);
  assert.equal(maand(out, drie).paid, 3, 'blijft in de maand van het rapport dat hem uitbetaalde');
  assert.equal(maand(out, twee).paid, 0, 'nooit dubbel');
});

test('overzicht: betaald in gesloten maand → inhaal, telt nergens; met [inhaal:]-correctie = voorgesteld', async () => {
  const vier = ymNu(-4), drie = ymNu(-3), twee = ymNu(-2), een = ymNu(-1);
  const basis = {
    facturen: [{ due_date: `${vier}-05`, amount_paid: 100, status: 'paid', paid_date: `${drie}-20` }],
    rapporten: [
      { period_month: `${drie}-01`, status: 'goedgekeurd', generated_at: `${drie}-02T06:00:00Z` }, // rapport vervalmaand: vóór betaling
      { period_month: `${twee}-01`, status: 'goedgekeurd', generated_at: `${twee}-02T06:00:00Z` },
      { period_month: `${een}-01`, status: 'goedgekeurd', generated_at: `${een}-02T06:00:00Z` },
    ],
  };
  zet(basis);
  let out = await computeBonusOverview(A);
  assert.equal(out.inhaal.length, 1);
  assert.equal(maand(out, drie).paid, 0);
  assert.equal(maand(out, vier).paid, 0);
  assert.equal(out.inhaal_totaal, 3);
  // Laatste definitieve rapport = periode vorige maand → volgend rapport = periode deze maand.
  assert.equal(out.inhaal[0].inhaal_voorstel_periode, ymNu(0));
  zet({ ...basis, adjs: [{ period_month: `${ymNu(0)}-01`, label: 'Inhaalcommissie J. termijn 1/1 [inhaal:f0]', amount_incl: 3 }] });
  out = await computeBonusOverview(A);
  assert.deepEqual(out.inhaal[0].inhaal_voorgesteld, { period_month: `${ymNu(0)}-01`, amount_incl: 3 });
  assert.equal(out.inhaal_totaal, 0);
});

test('overzicht: deelbetaling via payments bepaalt de maand', async () => {
  const twee = ymNu(-2), een = ymNu(-1);
  zet({
    facturen: [{ due_date: `${twee}-05`, amount_paid: 100, status: 'paid', paid_date: `${twee}-06` }],
    betalingen: [{ invoice_id: 'f0', amount: 40, payment_date: `${twee}-06` }, { invoice_id: 'f0', amount: 60, payment_date: `${een}-11` }],
  });
  const out = await computeBonusOverview(A);
  assert.equal(maand(out, twee).paid, 0);
  assert.equal(maand(out, een).paid, 3);
});
