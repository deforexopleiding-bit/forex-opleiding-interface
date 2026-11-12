// tests/commissie-ui-kaart.test.js
//
// De kaart "Mentorcommissie op deze offerte" en de commissie-chip
// (modules/klanten-v2/views/_commissie-ui.js) in hun toestanden. Het echte
// bestand draait in een node:vm.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function laad(role = 'super_admin') {
  const ctx = { console, Intl, Date, Promise, setTimeout, DFO: { S: { role } } };
  ctx.window = ctx;
  createContext(ctx);
  runInContext(readFileSync('modules/klanten-v2/views/_commissie-ui.js', 'utf8'), ctx);
  return ctx.KV_COMM;
}

const basis = {
  deal_id: 'd1', getekend: true, gearchiveerd: false, offerte: 'OFF-1', verkoper: { user_id: 'v', naam: 'Dave', is_mentor: false },
  abonnementen: [{ id: 's1', status: 'active', soort: 'origineel', soort_label: 'Origineel' }, { id: 's2', status: 'active', soort: 'aanpassing', soort_label: 'Aanpassing · uitstel' }],
  facturen: { aantal: 2, betaald: 300, open: 300, achterstallig: 0 }, basis_incl: 3600, vrijkomen: 'aanbetaling + 12 termijnen — per betaalde factuur naar verhouding',
  incasso: null, status: { k: 'deels', l: 'Deels vrijgegeven', c: 'accent' },
  commissie: {
    heeft_commissie: true, status: 'actief', open: true, pct: 3, basis: 3600, basis_incl_btw: true, totaal: 108, totaal_oorspronkelijk: 108, vrijgegeven: 9, uitbetaald: 0,
    bron: { soort: 'event', titel: 'Event Gent', datum: '2026-11-07T18:00:00Z' },
    mentoren: [{ user_id: 'a', naam: 'Chesney', bedrag: 108, vrijgegeven: 9, uitbetaald: 0, geannuleerd: false }],
  },
};

test('actieve event-commissie: mentor, bron, % van basis, balk, soorten, knoppen', () => {
  const C = laad();
  const h = C.kaart(basis);
  assert.match(h, /Mentorcommissie op deze offerte/);
  assert.match(h, /Chesney/);
  assert.match(h, /Event · Event Gent · 7 nov 2026/);
  assert.match(h, /3% van €\s3\.600,00 incl\. btw/);
  assert.match(h, /Deels vrijgegeven/);
  assert.match(h, /2 gelinkte abonnementen: Origineel, Aanpassing · uitstel/);
  assert.match(h, /Incasso: nee/);
  assert.match(h, /Bekijk in Commissies/);
  assert.match(h, /Sale toewijzen/);
  assert.match(C.chip(basis), /Chesney · Event 7\/11 · <b>€\s108<\/b>/);
});

test('geannuleerd: reden + datum, chip grijs doorgestreept', () => {
  const C = laad();
  const z = { ...basis, status: { k: 'geannuleerd', l: 'Geannuleerd', c: 'neutral' }, commissie: { ...basis.commissie, status: 'geannuleerd', open: false, totaal: 0,
    annulering: { reden: 'Klant geannuleerd', op: '2026-11-12' }, mentoren: [{ ...basis.commissie.mentoren[0], geannuleerd: true }] } };
  const h = C.kaart(z);
  assert.match(h, /Geannuleerd — <b>Klant geannuleerd<\/b> · 12 nov 2026/);
  assert.match(C.chip(z), /Geannuleerd · <s>€\s108<\/s>/);
});

test('geen commissie: verkoper is mentor → oranje + Toewijzen; membership; vorige offerte-banner', () => {
  const C = laad();
  const geen = { ...basis, commissie: { heeft_commissie: false }, verkoper: { user_id: 'm', naam: 'Chesney', is_mentor: true }, status: { k: 'geen', l: 'Geen commissie', c: 'neutral' } };
  assert.match(C.kaart(geen), /Geen commissie — verkoper Chesney is mentor/);
  assert.match(C.chip(geen), /Geen · verkoper is mentor/);
  assert.match(C.chip({ ...geen, membership: true }), /Geen · membership/);
  const met = { ...geen, verkoper: null, vorige_vervangen: { vorige_offerte: 'OFF-0', vervangen_op: '2026-11-12', bedrag: 216, mentoren: [{ user_id: 'a', naam: 'Chesney' }], pct: 3, basis_incl_btw: true, bron: { soort: 'event', titel: 'Event 7/11', datum: '2026-11-07' } } };
  const h = C.kaart(met);
  assert.match(h, /Vorige offerte van deze klant had commissie/);
  assert.match(h, /nog niet gekoppeld/);
  const pf = C.prefillVoor(met);
  assert.equal(pf.deal_id, 'd1');
  assert.deepEqual([...pf.mentoren], ['a']);
  assert.equal(pf.pct, 3);
  assert.equal(pf.reden, 'handmatig');
  assert.match(pf.note, /Vervangt offerte OFF-0/);
});

test('incasso: chip rood, kaart toont stilstand; mentor/sales ziet geen toewijsknop', () => {
  const C = laad('sales');
  const z = { ...basis, incasso: { status: 'bij_incasso', label: 'Bij incasso', sinds: '2026-11-10' } };
  assert.match(C.chip(z), /Incasso · Chesney/);
  const h = C.kaart(z);
  assert.match(h, /Bij incasso sinds 10 nov 2026 — commissie staat stil/);
  assert.ok(!h.includes('Sale toewijzen'));
});

test('fix 3: korte chip voor lijsten kapt de namen af, bedrag blijft, volledige tekst in tooltip', () => {
  const C = laad();
  const z = { ...basis, commissie: { ...basis.commissie, mentoren: [{ user_id: 'a', naam: 'Chesney Van Der Langenaam', bedrag: 54 }, { user_id: 'b', naam: 'Bart', bedrag: 54 }] } };
  const h = C.chip(z, { kort: true });
  assert.match(h, /max-width:80px;overflow:hidden;text-overflow:ellipsis/);
  assert.match(h, /<\/span> · <b>€\s108<\/b><\/span>$/);
  assert.match(h, /title="Chesney Van Der Langenaam, Bart · Event Gent · 7 nov 2026"/);
});
