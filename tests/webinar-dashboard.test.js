// tests/webinar-dashboard.test.js
//
// Webinar fase 3 (2026-10-12): het dashboard — per funnel (v1/v2) en totaal
// aanmeldingen → calls → sales → commissie Karl, plus calls via de QR zonder
// aanmelding. Zelfde "geboekt"-definitie als de opvolging.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: null } });
mock.module(url('api/_lib/meta-whatsapp.js'), { namedExports: { sendTemplate: async () => ({}), templateStatusOpLijn: async () => 'APPROVED' } });
mock.module(url('api/_lib/send-email-core.js'), { namedExports: { sendEmailViaSmtp: async () => ({ ok: true }) } });
mock.module(url('api/_lib/wa-outbound-log.js'), { namedExports: { logOutboundWa: async () => ({ ok: true }) } });
const D = await import(url('api/_lib/webinar-dashboard.js'));

const aanm = (id, bron, email, o = {}) => ({ id, bron, email, telefoon: null, lead_id: null, is_test: false, aangemeld_op: '2026-10-15T10:00:00Z', ...o });
const boeking = (o) => ({ id: 'b-' + Math.random(), booking_source: 'webinar', status: 'scheduled', created_at: '2026-10-19T18:00:00Z', scheduled_at: '2026-10-22T08:00:00Z', parent_appointment_id: null, lead_email: null, lead_phone: null, ...o });

test('trechter per funnel: aanmeldingen, personen, calls (na aanmelding, niet geannuleerd), A vs B en totaal', () => {
  const r = D.berekenDashboard({
    aanmeldingen: [
      aanm('a1', 'webinar-v1', 'ann@example.com'),
      aanm('a2', 'webinar-v1', 'bob@example.com', { telefoon: '+31611111111' }),
      aanm('a3', 'webinar-v2', 'cas@example.com'),
      aanm('a4', 'webinar-v2', 'ANN@example.com', { aangemeld_op: '2026-10-22T10:00:00Z' }), // Ann later nóg eens (via B) → telt bij A
      aanm('t1', 'webinar-v2', 'test@example.com', { is_test: true }),
    ],
    afspraken: [
      boeking({ lead_email: 'ann@example.com' }),                                   // Ann (A) belt
      boeking({ lead_phone: '06 1111 1111', status: 'cancelled' }),                // Bob annuleerde → geen call
      boeking({ lead_email: 'cas@example.com', created_at: '2026-10-10T10:00:00Z' }), // Cas boekte vóór aanmelding → telt niet
      boeking({ lead_email: 'onbekend@example.com' }),                              // QR zonder aanmelding
      boeking({ lead_email: 'onbekend@example.com', parent_appointment_id: 'x' }),  // verzet → niet dubbel
      boeking({ lead_email: 'weg@example.com', status: 'verwijderd' }),             // verwijderd → telt niet
    ],
  });
  const v1 = r.funnels.find((f) => f.funnel === 'webinar-v1');
  const v2 = r.funnels.find((f) => f.funnel === 'webinar-v2');
  assert.deepEqual([v1.aanmeldingen, v1.personen, v1.calls], [2, 2, 1]);
  assert.deepEqual([v2.aanmeldingen, v2.personen, v2.calls], [2, 1, 0], 'Ann telt als persoon bij A (eerste aanmelding)');
  assert.deepEqual([r.totaal.aanmeldingen, r.totaal.personen, r.totaal.calls], [4, 3, 1], 'testaanmelding telt niet');
  assert.equal(r.zonder_aanmelding.calls, 1, 'één QR-boeking zonder aanmelding (verzette rij niet dubbel)');
  assert.ok(!r.funnels.some((f) => f.funnel === 'overig'));
});

