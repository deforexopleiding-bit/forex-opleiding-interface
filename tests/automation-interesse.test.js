// tests/automation-interesse.test.js — automation-interesse uit de onboarding
// wordt één belkaart voor Dave (Opvolging), en niets laat hem stil uit een
// telling vallen of vals alarm geven.
//
// Bedoeld gedrag (opdracht 27 okt 2026):
//   · bij de save (niet pas bij afronden) één kaart, idempotent;
//   · due vandaag, na 20:00 Brussel morgen;
//   · terug op nee vóór contact → dicht met 'klant_trok_interesse_in'; weer ja →
//     dezelfde kaart open; na contact verandert er niets automatisch;
//   · inplannen boekt met booking_source 'automation';
//   · Salesrapport / doorrol / migratie houden er rekening mee.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  beslis, dueVoor, kaartRij, kaartNotitie, syncAutomationKaart, TROK_IN, AUTOMATION_REDEN, AFSLUIT_CODES,
} from '../api/_lib/automation-interesse.js';
import { boekBronVoorTaak } from '../api/opvolging-agenda.js';
import { terugNaWachtPatch } from '../api/_lib/opvolging-doorrol.js';
import { beoordeelMoeite } from '../api/_lib/opvolging-vensters.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ── Beslissing ─────────────────────────────────────────────────────────────

test('beslis: ja zonder kaart → maak; nee zonder kaart → niets', () => {
  assert.equal(beslis({ interesse: 'ja_interesse', kaart: null, contact: false }).actie, 'maak');
  assert.equal(beslis({ interesse: 'nee', kaart: null, contact: false }).actie, 'niets');
  assert.equal(beslis({ interesse: undefined, kaart: null, contact: false }).actie, 'niets');
});

test('beslis: nee vóór contact sluit; weer ja heropent precies die kaart', () => {
  const open = { status: 'open' };
  assert.equal(beslis({ interesse: 'nee', kaart: open, contact: false }).actie, 'sluit');
  assert.equal(beslis({ interesse: 'nee', kaart: { status: 'wacht_inplanning' }, contact: false }).actie, 'sluit');
  const dicht = { status: 'gearchiveerd', archief_reden: TROK_IN };
  assert.equal(beslis({ interesse: 'ja_interesse', kaart: dicht, contact: false }).actie, 'heropen');
  assert.equal(beslis({ interesse: 'nee', kaart: dicht, contact: false }).actie, 'niets');
  assert.equal(beslis({ interesse: 'ja_interesse', kaart: open, contact: false }).actie, 'bijwerken');
});

test('beslis: NA contact, ingepland of door Dave afgesloten verandert er niets automatisch', () => {
  for (const interesse of ['ja_interesse', 'nee']) {
    assert.equal(beslis({ interesse, kaart: { status: 'open' }, contact: true }).actie, 'niets');
    assert.equal(beslis({ interesse, kaart: { status: 'ingepland' }, contact: false }).actie, 'niets');
    assert.equal(beslis({ interesse, kaart: { status: 'gearchiveerd', archief_reden: 'Gesprek gehad: x' }, contact: false }).actie, 'niets');
  }
});

test('due: vandaag in Brussel, na 20:00 morgen (ook over de jaargrens)', () => {
  assert.equal(dueVoor(Date.parse('2026-10-27T18:59:00Z')), '2026-10-27'); // 19:59 Brussel (CET)
  assert.equal(dueVoor(Date.parse('2026-10-27T19:00:00Z')), '2026-10-28'); // 20:00 Brussel
  assert.equal(dueVoor(Date.parse('2026-07-01T17:59:00Z')), '2026-07-01'); // 19:59 zomertijd
  assert.equal(dueVoor(Date.parse('2026-07-01T18:00:00Z')), '2026-07-02');
  assert.equal(dueVoor(Date.parse('2026-12-31T21:00:00Z')), '2027-01-01');
  assert.equal(dueVoor(Date.parse('2026-10-27T23:30:00Z')), '2026-10-28'); // 00:30 Brussel = al morgen
});

