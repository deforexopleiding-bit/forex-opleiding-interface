// tests/automation-sectie.test.js — de sectie "Automation" (27 okt 2026):
// eigen lijst 'automation' in opvolging_taken, NIET in Daves daglijst of Leads
// bellen; eigen MODS-item + recht automation.view; het overzicht (tabs + KPI);
// de view hergebruikt de vensters van Opvolging via haken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

import {
  tabVoor, afgerondLabel, weekVan, dagVan, laatsteAfspraak, afspraakStand, bouwOverzicht,
} from '../api/_lib/automation-overzicht.js';
import { alleenAutomationlijst, isAutomationkaart, LIJST_AUTOMATION } from '../api/_lib/opvolging-lijst.js';
import { syncAutomationKaart } from '../api/_lib/automation-interesse.js';
import { maakHandler } from '../api/automation-overzicht.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const NU = Date.parse('2026-10-29T10:00:00Z'); // woensdag

// ── De lijst ──────────────────────────────────────────────────────────────
test('lijst: automation-kaarten = reden automation_interesse in lijst automation (of vóór de migratie dag)', () => {
  const gezien = [];
  const q = { eq(k, v) { gezien.push(['eq', k, v]); return q; }, in(k, v) { gezien.push(['in', k, v]); return q; } };
  alleenAutomationlijst(q);
  assert.deepEqual(gezien, [['eq', 'reden', 'automation_interesse'], ['in', 'lijst', ['automation', 'dag']]]);
  assert.equal(LIJST_AUTOMATION, 'automation');
  assert.equal(isAutomationkaart({ lijst: 'automation' }), true);
  assert.equal(isAutomationkaart({ lijst: 'dag', reden: 'automation_interesse' }), true);
  assert.equal(isAutomationkaart({ lijst: 'dag', reden: 'no_show_call' }), false);
});

