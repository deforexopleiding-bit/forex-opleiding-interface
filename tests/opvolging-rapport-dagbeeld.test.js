// tests/opvolging-rapport-dagbeeld.test.js
//
// SECTIE 4 VAN HET RAPPORT, DRAAIEND — NIET GELEZEN.
//
// Bij de sabotage-ronde op het dagbeeld gaven twee bewuste regressies NUL rood:
// het rapport dat de verzette afspraak weer op zijn nieuwe dag zet, en de
// terugval die op de foutcode 42703 afgaat in plaats van op de kolomnaam. Beide
// zitten in api/opvolging-rapport.js, en de tests eromheen keken naar de lib en
// naar de brontekst — niet naar wat het rapport ermee doet.
//
// Dat is deze week de vierde keer dat een groene suite naast een gat stond. De
// enige test die dat sluit is er een die de bouwer echt aanroept.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { VERZET } from '../api/_lib/opvolging-dagbeeld.js';

// GEEN STATISCHE IMPORT VAN HET RAPPORT. `import`-regels worden gehesen en
// draaien vóór mock.module hieronder; dan laadt de module de ECHTE
// supabase-client, en die probeert bij de eerste query het netwerk op. Alles
// wat uit api/opvolging-rapport.js komt wordt daarom hieronder dynamisch
// geladen, ná de mock.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NU = Date.parse('2026-09-08T12:00:00Z');

let actief = null;   // de nepdatabank van de lopende test
mock.module(join(ROOT, 'api/supabase.js'), {
  namedExports: {
    supabaseAdmin: { from: (n) => actief.client.from(n) },
    supabase     : { from: (n) => actief.client.from(n) },
    createUserClient: () => actief.client,
    checkCronAuth: () => ({ ok: true }),
  },
});
const rapport = async () => { if (!actief) actief = maakStub(); return import(join(ROOT, 'api/opvolging-rapport.js')); };

// ═══════════════════════════════════════════════════════════════════════════
// DE LIJST ZELF
// ═══════════════════════════════════════════════════════════════════════════

const SANDER = {
  id: 'a-sander', lead_name: 'sander De groot', status: 'scheduled',
  scheduled_at: '2026-09-15T13:00:00Z', eerst_gepland_op: '2026-09-07T13:00:00Z',
};

test('een in dezelfde rij verzette afspraak blijft in sectie 4 op zijn oude dag staan', async () => {
  const { bouwZoomcalls } = await rapport();
  const [c] = bouwZoomcalls({ afspraken: [SANDER], uitkomstKolommen: true, nuMs: NU });
  assert.equal(c.dag, '2026-09-07', 'niet de dag waar hij inmiddels heen is');
  assert.equal(c.tijd, '15:00');
});

test('en hij draagt de bestemming mee', async () => {
  const { bouwZoomcalls } = await rapport();
  const [c] = bouwZoomcalls({ afspraken: [SANDER], uitkomstKolommen: true, nuMs: NU });
  assert.equal(c.verzet_naar.dag, '2026-09-15');
  assert.equal(c.toon.staat, VERZET);
  assert.match(c.toon.label, /verzet naar 15 september/);
  assert.equal(c.toon.doorgehaald, true);
});

