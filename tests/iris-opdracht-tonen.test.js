// tests/iris-opdracht-tonen.test.js
//
// Je moet kunnen zien wat Iris gedaan heeft (O-1).
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// Maxims enige opdracht stond op "Geregeld", en klapte je hem open dan stond er
// het woord "geregeld" en een knop "Terug openen". Meer niet.
//
// Niet omdat er niets was:
//
//   plan      (iris_opdrachten.plan)    geschreven, niet getoond
//   verloop   (iris_opdrachten.verloop) geschreven, niet getoond
//   resultaat (iris_acties.resultaat)   geschreven, niet getoond
//
// En het woord "geregeld" was `na_uitvoeren` -- een enum-waarde die cursief
// werd afgedrukt alsof het een zin was.
//
// Het plan-blok hing bovendien aan `acties.length`. Zijn er geen iris_acties --
// en dat is precies het geval bij een opdracht die nog op een antwoord wacht --
// dan viel het hele blok weg.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  STAP_LABELS,
  TAKEN_URL,
  naUitvoerenZin,
  resultaatRegels,
  bouwPlanRegels,
  bouwVerloop,
} from '../api/_lib/iris/opdracht-tekst.js';
import { STAPTYPES } from '../api/_lib/iris/opdracht.js';

// ── na_uitvoeren ─────────────────────────────────────────────────────────────

test('na_uitvoeren wordt een zin, geen enum-woord', () => {
  assert.match(naUitvoerenZin('wacht'), /in de gaten/);
  assert.match(naUitvoerenZin('geregeld'), /klaar/);
  // Geen van beide mag het kale woord teruggeven -- dat is precies wat er
  // cursief op het scherm stond.
  assert.notEqual(naUitvoerenZin('wacht'), 'wacht');
  assert.notEqual(naUitvoerenZin('geregeld'), 'geregeld');
});

test('een lege of onbekende na_uitvoeren geeft niets', () => {
  // Niets is beter dan een los woord: dan staat er tenminste geen zin die
  // niemand kan plaatsen.
  assert.equal(naUitvoerenZin(null), null);
  assert.equal(naUitvoerenZin(''), null);
  assert.equal(naUitvoerenZin('iets_anders'), null);
});

// ── de staplabels ────────────────────────────────────────────────────────────

test('elk staptype heeft een leesbaar label', () => {
  // Zonder dit staat er `lms_toegang_verlengen` op het scherm. Dat is een
  // sleutel uit een enum, geen taal.
  for (const t of STAPTYPES) {
    assert.ok(STAP_LABELS[t], `${t} heeft geen label`);
    assert.ok(!STAP_LABELS[t].includes('_'), `${t} leest nog als een sleutel`);
  }
});

// ── het resultaat per stap ───────────────────────────────────────────────────

test('een aangemaakte taak krijgt een link naar waar hij staat', () => {
  const r = resultaatRegels('taak_aanmaken', { taak_id: 'abc' });
  assert.equal(r.length, 1);
  assert.match(r[0].tekst, /Taak aangemaakt/);
  assert.equal(r[0].link.href, TAKEN_URL);
});

test('een verlenging toont was en wordt', () => {
  // Alleen "wordt" zou de vraag oproepen of er iets veranderd is.
  const r = resultaatRegels('lms_toegang_verlengen', { student_id: 1, was: '2026-09-01', wordt: '2026-09-15', dagen: 14 });
  assert.equal(r.length, 1);
  assert.match(r[0].tekst, /2026-09-15/);
  assert.match(r[0].tekst, /was 2026-09-01/);
});

test('een verlenging zonder eerdere einddatum zegt niet "was null"', () => {
  const r = resultaatRegels('lms_toegang_verlengen', { wordt: '2026-09-15' });
  assert.doesNotMatch(r[0].tekst, /was/);
});

test('een betaaltoezegging toont datum en bedrag', () => {
  const r = resultaatRegels('belofte_vastleggen', { belofte_id: 'x', datum: '2026-10-01', bedrag: 250 });
  assert.match(r[0].tekst, /2026-10-01/);
  assert.match(r[0].tekst, /250/);
});

test('een leeg of onbruikbaar resultaat geeft geen regels', () => {
  // Beter niets dan een blokje met {"iets":"onbekends"} erin.
  assert.deepEqual(resultaatRegels('taak_aanmaken', null), []);
  assert.deepEqual(resultaatRegels('taak_aanmaken', {}), []);
  assert.deepEqual(resultaatRegels('wa_versturen', 'geen object'), []);
});

