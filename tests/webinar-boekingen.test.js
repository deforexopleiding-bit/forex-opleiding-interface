// tests/webinar-boekingen.test.js
//
// MODULE WEBINAR › WEKEN › INGEPLAND (2026-11-02, Maxim).
//   - koppeling per dag van BOEKEN in Europe/Brussels (rond middernacht, zomer-
//     en wintertijd), niet de dag van de call;
//   - dag zonder webinar → het laatste webinar ervoor; vóór het eerste → apart;
//   - som van alle rijen + vóór het eerste = alle webinar-boekingen;
//   - verzet = één boeking (nieuwe call, status verplaatst); geannuleerd blijft;
//   - sale/offerte via lead (submissie) of e-mail van de klant, enkel na de boeking;
//   - API: zelfde recht als de rest van de module (events.event.view);
//   - UI: kolom Ingepland, rij klikt een lijst open.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');

mock.module(url('api/supabase.js'), { namedExports: { supabaseAdmin: null, createUserClient: () => null } });
const B = await import(url('api/_lib/webinar-boekingen.js'));

// De echte reeks (maandagen, 12 okt overgeslagen) — zomertijd tot 25 okt.
const SESSIES = [
  { id: 's1012', datum: '2026-10-12', status: 'overgeslagen', starts_at: '2026-10-12T17:00:00Z' },
  { id: 's1019', datum: '2026-10-19', status: 'gepland', starts_at: '2026-10-19T17:00:00Z' },
  { id: 's1026', datum: '2026-10-26', status: 'gepland', starts_at: '2026-10-26T18:00:00Z' },
  { id: 's1102', datum: '2026-11-02', status: 'gepland', starts_at: '2026-11-02T18:00:00Z' },
  { id: 's1109', datum: '2026-11-09', status: 'gepland', starts_at: '2026-11-09T18:00:00Z' },
];
const afspraak = (id, created_at, extra = {}) => ({ id, created_at, booking_source: 'webinar', status: 'scheduled', scheduled_at: '2026-11-20T16:30:00Z', lead_name: 'X ' + id, lead_email: id + '@example.com', lead_phone: null, parent_appointment_id: null, is_test: false, uitkomst: null, ...extra });
const sessieVan = (created) => { const d = B.brusselsDag(created); const s = B.sessieVoorDag(d, SESSIES); return s ? s.id : null; };

test('MIDDERNACHT BRUSSEL (wintertijd, UTC+1): 00:30 en 23:59 horen bij die dag, 00:00 bij de volgende', () => {
  assert.equal(B.brusselsDag('2026-11-01T23:30:00Z'), '2026-11-02'); // ma 2 nov 00:30
  assert.equal(B.brusselsDag('2026-11-02T22:59:59Z'), '2026-11-02'); // ma 2 nov 23:59:59
  assert.equal(B.brusselsDag('2026-11-02T23:00:00Z'), '2026-11-03'); // di 3 nov 00:00
  assert.equal(sessieVan('2026-11-01T23:30:00Z'), 's1102', 'maandag 00:30, vóór de start van het webinar → toch die maandag');
  assert.equal(sessieVan('2026-11-01T22:59:00Z'), 's1026', 'zondag 23:59 → het webinar van de maandag ervoor');
  assert.equal(sessieVan('2026-11-02T23:00:00Z'), 's1102', 'dinsdag 00:00 (geen webinar) → laatste webinar ervoor');
});

test('MIDDERNACHT BRUSSEL (zomertijd, UTC+2) en de wissel van 25 okt', () => {
  assert.equal(B.brusselsDag('2026-10-18T22:30:00Z'), '2026-10-19'); // ma 19 okt 00:30 CEST
  assert.equal(B.brusselsDag('2026-10-18T21:59:00Z'), '2026-10-18'); // zo 18 okt 23:59 CEST
  assert.equal(sessieVan('2026-10-18T22:30:00Z'), 's1019');
  assert.equal(sessieVan('2026-10-18T21:59:00Z'), 's1012', 'zondag → de (overgeslagen) maandag ervoor: die week bestaat');
  assert.equal(B.brusselsDag('2026-10-25T22:30:00Z'), '2026-10-25'); // zo 25 okt 23:30 CET (na de wissel)
  assert.equal(B.brusselsDag('2026-10-25T23:00:00Z'), '2026-10-26'); // ma 26 okt 00:00 CET
});

