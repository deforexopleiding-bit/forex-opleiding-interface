// tests/opvolging-agenda-meta.test.js
//
// PR 6 — 'Agenda doorsturen' via een goedgekeurde Meta-template.
//   · niet goedgekeurd → brugpad (met melding)
//   · goedgekeurd → sendTemplate met de juiste lijn, naam, body {{1}} en geen
//     knop-parameter (statische URL-knop)
//   · failed-status → kaart terug open met melding
//   · antwoord in → contact op de kaart (idempotent)
//   · telPogingen telt één WhatsApp

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  kiesPad, templateGoedgekeurd, kiesTaakVoorNummer, vensterVan, failedPatch,
  opvolgingMetaInbound, opvolgingMetaFailed, metaBerichtAlsRegel, TEMPLATE_NAMEN,
} from '../api/_lib/opvolging-meta.js';
import { telPogingen } from '../api/_lib/opvolging-poging-telling.js';
import { waMislukt } from '../api/_lib/opvolging-leads-pot.js';
import { leesInstelling, valideerInstelling } from '../api/_lib/opvolging-agenda-doorsturen.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const LINK = 'https://deforexopleiding.nl/agenda/planning';
const OK_TEMPLATE = { name: 'agenda_doorsturen_v1', language: 'nl', status: 'APPROVED', body_text: 'Hey {{1}}', buttons: [{ type: 'URL', text: 'Kies een moment', url: LINK }], meta_param_mapping: null };

// ═══════════════════════════════════════════════════════════════════════════
// PUUR
// ═══════════════════════════════════════════════════════════════════════════

test('pad: alleen een APPROVED template op een lijn gaat via Meta', () => {
  assert.deepEqual(kiesPad({ kanaal: 'meta', template: OK_TEMPLATE, phoneNumberId: '123456' }), { pad: 'meta' });
  const wacht = kiesPad({ kanaal: 'meta', template: { ...OK_TEMPLATE, status: 'SUBMITTED' }, phoneNumberId: '123456' });
  assert.equal(wacht.pad, 'brug');
  assert.equal(wacht.reden, 'template_wacht');
  assert.match(wacht.melding, /wacht op goedkeuring door Meta/);
  assert.equal(kiesPad({ kanaal: 'meta', template: null, phoneNumberId: '123456' }).reden, 'template_wacht');
  assert.equal(kiesPad({ kanaal: 'meta', template: OK_TEMPLATE, phoneNumberId: null }).reden, 'geen_lijn');
  assert.equal(kiesPad({ kanaal: 'brug', template: OK_TEMPLATE, phoneNumberId: '1' }).reden, 'kanaal_brug');
  assert.equal(templateGoedgekeurd({ status: 'approved' }), true);
});

test('instelling: standaard kanaal meta op de afspraaklijn; valideert kanaal en lijn', () => {
  const i = leesInstelling({ agenda_link: LINK });
  assert.equal(i.kanaal, 'meta');
  assert.equal(i.module, 'leadsonderhoud');
  assert.equal(leesInstelling({ kanaal: 'brug' }).kanaal, 'brug');
  assert.match(valideerInstelling({ agenda_link: LINK, bericht: '{link}', herinnering: '{link}', kanaal: 'sms' }), /Kanaal/);
  assert.equal(valideerInstelling({ agenda_link: LINK, bericht: '{link}', herinnering: '{link}', kanaal: 'meta', module: 'leadsonderhoud' }), null);
  assert.deepEqual(TEMPLATE_NAMEN, { eerste: 'agenda_doorsturen_v1', herinnering: 'agenda_herinnering_v1' });
});

test('kaart bij een nummer: exact, anders een unieke staart van 9 cijfers', () => {
  const k = [{ id: 'a', telefoon: '+32470111222' }, { id: 'b', telefoon: '0612345678' }];
  assert.equal(kiesTaakVoorNummer(k, '+32470111222').id, 'a');
  assert.equal(kiesTaakVoorNummer(k, '+31612345678').id, 'b');
  assert.equal(kiesTaakVoorNummer([...k, { id: 'c', telefoon: '+44612345678' }], '+31612345678'), null);
});

