// tests/intake-gesprek-stand.test.js
//
// Het intakegesprek uit de intake-pot van het LMS, voor het CRM-overzicht en
// het detailscherm (opdracht 5 oktober 2026). Borgt de stand per rij, en dat
// "niet gelezen" nooit als "niet in de pot" terugkomt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { intakeGesprekStand, intakeGesprekkenVoor } from '../api/_lib/intake-gesprek-stand.js';

const NU = Date.parse('2026-10-08T12:00:00Z');
const uurVoor = (u) => new Date(NU - u * 3_600_000).toISOString();
const rij = (o) => ({ crm_onboarding_id: 'a', aangemeld_op: uurVoor(10), crm_stand: 'open', ...o });

test('stand: vrij, geclaimd, ingepland, afgerond — en te laat alleen zonder afronding', () => {
  const namen = new Map([['m1', 'Kjento']]);
  assert.equal(intakeGesprekStand(rij({}), namen, NU).stand, 'vrij');
  assert.equal(intakeGesprekStand(rij({ geclaimd_door: 'm1' }), namen, NU).geclaimd_naam, 'Kjento');
  assert.equal(intakeGesprekStand(rij({ geclaimd_door: 'm1', gesprek_op: uurVoor(-20) }), namen, NU).stand, 'ingepland');
  const af = intakeGesprekStand(rij({ afgerond_door: 'm1', afgerond_op: uurVoor(1), uitkomst: 'ok', actieplan: { doel: 'x' } }), namen, NU);
  assert.equal(af.stand, 'afgerond');
  assert.equal(af.afgerond_naam, 'Kjento');
  assert.deepEqual(af.actieplan, { doel: 'x' });
  assert.equal(intakeGesprekStand(rij({ aangemeld_op: uurVoor(50) }), namen, NU).te_laat, true);
  assert.equal(intakeGesprekStand(rij({ aangemeld_op: uurVoor(50), afgerond_op: uurVoor(1) }), namen, NU).te_laat, false);
  assert.equal(intakeGesprekStand(rij({ aangemeld_op: uurVoor(50), crm_stand: 'vervallen' }), namen, NU).te_laat, false);
});

function nepLms(tabellen) {
  return {
    from(t) {
      const filters = [];
      const keten = {
        select: () => keten,
        in: (k, vs) => { filters.push((r) => vs.includes(r[k])); return keten; },
        then: (res, rej) => {
          const b = tabellen[t];
          const uit = b && !Array.isArray(b) ? { data: null, error: b } : { data: (b || []).filter((r) => filters.every((f) => f(r))), error: null };
          return Promise.resolve(uit).then(res, rej);
        },
      };
      return keten;
    },
  };
}

test('gelezen: alleen de gevraagde ids, met namen', async () => {
  const lms = nepLms({
    hlms_intake: [rij({ crm_onboarding_id: 'a', geclaimd_door: 'm1' }), rij({ crm_onboarding_id: 'z' })],
    hlms_personeel: [{ id: 'm1', naam: 'Kjento' }],
  });
  const r = await intakeGesprekkenVoor(['a', 'b'], { lmsClient: lms, nu: NU });
  assert.equal(r.status, 'gelezen');
  assert.deepEqual(Object.keys(r.gesprekken), ['a']);
  assert.equal(r.gesprekken.a.geclaimd_naam, 'Kjento');
});

test('ontbrekende tabel en een andere fout zijn twee verschillende standen, allebei zonder gesprekken', async () => {
  const weg = await intakeGesprekkenVoor(['a'], { lmsClient: nepLms({ hlms_intake: { code: 'PGRST205', message: 'Could not find the table' } }) });
  assert.equal(weg.status, 'tabel-ontbreekt');
  const stuk = await intakeGesprekkenVoor(['a'], { lmsClient: nepLms({ hlms_intake: { code: '57014', message: 'timeout' } }) });
  assert.equal(stuk.status, 'onbereikbaar');
  assert.deepEqual(stuk.gesprekken, {});
});

test('het overzicht en het detailscherm zeggen bij niet-gelezen "onbekend", nooit "niet in de pot"', () => {
  const lijst = readFileSync(new URL('../modules/klanten-v2/views/onboarding-v2.js', import.meta.url), 'utf8');
  assert.match(lijst, /gesprekStatus === 'gelezen' \? \(gesprekken\[r\.id\] \|\| null\) : undefined/);
  const detail = readFileSync(new URL('../modules/klanten-v2/views/modals/onboarding-detail.js', import.meta.url), 'utf8');
  assert.match(detail, /gesprekken_status === 'gelezen'/);
});

test('de uitbetaling krijgt een eigen regel "Intakes: n × 0,25"', () => {
  const core = readFileSync(new URL('../api/_lib/payout-generate-core.js', import.meta.url), 'utf8');
  assert.match(core, /key: 'intake',\s+kind: 'coaching_intake'/);
  assert.match(core, /intakeRegelLabel\(qty\)/);
  const render = readFileSync(new URL('../modules/shared/mentor-payout-render.js', import.meta.url), 'utf8');
  assert.match(render, /case 'coaching_intake'/);
});
