// tests/opvolging-leads-pot.test.js
//
// 'Leads bellen' — de pot, de warmtescore en de potten van de kaarten.
// Alles puur: zie api/_lib/opvolging-leads-pot.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stelPottenSamen, berekenWarmte, warmteLabel, potVoorKaart, beslisKandidaat,
  beoordeelAfronden, valideerAfronden, productVan, isProefLead, naamVan, proefDuur,
  beoordeelCalls, gespreksopener, normaliseerTrial, resterendeUren, inspanningTekst,
  dagInZone, POTTEN, UITSLUITREDENEN,
} from '../api/_lib/opvolging-leads-pot.js';
import { terugNaWachtPatch } from '../api/_lib/opvolging-doorrol.js';
import { telPogingen } from '../api/_lib/opvolging-poging-telling.js';

const NU = Date.parse('2026-10-02T10:00:00Z');
const VANDAAG = dagInZone(NU);
const dagenTerug = (n) => new Date(NU - n * 86400000).toISOString();

let teller = 0;
const lead = (o = {}) => ({
  id: o.id || ('00000000-0000-4000-8000-' + String(++teller).padStart(12, '0')),
  voornaam: 'Jan', achternaam: 'Peeters', email: 'jan' + teller + '@voorbeeld.be', telefoon_e164: '+3247000' + String(1000 + teller),
  traject: 'minicursus', bron: 'kennismakingscursus-v2', kwalificatie: null,
  aangemaakt: dagenTerug(1), customer_id: null, verwijderd_op: null, ...o,
});

// ═══════════════════════════════════════════════════════════════════════════
// UITSLUITEN — ELK PAD, EN DE TELLING ERVAN
// ═══════════════════════════════════════════════════════════════════════════

test('elk uitsluitpad telt mee in "niet getoond", niets valt stil weg', () => {
  const klant = lead({ customer_id: 'c1' });
  const zonderTel = lead({ telefoon_e164: null, telefoon: null });
  const komend = lead();
  const uitkomst = lead();
  const opDag = lead();
  const metKaart = lead();
  const weg = lead();
  const goed = lead();
  const afspraken = [
    { id: 'a1', lead_phone: komend.telefoon_e164, status: 'scheduled', scheduled_at: new Date(NU + 86400000).toISOString() },
    { id: 'a2', lead_phone: null, lead_email: uitkomst.email, status: 'completed', scheduled_at: dagenTerug(3), uitkomst: 'geen_klant' },
  ];
  const kaarten = [
    { id: 'k1', lead_id: metKaart.id, status: 'open', due: VANDAAG, lijst: 'leads', created_at: dagenTerug(0) },
    { id: 'k2', lead_id: weg.id, status: 'gearchiveerd', gearchiveerd_at: dagenTerug(1), lijst: 'leads', created_at: dagenTerug(2) },
  ];
  const o = stelPottenSamen({
    leads: [klant, zonderTel, komend, uitkomst, opDag, metKaart, weg, goed],
    kaarten, afspraken, daglijstTelefoons: ['0' + opDag.telefoon_e164.slice(3)], nuMs: NU,
  });
  assert.deepEqual(o.potten.nieuw.map((r) => r.lead_id), [goed.id]);
  const per = Object.fromEntries(o.niet_getoond.map((r) => [r.code, r.aantal]));
  assert.deepEqual(per, {
    geen_telefoon: 1, al_klant: 1, weggegooid: 1, eigen_kaart: 1,
    komende_call: 1, call_uitkomst: 1, op_daglijst: 1,
  });
  // elke regel heeft een leesbare zin
  for (const r of o.niet_getoond) assert.equal(r.tekst, UITSLUITREDENEN[r.code]);
  // de eigen kaart staat in zijn pot, de weggegooide in Afgerond
  assert.equal(o.potten.bezig.length, 1);
  assert.equal(o.potten.afgerond.length, 1);
});

