// tests/dfo-lms-student.test.js
//
// Borgt de twee dingen die bij de dfo-lms-koppeling stil fout kunnen gaan:
//
//   1. product_soort. hlms_student.product_soort is `text` ZONDER CHECK, dus
//      de databank houdt een verkeerde waarde niet tegen. De studentkant
//      (trajectstand.ts) kent alleen 'mentorship' en 'membership'; al het
//      andere valt daar in 'onbekend' en dan ziet een betalende klant dat
//      zijn traject niet bekend is. Deze test borgt dat er nooit een derde
//      waarde uit de mapping komt — ook niet via de traject-key.
//   2. De datum-rekenkunde van het toegangsvenster (maand-clamp).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bepaalProductSoort, bepaalCallsTotaal } from '../api/_lib/dfo-lms-student.js';
import { addMonths, parseDatumUtc, berekenLmsVenster } from '../api/_lib/onboarding-window.js';
import { isUniqueViolation } from '../api/_lib/dfo-lms-db.js';

// ── 1) product_soort: strikte woordenlijst ──────────────────────────────────

test('product_soort: 1op1 wordt mentorship', () => {
  assert.equal(bepaalProductSoort({ type: '1op1' }), 'mentorship');
});

test('product_soort: membership blijft membership', () => {
  assert.equal(bepaalProductSoort({ type: 'membership' }), 'membership');
});

test('product_soort: hoofdletters en spaties worden genormaliseerd', () => {
  assert.equal(bepaalProductSoort({ type: '  MemberShip ' }), 'membership');
  assert.equal(bepaalProductSoort({ type: '1OP1' }), 'mentorship');
});

test('product_soort: traject-key glipt er NIET doorheen als terugval', () => {
  // Dit was de oude bug: type onbekend -> key doorgeven -> derde waarde in
  // de databank -> student ziet 'onbekend'. Moet nu null zijn zodat de
  // aanmaak luidruchtig faalt.
  assert.equal(bepaalProductSoort({ type: null, key: '1-op-1-coaching-12m' }), null);
  assert.equal(bepaalProductSoort({ type: '', key: 'membership-jaar' }), null);
});

test('product_soort: onbekend type geeft null, nooit een gok', () => {
  for (const t of ['coaching', 'alpha', 'lidmaatschap', 'mentorship-plus', 'onbekend', undefined]) {
    assert.equal(bepaalProductSoort({ type: t }), null, 'type=' + String(t));
  }
  assert.equal(bepaalProductSoort(null), null);
});

test('product_soort: geeft ALLEEN ooit mentorship of membership terug', () => {
  const toegestaan = new Set(['mentorship', 'membership', null]);
  const proef = ['1op1', '1-op-1', 'mentorship', 'membership', 'MEMBERSHIP',
    'rommel', '', null, undefined, '  ', '1op1 ', 'student'];
  for (const t of proef) {
    assert.ok(toegestaan.has(bepaalProductSoort({ type: t })), 'onverwachte waarde voor ' + String(t));
  }
});

// ── 2) calls_totaal ─────────────────────────────────────────────────────────

test('calls_totaal: calls wint van alpha_calls_total', () => {
  assert.equal(bepaalCallsTotaal({ calls: 24, alpha_calls_total: 48 }, 'mentorship'), 24);
});

test('calls_totaal: valt terug op alpha_calls_total', () => {
  assert.equal(bepaalCallsTotaal({ calls: null, alpha_calls_total: 48 }, 'mentorship'), 48);
});

test('calls_totaal: mentorship zonder aantal geeft null (geen 0 als sentinel)', () => {
  // 0 zou hier betekenen dat een 1-op-1-klant zijn traject als "0 calls" ziet.
  // Liever null, zodat de aanmaak luidruchtig stopt.
  assert.equal(bepaalCallsTotaal({ calls: 0, alpha_calls_total: 0 }, 'mentorship'), null);
  assert.equal(bepaalCallsTotaal({}, 'mentorship'), null);
  assert.equal(bepaalCallsTotaal(null, 'mentorship'), null);
});

test('calls_totaal: membership geeft ALTIJD 0, nooit null', () => {
  // Dit was de bug van 9 september: hlms_student.calls_totaal staat op NOT
  // NULL, en een membership-traject heeft geen calls — dus rolde er null uit
  // en sloeg de insert af op de constraint. Zie
  // tests/dfo-lms-membership-calls.test.js voor de hele weg.
  for (const t of [{}, null, { calls: null, alpha_calls_total: null },
    { calls: 0 }, { calls: 12, alpha_calls_total: 24 }]) {
    assert.equal(bepaalCallsTotaal(t, 'membership'), 0,
      'membership hoort 0 te geven voor ' + JSON.stringify(t));
  }
});

