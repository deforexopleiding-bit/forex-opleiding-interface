// tests/trial-overzicht.test.js
//
// Leadsonderhoud › The Lab = het overzicht van ALLE trial-leads (26 okt 2026).
// Legt vast: KPI's per product (testleads tellen niet), één rij per e-mail met
// de belofte van de eerste aanmelding, status-chips, en de bellijst-volgorde
// (warm → ingelogd → niet ingelogd met toestemming; nooit geboekt/klant/
// afgemeld/zonder nummer/test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bouwOverzicht, belGroep, bellijstCsv, statusChips } from '../api/_lib/trial-overzicht.js';
import { valideerBelpoging } from '../api/trial-belpoging.js';

const NU = Date.parse('2026-10-28T10:00:00Z');
const A = (id, email, over = {}) => ({ id, email, aangemaakt: '2026-10-26T10:00:00Z', voornaam: email.split('@')[0], telefoon_e164: '+32470000000', toestemming: true, ...over });
const stand = (over = {}) => ({
  labLead: { toegang_van: '2026-10-26T10:00:00Z', toegang_tot: '2026-11-02T10:00:00Z', eerste_login_op: null, ...over.lead },
  sessie: over.sessie || null, videos: over.videos || 0, videoTitels: (over.titels || []).map((t) => ({ titel: t })),
});

function opzet() {
  const aanmeldingen = [
    A('a-warm', 'warm@x.be', { product: 'minicursus', bron: 'kennismakingscursus-v9' }),
    A('a-in', 'in@x.be', { product: '7-daagse', bron: '7-daagse-v6' }),
    A('a-niet', 'niet@x.be', { landingspagina: 'trial:webinar:webinar-v2' }),
    A('a-geboekt', 'geboekt@x.be', { product: 'minicursus' }),
    A('a-lab', 'lab@x.be', { hook: 'H03' }),
    A('a-test', 'maxim.delombaerde96+t1@gmail.com', { product: 'minicursus', is_test: true }),
    A('a-zonder', 'zonder@x.be', { product: '7-daagse', toestemming: false, telefoon_e164: null }),
    // tweede touch van warm@ later via een andere belofte: telt niet als tweede lead
    A('a-warm2', 'warm@x.be', { product: '7-daagse', aangemaakt: '2026-10-27T10:00:00Z' }),
  ];
  const standPerEmail = new Map([
    ['warm@x.be', stand({ lead: { eerste_login_op: '2026-10-26T11:00:00Z' }, videos: 2, titels: ['Market Structure', 'Fibonacci'] })],
    ['in@x.be', stand({ lead: { eerste_login_op: '2026-10-26T11:00:00Z' }, videos: 1 })],
    ['niet@x.be', stand()],
    ['geboekt@x.be', stand({ lead: { eerste_login_op: '2026-10-26T11:00:00Z', sessie_geboekt_op: '2026-10-27T09:00:00Z', sessie_moment: '2026-10-30T14:00:00Z' } })],
    ['lab@x.be', stand({ lead: { eerste_login_op: '2026-10-26T11:00:00Z' }, sessie: { stap: 25, stappen: 25, voortgang: 100 } })],
    ['maxim.delombaerde96+t1@gmail.com', stand({ lead: { is_test: true } })],
    ['zonder@x.be', stand()],
  ]);
  return { aanmeldingen, standPerEmail };
}

test('KPI per product: één lead per e-mail, de eerste belofte, testleads tellen niet', () => {
  const o = bouwOverzicht({ ...opzet(), nu: NU });
  const k = Object.fromEntries(o.kpi.map((r) => [r.sleutel, r]));
  assert.equal(k.totaal.leads, 6);
  assert.equal(k.minicursus.leads, 2, 'warm + geboekt (test telt niet)');
  assert.equal(k['7-daagse'].leads, 2);
  assert.equal(k.webinar.leads, 1, 'herkomst uit de marker van vóór de migratie');
  assert.equal(k['the-lab'].leads, 1);
  assert.equal(k.totaal.ingelogd, 4);
  assert.equal(k.totaal.video, 2);
  assert.equal(k.totaal.lab_afgewerkt, 1);
  assert.equal(k.totaal.geboekt, 1);
  assert.equal(o.leads.length, 7, 'de test staat wel in de lijst');
});

test('filter per product en hook', () => {
  const o = bouwOverzicht({ ...opzet(), nu: NU, filter: { product: 'minicursus' } });
  assert.deepEqual(o.leads.map((r) => r.email).sort(), ['geboekt@x.be', 'maxim.delombaerde96+t1@gmail.com', 'warm@x.be']);
  const h = bouwOverzicht({ ...opzet(), nu: NU, filter: { hook: 'H03' } });
  assert.deepEqual(h.leads.map((r) => r.email), ['lab@x.be']);
});