test('GEEN WEBINAR die dag → laatste webinar ervoor; vóór het eerste → apart; de call-datum telt niet', () => {
  const v = B.verdeelBoekingen({
    sessies: SESSIES,
    afspraken: [
      afspraak('dinsdag', '2026-10-27T09:20:00Z', { scheduled_at: '2026-11-05T18:30:00Z', status: 'cancelled' }),
      afspraak('vroeg', '2026-10-01T10:00:00Z'),
      afspraak('maxim', '2026-11-02T16:01:04Z', { scheduled_at: '2026-11-20T16:30:00Z', is_test: true }),
    ],
  });
  assert.deepEqual(v.perSessie.s1026.map((b) => b.id), ['dinsdag']);
  assert.equal(v.perSessie.s1026[0].status, 'geannuleerd', 'geannuleerd blijft zichtbaar');
  assert.deepEqual(v.voorEerste.map((b) => b.id), ['vroeg']);
  assert.deepEqual(v.perSessie.s1102.map((b) => b.id), ['maxim'], 'call op 20 nov, geboekt op 2 nov → 2 nov');
  assert.equal(v.perSessie.s1102[0].is_test, true, 'testboeking telt mee, met label');
  assert.deepEqual(v.perSessie.s1109, []);
  const som = B.samenvatting(v, SESSIES.map((s) => s.id));
  assert.deepEqual(som, { totaal: 3, in_tabel: 2, andere_weken: 0, voor_eerste: 1 });
  assert.equal(som.in_tabel + som.andere_weken + som.voor_eerste, som.totaal);
  // Getoonde weken = enkel de laatste twee → de rest telt als "andere weken", niets verdwijnt.
  const deel = B.samenvatting(v, ['s1102', 's1109']);
  assert.deepEqual(deel, { totaal: 3, in_tabel: 1, andere_weken: 1, voor_eerste: 1 });
});

test('VERZET = één boeking: geboekt op = de oorspronkelijke, call + status van de laatste; andere bronnen tellen niet', () => {
  const v = B.verdeelBoekingen({
    sessies: SESSIES,
    afspraken: [
      afspraak('root', '2026-10-19T18:13:45Z', { status: 'verplaatst', scheduled_at: '2026-10-21T09:00:00Z' }),
      afspraak('kind', '2026-10-21T10:35:10Z', { parent_appointment_id: 'root', scheduled_at: '2026-11-12T10:00:00Z' }),
      afspraak('root2', '2026-10-19T18:10:23Z', { status: 'verplaatst' }),
      afspraak('kind2', '2026-10-22T11:29:37Z', { parent_appointment_id: 'root2', status: 'completed', scheduled_at: '2026-10-27T17:00:00Z' }),
      afspraak('ander', '2026-10-19T18:00:00Z', { booking_source: 'dave' }),
    ],
  });
  assert.equal(v.totaal, 2);
  const [a, b] = [...v.perSessie.s1019].sort((x, y) => x.id.localeCompare(y.id));
  assert.equal(a.id, 'root'); assert.equal(a.afspraak_id, 'kind'); assert.equal(a.call_op, '2026-11-12T10:00:00Z');
  assert.equal(a.status, 'verplaatst'); assert.equal(a.eerst_gepland_op, '2026-10-21T09:00:00Z');
  assert.equal(b.id, 'root2'); assert.equal(b.status, 'gehad');
  assert.deepEqual(v.perSessie.s1026, [], 'de verzetting (22 okt) maakt geen tweede boeking');
});

test('STATUSSEN', () => {
  const k = (status, n = 1) => ({ root: {}, laatste: { status }, ids: Array(n).fill('x') });
  assert.equal(B.boekingStatus(k('scheduled')), 'gepland');
  assert.equal(B.boekingStatus(k('scheduled', 2)), 'verplaatst');
  assert.equal(B.boekingStatus(k('wacht_op_reschedule')), 'verplaatst');
  assert.equal(B.boekingStatus(k('cancelled')), 'geannuleerd');
  assert.equal(B.boekingStatus(k('no_show')), 'no-show');
  assert.equal(B.boekingStatus(k('completed')), 'gehad');
});