test('calls_totaal: membership geeft een GETAL, niet iets dat op 0 lijkt', () => {
  // null, undefined en '' laten de kolom allemaal vallen en dan slaat
  // dezelfde constraint alsnog toe.
  const uit = bepaalCallsTotaal({}, 'membership');
  assert.equal(typeof uit, 'number');
  assert.ok(Number.isFinite(uit));
});

// ── 3) Datum-rekenkunde ─────────────────────────────────────────────────────

test('addMonths klemt op de laatste dag van de doelmaand', () => {
  // 31 januari + 1 maand mag geen 2/3 maart worden.
  const uit = addMonths(new Date('2026-01-31T00:00:00Z'), 1);
  assert.equal(uit.toISOString().slice(0, 10), '2026-02-28');
});

test('addMonths met schrikkeljaar', () => {
  const uit = addMonths(new Date('2024-01-31T00:00:00Z'), 1);
  assert.equal(uit.toISOString().slice(0, 10), '2024-02-29');
});

test('addMonths negeert negatieve en onzinnige maanden', () => {
  const basis = new Date('2026-03-15T00:00:00Z');
  assert.equal(addMonths(basis, -3).toISOString(), basis.toISOString());
  assert.equal(addMonths(basis, null).toISOString(), basis.toISOString());
});

test('parseDatumUtc leest een date-kolom als UTC-middernacht', () => {
  // Zonder expliciete UTC-suffix zou dit bij negatieve offsets een dag
  // verschuiven; dat is exact de off-by-one uit de lessons learned.
  assert.equal(parseDatumUtc('2026-09-05').toISOString(), '2026-09-05T00:00:00.000Z');
  assert.equal(parseDatumUtc(null), null);
  assert.equal(parseDatumUtc('rommel'), null);
});

test('berekenLmsVenster: start + duur geeft einddatum', () => {
  const { startIso, eindIso } = berekenLmsVenster({ startDate: '2026-09-05', duurMaanden: 12 });
  assert.equal(startIso, '2026-09-05T00:00:00.000Z');
  assert.equal(eindIso.slice(0, 10), '2027-09-05');
});

test('berekenLmsVenster: zonder duur GEEN verzonnen einddatum', () => {
  const { eindIso } = berekenLmsVenster({ startDate: '2026-09-05', duurMaanden: null });
  assert.equal(eindIso, null);
  assert.equal(berekenLmsVenster({ startDate: '2026-09-05', duurMaanden: 0 }).eindIso, null);
});

test('berekenLmsVenster: startdatum in het verleden blijft de ECHTE startdatum', () => {
  // Wijkt bewust af van de Bubble-variant, die naar now schuift. Een
  // studentrij legt een administratief feit vast; bij de handmatige knop op
  // een bestaande onboarding is dat de oorspronkelijke startdatum.
  const { startIso } = berekenLmsVenster({ startDate: '2024-01-10', duurMaanden: 6 });
  assert.equal(startIso, '2024-01-10T00:00:00.000Z');
});

// ── 4) Unique-violation herkenning ──────────────────────────────────────────

test('isUniqueViolation herkent 23505 en niets anders', () => {
  assert.equal(isUniqueViolation({ code: '23505' }), true);
  assert.equal(isUniqueViolation({ code: 23505 }), true);   // niet-string variant
  assert.equal(isUniqueViolation({ code: '23503' }), false); // FK-schending
  assert.equal(isUniqueViolation({ message: 'duplicate key' }), false);
  assert.equal(isUniqueViolation(null), false);
});

// ── 5) VORM-CONTRACT van provisionDfoLmsStudent ─────────────────────────────
//
// Deze tests repareren niet één fout maar sluiten een SOORT fout uit.
//
// Aanleiding (6 september 2026): het 'al gekoppeld'-uitstappad gaf wél
// ok:true maar geen `email`. De aanroeper heeft dat adres nodig om de
// LMS-uitnodiging te versturen, dus die sloeg de aanroep over — met de
// melding 'geen studentrij', terwijl het bestaan van die rij juist de oorzaak
// was. De knop had daardoor nooit gewerkt.
//
// Een test die alleen controleert dat het NU werkt, vangt de volgende keer
// niet. Daarom dwingen we hieronder af dat élk geslaagd pad door
// succesResultaat() gaat: wie later een vijfde pad toevoegt met een eigen
// object-literal, laat deze test falen.

import { readFileSync } from 'node:fs';
import { succesResultaat } from '../api/_lib/dfo-lms-student.js';
import { verklaarNietGebeld } from '../api/onboarding-dfo-lms-provision.js';

const BRON = readFileSync(
  new URL('../api/_lib/dfo-lms-student.js', import.meta.url), 'utf8');