test('een geannuleerde of no-show call houdt de lead IN de pot, met tag', () => {
  const a = lead(), b = lead();
  const o = stelPottenSamen({
    leads: [a, b], nuMs: NU,
    afspraken: [
      { id: 'x', lead_phone: a.telefoon_e164, status: 'cancelled', scheduled_at: dagenTerug(5) },
      { id: 'y', lead_phone: b.telefoon_e164, status: 'no_show', scheduled_at: dagenTerug(5) },
    ],
  });
  assert.equal(o.potten.nieuw.length, 2);
  const tags = o.potten.nieuw.flatMap((r) => r.chips.map((c) => c.tekst));
  assert.ok(tags.includes('annuleerde eerder een call'));
  assert.ok(tags.includes('kwam niet opdagen'));
});

test('een call die 1 uur geleden begon telt nog als komend (2u speling)', () => {
  const c = beoordeelCalls([{ status: 'in_progress', scheduled_at: new Date(NU - 3600000).toISOString() }], NU);
  assert.equal(c.komend, true);
  const d = beoordeelCalls([{ status: 'scheduled', scheduled_at: new Date(NU - 3 * 3600000).toISOString() }], NU);
  assert.equal(d.komend, false);
});

test('testafspraken tellen niet mee', () => {
  const c = beoordeelCalls([{ status: 'completed', is_test: true, scheduled_at: dagenTerug(1) }], NU);
  assert.equal(c.met_uitkomst, false);
});

test('het daglijstfilter matcht op de laatste 9 cijfers (lokaal genoteerd telt mee)', () => {
  const l = lead({ telefoon_e164: '+32471234567' });
  const r = beslisKandidaat({ lead: l, calls: {}, kaart: null, daglijstStaarten: new Set(['471234567']) });
  assert.deepEqual(r, { in: false, reden: 'op_daglijst' });
});

test('alleen proefleads: traject of bron', () => {
  assert.equal(isProefLead({ traject: 'Minicursus' }), true);
  assert.equal(isProefLead({ traject: null, bron: '7-daagse-website' }), true);
  assert.equal(isProefLead({ traject: 'Membership', bron: 'event' }), false);
});

test('geen testfilter op leads (geen kolom), maar testafspraken tellen niet', () => {
  const t = lead({ voornaam: 'Test', email: 'test@example.com' });
  const o = stelPottenSamen({ leads: [t], nuMs: NU,
    afspraken: [{ id: 'z', lead_phone: t.telefoon_e164, status: 'scheduled', is_test: true, scheduled_at: new Date(NU + 86400000).toISOString() }] });
  assert.equal(o.potten.nieuw.length, 1);
});

test('naam uit voornaam + achternaam; looptijd uit toegang of product', () => {
  assert.equal(naamVan({ voornaam: 'An', achternaam: 'Smet' }), 'An Smet');
  assert.equal(naamVan({ naam: 'Uit kaart' }), 'Uit kaart');
  assert.equal(proefDuur(normaliseerTrial({ toegang_van: '2026-10-01', toegang_tot: '2026-10-08' }), 'Minicursus'), 7);
  assert.equal(proefDuur(null, 'Minicursus'), 30);
  assert.equal(proefDuur(null, '7-daagse'), 7);
});

test('product en variant uit traject en bron', () => {
  assert.deepEqual(productVan({ traject: 'minicursus', bron: 'kennismakingscursus-v3' }),
    { product: 'Minicursus', variant: 'v3', label: 'Minicursus · v3' });
  assert.deepEqual(productVan({ traject: '7-daagse', bron: '7-daagse-website' }),
    { product: '7-daagse', variant: 'website', label: '7-daagse · website' });
});

// ═══════════════════════════════════════════════════════════════════════════
// WARMTE — DE GRENZEN
// ═══════════════════════════════════════════════════════════════════════════

const w = (o) => berekenWarmte({ vandaag: VANDAAG, calls: {}, trial: null, ...o });
const aangemeld = (dagen) => ({ aangemaakt: new Date(Date.parse(VANDAAG + 'T10:00:00Z') - dagen * 86400000).toISOString() });

test('recentheid: ≤2d +30 · 3–7d +20 · 8–14d +10 · 15–30d +5 · ouder 0', () => {
  const s = (d) => w({ lead: aangemeld(d) }).score;
  assert.equal(s(0), 30); assert.equal(s(2), 30);
  assert.equal(s(3), 20); assert.equal(s(7), 20);
  assert.equal(s(8), 10); assert.equal(s(14), 10);
  assert.equal(s(15), 5); assert.equal(s(30), 5);
  assert.equal(s(31), 0);
});