test('SALE / OFFERTE: via de lead of het e-mailadres, alleen na de boeking, Sale vóór offerte, gearchiveerd niet', () => {
  const afs = [afspraak('a1', '2026-10-19T18:10:10Z', { lead_email: 'Eve@Example.com', status: 'completed', uitkomst: 'sale' }),
    afspraak('a2', '2026-10-19T18:11:00Z', { lead_email: 'leeg@example.com', status: 'completed', uitkomst: 'sale' }),
    afspraak('a3', '2026-10-19T18:12:00Z', { lead_email: 'oud@example.com' })];
  const v = B.verdeelBoekingen({
    sessies: SESSIES, afspraken: afs,
    submissions: [{ appointment_id: 'a1', lead_id: 'L1' }],
    klanten: [{ id: 'K1', email: 'eve@example.com' }, { id: 'K3', email: 'oud@example.com' }],
    deals: [
      { id: 'd-open', customer_id: 'K1', tl_quotation_status: 'sent', created_at: '2026-10-20T10:00:00Z' },
      { id: 'd-sale', source_lead_id: 'L1', tl_quotation_status: 'accepted', quote_reference: 'OFF-12', created_at: '2026-10-20T09:00:00Z' },
      { id: 'd-arch', source_lead_id: 'L1', tl_quotation_status: 'accepted', archived_at: '2026-10-21T00:00:00Z', created_at: '2026-10-21T09:00:00Z' },
      { id: 'd-oud', customer_id: 'K3', tl_quotation_status: 'accepted', created_at: '2026-09-01T00:00:00Z' },
    ],
  });
  const r = Object.fromEntries(v.perSessie.s1019.map((b) => [b.id, b]));
  assert.deepEqual(r.a1.deal, { id: 'd-sale', label: 'Sale', referentie: 'OFF-12' });
  assert.equal(r.a2.deal, null); assert.equal(r.a2.sale_uitkomst, true, 'enkel de uitkomst van de call');
  assert.equal(r.a3.deal, null, 'deal van vóór de boeking hoort er niet bij');
});

test('ECHTE DATA (2 nov 2026, geanonimiseerd): 10 afspraken = 8 boekingen; Maxims testboeking (bron webinar) onder 2 nov', () => {
  const rij = (id, created_at, status, extra = {}) => afspraak(id, created_at, { status, ...extra });
  const afs = [
    rij('11492bc8', '2026-10-19T18:10:10Z', 'completed', { uitkomst: 'sale' }),
    rij('92bf1b75', '2026-10-19T18:10:23Z', 'verplaatst'),
    rij('d08ec38e', '2026-10-19T18:10:35Z', 'scheduled'),
    rij('fd9ea313', '2026-10-19T18:12:59Z', 'completed'),
    rij('372d9a7f', '2026-10-19T18:13:45Z', 'verplaatst'),
    rij('e95dc284', '2026-10-19T18:14:44Z', 'no_show'),
    rij('6cc493f7', '2026-10-21T10:35:10Z', 'scheduled', { parent_appointment_id: '372d9a7f' }),
    rij('4735f3bb', '2026-10-22T11:29:37Z', 'completed', { parent_appointment_id: '92bf1b75' }),
    rij('ae6a6dd0', '2026-10-27T09:20:06Z', 'cancelled'),
    rij('25fa3f30', '2026-11-02T16:01:04Z', 'scheduled', { lead_email: 'maxim.delombaerde96@gmail.com', scheduled_at: '2026-11-20T16:30:00Z' }),
  ];
  const v = B.verdeelBoekingen({ sessies: SESSIES, afspraken: afs });
  assert.equal(v.totaal, 8);
  assert.equal(v.perSessie.s1019.length, 6);
  assert.deepEqual(v.perSessie.s1026.map((b) => [b.id, b.status]), [['ae6a6dd0', 'geannuleerd']], 'dinsdag 27 okt → webinar 26 okt');
  assert.deepEqual(v.perSessie.s1102.map((b) => [b.email, b.geboekt_dag]), [['maxim.delombaerde96@gmail.com', '2026-11-02']]);
  const som = B.samenvatting(v, SESSIES.map((s) => s.id));
  assert.equal(som.in_tabel + som.andere_weken + som.voor_eerste, 8);
});