test('kaart: reden, koppeling naar de onboarding, notitie met traject/start/belmoment, test blijft test', () => {
  const rij = kaartRij({
    onboarding: { id: 'ob-1', customer_id: 'c-1', traject_id: 't-1', start_date: '2026-11-03', is_test: true, customer_name: 'X' },
    klant: { first_name: 'Wim', last_name: 'Peeters', email: 'wim@example.com', phone: '0470000000' },
    trajectLabel: '1-op-1 — 12 maanden', belmoment: ['avond', 'weekend'], nuMs: Date.parse('2026-10-27T10:00:00Z'),
  });
  assert.equal(rij.reden, AUTOMATION_REDEN);
  assert.equal(rij.naam, 'Wim Peeters');
  assert.equal(rij.status, 'open');
  assert.equal(rij.lijst, 'dag');
  assert.equal(rij.due, '2026-10-27');
  assert.equal(rij.eigenaar_id, null);
  assert.equal(rij.is_test, true);
  assert.equal(rij.bron_ref.onboarding_id, 'ob-1');
  assert.deepEqual(rij.bron_ref.belmoment, ['avond', 'weekend']);
  assert.match(rij.notitie, /via de onboarding/);
  assert.match(rij.notitie, /1-op-1 — 12 maanden/);
  assert.match(rij.notitie, /3 november 2026/);
  assert.match(rij.notitie, /avond, zaterdag/);
  assert.match(kaartNotitie({ belmoment: [] }), /Geen voorkeur/);
});

// ── Lezen en schrijven (nep-databank) ─────────────────────────────────────

function nepDb({ kaarten = [], pogingen = [], fouten = {} } = {}) {
  const log = { inserts: [], updates: [] };
  const tabellen = {
    opvolging_taken: kaarten,
    opvolging_pogingen: pogingen,
    customers: [{ id: 'c-1', first_name: 'Wim', last_name: 'Peeters', email: 'wim@example.com', phone: '+32470000000' }],
    onboarding_trajecten: [{ id: 't-1', label: '1-op-1 — 12 maanden' }],
  };
  return {
    log, tabellen,
    from(t) {
      const filters = [];
      let op = 'select'; let waarden = null;
      const pas = (r) => filters.every((f) => f(r));
      const veld = (r, k) => (k.includes('->>') ? (r[k.split('->>')[0]] || {})[k.split('->>')[1]] : r[k]);
      const voer = () => {
        const f = fouten[`${t}.${op}`];
        if (f) return { data: null, error: f };
        const rijen = tabellen[t] || [];
        if (op === 'insert') {
          if (t === 'opvolging_taken' && rijen.some((r) => r.reden === waarden.reden && r.bron_ref?.onboarding_id === waarden.bron_ref?.onboarding_id)) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
          const rij = { id: 'taak-' + (rijen.length + 1), ...waarden };
          rijen.push(rij); log.inserts.push({ t, rij });
          return { data: { id: rij.id }, error: null };
        }
        if (op === 'update') {
          const geraakt = rijen.filter(pas);
          for (const r of geraakt) Object.assign(r, waarden);
          log.updates.push({ t, waarden, n: geraakt.length });
          return { data: null, error: null };
        }
        return { data: rijen.filter(pas).map((r) => ({ ...r })), error: null };
      };
      const q = {
        select() { return q; },
        insert(v) { op = 'insert'; waarden = v; return q; },
        update(v) { op = 'update'; waarden = v; return q; },
        eq(k, v) { filters.push((r) => veld(r, k) === v); return q; },
        in(k, vs) { filters.push((r) => vs.includes(veld(r, k))); return q; },
        limit() { return q; },
        maybeSingle() { const r = voer(); return Promise.resolve(r.error ? r : { data: Array.isArray(r.data) ? r.data[0] || null : r.data, error: null }); },
        then(ok, nok) { return Promise.resolve(voer()).then(ok, nok); },
      };
      return q;
    },
  };
}

const OB = { id: 'ob-1', customer_id: 'c-1', traject_id: 't-1', start_date: '2026-11-03', is_test: false, customer_name: 'Wim Peeters' };
const NU = new Date('2026-10-27T10:00:00Z');

test('sync: ja → één kaart; nog een keer ja → GEEN tweede kaart (idempotent)', async () => {
  const db = nepDb();
  const a = await syncAutomationKaart(db, { onboarding: OB, answers: { robot_interesse: 'ja_interesse', robot_belmoment: ['avond'] }, nu: NU });
  assert.equal(a.actie, 'maak');
  const b = await syncAutomationKaart(db, { onboarding: OB, answers: { robot_interesse: 'ja_interesse', robot_belmoment: ['avond', 'voormiddag'] }, nu: NU });
  assert.equal(b.actie, 'bijwerken');
  assert.equal(db.tabellen.opvolging_taken.length, 1);
  const k = db.tabellen.opvolging_taken[0];
  assert.equal(k.reden, 'automation_interesse');
  assert.equal(k.telefoon, '+32470000000');
  assert.deepEqual(k.bron_ref.belmoment, ['avond', 'voormiddag']);
  assert.match(k.notitie, /avond, voormiddag/);
});