test('LMS-score × 1,5 met een plafond van 40', () => {
  const s = (sc) => w({ lead: aangemeld(40), trial: normaliseerTrial({ score: sc }) }).score;
  assert.equal(s(10), 15);
  assert.equal(s(26), 39);
  assert.equal(s(27), 40);
  assert.equal(s(45), 40);
});

test('laatst actief ≤ 3 dagen +10, 4 dagen niet', () => {
  const s = (d) => w({ lead: aangemeld(40), trial: normaliseerTrial({ laatst_actief: new Date(NU - d * 86400000).toISOString() }) }).score;
  assert.equal(s(3), 10);
  assert.equal(s(4), 0);
});

test('kwalificatie: toegang +10, geen toegang −10, nooit onder 0', () => {
  assert.equal(w({ lead: { ...aangemeld(40), kwalificatie: 'toegang' } }).score, 10);
  assert.equal(w({ lead: { ...aangemeld(5), kwalificatie: 'geen toegang' } }).score, 10);
  assert.equal(w({ lead: { ...aangemeld(40), kwalificatie: 'geen toegang' } }).score, 0);
});

test('eerdere annulering of no-show +10 (één keer, ook bij beide)', () => {
  assert.equal(w({ lead: aangemeld(40), calls: { annuleerde: true } }).score, 10);
  assert.equal(w({ lead: aangemeld(40), calls: { annuleerde: true, no_show: true } }).score, 10);
});

test('toegang loopt af (0–2 d) of verliep ≤ 7 d geleden: +5, anders niet', () => {
  const s = (d) => w({ lead: aangemeld(40), trial: normaliseerTrial({ dagen_over: d }) });
  assert.equal(s(2).score, 5); assert.equal(s(0).score, 5); assert.equal(s(3).score, 0);
  assert.equal(s(-7).score, 5); assert.equal(s(-8).score, 0);
  assert.ok(s(1).chips.some((c) => c.tekst === 'toegang loopt af'));
  assert.ok(s(-1).chips.some((c) => c.tekst === 'toegang verlopen'));
});

test('labels: ≥60 heet · 35–59 warm · 15–34 lauw · <15 koud', () => {
  assert.equal(warmteLabel(60).code, 'heet'); assert.equal(warmteLabel(59).code, 'warm');
  assert.equal(warmteLabel(35).code, 'warm'); assert.equal(warmteLabel(34).code, 'lauw');
  assert.equal(warmteLabel(15).code, 'lauw'); assert.equal(warmteLabel(14).code, 'koud');
});

test('maximaal 100, en elke punt heeft een reden', () => {
  const r = w({
    lead: { ...aangemeld(0), kwalificatie: 'toegang' },
    trial: normaliseerTrial({ score: 40, laatst_actief: new Date(NU).toISOString(), dagen_over: 1 }),
    calls: { annuleerde: true },
  });
  assert.equal(r.score, 100);
  assert.equal(r.redenen.reduce((n, x) => n + x.punten, 0) >= 100, true);
});

test('"nog niet ingelogd" alleen als dat echt gemeten is', () => {
  const nee = w({ lead: aangemeld(1), trial: normaliseerTrial({ ooit_ingelogd: false }) });
  assert.ok(nee.chips.some((c) => c.tekst === 'nog niet ingelogd'));
  const onbekend = w({ lead: aangemeld(1), trial: normaliseerTrial({ score: 3 }) });
  assert.ok(!onbekend.chips.some((c) => /ingelogd/.test(c.tekst)));
});

test('sortering: score aflopend, dan recentste aanmelding', () => {
  const oud = lead({ aangemaakt: dagenTerug(4) });   // +20
  const nieuw = lead({ aangemaakt: dagenTerug(5) }); // +20
  const heet = lead({ aangemaakt: dagenTerug(0) });  // +30
  const o = stelPottenSamen({ leads: [nieuw, oud, heet], nuMs: NU });
  assert.deepEqual(o.potten.nieuw.map((r) => r.lead_id), [heet.id, oud.id, nieuw.id]);
});