test('24u-venster: open zolang het laatste inkomende bericht < 24 uur oud is', () => {
  const nu = Date.parse('2026-10-02T12:00:00Z');
  assert.equal(vensterVan([{ direction: 'in', created_at: '2026-10-01T13:00:00Z' }], nu).open, true);
  assert.equal(vensterVan([{ direction: 'in', created_at: '2026-10-01T11:00:00Z' }], nu).open, false);
  assert.equal(vensterVan([{ direction: 'out', created_at: '2026-10-02T11:00:00Z' }], nu).open, false);
});

test('failed: kaart op wacht gaat terug open met melding; een open kaart krijgt alleen de melding', () => {
  const p = failedPatch({ taak: { status: 'wacht_inplanning', notitie: 'oud' }, reden: '[131026] Message undeliverable', vandaag: '2026-10-02' });
  assert.equal(p.status, 'open');
  assert.equal(p.due, '2026-10-02');
  assert.equal(p.agenda_doorgestuurd_at, null);
  assert.match(p.notitie, /^2026-10-02 · ⚠ WhatsApp niet afgeleverd: \[131026\] Message undeliverable — terug in de lijst\.\n\noud$/);
  const q = failedPatch({ taak: { status: 'open' }, reden: 'x', vandaag: '2026-10-02' });
  assert.equal(q.status, undefined);
  assert.match(q.notitie, /niet afgeleverd/);
});

test('telPogingen: agenda_doorgestuurd + de Meta-whatsapp-poging = één WhatsApp', () => {
  const t = '2026-10-02T09:00:00Z';
  const tel = telPogingen([
    { soort: 'agenda_doorgestuurd', resultaat: 'agenda doorgestuurd via Meta-template', richting: 'uit', tijdstip: t },
    { soort: 'whatsapp', resultaat: 'WhatsApp verstuurd (template agenda_doorsturen_v1)', richting: 'uit', tijdstip: t, call_log_id: 'meta:wamid.X' },
    { soort: 'whatsapp', resultaat: 'antwoord ontvangen (Meta): ja', richting: 'in', tijdstip: t },
  ], '2026-10-02', (x) => String(x).slice(0, 10));
  assert.equal(tel.wa_totaal, 1);
  assert.equal(tel.inkomend, 1);
});

test('leadrij: de laatste uitgaande WhatsApp niet afgeleverd → melding; daarna opnieuw verstuurd → weg', () => {
  const mislukt = { soort: 'whatsapp', richting: 'uit', resultaat: 'WhatsApp niet afgeleverd: [131026] x' };
  assert.match(waMislukt([mislukt]), /niet afgeleverd/);
  assert.equal(waMislukt([mislukt, { soort: 'whatsapp', richting: 'uit', resultaat: 'WhatsApp verstuurd' }]), null);
});

test('gespreksregel uit Meta: richting, tekst en status', () => {
  const r = metaBerichtAlsRegel({ id: 'm1', direction: 'out', body: null, template_name: 'agenda_doorsturen_v1', status: 'failed', failed_reason: 'x', created_at: 't' });
  assert.equal(r.richting, 'uit');
  assert.equal(r.bron, 'meta');
  assert.match(r.tekst, /agenda_doorsturen_v1/);
  assert.equal(r.status, 'failed');
});

// ═══════════════════════════════════════════════════════════════════════════
// NEP-DATABANK
// ═══════════════════════════════════════════════════════════════════════════

function nepDb(t) {
  const from = (tabel) => {
    const f = []; let modus = 'select', payload = null;
    const k = {
      select: () => k, order: () => k, limit: () => k, gte: () => k,
      eq: (c, v) => { f.push((r) => String(r[c]) === String(v)); return k; },
      in: (c, v) => { f.push((r) => v.map(String).includes(String(r[c]))); return k; },
      not: (c, _op, v) => { f.push((r) => (r[c] ?? null) !== v); return k; },
      update: (p) => { modus = 'update'; payload = p; return k; },
      insert: (p) => { modus = 'insert'; payload = p; return k; },
      maybeSingle: async () => run(true), single: async () => run(true),
      then: (a, b) => run(false).then(a, b),
    };
    async function run(een) {
      const rows = (t[tabel] || []).filter((r) => f.every((x) => x(r)));
      if (modus === 'insert') {
        const lijst = Array.isArray(payload) ? payload : [payload];
        (t[tabel] = t[tabel] || []).push(...lijst.map((x, i) => ({ id: tabel + '-' + ((t[tabel] || []).length + i + 1), ...x })));
        return { data: een ? lijst[0] : lijst, error: null };
      }
      if (modus === 'update') { rows.forEach((r) => Object.assign(r, payload)); return { data: een ? rows[0] || null : rows, error: null }; }
      return { data: een ? rows[0] || null : rows, error: null };
    }
    return k;
  };
  return { from, t };
}