test('API: ?boekingen achter hetzelfde recht als de module (events.event.view); gewone GET geeft ingepland + samenvatting', () => {
  const src = lees('api/webinar-admin.js');
  const iView = src.indexOf("requirePermission(req, 'events.event.view')");
  const iBoek = src.indexOf('const boekSleutel = req.query?.boekingen;');
  assert.ok(iView > 0 && iBoek > iView, 'boekingen pas na de rechtencheck');
  assert.match(src, /if \(k !== VOOR_EERSTE && !UUID_RE\.test\(k\)\) return res\.status\(400\)/);
  assert.match(src, /ingepland: verdeling \? \(verdeling\.perSessie\[s\.id\] \|\| \[\]\)\.length : null/);
  assert.match(src, /boekingen: verdeling \? samenvatting\(verdeling, \(sessies \|\| \[\]\)\.map\(\(s\) => s\.id\)\) : null/);
  // Alleen lezen: geen insert/update/delete in de rekenkern.
  assert.doesNotMatch(lees('api/_lib/webinar-boekingen.js'), /\.(insert|update|upsert|delete)\(/);
});

test('UI: kolom Ingepland, klik op de rij klapt de lijst open (naam, e-mail, tel, geboekt, call, status, sale), samenvatting', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="c"></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const opgevraagd = [];
  w.KV = { toast() {}, authedJson: async (u) => {
    opgevraagd.push(u);
    if (u === '/api/webinar-admin') return {
      reeks: { titel: 'W', zoom_url: 'https://zoom.us/j/1', starttijd: '19:00:00', duur_min: 60, actief: true },
      sessies: [{ id: '19552dfc-2da3-4049-bc60-9af2ec3ba035', datum: '2026-11-02', status: 'gepland', starts_at: '2026-11-02T18:00:00Z', aantal: 4, ingepland: 1 }],
      boekingen: { totaal: 9, in_tabel: 1, andere_weken: 7, voor_eerste: 1 },
    };
    if (u === '/api/webinar-admin?boekingen=19552dfc-2da3-4049-bc60-9af2ec3ba035') return { boekingen: [{
      id: 'b1', naam: 'Maxim Del', email: 'maxim.delombaerde96@gmail.com', telefoon: '+32470000000', geboekt_op: '2026-11-02T16:01:04Z',
      call_op: '2026-11-20T16:30:00Z', status: 'gepland', is_test: false, deal: { id: 'd1', label: 'Sale', referentie: 'OFF-1' },
    }] };
    if (u === '/api/webinar-admin?dashboard=1') return { funnels: [], totaal: { aanmeldingen: 0, personen: 0, calls: 0, sales: 0, commissie_geboekt: 0, commissie_te_boeken: 0, commissie: 0 }, zonder_aanmelding: { calls: 0, sales: 0, commissie: 0 } };
    return {};
  } };
  w.DFO = { VIEWS: {}, render: () => { w.document.getElementById('c').innerHTML = w.DFO.VIEWS['webinar/'](); } };
  w.eval(lees('modules/klanten-v2/views/webinar-v2.js'));
  w.DFO.render();
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  const weken = [...w.document.querySelectorAll('.card')].find((c) => /Weken/.test(c.querySelector('.card-title')?.textContent || ''));
  const kop = [...weken.querySelectorAll('thead th')].map((th) => th.textContent);
  assert.deepEqual(kop, ['Datum', 'Tijd', 'Status', 'Aanmeldingen', 'Ingepland', 'Zoom', 'Acties']);
  const rij = weken.querySelector('tbody tr');
  assert.equal(rij.querySelectorAll('td')[4].textContent.trim(), '1');
  assert.match(weken.textContent, /9 boekingen via de QR in totaal · 1 in deze weken · 7 in eerdere weken \(niet in deze lijst\) · 1 vóór het eerste webinar/);
  // Klik op de rij (niet op een knop).
  w.__wbBoek('19552dfc-2da3-4049-bc60-9af2ec3ba035', { target: rij.querySelector('td') });
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(opgevraagd.includes('/api/webinar-admin?boekingen=19552dfc-2da3-4049-bc60-9af2ec3ba035'));
  const lijst = [...w.document.querySelectorAll('table')].find((t) => t.querySelector('thead th')?.textContent === 'Naam');
  assert.ok(lijst, 'lijst open');
  assert.deepEqual([...lijst.querySelectorAll('thead th')].map((th) => th.textContent), ['Naam', 'E-mail', 'Telefoon', 'Geboekt op', 'Call', 'Status', 'Sale / offerte']);
  const cel = [...lijst.querySelectorAll('tbody td')].map((td) => td.textContent.trim());
  assert.equal(cel[0], 'Maxim Del'); assert.equal(cel[1], 'maxim.delombaerde96@gmail.com');
  assert.match(cel[3], /2 nov/); assert.match(cel[4], /20 nov/); assert.equal(cel[5], 'gepland'); assert.equal(cel[6], 'Sale OFF-1');
  // Klik op een knop in de rij klapt NIET open/dicht.
  const knop = w.document.createElement('button'); rij.appendChild(knop);
  w.__wbBoek('19552dfc-2da3-4049-bc60-9af2ec3ba035', { target: knop });
  assert.ok([...w.document.querySelectorAll('table')].some((t) => /Geboekt op/.test(t.textContent)), 'blijft open');
});