// ── het plan ─────────────────────────────────────────────────────────────────

const PLAN = {
  titel: 'Opvolging advocaat',
  begrepen: 'De mail van de advocaat van Andy opvolgen.',
  stappen: [
    { type: 'taak_aanmaken', omschrijving: 'Taak: opvolging mail advocaat', wie: 'Andy' },
    { type: 'belrij_toevoegen', omschrijving: 'Andy op de belrij zetten' },
  ],
  raakt_groep: false,
};

test('HET PUNT: het plan is er ook zonder ook maar één iris_actie', () => {
  // Dit is de bug. Het blok hing aan acties.length, en een opdracht die nog op
  // een antwoord wacht heeft nul acties -- dus viel alles weg wat Iris bedacht
  // had, en hield je precies over wat Maxim zag.
  const r = bouwPlanRegels(PLAN, []);
  assert.equal(r.length, 2);
  assert.equal(r[0].stand, 'voorgenomen');
  assert.equal(r[0].omschrijving, 'Taak: opvolging mail advocaat');
  assert.equal(r[0].label, STAP_LABELS.taak_aanmaken);
});

test('een uitgevoerde stap draagt zijn resultaat mee', () => {
  const r = bouwPlanRegels(PLAN, [
    { id: 'a1', type: 'taak_aanmaken', status: 'uitgevoerd', resultaat: { taak_id: 't1' } },
  ]);
  assert.equal(r[0].stand, 'gedaan');
  assert.equal(r[0].actie_id, 'a1');
  assert.equal(r[0].resultaat[0].link.href, TAKEN_URL);
  // De tweede stap heeft nog geen actie en blijft voorgenomen.
  assert.equal(r[1].stand, 'voorgenomen');
});

test('klaargezet is iets anders dan voorgenomen', () => {
  // "Voorgenomen" betekent dat er nog niets klaarstaat om op te drukken,
  // "klaargezet" dat iemand op Uitvoeren moet. Die twee als hetzelfde tonen --
  // wat de grijze punt deed -- laat een opdracht er afgerond uitzien terwijl
  // er nog een klik ontbreekt.
  const r = bouwPlanRegels(PLAN, [{ id: 'a1', type: 'taak_aanmaken', status: 'gepland' }]);
  assert.equal(r[0].stand, 'klaargezet');
  assert.equal(r[1].stand, 'voorgenomen');
});

test('een mislukte stap is mislukt, ook als de status iets anders zegt', () => {
  const r = bouwPlanRegels(PLAN, [
    { id: 'a1', type: 'taak_aanmaken', status: 'uitgevoerd', fout: 'taak aanmaken: kapot' },
  ]);
  assert.equal(r[0].stand, 'mislukt');
  assert.equal(r[0].fout, 'taak aanmaken: kapot');
});

test('twee stappen van hetzelfde type krijgen elk hun eigen actie', () => {
  const plan = { stappen: [{ type: 'taak_aanmaken' }, { type: 'taak_aanmaken' }] };
  const r = bouwPlanRegels(plan, [
    { id: 'a1', type: 'taak_aanmaken', status: 'uitgevoerd' },
    { id: 'a2', type: 'taak_aanmaken', status: 'gepland' },
  ]);
  assert.equal(r[0].actie_id, 'a1');
  assert.equal(r[1].actie_id, 'a2');
});

test('een actie zonder plan-stap verdwijnt niet', () => {
  // Een plan dat herschreven is na een antwoord, of een stap die later met de
  // hand is klaargezet. Die stilletjes weglaten zou erger zijn dan het
  // oorspronkelijke probleem.
  const r = bouwPlanRegels(PLAN, [
    { id: 'a9', type: 'factuur_nakijken', status: 'uitgevoerd', resultaat: { taak_id: 't9' } },
  ]);
  assert.equal(r.length, 3);
  assert.equal(r[2].type, 'factuur_nakijken');
  assert.equal(r[2].stand, 'gedaan');
});

test('geen plan en geen acties geeft een lege lijst, geen fout', () => {
  assert.deepEqual(bouwPlanRegels(null, null), []);
  assert.deepEqual(bouwPlanRegels({}, []), []);
  assert.deepEqual(bouwPlanRegels({ stappen: 'geen array' }, undefined), []);
});

// ── het verloop ──────────────────────────────────────────────────────────────