test('bellijst: warm eerst, dan ingelogd, dan niet ingelogd; nooit geboekt, test of zonder nummer', () => {
  const o = bouwOverzicht({ ...opzet(), nu: NU });
  assert.deepEqual(o.bellijst.map((r) => [r.email, r.bel_groep]), [
    ['lab@x.be', 'warm'], ['warm@x.be', 'warm'], ['in@x.be', 'ingelogd'], ['niet@x.be', 'niet_ingelogd'],
  ]);
  assert.equal(belGroep({ is_test: false, geboekt: false, klant: false, afgemeld: true, telefoon: '+32', lab: {}, videos: 5 }), null, 'afgemeld = niet bellen');
});

test('bellijst: wie de laatste 24u al gebeld werd, schuift achteraan in zijn groep', () => {
  const o = bouwOverzicht({ ...opzet(), nu: NU, laatsteBel: new Map([['lab@x.be', { op: '2026-10-28T08:00:00Z', resultaat: 'voicemail' }]]) });
  assert.deepEqual(o.bellijst.slice(0, 2).map((r) => r.email), ['warm@x.be', 'lab@x.be']);
});

test('chips: niet ingelogd / ingelogd / video\'s / Lab / geboekt / verlopen', () => {
  const o = bouwOverzicht({ ...opzet(), nu: Date.parse('2026-11-05T10:00:00Z') });
  const r = (e) => o.leads.find((x) => x.email === e).chips.map((c) => c.code);
  assert.deepEqual(r('warm@x.be'), ['ingelogd', 'video', 'verlopen']);
  assert.deepEqual(r('lab@x.be'), ['ingelogd', 'lab_af', 'verlopen']);
  assert.deepEqual(r('geboekt@x.be'), ['geboekt', 'ingelogd', 'verlopen']);
  assert.deepEqual(r('niet@x.be'), ['niet_ingelogd', 'verlopen']);
  assert.deepEqual(o.leads.find((x) => x.email === 'warm@x.be').video_titels, ['Market Structure', 'Fibonacci']);
  assert.equal(statusChips({ ingelogd: true, videos: 0, lab: { gestart: true, stap: 4, stappen: 25 } })[1].label, 'Lab · stap 4/25');
});

test('CSV: puntkomma, kop + één regel per lead, citeert waar nodig', () => {
  const o = bouwOverzicht({ ...opzet(), nu: NU, laatsteBel: new Map([['warm@x.be', { op: '2026-10-27T15:00:00Z', resultaat: 'terugbellen', notitie: 'na 18u; "liefst" bellen' }]]) });
  const csv = bellijstCsv(o.bellijst).split('\n');
  assert.equal(csv.length, 5);
  assert.match(csv[0], /^groep;naam;telefoon;email/);
  assert.match(csv[2], /terugbellen;"na 18u; ""liefst"" bellen"$/);
});

test('belpoging: validatie', () => {
  assert.equal(valideerBelpoging({ email: 'x@y.be', resultaat: 'gesproken' }).ok, true);
  assert.equal(valideerBelpoging({ email: 'x', resultaat: 'gesproken' }).ok, false);
  assert.equal(valideerBelpoging({ email: 'x@y.be', resultaat: 'onzin' }).ok, false);
  assert.equal(valideerBelpoging({ email: 'X@Y.be', resultaat: 'voicemail', lead_id: 'geen-uuid' }).rij.lead_id, null);
});

test('al student (resultaat al_toegang, geen lab-account): apart, niet in KPI, lijst of bellijst', () => {
  const { aanmeldingen, standPerEmail } = opzet();
  aanmeldingen.push(A('a-stud', 'student@x.be', { product: 'minicursus', resultaat: 'al_toegang', mail_status: 'verstuurd' }));
  const o = bouwOverzicht({ aanmeldingen, standPerEmail, nu: NU });
  assert.deepEqual(o.al_student.map((r) => [r.email, r.chips[0].label]), [['student@x.be', 'Al student']]);
  assert.ok(!o.leads.some((r) => r.email === 'student@x.be'));
  assert.ok(!o.bellijst.some((r) => r.email === 'student@x.be'));
  assert.equal(o.kpi.find((k) => k.sleutel === 'totaal').leads, 6, 'telt niet mee');
});

test('laatste bericht: de welkomstmail als er nog geen motorbericht is; het nieuwste wint', () => {
  const { aanmeldingen, standPerEmail } = opzet();
  aanmeldingen.find((a) => a.id === 'a-in').mail_status = 'verstuurd';
  aanmeldingen.find((a) => a.id === 'a-in').resultaat = 'nieuw_account';
  let o = bouwOverzicht({ aanmeldingen, standPerEmail, nu: NU });
  assert.deepEqual(o.leads.find((r) => r.email === 'in@x.be').laatste_bericht, { stap: 'welkom', kanaal: 'mail', op: '2026-10-26T10:00:00Z' });
  o = bouwOverzicht({ aanmeldingen, standPerEmail, nu: NU, laatsteMotor: new Map([['in@x.be', { stap: 'niet-ingelogd-24u', kanaal: 'mail', op: '2026-10-27T10:00:00Z' }]]) });
  assert.equal(o.leads.find((r) => r.email === 'in@x.be').laatste_bericht.stap, 'niet-ingelogd-24u');
});