test('antwoord in → contact op de lopende kaart, idempotent op wamid', async () => {
  const db = nepDb({ opvolging_taken: [{ id: 'k1', telefoon: '+32470111222', status: 'wacht_inplanning' }], opvolging_pogingen: [] });
  const r1 = await opvolgingMetaInbound(db, { telefoon: '+32470111222', wamid: 'wamid.A', tekst: 'Ja, gepland!', mediaType: 'text', tijdstipIso: '2026-10-02T10:00:00Z' });
  const r2 = await opvolgingMetaInbound(db, { telefoon: '+32470111222', wamid: 'wamid.A', tekst: 'Ja, gepland!' });
  assert.equal(r1.gekoppeld, true);
  assert.equal(r2.hergebruikt, true);
  assert.equal(db.t.opvolging_pogingen.length, 1);
  const p = db.t.opvolging_pogingen[0];
  assert.deepEqual([p.taak_id, p.soort, p.richting, p.call_log_id], ['k1', 'whatsapp', 'in', 'meta:wamid.A']);
  assert.match(p.resultaat, /Ja, gepland!/);
  const geen = await opvolgingMetaInbound(db, { telefoon: '+32499999999', wamid: 'wamid.B' });
  assert.equal(geen.gekoppeld, false);
});

test('failed-status → kaart terug open met melding, poging herschreven', async () => {
  const db = nepDb({
    opvolging_taken: [{ id: 'k1', status: 'wacht_inplanning', notitie: '', agenda_doorgestuurd_at: '2026-10-02T09:00:00Z' }],
    opvolging_pogingen: [{ id: 'p1', taak_id: 'k1', soort: 'whatsapp', richting: 'uit', call_log_id: 'meta:wamid.X', resultaat: 'WhatsApp verstuurd' }],
  });
  const r = await opvolgingMetaFailed(db, { wamid: 'wamid.X', reden: '[131026] Message undeliverable', vandaag: '2026-10-02' });
  assert.equal(r.terug_open, true);
  const k = db.t.opvolging_taken[0];
  assert.equal(k.status, 'open');
  assert.match(k.notitie, /WhatsApp niet afgeleverd: \[131026\]/);
  assert.match(db.t.opvolging_pogingen[0].resultaat, /^WhatsApp niet afgeleverd/);
  // Een onbekende wamid raakt niets.
  assert.equal((await opvolgingMetaFailed(db, { wamid: 'wamid.ONBEKEND', reden: 'x', vandaag: '2026-10-02' })).gevonden, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ENDPOINT
// ═══════════════════════════════════════════════════════════════════════════

async function laad(db, { template, brug, meta }) {
  mock.module(url('api/supabase.js'), { namedExports: {
    supabaseAdmin: db, supabase: db,
    createUserClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }),
  } });
  mock.module(url('api/_lib/requirePermission.js'), { namedExports: { requirePermission: async () => true } });
  mock.module(url('api/_lib/opvolging-brug-ververs.js'), { namedExports: { brugLeadlijstVerversen: async () => ({ ok: false }) } });
  mock.module(url('api/_lib/whatsapp-brug-client.js'), { namedExports: { brugFetch: brug } });
  mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async (_db, a) => { meta.log.push(a); return { ok: true }; } } });
  class MetaNotConfiguredError extends Error {}
  mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: {
    sendTemplate: async (a) => { meta.sends.push(a); return { wamid: 'wamid.T1' }; },
    MetaNotConfiguredError,
  } });
  const echt = await import('../api/_lib/opvolging-meta.js');
  mock.module(url('api/_lib/opvolging-meta.js'), { namedExports: {
    ...echt,
    resolveAgendaLijn: async () => '1098765432',
    leesTemplate: async () => template,
  } });
  return (await import(url('api/opvolging-agenda-doorsturen.js') + '?t=' + Math.random())).default;
}
const res = () => { const u = {}; return { setHeader() {}, status(c) { u.code = c; return this; }, json(b) { u.body = b; return this; }, u }; };
const basisDb = () => nepDb({
  app_settings: [{ key: 'opvolging_agenda_doorsturen', value: { agenda_link: LINK } }],
  opvolging_taken: [{ id: 'k1', status: 'open', naam: 'Sara Janssens', telefoon: '+32471123456', created_at: new Date(Date.now() - 3600000).toISOString() }],
  opvolging_pogingen: [],
});