test('een gewone afspraak verandert niet van dag', async () => {
  const { bouwZoomcalls } = await rapport();
  const [c] = bouwZoomcalls({
    afspraken: [{ id: 'a', lead_name: 'Gewoon', status: 'scheduled',
      scheduled_at: '2026-09-08T11:30:00Z', eerst_gepland_op: '2026-09-08T11:30:00Z' }],
    uitkomstKolommen: true, nuMs: NU,
  });
  assert.equal(c.dag, '2026-09-08');
  assert.equal(c.verzet_naar, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN DE TWEE TERUGVALLEN, DRAAIEND MET EEN NEPDATABANK
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param ontbreekt  kolomnamen die deze databank niet kent; een select die er
 *   een noemt faalt met 42703, net als in Postgres.
 */
function maakStub({ ontbreekt = [], rijen = {} } = {}) {
  const selects = [];
  const filters = [];   // wat er echt gefilterd is, niet wat de bron zegt
  const tafel = (naam) => {
    const q = { _k: null };
    const zelf = () => q;
    Object.assign(q, {
      select(k) { q._k = String(k || ''); selects.push({ tafel: naam, kolommen: q._k }); return q; },
      or(uitdrukking) { filters.push({ tafel: naam, or: String(uitdrukking || '') }); return q; },
      eq: zelf, neq: zelf, in: zelf, not: zelf, is: zelf,
      gte: zelf, gt: zelf, lte: zelf, lt: zelf, order: zelf, limit: zelf, range: zelf,
      maybeSingle: async () => ({ data: null, error: null }),
      then(res, rej) {
        const mis = ontbreekt.find((k) => new RegExp('\\b' + k + '\\b').test(q._k || ''));
        if (mis) {
          return Promise.resolve({ data: null, error:
            { code: '42703', message: `column ${naam}.${mis} does not exist` } }).then(res, rej);
        }
        return Promise.resolve({ data: rijen[naam] || [], error: null }).then(res, rej);
      },
    });
    return q;
  };
  return { selects, filters, client: { from: tafel } };
}

const DAG = '2026-09-08';
async function draai(stub) {
  actief = stub;
  const { bouwRapport } = await rapport();
  const vanMs = Date.parse(DAG + 'T00:00:00Z');
  return bouwRapport({
    supabase: stub.client, van: DAG, tot: DAG, dagen: [DAG], vandaag: DAG,
    vanIso: new Date(vanMs - 2 * 3600e3).toISOString(),
    totIso: new Date(vanMs + 22 * 3600e3).toISOString(),
  });
}

test('met beide kolommen draait het rapport en meldt het geen gat', async () => {
  const r = await draai(maakStub());
  assert.equal(r.blinde_vlekken.some((b) => /eerst_gepland_op/.test(b.waarom || '')), false);
});

test('zonder eerst_gepland_op valt hij terug EN meldt hij het als blinde vlek', async () => {
  // Stil terugvallen zou een onvolledig dagbeeld als volledig presenteren.
  const r = await draai(maakStub({ ontbreekt: ['eerst_gepland_op'] }));
  const bv = r.blinde_vlekken.find((b) => b.sectie === 'zoomcalls' && /eerst_gepland_op/.test(b.waarom || ''));
  assert.ok(bv, 'er hoort een blinde vlek op sectie 4 te staan');
  assert.match(bv.wat, /verzet/i);
});

test('ontbreekt alleen UITKOMST, dan blijft het dagbeeld gewoon aan', async () => {
  // Dit is de sabotage die nul rood gaf: een terugval op de foutcode 42703
  // in plaats van op de kolomnaam zet het dagbeeld uit voor een kolom die er
  // wél is, en dan verdwijnen de verzette afspraken om een reden die er niets
  // mee te maken heeft.
  const stub = maakStub({ ontbreekt: ['uitkomst'] });
  const r = await draai(stub);
  assert.equal(r.blinde_vlekken.some((b) => /eerst_gepland_op/.test(b.waarom || '')), false,
    'het dagbeeld hoort NIET uitgezet te worden door een ontbrekende uitkomst-kolom');
  // En de uitkomst-terugval moet wél gemeld zijn.
  assert.ok(r.blinde_vlekken.some((b) => /uitkomst/.test(b.waarom || '')));
  // De laatste zoomcall-select hoort eerst_gepland_op nog te noemen.
  const apptSelects = stub.selects.filter((s) => s.tafel === 'follow_up_appointments');
  assert.ok(apptSelects.some((s) => /eerst_gepland_op/.test(s.kolommen)),
    'de kolom is nooit meer geprobeerd, dus het dagbeeld is stil weggevallen');
});

test('het venster zoekt op BEIDE dagen, niet alleen op scheduled_at', async () => {
  // Zonder de tweede voorwaarde komt een afspraak die naar een andere dag is
  // verzet nooit meer boven water, en dan is het hele dagbeeld voor niets.
  // Op het uitgevoerde filter getoetst, niet op de brontekst: die laatste
  // bewaakt hoe het er staat en niet wat het doet.
  const stub = maakStub();
  await draai(stub);
  const appt = stub.filters.filter((f) => f.tafel === 'follow_up_appointments');
  assert.ok(appt.length > 0, 'de afsprakenquery gebruikt geen or-venster meer');
  assert.ok(appt.some((f) => /scheduled_at\.gte/.test(f.or) && /eerst_gepland_op\.gte/.test(f.or)),
    'het venster dekt alleen scheduled_at — verzette afspraken vallen er dan uit:\n  '
    + appt.map((f) => f.or).join('\n  '));
});

test('ontbreken ze allebei, dan draait hij nog steeds en meldt hij beide', async () => {
  const r = await draai(maakStub({ ontbreekt: ['eerst_gepland_op', 'uitkomst'] }));
  assert.ok(r, 'het rapport valt niet om');
  assert.ok(r.blinde_vlekken.some((b) => /eerst_gepland_op/.test(b.waarom || '')));
  assert.ok(r.blinde_vlekken.some((b) => /uitkomst/.test(b.waarom || '')));
});
