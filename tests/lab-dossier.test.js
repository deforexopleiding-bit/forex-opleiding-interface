// tests/lab-dossier.test.js
//
// De regels achter het Lab-dossier en de funnel per hook (api/_lib/lab-dossier.js).
//   - status van ver naar dichtbij: geboekt > afgewerkt > bezig > verlopen > ingelogd > aangemeld;
//   - een lead telt bij de hook van zijn EERSTE aanmelding, touches apart;
//   - testaanmeldingen tellen nooit mee;
//   - antwoorden uit de simulatie én de vragenlaag komen leesbaar terug.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labStatus, aggregeerFunnel, vragenUitSnapshot, kwalificatieRegels, minutenInLab, isAfgerond, gebeurtenisRegel, ROUTE_LABELS } from '../api/_lib/lab-dossier.js';

const nu = Date.parse('2026-10-15T12:00:00Z');
const toekomst = '2026-10-20T00:00:00Z';

test('status: van ver naar dichtbij', () => {
  const lead = { toegang_tot: toekomst, eerste_login_op: null };
  assert.equal(labStatus({ labLead: null, sessie: null, nu }).code, 'geen_account');
  assert.equal(labStatus({ labLead: lead, sessie: null, nu }).code, 'aangemeld');
  assert.equal(labStatus({ labLead: { ...lead, eerste_login_op: 'x' }, sessie: null, nu }).code, 'ingelogd');
  assert.equal(labStatus({ labLead: { ...lead, toegang_tot: '2026-10-01T00:00:00Z' }, sessie: null, nu }).code, 'verlopen');
  const bezig = labStatus({ labLead: lead, sessie: { stap: 7, stappen: 25, voortgang: 28 }, nu });
  assert.equal(bezig.code, 'bezig');
  assert.equal(bezig.label, 'Lab gestart · stap 7 van 25');
  assert.equal(labStatus({ labLead: lead, sessie: { stap: 25, stappen: 25, voortgang: 96, afgerond: 'true' }, nu }).code, 'afgewerkt');
  assert.equal(labStatus({ labLead: { ...lead, sessie_geboekt_op: 'x' }, sessie: { stap: 3 }, nu }).code, 'geboekt');
});

test('afgerond: de vlag uit de snapshot, of 100% voortgang', () => {
  assert.equal(isAfgerond({ snapshot: { afgerond: true } }), true);
  assert.equal(isAfgerond({ voortgang: 100 }), true);
  assert.equal(isAfgerond({ voortgang: 99 }), false);
});

test('funnel: eerste hook telt, touches apart, test telt niet', () => {
  const aanm = [
    { email: 'a@x.be', hook: 'H01', aangemaakt: '2026-10-01' },
    { email: 'a@x.be', hook: 'H02', aangemaakt: '2026-10-03' },
    { email: 'b@x.be', hook: 'H02', aangemaakt: '2026-10-02' },
    { email: 'c@x.be', hook: 'H01', aangemaakt: '2026-10-02' },
    { email: 't@x.be', hook: 'H01', aangemaakt: '2026-10-02', is_test: true },
  ];
  const lms = new Map([
    ['a@x.be', { labLead: { eerste_login_op: 'x', sessie_geboekt_op: 'x' }, sessie: { stap: 25, voortgang: 100 } }],
    ['b@x.be', { labLead: { eerste_login_op: 'x' }, sessie: { stap: 4, voortgang: 10 } }],
    ['c@x.be', { labLead: {}, sessie: null, geboekt: true }],
  ]);
  const { rijen, totaal } = aggregeerFunnel(aanm, lms, new Set(['a@x.be']));
  const h1 = rijen.find((r) => r.sleutel === 'H01');
  const h2 = rijen.find((r) => r.sleutel === 'H02');
  assert.deepEqual({ ...h1 }, { sleutel: 'H01', touches: 2, leads: 2, ingelogd: 1, gestart: 1, afgewerkt: 1, geboekt: 2, klant: 1 });
  assert.deepEqual({ ...h2 }, { sleutel: 'H02', touches: 2, leads: 1, ingelogd: 1, gestart: 1, afgewerkt: 0, geboekt: 0, klant: 0 });
  assert.equal(totaal.leads, 3);
});

test('funnel per campagne', () => {
  const { rijen } = aggregeerFunnel([{ email: 'a@x.be', utm_campaign: 'okt', aangemaakt: '1' }, { email: 'b@x.be', aangemaakt: '2' }], new Map(), new Set(), 'campagne');
  assert.deepEqual(rijen.map((r) => r.sleutel).sort(), ['(geen campagne)', 'okt']);
});

test('vragen: simulatie en vragenlaag samen, leesbaar', () => {
  const v = vragenUitSnapshot({
    antwoorden: { why: { q: 'Wat bracht je hier?', a: 'Bijverdienste' } },
    vraagAntwoorden: { v4: { vraagId: 'v4', label: 'Tussen 30 en 50%', waarde: '30-50' } },
  });
  assert.deepEqual(v.map((x) => [x.vraag, x.antwoord]), [
    ['Wat bracht je hier?', 'Bijverdienste'],
    ['Wat denk je dat jouw winratio is?', 'Tussen 30 en 50%'],
  ]);
});

test('kwalificatie en tijd in The Lab', () => {
  assert.deepEqual(kwalificatieRegels({ doel: 'vermogen', tijd: '3_6u', investeren: 'misschien' }).map((r) => r.antwoord), ['Vermogen opbouwen', '3 tot 6 uur', 'Misschien']);
  assert.deepEqual(kwalificatieRegels(null), []);
  assert.equal(minutenInLab({ gestart_op: '2026-10-15T10:00:00Z', bijgewerkt_op: '2026-10-15T10:21:30Z' }), 22);
});

test('GEBEURTENISSEN: elke soort heeft een leesbare regel voor Dave', () => {
  assert.equal(gebeurtenisRegel({ soort: 'kaart_getoond', data: { na: 'trade 1' } }), 'Boekingskaart in The Lab getoond (na trade 1)');
  assert.equal(gebeurtenisRegel({ soort: 'kaart_geklikt' }), 'Klikte op de boekingskaart in The Lab');
  assert.equal(gebeurtenisRegel({ soort: 'route_gekozen', sleutel: 'kort' }), 'Koos: ' + ROUTE_LABELS.kort);
  assert.equal(gebeurtenisRegel({ soort: 'video_voltooid', data: { titel: 'Market Structure' } }), 'Keek video uit: Market Structure');
  for (const s of ['kaart_gesloten', 'route_terugkeer', 'video_gestart', 'bevestiging_ics', 'terugbellen_gevraagd']) {
    assert.ok(gebeurtenisRegel({ soort: s }).length > 5, s);
  }
});