test('endpoint: goedgekeurd → sendTemplate op de afspraaklijn met body {{1}} = voornaam, geen knop-parameter', async (t) => {
  t.after(() => mock.reset());
  const meta = { sends: [], log: [] };
  let brug = 0;
  const db = basisDb();
  const h = await laad(db, { template: OK_TEMPLATE, brug: async () => { brug += 1; return {}; }, meta });
  const r = res();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1' } }, r);
  assert.equal(r.u.code, 200);
  assert.equal(r.u.body.kanaal, 'meta');
  assert.equal(brug, 0, 'de brug verstuurt niets');
  assert.equal(meta.sends.length, 1);
  const s = meta.sends[0];
  assert.equal(s.templateName, 'agenda_doorsturen_v1');
  assert.equal(s.phoneNumberId, '1098765432');
  assert.equal(s.to, '+32471123456');
  assert.deepEqual(s.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Sara' }] }]);
  // gelogd in de gesprekken, kaart op wacht, één whatsapp-poging met de wamid
  assert.equal(meta.log[0].wamid, 'wamid.T1');
  assert.equal(meta.log[0].templateName, 'agenda_doorsturen_v1');
  assert.equal(db.t.opvolging_taken[0].status, 'wacht_inplanning');
  const soorten = db.t.opvolging_pogingen.map((p) => p.soort).sort();
  assert.deepEqual(soorten, ['agenda_doorgestuurd', 'whatsapp']);
  assert.equal(db.t.opvolging_pogingen.find((p) => p.soort === 'whatsapp').call_log_id, 'meta:wamid.T1');
});

test('endpoint: template niet goedgekeurd → brugpad met melding, Meta niet aangeroepen', async (t) => {
  t.after(() => mock.reset());
  const meta = { sends: [], log: [] };
  let brugBody = null;
  const db = basisDb();
  const h = await laad(db, { template: { ...OK_TEMPLATE, status: 'SUBMITTED' }, brug: async (_p, o) => { brugBody = o.body; return {}; }, meta });
  const r = res();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1' } }, r);
  assert.equal(r.u.code, 200);
  assert.equal(r.u.body.kanaal, 'brug');
  assert.match(r.u.body.melding, /wacht op goedkeuring door Meta/);
  assert.equal(meta.sends.length, 0);
  assert.ok(brugBody.tekst.includes(LINK));
  assert.equal(db.t.opvolging_taken[0].status, 'wacht_inplanning');
});

test('endpoint: herinnering gebruikt agenda_herinnering_v1 en laat de 48u staan', async (t) => {
  t.after(() => mock.reset());
  const meta = { sends: [], log: [] };
  const db = basisDb();
  db.t.opvolging_taken[0].status = 'wacht_inplanning';
  db.t.opvolging_taken[0].agenda_doorgestuurd_at = '2026-10-01T09:00:00Z';
  const h = await laad(db, { template: { ...OK_TEMPLATE, name: 'agenda_herinnering_v1' }, brug: async () => ({}), meta });
  const r = res();
  await h({ method: 'POST', headers: {}, body: { taak_id: 'k1', soort: 'herinnering' } }, r);
  assert.equal(r.u.code, 200);
  assert.equal(meta.sends[0].templateName, 'agenda_herinnering_v1');
  assert.equal(db.t.opvolging_taken[0].agenda_doorgestuurd_at, '2026-10-01T09:00:00Z');
  assert.ok(db.t.opvolging_pogingen.some((p) => p.soort === 'agenda_herinnering'));
});