test('daglijst, weekbalk, Nu-doen, rapport, gezondheid en Leads bellen zien de lijst automation niet', () => {
  // Elk van deze schermen filtert op zijn EIGEN lijst; 'automation' is daar dus nooit bij.
  for (const f of ['api/opvolging-dag.js', 'api/opvolging-taken.js', 'api/opvolging-weekbalk.js', 'api/opvolging-rapport.js']) {
    assert.match(lees(f), /alleenDaglijst\(/, f);
  }
  assert.match(lees('api/cron-opvolging-gezondheid.js'), /String\(t\.lijst \|\| 'dag'\) === 'dag'/);
  assert.match(lees('api/_lib/opvolging-leads-data.js'), /alleenLeadlijst|alleenDaglijst/);
  assert.match(lees('api/_lib/opvolging-lijst.js'), /export function alleenDaglijst\(q\) \{\n  return q\.eq\('lijst', LIJST_DAG\);/);
  // De doorrol en de 48u-wacht-check werken per kaart en houden de reden (geen 'niet_ingepland').
  assert.match(lees('api/_lib/opvolging-doorrol.js'), /'automation_interesse'\) \{\n    return \{ \.\.\.basis, badge_label: 'Agenda doorgestuurd' \};/);
});

// ── Nieuwe kaarten in lijst automation, met terugval vóór de migratie ─────
function insertDb({ checkKentAutomation }) {
  const inserts = [];
  return {
    inserts,
    from(t) {
      let rij = null;
      const q = {
        select() { return q; }, eq() { return q; }, in() { return q; }, limit() { return q; },
        insert(v) { rij = v; return q; },
        maybeSingle() {
          if (t === 'opvolging_taken' && rij) {
            inserts.push(rij);
            if (rij.lijst === 'automation' && !checkKentAutomation) {
              return Promise.resolve({ data: null, error: { code: '23514', message: 'new row violates check constraint "opvolging_taken_lijst_chk"' } });
            }
            return Promise.resolve({ data: { id: 'taak-1' }, error: null });
          }
          if (t === 'customers') return Promise.resolve({ data: { first_name: 'Wim', phone: '0470000000' }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        then(ok) { return Promise.resolve({ data: [], error: null }).then(ok); },
      };
      return q;
    },
  };
}
const OB = { id: 'ob-1', customer_id: 'c-1', is_test: false };

test('sync: nieuwe kaart in lijst automation; botst de CHECK nog (vóór de migratie) → zoals vroeger in dag', async () => {
  const na = insertDb({ checkKentAutomation: true });
  const r = await syncAutomationKaart(na, { onboarding: OB, answers: { robot_interesse: 'ja_interesse' }, nu: new Date(NU) });
  assert.equal(r.actie, 'maak');
  assert.deepEqual(na.inserts.map((i) => i.lijst), ['automation']);

  const voor = insertDb({ checkKentAutomation: false });
  const r2 = await syncAutomationKaart(voor, { onboarding: OB, answers: { robot_interesse: 'ja_interesse' }, nu: new Date(NU) });
  assert.equal(r2.actie, 'maak');
  assert.equal(r2.taak_id, 'taak-1');
  assert.deepEqual(voor.inserts.map((i) => i.lijst), ['automation', 'dag']);
});

// ── De rekenkern ──────────────────────────────────────────────────────────
test('tabs, afsluitreden, week en de verzet-keten', () => {
  assert.equal(tabVoor({ status: 'open' }), 'te_bellen');
  assert.equal(tabVoor({ status: 'wacht_inplanning' }), 'te_bellen');
  assert.equal(tabVoor({ status: 'ingepland' }), 'ingepland');
  assert.equal(tabVoor({ status: 'gearchiveerd' }), 'afgerond');
  assert.equal(afgerondLabel({ status: 'gearchiveerd', reden_code: 'automation_gesprek' }), 'Gesprek gehad');
  assert.equal(afgerondLabel({ status: 'gearchiveerd', reden_code: 'automation_geen_interesse' }), 'Geen interesse');
  assert.equal(afgerondLabel({ status: 'gearchiveerd', reden_code: 'klant_trok_interesse_in' }), 'Klant trok interesse in');
  assert.equal(afgerondLabel({ status: 'gearchiveerd', archief_reden: 'test' }), 'test');
  assert.equal(afgerondLabel({ status: 'open' }), null);
  assert.deepEqual(weekVan('2026-10-29'), { van: '2026-10-26', tot: '2026-11-01' });
  assert.deepEqual(weekVan('2026-11-01'), { van: '2026-10-26', tot: '2026-11-01' });
  assert.equal(dagVan(Date.parse('2026-10-29T23:30:00Z')), '2026-10-30'); // Brussel
  const af = new Map([['a1', { id: 'a1', status: 'verplaatst' }], ['a2', { id: 'a2', status: 'scheduled' }]]);
  const op = new Map([['a1', af.get('a2')]]);
  assert.equal(laatsteAfspraak('a1', af, op).id, 'a2');
  assert.equal(laatsteAfspraak('x', af, op), null);
});

test('call op de kaart: datum/tijd, uitkomst achteraf, eigen moment, verzet', () => {
  const af = new Map([
    ['a1', { id: 'a1', status: 'verplaatst', scheduled_at: '2026-10-30T09:00:00Z' }],
    ['a2', { id: 'a2', status: 'scheduled', scheduled_at: '2026-10-31T09:00:00Z', uitkomst: 'sale' }],
  ]);
  const op = new Map([['a1', af.get('a2')]]);
  const s = afspraakStand({ afspraak_ref: { appointment_id: 'a1', scheduled_at: '2026-10-30T09:00:00Z', handmatig: true } }, af, op, NU);
  assert.equal(s.scheduled_at, '2026-10-31T09:00:00Z');
  assert.equal(s.verzet, true);
  assert.equal(s.handmatig, true);
  assert.equal(s.categorie, 'sale');
  assert.equal(s.label, 'Sale');
  const gepland = afspraakStand({ afspraak_ref: { appointment_id: 'z', scheduled_at: '2026-11-03T09:00:00Z' } }, new Map(), new Map(), NU);
  assert.equal(gepland.label, 'Gepland');
  assert.equal(afspraakStand({ afspraak_ref: null }, af, op, NU), null);
});

function fixture() {
  const kaarten = [
    { id: 'k1', naam: 'Nieuw Vandaag', status: 'open', due: '2026-10-29', created_at: '2026-10-29T08:00:00Z', reden: 'automation_interesse', lijst: 'automation', telefoon: '+32470000001', bron_ref: { onboarding_id: 'o1', belmoment: ['avond'] } },
    { id: 'k2', naam: 'Later Terug', status: 'open', due: '2026-11-04', created_at: '2026-10-20T08:00:00Z', reden: 'automation_interesse', lijst: 'automation', bron_ref: { onboarding_id: 'o2', traject_id: 't1' } },
    { id: 'k3', naam: 'Al Ingepland', status: 'ingepland', due: '2026-10-28', created_at: '2026-10-21T08:00:00Z', reden: 'automation_interesse', lijst: 'automation', bron_ref: { onboarding_id: 'o3' }, afspraak_ref: { appointment_id: 'a1', scheduled_at: '2026-10-30T09:00:00Z' } },
    { id: 'k4', naam: 'Gesprek Gehad', status: 'gearchiveerd', reden_code: 'automation_gesprek', gearchiveerd_at: '2026-10-25T10:00:00Z', created_at: '2026-10-10T08:00:00Z', reden: 'automation_interesse', lijst: 'dag', bron_ref: {} },
    { id: 'k5', naam: 'Trok In', status: 'gearchiveerd', reden_code: 'klant_trok_interesse_in', gearchiveerd_at: '2026-10-26T10:00:00Z', created_at: '2026-10-11T08:00:00Z', reden: 'automation_interesse', lijst: 'automation', bron_ref: {} },
  ];
  const pogingen = [
    { taak_id: 'k1', soort: 'call', richting: 'uit', resultaat: 'niet opgenomen', tijdstip: '2026-10-29T09:00:00Z' },
    { taak_id: 'k1', soort: 'whatsapp', richting: 'uit', resultaat: 'verstuurd', tijdstip: '2026-10-29T09:05:00Z' },
    { taak_id: 'k2', soort: 'call', richting: 'uit', resultaat: 'niet opgenomen', tijdstip: '2026-10-20T09:00:00Z' },
    { taak_id: 'k2', soort: 'call', richting: 'uit', resultaat: 'niet opgenomen', tijdstip: '2026-10-21T09:00:00Z' },
  ];
  const onboardings = new Map([
    ['o1', { id: 'o1', mentor_user_id: 'u1', traject_id: 't1', start_date: '2026-11-03', automation_interesse_op: '2026-10-29T07:55:00Z', automation_belmoment: ['avond', 'weekend'] }],
    ['o2', { id: 'o2', mentor_user_id: 'u-onbekend', start_date: null }],
    ['o3', { id: 'o3', mentor_user_id: null }],
  ]);
  return {
    kaarten, pogingen, onboardings,
    trajecten: new Map([['t1', '1-op-1 — 12 maanden']]),
    mentoren: new Map([['u1', 'Seppe']]),
    afspraken: new Map([['a1', { id: 'a1', status: 'scheduled', scheduled_at: '2026-10-30T09:00:00Z' }]]),
    opvolgers: new Map(),
    nuMs: NU,
  };
}

test('overzicht: tabs, volgorde, velden per kaart en de KPI-strip', () => {
  const o = bouwOverzicht(fixture());
  assert.deepEqual(o.aantallen, { te_bellen: 2, ingepland: 1, afgerond: 2, alle: 5 });
  // Te bellen: wat vandaag klaarstaat eerst, 'later terugbellen' onderaan.
  assert.deepEqual(o.tabs.te_bellen.map((k) => k.id), ['k1', 'k2']);
  assert.equal(o.tabs.te_bellen[1].komt_terug_op, '2026-11-04');
  // Afgerond: nieuwste eerst, met reden.
  assert.deepEqual(o.tabs.afgerond.map((k) => [k.id, k.afgerond_label]), [['k5', 'Klant trok interesse in'], ['k4', 'Gesprek gehad']]);
  const k1 = o.tabs.te_bellen[0];
  assert.equal(k1.traject, '1-op-1 — 12 maanden');
  assert.equal(k1.start_date, '2026-11-03');
  assert.equal(k1.mentor, 'Seppe');
  assert.deepEqual(k1.belmoment, ['avond', 'weekend']);           // uit de onboarding (meest actueel)
  assert.equal(k1.interesse_op, '2026-10-29T07:55:00Z');
  assert.equal(k1.bel_totaal, 1);
  assert.equal(k1.wa_totaal, 1);
  assert.equal(k1.pogingen.length, 2);                            // voor het historiekvenster
  assert.equal(k1.onboarding_id, 'o1');
  const k2 = o.tabs.te_bellen[1];
  assert.equal(k2.mentor, 'Mentor (naam onbekend)');
  assert.equal(k2.bel_dagen, 2);
  assert.equal(o.tabs.ingepland[0].mentor, null);
  assert.equal(o.tabs.ingepland[0].afspraak.scheduled_at, '2026-10-30T09:00:00Z');
  assert.deepEqual(o.kpi, {
    nieuw_vandaag: 1, te_bellen: 1, later: 1, ingepland_week: 1, gesprekken: 2, totaal: 5, conversie_pct: 40,
  });
  assert.equal(bouwOverzicht({ nuMs: NU }).kpi.conversie_pct, null);
});

// ── Het endpoint ──────────────────────────────────────────────────────────
function leesDb(fx) {
  const filters = [];
  return {
    filters,
    from(t) {
      const f = [];
      const q = {
        select() { return q; }, order() { return q; }, limit() { return q; },
        eq(k, v) { f.push([k, v]); if (t === 'opvolging_taken') filters.push(['eq', k, v]); return q; },
        in(k, v) { f.push([k, v]); if (t === 'opvolging_taken') filters.push(['in', k, v]); return q; },
        then(ok) {
          let data = [];
          if (t === 'opvolging_taken') data = fx.kaarten;
          if (t === 'opvolging_pogingen') data = fx.pogingen;
          if (t === 'onboardings') data = [...fx.onboardings.values()];
          if (t === 'onboarding_trajecten') data = [{ id: 't1', label: '1-op-1 — 12 maanden' }];
          if (t === 'team_members') data = [{ user_id: 'u1', name: 'Seppe' }];
          if (t === 'follow_up_appointments') data = f.some(([k]) => k === 'id') ? [...fx.afspraken.values()] : [];
          return Promise.resolve({ data, error: null }).then(ok);
        },
      };
      return q;
    },
  };
}
function nepRes() {
  const r = { code: 0, body: null, setHeader() {} };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

test('endpoint: 401 / 403 / 200; standaard zonder testkaarten, ?test=1 met', async () => {
  const fx = fixture();
  const db = leesDb(fx);
  const h = (ingelogd, mag) => maakHandler({ db, ingelogd: async () => ingelogd, mag: async () => mag });
  let r = nepRes(); await h(null, true)({ method: 'GET', query: {} }, r); assert.equal(r.code, 401);
  r = nepRes(); await h({ id: 'u' }, false)({ method: 'GET', query: {} }, r); assert.equal(r.code, 403);
  assert.match(r.body.error, /automation\.view/);
  r = nepRes(); await h({ id: 'u' }, true)({ method: 'POST', query: {} }, r); assert.equal(r.code, 405);
  r = nepRes(); await h({ id: 'u' }, true)({ method: 'GET', query: {} }, r);
  assert.equal(r.code, 200);
  assert.equal(r.body.aantallen.alle, 5);
  assert.equal(r.body.tabs.te_bellen[0].mentor, 'Seppe');
  assert.deepEqual(r.body.meldingen, []);
  assert.deepEqual(db.filters, [['eq', 'reden', 'automation_interesse'], ['in', 'lijst', ['automation', 'dag']], ['eq', 'is_test', false]]);
  db.filters.length = 0;
  r = nepRes(); await h({ id: 'u' }, true)({ method: 'GET', query: { test: '1' } }, r);
  assert.ok(!db.filters.some(([, k]) => k === 'is_test'));
});

// ── Menu, recht, migratie ─────────────────────────────────────────────────
test('menu: eigen MODS-item Automation met rollen + permKey; ingeladen na opvolging-v2', () => {
  const shell = lees('modules/shared/design-system/app-shell.js');
  assert.match(shell, /id: 'automation',\s+naam: 'Automation',[^\n]*roles: \['super_admin', 'admin', 'manager', 'sales'\], permKey: 'automation\.view', tabs: \['Te bellen', 'Ingepland', 'Afgerond', 'Alle'\]/);
  const idx = lees('modules/klanten-v2/index.html');
  assert.ok(idx.indexOf('views/automation-v2.js') > idx.indexOf('views/opvolging-v2.js'), 'na opvolging-v2.js');
  assert.match(idx, /app-shell\.js\?v=1ea/);
  assert.match(idx, /views\/opvolging-v2\.js\?v=81/);
  assert.match(lees('modules/klanten-v2/klanten-v2.js'), /'iris', 'automation'\]\);/);
  assert.match(lees('api/automation-overzicht.js'), /export const RECHT = 'automation\.view'/);
});

test('migratie: leest de huidige lijsten en behoudt ze, verhuist de kaarten, recht voor admin/manager/sales', () => {
  const sql = lees('docs/sql-migrations/2026-10-27-automation-lijst.sql');
  assert.match(sql, /conname = 'opvolging_taken_lijst_chk'/);
  assert.match(sql, /regexp_matches\(def/);
  assert.match(sql, /waarden := waarden \|\| 'automation'::text/);
  assert.match(sql, /update public\.opvolging_taken\s+set lijst = 'automation'\s+where reden = 'automation_interesse' and lijst = 'dag'/);
  for (const rol of ['admin', 'manager', 'sales']) assert.match(sql, new RegExp(`select '${rol}', 'automation\\.view', true`));
  assert.doesNotMatch(sql, /\bdrop table|delete from public\.opvolging_taken|truncate/i);
});

test('Opvolging: chip weg, vensters gedeeld via haken, geen vingerafdruk buiten Opvolging', () => {
  const v = lees('modules/klanten-v2/views/opvolging-v2.js');
  assert.doesNotMatch(v, /autochip|__opvAutoFilter|alleenAutomation/);
  assert.match(v, /if \(S && S\.mod && S\.mod !== 'opvolging'\) return null;/);
  assert.match(v, /window\.__opvAutomationZoek\(id\)/);
  assert.equal((v.match(/window\.__opvAutomationVerander\(\)/g) || []).length, 2);
});

// ── De view, echt getekend (jsdom) ────────────────────────────────────────
async function tekenView(tab, { rechten = ['opvolging.module.access', 'opvolging.whatsapp.sturen', 'opvolging.taak.afronden', 'opvolging.agenda.boeken'] } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://crm.example/modules/klanten-v2/', runScripts: 'outside-only' });
  const w = dom.window;
  const o = bouwOverzicht(fixture());
  const geopend = [];
  w.DFO = { VIEWS: {}, render() {}, goMod() {}, goTab() {} };
  w.KV = { authedJson: async () => JSON.parse(JSON.stringify({ ...o, meldingen: [] })) };
  w.RBAC = { canSync: (k) => rechten.includes(k) };
  w.__opvGedeeld = {
    stijl() {}, waLamp: () => '', modalHtml: () => '<i data-modal></i>', waPaneelHtml: () => '', gesprekPaneelHtml: () => '',
    openModal: (m) => geopend.push(m),
  };
  w.eval(lees('modules/klanten-v2/views/automation-v2.js'));
  w.DFO.VIEWS['automation/' + tab]();            // start het laden
  await new Promise((r) => setTimeout(r, 10));
  return { html: w.DFO.VIEWS['automation/' + tab](), w, geopend };
}

test('view: Te bellen met KPI-strip, gegevens per kaart en de knoppen van Opvolging', async () => {
  const { html, w, geopend } = await tekenView('Te bellen');
  assert.match(html, /data-aut="kpi"/);
  assert.match(html, /Nieuw vandaag/);
  assert.match(html, /Interesse → gesprek/);
  assert.match(html, /40%/);
  assert.match(html, /Nieuw Vandaag/);
  assert.match(html, /1-op-1 — 12 maanden/);
  assert.match(html, /mentor <b>Seppe<\/b>/);
  assert.match(html, /Belmoment: <b>Avond, Zaterdag<\/b>/);
  assert.match(html, /1× gebeld \(1 dag\) · 1 WhatsApp/);
  assert.match(html, /window\.__opvBel\('k1','automation'\)/);
  assert.match(html, /window\.__opvWa\('k1'\)/);
  assert.match(html, /window\.__opvWatNu\('k1'\)/);
  assert.match(html, /window\.__opvHist\('k1'\)/);
  assert.match(html, /window\.__autDossier\('o1'\)/);
  assert.match(html, /Later terugbellen/);
  assert.match(html, /terug op/);
  assert.match(html, /<i data-modal><\/i>/);                     // de gedeelde vensters staan eronder
  assert.doesNotMatch(html, /Al Ingepland|Gesprek Gehad/);
  // De haak waarmee Opvolging onze kaarten vindt.
  assert.equal(w.__opvAutomationZoek('k3').naam, 'Al Ingepland');
  assert.equal(w.__opvAutomationZoek('nee'), null);
  w.__autActie('k1', 'inplannen');
  w.__autActie('k3', 'gesprek_gehad');
  assert.deepEqual(JSON.parse(JSON.stringify(geopend)), [{ soort: 'inplannen', taakId: 'k1' }, { soort: 'auto-afsluit', taakId: 'k3', uitkomst: 'gesprek_gehad' }]);
});

test('view: Ingepland toont datum/tijd + uitkomst; Afgerond de reden; zonder Opvolging-rechten alleen inzien', async () => {
  const ing = (await tekenView('Ingepland')).html;
  assert.match(ing, /Al Ingepland/);
  assert.match(ing, /Gepland/);
  assert.match(ing, /Gesprek gehad/);
  const af = (await tekenView('Afgerond')).html;
  assert.match(af, /Klant trok interesse in/);
  const zonder = (await tekenView('Te bellen', { rechten: [] })).html;
  assert.match(zonder, /lopen via de rechten van Opvolging/);
  assert.doesNotMatch(zonder, /__opvBel|__opvWa\(|__opvWatNu/);
  assert.match(zonder, /__opvHist/);
});