test('sync: gelijktijdige save (unieke index botst) is geen fout', async () => {
  const db = nepDb({ kaarten: [] });
  // Simuleer: de lees-query ziet nog niets, maar de insert botst op de index.
  db.tabellen.opvolging_taken.push({ id: 'x', reden: 'iets_anders' });
  const orig = db.from.bind(db);
  let eersteLees = true;
  db.from = (t) => {
    const q = orig(t);
    if (t === 'opvolging_taken' && eersteLees) {
      eersteLees = false;
      const then = q.then.bind(q);
      q.then = (ok, nok) => then((r) => ok({ ...r, data: [] }), nok);
    }
    return q;
  };
  db.tabellen.opvolging_taken.push({ id: 'bestaand', lijst: 'dag', reden: 'automation_interesse', bron_ref: { onboarding_id: 'ob-1' }, status: 'open' });
  const r = await syncAutomationKaart(db, { onboarding: OB, answers: { robot_interesse: 'ja_interesse' }, nu: NU });
  assert.equal(r.actie, 'niets');
  assert.equal(db.tabellen.opvolging_taken.filter((k) => k.reden === 'automation_interesse').length, 1);
});

test('sync: nee vóór contact → dicht met klant_trok_interesse_in; weer ja → open', async () => {
  const kaart = { id: 'k1', lijst: 'dag', reden: 'automation_interesse', bron_ref: { onboarding_id: 'ob-1' }, status: 'open', uitkomst_log: [] };
  const db = nepDb({ kaarten: [kaart] });
  const r = await syncAutomationKaart(db, { onboarding: OB, answers: { robot_interesse: 'nee' }, nu: NU });
  assert.equal(r.actie, 'sluit');
  assert.equal(kaart.status, 'gearchiveerd');
  assert.equal(kaart.archief_reden, TROK_IN);
  assert.equal(kaart.reden_code, TROK_IN);
  const r2 = await syncAutomationKaart(db, { onboarding: OB, answers: { robot_interesse: 'ja_interesse' }, nu: NU });
  assert.equal(r2.actie, 'heropen');
  assert.equal(kaart.status, 'open');
  assert.equal(kaart.archief_reden, null);
  assert.equal(kaart.due, '2026-10-27');
  assert.equal(kaart.uitkomst_log.length, 2);
});

test('sync: na contact (gesproken) verandert nee niets', async () => {
  const kaart = { id: 'k1', lijst: 'dag', reden: 'automation_interesse', bron_ref: { onboarding_id: 'ob-1' }, status: 'open' };
  const db = nepDb({ kaarten: [kaart], pogingen: [{ taak_id: 'k1', soort: 'call', resultaat: 'gesproken', richting: 'uit' }] });
  const r = await syncAutomationKaart(db, { onboarding: OB, answers: { robot_interesse: 'nee' }, nu: NU });
  assert.equal(r.actie, 'niets');
  assert.equal(kaart.status, 'open');
});

test('sync: een niet-opgenomen belpoging is GEEN contact — nee sluit nog', async () => {
  const kaart = { id: 'k1', lijst: 'dag', reden: 'automation_interesse', bron_ref: { onboarding_id: 'ob-1' }, status: 'open' };
  const db = nepDb({ kaarten: [kaart], pogingen: [{ taak_id: 'k1', soort: 'call', resultaat: 'niet opgenomen', richting: 'uit' }] });
  const r = await syncAutomationKaart(db, { onboarding: OB, answers: { robot_interesse: 'nee' }, nu: NU });
  assert.equal(r.actie, 'sluit');
});

test('sync: faalzacht — een databankfout geeft een verslag, geen throw', async () => {
  const db = nepDb({ fouten: { 'opvolging_taken.select': { message: 'weg' } } });
  const r = await syncAutomationKaart(db, { onboarding: OB, answers: { robot_interesse: 'ja_interesse' }, nu: NU });
  assert.equal(r.actie, 'fout');
  // CHECK nog niet uitgebreid (migratie niet gedraaid): ook geen throw.
  const db2 = nepDb({ fouten: { 'opvolging_taken.insert': { code: '23514', message: 'violates check constraint "opvolging_taken_reden_chk"' } } });
  const r2 = await syncAutomationKaart(db2, { onboarding: OB, answers: { robot_interesse: 'ja_interesse' }, nu: NU });
  assert.equal(r2.actie, 'fout');
});