test('gespreksopener volgt de data', () => {
  assert.match(gespreksopener({ trial: { ooit_ingelogd: false }, calls: {}, vandaag: VANDAAG }), /Nog niet ingelogd/);
  assert.match(gespreksopener({ trial: { dagen_over: 2 }, calls: {}, vandaag: VANDAAG }), /overmorgen/);
  assert.match(gespreksopener({ trial: {}, calls: { annuleerde: true }, vandaag: VANDAAG }), /Annuleerde eerder/);
  assert.match(gespreksopener({ trial: { lessen: 3, laatst_actief: new Date(NU - 86400000).toISOString() }, calls: {}, vandaag: VANDAAG }), /Bekeek 3 lessen, laatst gisteren/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE POTTEN VAN DE KAARTEN
// ═══════════════════════════════════════════════════════════════════════════

test('potVoorKaart: elke status naar zijn pot', () => {
  const k = (o) => potVoorKaart({ status: 'open', due: VANDAAG, ...o }, VANDAAG, NU);
  assert.equal(k({ reden_code: 'terugbellen' }), 'terugbellen');
  assert.equal(k({ reden_code: 'inplantermijn_verlopen' }), 'verlopen');
  assert.equal(k({}), 'bezig');
  assert.equal(k({ due: '2026-10-09', reden_code: 'terugbellen' }), 'later');
  assert.equal(k({ status: 'wacht_inplanning' }), 'wacht');
  assert.equal(k({ status: 'ingepland', afspraak_gevonden_at: dagenTerug(29) }), 'ingepland');
  assert.equal(k({ status: 'ingepland', afspraak_gevonden_at: dagenTerug(31) }), null);
  assert.equal(k({ status: 'gearchiveerd', gearchiveerd_at: dagenTerug(59) }), 'afgerond');
  assert.equal(k({ status: 'gearchiveerd', gearchiveerd_at: dagenTerug(61) }), null);
});

test('terugbellen en verlopen staan apart van nieuw, en de badge telt ze plus nieuw-heet', () => {
  const a = lead(), b = lead(), c = lead({ aangemaakt: dagenTerug(0), kwalificatie: 'toegang' });
  const o = stelPottenSamen({
    leads: [a, b, c], nuMs: NU,
    trialPerLead: new Map([[c.id, normaliseerTrial({ score: 20 })]]),
    kaarten: [
      { id: 't1', lead_id: a.id, status: 'open', due: VANDAAG, reden_code: 'terugbellen', created_at: dagenTerug(1) },
      { id: 't2', lead_id: b.id, status: 'open', due: VANDAAG, reden_code: 'inplantermijn_verlopen', created_at: dagenTerug(3) },
    ],
  });
  assert.equal(o.aantallen.terugbellen, 1);
  assert.equal(o.aantallen.verlopen, 1);
  assert.equal(o.aantallen.nieuw, 1);
  assert.equal(o.potten.nieuw[0].label.code, 'heet');
  assert.equal(o.badge, 3);
  assert.deepEqual(Object.keys(o.aantallen), POTTEN);
});

test('resterende uren van de 48', () => {
  assert.equal(resterendeUren({ agenda_doorgestuurd_at: new Date(NU - 10 * 3600000).toISOString() }, NU), 38);
  assert.equal(resterendeUren({ agenda_doorgestuurd_at: new Date(NU - 50 * 3600000).toISOString() }, NU), 0);
});

test('dagstatistiek telt de pogingen van leadkaarten van vandaag', () => {
  const tijd = new Date(NU - 3600000).toISOString();
  const pog = [
    { soort: 'call', richting: 'uit', resultaat: 'gesproken', tijdstip: tijd },
    { soort: 'call', richting: 'uit', resultaat: 'niet opgenomen', tijdstip: tijd },
    { soort: 'whatsapp', richting: 'uit', tijdstip: tijd },
    { soort: 'whatsapp', richting: 'in', tijdstip: tijd },
    { soort: 'agenda_doorgestuurd', tijdstip: tijd },
  ];
  const kaarten = [{ id: 'k', lead_id: null, status: 'wacht_inplanning', due: VANDAAG, naam: 'X', agenda_doorgestuurd_at: tijd }];
  const o = stelPottenSamen({ kaarten, telPerKaart: new Map([['k', { pogingen: pog }]]), nuMs: NU });
  assert.deepEqual(o.dag, { gebeld: 2, gesproken: 1, whatsapps: 1, doorgestuurd: 1, ingepland: 0, afgerond: 0 });
  assert.deepEqual(o.week, { doorgestuurd: 1, ingepland: 0, pct: 0 });
});

// ═══════════════════════════════════════════════════════════════════════════
// AFRONDEN
// ═══════════════════════════════════════════════════════════════════════════

test('afronden: categorie en notitie (≥15 tekens) verplicht', () => {
  assert.match(valideerAfronden({ categorie: null, notitie: 'x'.repeat(20) }), /categorie/);
  assert.match(valideerAfronden({ categorie: 'onzin', notitie: 'x'.repeat(20) }), /categorie/);
  assert.match(valideerAfronden({ categorie: 'geen_interesse', notitie: 'te kort' }), /15 tekens/);
  assert.equal(valideerAfronden({ categorie: 'geen_interesse', notitie: 'Wil echt niet verder, zegt hij.' }), null);
});

test('drempel: ≥2 belpogingen op ≥2 dagen én ≥1 WhatsApp, met uitzonderingen', () => {
  assert.equal(beoordeelAfronden({ bel_totaal: 2, bel_dagen: 2, wa_totaal: 1, categorie: 'niet_bereikbaar' }).genoeg, true);
  const te = beoordeelAfronden({ bel_totaal: 2, bel_dagen: 1, wa_totaal: 0, categorie: 'niet_bereikbaar' });
  assert.equal(te.genoeg, false);
  assert.equal(te.tekort.length, 2);
  assert.equal(beoordeelAfronden({ bel_totaal: 0, categorie: 'foutief_nummer' }).genoeg, true);
  assert.equal(beoordeelAfronden({ bel_totaal: 0, categorie: 'al_klant' }).genoeg, true);
  assert.equal(beoordeelAfronden({ bel_totaal: 1, bel_dagen: 1, gesproken: true, categorie: 'geen_interesse' }).genoeg, true);
});

test('inspanning in één zin', () => {
  assert.equal(inspanningTekst({ bel_totaal: 2, bel_dagen: 1, wa_totaal: 0 }), '2× gebeld op 1 dag, 0 WhatsApps, nooit gesproken');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE 48-UURCONTROLE: LEADKAART TEGENOVER DAGLIJST
// ═══════════════════════════════════════════════════════════════════════════

test('wacht-check verlopen-tak: leadkaart houdt reden lead_bellen, daglijst wordt niet_ingepland', () => {
  const lead = terugNaWachtPatch({ taak: { lijst: 'leads', notitie: 'oud' }, vandaag: VANDAAG, regel: 'nieuw' });
  assert.equal(lead.status, 'open');
  assert.equal(lead.due, VANDAAG);
  assert.equal(lead.reden, undefined, 'reden blijft lead_bellen — niet overschrijven');
  assert.equal(lead.reden_code, 'inplantermijn_verlopen');
  assert.equal(lead.badge_label, 'Inplantermijn verlopen');
  assert.equal(lead.notitie, 'nieuw\n\noud');

  const dag = terugNaWachtPatch({ taak: { lijst: 'dag' }, vandaag: VANDAAG, regel: 'nieuw' });
  assert.equal(dag.reden, 'niet_ingepland');
  assert.equal(dag.badge_label, 'Agenda doorgestuurd');
  assert.equal(dag.reden_code, undefined);
  // een rij zonder lijst (oud) is een daglijstkaart
  assert.equal(terugNaWachtPatch({ taak: {}, vandaag: VANDAAG, regel: 'x' }).reden, 'niet_ingepland');
});

// ═══════════════════════════════════════════════════════════════════════════
// AGENDA DOORSTUREN TELT ALS ÉÉN WHATSAPP
// ═══════════════════════════════════════════════════════════════════════════

test('doorsturen + het WA-bericht van de webhook = één WhatsApp in telPogingen', () => {
  const t = '2026-10-02T09:00:00Z';
  const tel = telPogingen([
    { soort: 'agenda_doorgestuurd', resultaat: 'agenda doorgestuurd via WhatsApp', tijdstip: t, richting: 'uit' },
    { soort: 'whatsapp', resultaat: 'WhatsApp verstuurd', tijdstip: t, richting: 'uit' },
  ], '2026-10-02', (x) => String(x).slice(0, 10));
  assert.equal(tel.wa_totaal, 1);
  assert.equal(tel.wa_vandaag, 1);
});