test('sales + commissie: deals van de setter per funnel (via lead_id of klant-e-mail/telefoon), gearchiveerd/afgewezen niet', () => {
  const r = D.berekenDashboard({
    aanmeldingen: [aanm('a1', 'webinar-v1', 'ann@example.com', { lead_id: 'lead-ann' }), aanm('a2', 'webinar-v2', 'bob@example.com', { telefoon: '+31622222222' })],
    afspraken: [boeking({ lead_email: 'ann@example.com' }), boeking({ lead_phone: '0622222222' }), boeking({ lead_email: 'qr@example.com' })],
    deals: [
      { id: 'd1', source_lead_id: 'lead-ann', customer_id: 'k1' },
      { id: 'd2', source_lead_id: null, customer_id: 'k2' },
      { id: 'd3', source_lead_id: null, customer_id: 'k3' },
      { id: 'd4', source_lead_id: 'lead-ann', customer_id: 'k1', archived_at: '2026-10-25T00:00:00Z' },
      { id: 'd5', source_lead_id: null, customer_id: 'k2', tl_quotation_status: 'declined' },
    ],
    klanten: [{ id: 'k1', email: 'x@x.nl' }, { id: 'k2', email: 'nope@x.nl', phone: '+32 6 2222 2222' }, { id: 'k3', email: 'qr@example.com' }],
    commissie: { d1: { geboekt: 0, te_boeken: 72.6 }, d2: { geboekt: 30, te_boeken: 15 }, d3: { geboekt: 0, te_boeken: 9.99 }, d4: { geboekt: 0, te_boeken: 50 } },
  });
  const v1 = r.funnels.find((f) => f.funnel === 'webinar-v1');
  const v2 = r.funnels.find((f) => f.funnel === 'webinar-v2');
  assert.deepEqual([v1.calls, v1.sales, v1.commissie_te_boeken, v1.commissie], [1, 1, 72.6, 72.6], 'via source_lead_id');
  assert.deepEqual([v2.calls, v2.sales, v2.commissie_geboekt, v2.commissie_te_boeken, v2.commissie], [1, 1, 30, 15, 45], 'via telefoon van de klant');
  assert.deepEqual([r.zonder_aanmelding.calls, r.zonder_aanmelding.sales, r.zonder_aanmelding.commissie], [1, 1, 9.99]);
  assert.deepEqual([r.totaal.sales, r.totaal.commissie], [2, 117.6], 'gearchiveerd en afgewezen tellen niet');
});

test('commissiePerDeal: geboekt via factuur → deal, plus wat de cron zou boeken', () => {
  const plan = {
    facturen: [{ invoice_id: 'i1', deal_id: 'd1' }, { invoice_id: 'i2', deal_id: 'd1' }, { invoice_id: 'i3', deal_id: 'd2' }],
    mutaties: [{ deal_id: 'd1', amount: 10 }, { deal_id: 'd2', amount: 72.6 }],
  };
  assert.deepEqual(D.commissiePerDeal(plan, [{ invoice_id: 'i1', amount: 5 }, { invoice_id: 'i2', amount: 2.5 }, { invoice_id: 'onbekend', amount: 99 }]), {
    d1: { geboekt: 7.5, te_boeken: 10 }, d2: { geboekt: 0, te_boeken: 72.6 },
  });
  assert.deepEqual(D.commissiePerDeal(null, []), {});
});

test('laadDashboard: setter = eigenaar van de webinar-link; zonder setter geen deals; dry-run doorgegeven', async () => {
  const tab = {
    booking_sources: [{ slug: 'webinar', owner_user_id: null }],
    webinar_aanmeldingen: [aanm('a1', 'webinar-v1', 'ann@example.com')],
    follow_up_appointments: [boeking({ lead_email: 'ann@example.com' })],
    opstartsessie_submissions: [], app_settings: [{ key: 'setter_commissie_dry_run', value: { enabled: true } }],
  };
  const vraag = [];
  const sb = { from(t) {
    const f = [];
    const k = { select: () => k, eq: (c, v) => { f.push((r) => r[c] === v); return k; }, not: () => k, in: () => k, limit: () => k,
      maybeSingle: () => k.then((r) => ({ data: r.data[0] || null, error: null })),
      then: (ok) => { vraag.push(t); return Promise.resolve({ data: (tab[t] || []).filter((r) => f.every((fn) => fn(r))), error: null }).then(ok); } };
    return k;
  } };
  const d = await D.laadDashboard(sb);
  assert.equal(d.setter, null);
  assert.equal(d.dry_run, true);
  assert.equal(d.totaal.calls, 1);
  assert.ok(!vraag.includes('deals'), 'zonder setter geen deals-query');
});

