// tests/tv-nieuwe-leads.test.js
//
// TV-bord "Nieuwe leads" (2026-10-08): ELKE aanmelding van vandaag telt, ook een
// heraanmelding van een bestaande lead. upsert_lead ontdubbelt op e-mail →
// `aangemaakt` blijft de oude datum. Het aanmeldmoment staat in
// leads.laatste_aanmelding (gezet door /api/lead — funnels + site-formulier — en
// door een trigger op event_attendees). Zonder die kolom (vóór de migratie):
// terugval op funnel_events 'lead_ingediend'.
//   1. zonder optie: oude telling — v2-dashboard ongewijzigd;
//   2. met optie + kolom: aangemaakt OF laatste_aanmelding vandaag, uniek per lead,
//      ook site-formulier en event (geen funnel-event nodig), zelfde filters;
//   3. kolom ontbreekt: terugval op funnel_events; ook dat kapot → oude telling;
//   4. bedrading in display-metrics, website en de SQL-migratie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeLeadsByTraject } from '../api/_lib/leads-per-traject-compute.js';

const START = new Date('2026-10-07T22:00:00Z');   // NL 8 okt 00:00
const EIND = new Date('2026-10-08T22:00:00Z');
const range = { start: START, endExclusive: EIND };

function nepDb({ leads, events = [], kolom = true, eventsFout = false }) {
  return {
    from(tabel) {
      const f = [];
      let kolommen = '';
      const k = {
        select: (c) => { kolommen = String(c || ''); return k; },
        is: (c, v) => { f.push((r) => (r[c] ?? null) === v); return k; },
        not: (c) => { f.push((r) => r[c] != null); return k; },
        eq: (c, v) => { f.push((r) => r[c] === v); return k; },
        in: (c, v) => { f.push((r) => v.includes(r[c])); return k; },
        gte: (c, v) => { f.push((r) => r[c] != null && String(r[c]) >= v); return k; },
        lt: (c, v) => { f.push((r) => r[c] != null && String(r[c]) < v); return k; },
        order: () => k, limit: () => k,
        then(ok, nok) {
          if (tabel === 'leads' && !kolom && kolommen.includes('laatste_aanmelding')) {
            return Promise.resolve({ data: null, error: { code: '42703', message: 'column leads.laatste_aanmelding does not exist' } }).then(ok, nok);
          }
          if (tabel === 'funnel_events' && eventsFout) return Promise.resolve({ data: null, error: { message: 'kapot' } }).then(ok, nok);
          const bron = tabel === 'leads' ? leads : events;
          return Promise.resolve({ data: bron.filter((r) => f.every((fn) => fn(r))), error: null }).then(ok, nok);
        },
      };
      return k;
    },
  };
}

const L = (id, traject, aangemaakt, laatste, extra = {}) => ({
  id, traject, email: id + '@gmail.com', afwijzer: false, verwijderd_op: null, aangemaakt, laatste_aanmelding: laatste, voornaam: id, ...extra,
});
const LEADS = [
  L('nieuw', '7-daagse', '2026-10-08T08:00:00Z', '2026-10-08T08:00:00Z'),                 // nieuw vandaag
  L('funnel-v5', 'minicursus', '2026-08-01T13:44:24Z', '2026-10-08T14:22:02Z'),           // heraanmelding funnel
  L('site', 'student', '2026-06-01T10:00:00Z', '2026-10-08T11:00:00Z'),                   // heraanmelding site-formulier
  L('event', 'event', '2026-05-01T10:00:00Z', '2026-10-08T12:30:00Z', { afwijzer: true }), // heraanmelding event
  L('crm-bewerkt', '7-daagse', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),           // alleen in CRM bewerkt
  L('gisteren', 'minicursus', '2026-09-01T00:00:00Z', '2026-10-07T21:59:59Z'),            // 23:59 NL gisteren
  L('test', 'minicursus', '2026-07-01T00:00:00Z', '2026-10-08T09:00:00Z', { email: 'test@x.nl' }),
  L('weg', 'minicursus', '2026-07-01T00:00:00Z', '2026-10-08T09:00:00Z', { verwijderd_op: '2026-10-08T09:30:00Z' }),
];
const EVENTS = [
  { lead_id: 'funnel-v5', event_type: 'lead_ingediend', ts: '2026-10-08T14:22:02Z' },
  { lead_id: 'nieuw', event_type: 'lead_ingediend', ts: '2026-10-08T08:00:01Z' },
];

