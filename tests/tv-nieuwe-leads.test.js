// tests/tv-nieuwe-leads.test.js
//
// TV-bord "Nieuwe leads" (2026-10-08): een bestaande lead die zich vandaag
// opnieuw via een funnel aanmeldt, telt mee. /api/lead schrijft via upsert_lead
// (ontdubbelt op e-mail) → `aangemaakt` blijft de oude datum; het bewijs van de
// inzending is funnel_events 'lead_ingediend' met lead_id.
//   1. zonder optie: oude telling (alleen aangemaakt in de periode) — v2-dashboard ongewijzigd;
//   2. met `heraanmeldingen: true`: + leads met lead_ingediend in de periode, uniek per lead,
//      zelfde filters (test-mail eruit, verwijderd_op), bron-onafhankelijk;
//   3. fail-soft als funnel_events niet te lezen is;
//   4. display-metrics zet de optie aan en toont de heraanmelding in de feed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeLeadsByTraject } from '../api/_lib/leads-per-traject-compute.js';

const START = new Date('2026-10-07T22:00:00Z');
const EIND = new Date('2026-10-08T22:00:00Z');
const range = { start: START, endExclusive: EIND };

function nepDb({ leads, events, eventsFout = false }) {
  return {
    from(tabel) {
      const f = [];
      const k = {
        select: () => k,
        is: (c, v) => { f.push((r) => (r[c] ?? null) === v); return k; },
        not: (c) => { f.push((r) => r[c] != null); return k; },
        eq: (c, v) => { f.push((r) => r[c] === v); return k; },
        in: (c, v) => { f.push((r) => v.includes(r[c])); return k; },
        gte: (c, v) => { f.push((r) => String(r[c]) >= v); return k; },
        lt: (c, v) => { f.push((r) => String(r[c]) < v); return k; },
        order: () => k, limit: () => k,
        then(ok, nok) {
          if (tabel === 'funnel_events' && eventsFout) return Promise.resolve({ data: null, error: { message: 'kapot' } }).then(ok, nok);
          const bron = tabel === 'leads' ? leads : events;
          return Promise.resolve({ data: bron.filter((r) => f.every((fn) => fn(r))), error: null }).then(ok, nok);
        },
      };
      return k;
    },
  };
}

const LEADS = [
  // nieuw vandaag
  { id: 'nieuw', traject: '7-daagse', email: 'a@gmail.com', afwijzer: false, verwijderd_op: null, aangemaakt: '2026-10-08T08:00:00Z' },
  // bestaand, vandaag opnieuw aangemeld via v5 en v6 (zoals 8 okt)
  { id: 'oud-v5', traject: 'minicursus', email: 'b@gmail.com', afwijzer: false, verwijderd_op: null, aangemaakt: '2026-08-01T13:44:24Z', voornaam: 'B' },
  { id: 'oud-v6', traject: 'minicursus', email: 'c@gmail.com', afwijzer: true, verwijderd_op: null, aangemaakt: '2026-09-29T15:10:56Z', voornaam: 'C' },
  // bestaand, test-mail → eruit
  { id: 'oud-test', traject: 'minicursus', email: 'test@x.nl', afwijzer: false, verwijderd_op: null, aangemaakt: '2026-07-01T00:00:00Z' },
  // bestaand, verwijderd → eruit
  { id: 'oud-weg', traject: 'minicursus', email: 'd@gmail.com', afwijzer: false, verwijderd_op: '2026-10-01T00:00:00Z', aangemaakt: '2026-07-01T00:00:00Z' },
  // bestaand, niet opnieuw aangemeld (alleen in het CRM bewerkt) → telt niet
  { id: 'oud-stil', traject: '7-daagse', email: 'e@gmail.com', afwijzer: false, verwijderd_op: null, aangemaakt: '2026-09-01T00:00:00Z' },
];
const EVENTS = [
  { lead_id: 'oud-v5', event_type: 'lead_ingediend', ts: '2026-10-08T14:22:02Z' },
  { lead_id: 'oud-v5', event_type: 'lead_ingediend', ts: '2026-10-08T15:00:00Z' },   // tweede keer → één lead
  { lead_id: 'oud-v6', event_type: 'lead_ingediend', ts: '2026-10-08T14:44:17Z' },
  { lead_id: 'nieuw', event_type: 'lead_ingediend', ts: '2026-10-08T08:00:01Z' },     // al geteld → niet dubbel
  { lead_id: 'oud-test', event_type: 'lead_ingediend', ts: '2026-10-08T09:00:00Z' },
  { lead_id: 'oud-weg', event_type: 'lead_ingediend', ts: '2026-10-08T09:00:00Z' },
  { lead_id: 'oud-stil', event_type: 'lead_ingediend', ts: '2026-10-07T21:59:59Z' }, // gisteren (NL)
  { lead_id: 'oud-stil', event_type: 'formulier_start', ts: '2026-10-08T10:00:00Z' }, // geen inzending
];

test('zonder optie: de oude telling (v2-dashboard verandert niet)', async () => {
  const r = await computeLeadsByTraject({ supabaseAdmin: nepDb({ leads: LEADS, events: EVENTS }), range, skipAllLabels: true });
  assert.equal(r.total_incl_afwijzer, 1);
  assert.deepEqual(r.heraanmeldingen, []);
});

test('met heraanmeldingen: bestaande leads die vandaag opnieuw indienden tellen mee, uniek en gefilterd', async () => {
  const r = await computeLeadsByTraject({ supabaseAdmin: nepDb({ leads: LEADS, events: EVENTS }), range, skipAllLabels: true, heraanmeldingen: true });
  assert.equal(r.total_incl_afwijzer, 3, 'nieuw + oud-v5 + oud-v6');
  assert.deepEqual({ ...r.by_traject_incl_afwijzer }, { '7-daagse': 1, minicursus: 2 });
  assert.equal(r.total, 2, 'schone telling: oud-v6 is afwijzer');
  assert.deepEqual(r.heraanmeldingen.map((h) => h.id).sort(), ['oud-test', 'oud-v5', 'oud-v6']);
  assert.equal(r.heraanmeldingen.find((h) => h.id === 'oud-v5').ingediend_op, '2026-10-08T14:22:02Z', 'eerste inzending van de dag');
  assert.equal(r.excluded.test_email, 1);
});

test('fail-soft: funnel_events niet leesbaar → oude telling', async () => {
  const r = await computeLeadsByTraject({ supabaseAdmin: nepDb({ leads: LEADS, events: EVENTS, eventsFout: true }), range, skipAllLabels: true, heraanmeldingen: true });
  assert.equal(r.total_incl_afwijzer, 1);
});

test('display-metrics: optie aan, NL-dag, en heraanmelding in de feed', () => {
  const src = readFileSync(new URL('../api/display-metrics.js', import.meta.url), 'utf8');
  assert.match(src, /computeLeadsByTraject\(\{ supabaseAdmin, range: \{ start: dayStart, endExclusive: dayEnd \}, skipAllLabels: true, heraanmeldingen: true \}\)/);
  assert.match(src, /const dayStart = nlDayStart\(\);/);
  assert.match(src, /for \(const l of \(leadsCompute\.heraanmeldingen \|\| \[\]\)\)/);
  assert.match(src, /\(opnieuw aangemeld\)/);
  // De andere aanroeper (v2-dashboard via leads-per-traject-count) zet de optie NIET.
  const v2 = readFileSync(new URL('../api/leads-per-traject-count.js', import.meta.url), 'utf8');
  assert.doesNotMatch(v2, /heraanmeldingen/);
});