test('het verloop komt eruit als leesbare regels', () => {
  const r = bouwVerloop([
    { op: '2026-09-20T08:00:00Z', wie: 'u1', wat: 'opdracht gegeven' },
    { op: '2026-09-20T08:00:09Z', wie: null, wat: 'plan gemaakt', details: { stappen: 2 } },
  ]);
  assert.equal(r.length, 2);
  assert.equal(r[0].door_mens, true, 'wie gevuld = een mens deed het');
  assert.equal(r[1].door_mens, false, 'wie leeg = Iris deed het');
  assert.deepEqual(r[1].details, { stappen: 2 });
});

test('rommel in het verloop wordt overgeslagen, niet gerenderd', () => {
  assert.deepEqual(bouwVerloop([null, 'tekst', {}, { wat: '' }]), []);
  assert.deepEqual(bouwVerloop(null), []);
});

// ── de bedrading ─────────────────────────────────────────────────────────────

const ENDPOINT = readFileSync(new URL('../api/iris-opdracht.js', import.meta.url), 'utf8');
const SCHERM = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');

/**
 * Het blok van opdrachtDetail, tot precies waar de functie ophoudt.
 *
 * Niet "de eerste zoveel tekens": dat is twee keer eerder in deze reeks
 * misgegaan. Te kort en de test kijkt langs de helft heen (dit is 6300 tekens),
 * te lang en hij slaat aan op code van de buren.
 */
function detailBlok() {
  const van = SCHERM.indexOf('function opdrachtDetail');
  const tot = SCHERM.indexOf('function planRegel', van);
  assert.ok(van > 0 && tot > van, 'opdrachtDetail en planRegel horen allebei te bestaan');
  return SCHERM.slice(van, tot);
}

test('het detail-endpoint stuurt de drie leesbare vormen mee', () => {
  const i = ENDPOINT.indexOf('async function geefEen');
  const blok = ENDPOINT.slice(i, ENDPOINT.indexOf('\n}', i));
  assert.match(blok, /plan_regels: bouwPlanRegels\(opdracht\.plan, lijst\)/);
  assert.match(blok, /verloop_regels: bouwVerloop\(opdracht\.verloop\)/);
  assert.match(blok, /na_uitvoeren_zin: naUitvoerenZin\(opdracht\.na_uitvoeren\)/);
  // De ruwe vorm blijft: wie die wil, heeft hem nog.
  assert.match(blok, /acties: lijst/);
});

test('het scherm hangt het plan niet meer aan acties.length', () => {
  const blok = detailBlok();
  assert.doesNotMatch(blok, /const plan = acties\.length/);
  assert.match(blok, /const regels = Array\.isArray\(d\.plan_regels\)/);
});

test('het scherm toont verloop en de zin in plaats van het enum-woord', () => {
  const blok = detailBlok();
  assert.match(blok, /d\.verloop_regels/);
  assert.match(blok, /d\.na_uitvoeren_zin/);
  // Het oude patroon: het kale veld, cursief.
  assert.doesNotMatch(blok, /font-style:italic">\$\{esc\(o\.na_uitvoeren\)\}/);
});

test('wijzigingen halen het detail opnieuw op in plaats van het half te overschrijven', () => {
  // Antwoorden, afsluiten en heropenen bouwden het detail na uit j.opdracht.
  // Dat wiste precies plan_regels, verloop_regels en na_uitvoeren_zin -- en
  // juist op het moment dat je er het meest naar wilt kijken: nadat Iris op
  // jouw antwoord een nieuw plan maakte.
  assert.match(SCHERM, /async function herlaadDetail\(id\)/);
  assert.doesNotMatch(SCHERM, /detail = \{ opdracht: j\.opdracht/);
  for (const naam of ['__irisOpdrachtAntwoord =', '__irisOpdrachtAfsluiten =', '__irisOpdrachtHeropenen =']) {
    const i = SCHERM.indexOf(naam);
    assert.ok(i > 0, naam);
    assert.match(SCHERM.slice(i, i + 700), /herlaadDetail\(id\);/, naam);
  }
});

test('herlaadDetail doet niets als er intussen iets anders openstaat', () => {
  // Zonder die check overschrijft een traag antwoord het detail van de
  // opdracht die je inmiddels open hebt staan.
  const i = SCHERM.indexOf('async function herlaadDetail(id)');
  assert.match(SCHERM.slice(i, i + 200), /S\.opdrachten\.open !== id/);
});