// ── De rest van het systeem ────────────────────────────────────────────────

test('inplannen vanaf een automation-kaart boekt met booking_source automation (en de rest niet)', () => {
  assert.equal(boekBronVoorTaak({ reden: 'automation_interesse' }), 'automation');
  assert.equal(boekBronVoorTaak({ reden: 'no_show_call' }), null);
  assert.equal(boekBronVoorTaak(null), null);
  assert.match(lees('api/opvolging-agenda.js'), /boekBronVoorTaak\(taak\) \? \{ source: boekBronVoorTaak\(taak\) \}/);
});

test('terug na 48u agenda-doorsturen: automation-kaart HOUDT zijn reden', () => {
  const p = terugNaWachtPatch({ taak: { lijst: 'dag', reden: 'automation_interesse' }, vandaag: '2026-10-27', regel: 'x' });
  assert.equal(p.reden, undefined);
  assert.equal(p.status, 'open');
  const gewoon = terugNaWachtPatch({ taak: { lijst: 'dag', reden: 'no_show_call' }, vandaag: '2026-10-27', regel: 'x' });
  assert.equal(gewoon.reden, 'niet_ingepland');
  assert.match(lees('api/cron-opvolging-wacht-check.js'), /badge_label, notitie, lijst, reden'\)/);
});

test('Salesrapport: automatisch of na gesprek gesloten automation-kaart is geen "te weinig pogingen"', () => {
  for (const code of [TROK_IN, AFSLUIT_CODES.gesprek_gehad, AFSLUIT_CODES.geen_interesse]) {
    assert.equal(beoordeelMoeite({ bel_dagen: 0, wa_totaal: 0, reden_code: code, duur_bekend: true }).staat, 'nvt', code);
  }
  // Andere kaarten blijven gewoon beoordeeld.
  assert.equal(beoordeelMoeite({ bel_dagen: 0, wa_totaal: 0, reden_code: null, duur_bekend: true }).staat, 'te_weinig');
});

test('Wat nu? → gesprek gehad / geen interesse: taak-update zet reden_code + categorie (notitie verplicht)', () => {
  const s = lees('api/opvolging-taak-update.js');
  assert.match(s, /taak\.reden === AUTOMATION_REDEN && b\.automation_uitkomst/);
  assert.match(s, /patch\.reden_code = code/);
  const v = lees('modules/klanten-v2/views/opvolging-v2.js');
  assert.match(v, /automation_interesse: \['Automation', 't-auto'\]/);
  assert.match(v, /#6D3FD4/);
  assert.match(v, /data-opv-filter="automation"/);
  assert.match(v, /'Call inplannen'/);
  assert.match(v, /'Gesprek gehad'/);
  assert.match(v, /'Geen interesse meer'/);
  assert.match(v, /'Later terugbellen'/);
  assert.match(v, /c\.bron === 'automation'/);
  assert.match(lees('modules/klanten-v2/views/call-rapport-v2.js'), /booking_source === 'automation'/);
});

test('geen WhatsApp of mail naar de klant vanuit de automation-kaart', () => {
  const s = lees('api/_lib/automation-interesse.js').split('\n').filter((r) => !/^\s*\/\//.test(r)).join('\n');
  assert.doesNotMatch(s, /sendMail|whatsapp|metaPostMessage|sendTemplate|nodemailer/i);
});

test('migratie: leest de huidige redenen uit de databank en behoudt ze, unieke index, booking source', () => {
  const sql = lees('docs/sql-migrations/2026-10-27-opvolging-automation-interesse.sql');
  assert.match(sql, /pg_get_constraintdef/);
  assert.match(sql, /regexp_matches\(def/);
  assert.match(sql, /waarden \|\| 'automation_interesse'::text/);
  assert.match(sql, /create unique index if not exists opvolging_taken_automation_uniek[\s\S]*\(\(bron_ref->>'onboarding_id'\)\)[\s\S]*where reden = 'automation_interesse'/);
  assert.match(sql, /values \('automation', 'Automation \(onboarding\)', true, false\)\s*on conflict \(slug\) do nothing/);
  const zonder = sql.split('\n').filter((r) => !/^\s*--/.test(r)).join('\n');
  assert.doesNotMatch(zonder, /\bdrop (table|column|index)\b/i);
});

test('portal: de save roept de automation-sync aan', () => {
  assert.match(lees('api/onboarding-portal.js'), /naAutomation: \(\{ onboarding, answers, nu \}\) => syncAutomationKaart\(supabaseAdmin/);
});