/** Alleen de body van provisionDfoLmsStudent — andere functies hebben een
 *  eigen contract (syncDfoLmsMentor geeft bv. geen student terug). */
function bodyVanProvision() {
  const start = BRON.indexOf('export async function provisionDfoLmsStudent(');
  assert.ok(start > -1, 'provisionDfoLmsStudent niet gevonden in de bron');
  const na = BRON.indexOf('\nexport ', start + 10);
  return na > -1 ? BRON.slice(start, na) : BRON.slice(start);
}

test('CONTRACT: geen enkel geslaagd pad bouwt zijn eigen object-literal', () => {
  const body = bodyVanProvision();
  const rauw = body.match(/return\s*\{[\s\S]{0,220}?ok:\s*true/g) || [];
  assert.deepEqual(
    rauw, [],
    'Gevonden: een `return { ok: true, ... }` in provisionDfoLmsStudent.\n'
    + 'Gebruik succesResultaat({ studentId, email, ... }) — anders kan een pad\n'
    + 'opnieuw stilzwijgend `email` vergeten en werkt de uitnodigingsknop niet.\n'
    + 'Gevonden fragment(en):\n' + rauw.join('\n---\n'),
  );
});

test('CONTRACT: er zijn meerdere geslaagde paden en die gaan allemaal via de bouwer', () => {
  const body = bodyVanProvision();
  const viaBouwer = (body.match(/return\s+succesResultaat\(/g) || []).length;
  assert.ok(viaBouwer >= 4,
    'Verwacht minstens 4 succes-paden via succesResultaat(), gevonden: ' + viaBouwer
    + '. Is er een pad verdwenen, of gaat er eentje buitenom?');
});

test('CONTRACT: het al-gekoppeld-pad geeft email mee', () => {
  const body = bodyVanProvision();
  const i = body.indexOf('dfo_lms_provisioned === true');
  assert.ok(i > -1, 'de al-gekoppeld-controle is niet meer te vinden');
  const tak = body.slice(i, i + 400);
  assert.match(tak, /succesResultaat\(/,
    'het al-gekoppeld-pad bouwt zijn resultaat niet via succesResultaat()');
  assert.match(tak, /email/,
    'het al-gekoppeld-pad geeft geen email mee — precies de fout van 6 september');
});

// ── 6) succesResultaat zelf ─────────────────────────────────────────────────

test('succesResultaat levert altijd ok + student_id + email', () => {
  const r = succesResultaat({ studentId: 'stud-1', email: 'a@b.nl', created: true });
  assert.equal(r.ok, true);
  assert.equal(r.student_id, 'stud-1');
  assert.equal(r.email, 'a@b.nl');
  assert.equal(r.created, true);
});

test('succesResultaat weigert een "succes" zonder email', () => {
  const r = succesResultaat({ studentId: 'stud-1', email: '' });
  assert.equal(r.ok, false, 'zonder email is het geen geldig succes');
  assert.match(r.error, /email/);
});

test('succesResultaat weigert een "succes" zonder student_id', () => {
  const r = succesResultaat({ studentId: null, email: 'a@b.nl' });
  assert.equal(r.ok, false);
  assert.match(r.error, /student_id/);
});

// ── 7) Meldingen mogen niets beweren wat niet gemeten is ────────────────────

test('verklaarNietGebeld: bij een geldig resultaat is er GEEN reden', () => {
  assert.equal(
    verklaarNietGebeld({ ok: true, student_id: 's', email: 'a@b.nl' }),
    null, 'hier had de uitnodiging wél verstuurd moeten worden');
});

test('verklaarNietGebeld: zegt NOOIT "geen studentrij" als die rij er is', () => {
  const uitleg = verklaarNietGebeld({ ok: true, student_id: 'stud-9', email: null });
  assert.doesNotMatch(uitleg, /geen studentrij/i,
    'de rij bestaat — dit was precies de misleidende melding van 6 september');
  assert.match(uitleg, /stud-9/, 'noem het student-id dat wél gemeten is');
  assert.match(uitleg, /e-mailadres/);
});

test('verklaarNietGebeld: benoemt een mislukte koppeling met de echte reden', () => {
  const uitleg = verklaarNietGebeld({ ok: false, error: 'onbekend traject-type' });
  assert.match(uitleg, /niet geslaagd/);
  assert.match(uitleg, /onbekend traject-type/);
});

test('verklaarNietGebeld: ontbrekend student-id wordt als zodanig benoemd', () => {
  const uitleg = verklaarNietGebeld({ ok: true, student_id: null, email: 'a@b.nl' });
  assert.match(uitleg, /geen student-id/);
});

test('verklaarNietGebeld: geen resultaat is ook een eerlijke melding', () => {
  assert.match(verklaarNietGebeld(null), /geen resultaat/);
});