test('zonder optie: de oude telling (v2-dashboard verandert niet)', async () => {
  const r = await computeLeadsByTraject({ supabaseAdmin: nepDb({ leads: LEADS, events: EVENTS }), range, skipAllLabels: true });
  assert.equal(r.total_incl_afwijzer, 1);
  assert.deepEqual(r.heraanmeldingen, []);
});

test('met kolom: aangemaakt OF laatste_aanmelding vandaag — ook site-formulier en event, uniek per lead', async () => {
  const r = await computeLeadsByTraject({ supabaseAdmin: nepDb({ leads: LEADS, events: EVENTS }), range, skipAllLabels: true, heraanmeldingen: true });
  assert.equal(r.total_incl_afwijzer, 4, 'nieuw + funnel-v5 + site + event');
  assert.deepEqual({ ...r.by_traject_incl_afwijzer }, { '7-daagse': 1, minicursus: 1, student: 1, event: 1 });
  assert.equal(r.total, 3, 'schone telling: de event-lead is afwijzer');
  assert.deepEqual(r.heraanmeldingen.map((h) => h.id).sort(), ['event', 'funnel-v5', 'site', 'test']);
  assert.equal(r.heraanmeldingen.find((h) => h.id === 'site').ingediend_op, '2026-10-08T11:00:00Z');
  assert.ok(!r.heraanmeldingen.some((h) => h.id === 'nieuw'), 'nieuw telt via aangemaakt, niet dubbel');
  assert.equal(r.excluded.test_email, 1);
});

test('kolom ontbreekt (vóór de migratie): terugval op funnel_events, alleen funnels', async () => {
  const r = await computeLeadsByTraject({ supabaseAdmin: nepDb({ leads: LEADS, events: EVENTS, kolom: false }), range, skipAllLabels: true, heraanmeldingen: true });
  assert.equal(r.total_incl_afwijzer, 2, 'nieuw + funnel-v5');
  assert.deepEqual(r.heraanmeldingen.map((h) => h.id), ['funnel-v5']);
});

test('kolom ontbreekt én funnel_events kapot: oude telling, geen crash', async () => {
  const r = await computeLeadsByTraject({ supabaseAdmin: nepDb({ leads: LEADS, events: EVENTS, kolom: false, eventsFout: true }), range, skipAllLabels: true, heraanmeldingen: true });
  assert.equal(r.total_incl_afwijzer, 1);
});

test('bedrading: display-metrics zet de optie aan (NL-dag, feed); v2-endpoint niet', () => {
  const src = readFileSync(new URL('../api/display-metrics.js', import.meta.url), 'utf8');
  assert.match(src, /computeLeadsByTraject\(\{ supabaseAdmin, range: \{ start: dayStart, endExclusive: dayEnd \}, skipAllLabels: true, heraanmeldingen: true \}\)/);
  assert.match(src, /const dayStart = nlDayStart\(\);/);
  assert.match(src, /for \(const l of \(leadsCompute\.heraanmeldingen \|\| \[\]\)\)/);
  assert.match(src, /\(opnieuw aangemeld\)/);
  const v2 = readFileSync(new URL('../api/leads-per-traject-count.js', import.meta.url), 'utf8');
  assert.doesNotMatch(v2, /heraanmeldingen/);
});

test('SQL-migratie: kolom zonder default, backfill = aangemaakt, pas dan default; event-trigger; upsert_lead ongemoeid', () => {
  const sql = readFileSync(new URL('../docs/sql-migrations/2026-10-08-leads-laatste-aanmelding.sql', import.meta.url), 'utf8');
  const actief = sql.split('\n').filter((r) => !r.trim().startsWith('--')).join('\n');
  const add = actief.indexOf('ADD COLUMN IF NOT EXISTS laatste_aanmelding timestamptz;');
  const backfill = actief.indexOf('SET laatste_aanmelding = aangemaakt WHERE laatste_aanmelding IS NULL');
  const def = actief.indexOf('ALTER COLUMN laatste_aanmelding SET DEFAULT now()');
  assert.ok(add > 0 && backfill > add && def > backfill, 'volgorde: kolom → backfill → default');
  assert.match(actief, /AFTER INSERT ON public\.event_attendees/);
  assert.match(actief, /UPDATE public\.leads SET laatste_aanmelding = now\(\)/);
  assert.doesNotMatch(actief, /FUNCTION public\.upsert_lead/i, 'upsert_lead blijft ongewijzigd');
  assert.doesNotMatch(actief, /spiegel_attendee_naar_lead/, 'bestaande spiegel-trigger blijft ongewijzigd');
});