test('endpoint + view: ?dashboard=1, kaart met A/B/totaal + QR zonder aanmelding + dry-run-melding (jsdom)', async () => {
  assert.match(lees('api/webinar-admin.js'), /if \(req\.query\?\.dashboard\) return res\.status\(200\)\.json\(await laadDashboard\(supabaseAdmin\)\);/);
  assert.ok(Number(lees('modules/klanten-v2/index.html').match(/views\/webinar-v2\.js\?v=(\d+)"/)[1]) >= 5);
  const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const DASH = {
    funnels: [
      { funnel: 'webinar-v1', aanmeldingen: 10, personen: 9, calls: 3, sales: 1, commissie_geboekt: 0, commissie_te_boeken: 72.6, commissie: 72.6 },
      { funnel: 'webinar-v2', aanmeldingen: 8, personen: 8, calls: 2, sales: 0, commissie_geboekt: 0, commissie_te_boeken: 0, commissie: 0 },
    ],
    totaal: { aanmeldingen: 18, personen: 17, calls: 5, sales: 1, commissie_geboekt: 0, commissie_te_boeken: 72.6, commissie: 72.6 },
    zonder_aanmelding: { aanmeldingen: 0, personen: 0, calls: 2, sales: 0, commissie_geboekt: 0, commissie_te_boeken: 0, commissie: 0 },
    setter: { id: 'k', naam: 'Karl Eireiner' }, dry_run: true,
  };
  w.KV = { toast() {}, authedJson: async (u) => {
    if (u === '/api/webinar-admin') return { reeks: { titel: 'W', zoom_url: 'https://zoom.us/j/1', starttijd: '19:00:00', duur_min: 60, actief: true }, sessies: [] };
    if (u === '/api/webinar-admin?dashboard=1') return DASH;
    if (u === '/api/webinar-admin?qr=1') return { url: 'https://deforexopleiding.nl/agenda/webinar', png: 'data:image/png;base64,AA==', svg: '<svg></svg>' };
    return {};
  } };
  w.DFO = { VIEWS: {}, render: () => { w.document.getElementById('c').innerHTML = w.DFO.VIEWS['webinar/'](); } };
  w.eval(lees('modules/klanten-v2/views/webinar-v2.js'));
  w.DFO.render();
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  const kaart = [...w.document.querySelectorAll('.card')].find((c) => /Resultaten per funnel/.test(c.textContent));
  assert.ok(kaart, 'kaart aanwezig');
  const rijen = [...kaart.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(rijen.map((r) => r[0]), ['Funnel A (webinar-v1)', 'Funnel B (webinar-v2)', 'Totaal', 'Calls via de QR zonder aanmelding']);
  assert.deepEqual(rijen[0].slice(1), ['10 (9 pers.)', '3 33%', '1 33%', '€ 72,60']);
  assert.deepEqual(rijen[2].slice(1), ['18 (17 pers.)', '5 29%', '1 20%', '€ 72,60']);
  assert.equal(rijen[3][2], '2');
  assert.match(kaart.textContent, /Commissie Karl Eireiner/);
  assert.match(kaart.textContent, /dry-run/);
  assert.doesNotMatch(kaart.textContent, /opkomst \d|show-rate \d/i);
  const titels = [...w.document.querySelectorAll('.card-title')].map((t) => t.textContent);
  assert.deepEqual(titels, ['Webinar-instellingen', 'Resultaten per funnel', 'QR-code: gratis strategie-scan', 'Weken'].filter((t) => titels.includes(t)));
});
