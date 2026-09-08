// tests/opvolging-gezondheid-doorrol.test.js
//
// DE ZEVENDE CONTROLE: HEEFT DE DOORROL ZIJN WERK GOED GEDAAN?
//
// De zesde controle (`controleerDagritme`) kijkt of er een open kaart met een
// due in het VERLEDEN staat. Die had de fout van 8 september nooit gezien: de
// kapotte doorrol zette kaarten juist een dag te VER VOORUIT — op 2026-09-09
// terwijl ze op de 8e hoorden. Een due in de toekomst is voor die controle
// onzichtbaar.
//
// ── WAAROM DIT NIET MET EEN VUISTREGEL OP DE RIJEN KAN ───────────────────
// 'Een open kaart die ver vooruit staat is verdacht' werkt niet. Een
// bevestigde aanmelding slaapt legitiem tot vier dagen voor het event, en
// cron-opvolging-aanmeldingen draait elk kwartier — ook 's nachts — en maakt
// dan kaarten met een due weken vooruit. Een nachtvenster als vingerafdruk
// levert dus vals alarm op precies de kaarten die het goed doen.
//
// Daarom laat de doorrol nu een merkteken achter in app_settings: op welke dag
// hij richtte, wanneer hij draaide, hoeveel kaarten hij verzette en een greep
// uit de ids. De controle rekent dat na — en dat is geen zelfbevestiging, want
// hij leidt de dag OPNIEUW af uit het ruwe tijdstip van de run. Precies daar
// zat de fout.
//
// ── EN DE DREMPEL IS 'VOORUIT', NIET 'MEER DAN EEN DAG VOORUIT' ──────────
// Gemeten: updated_at 2026-09-07T23:59Z is in Amsterdam 2026-09-08, en de due
// werd 2026-09-09. Dat is precies EEN dag vooruit. Een controle op 'meer dan
// een dag' had deze fout dus óók gemist. Na een doorrol hoort de due exact de
// dag van de run te zijn; alles daarvoor of daarna is fout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  controleerDoorrol, OK, FOUT, NIET_GEMETEN,
} from '../api/_lib/opvolging-gezondheid.js';
import { bouwMerkteken, VOORBEELDEN_MAX } from '../api/_lib/opvolging-doorrol.js';

const VANDAAG = '2026-09-08';
// Het moment waarop de cron echt draait: 23:59 UTC = 01:59 in Amsterdam.
const GEDRAAID = '2026-09-07T23:59:12.000Z';

const goed = (over) => ({
  dag: VANDAAG, gedraaid_op: GEDRAAID, doorgerold: 5, voorbeelden: [], ...over,
});

test('een doorrol die op de dag van draaien richtte is in orde', () => {
  const u = controleerDoorrol({ merkteken: goed(), taken: [], vandaag: VANDAAG });
  assert.equal(u.staat, OK);
  assert.equal(u.naam, 'doorrol');
});

test('DE FOUT VAN 8 SEPTEMBER: hij richtte op de dag NA de run', () => {
  // Dit is de regressietest van de bug zelf. De cron draaide op 07-09T23:59Z
  // (in Amsterdam de 8e) en zette kaarten op de 9e.
  const u = controleerDoorrol({
    merkteken: goed({ dag: '2026-09-09' }), taken: [], vandaag: VANDAAG,
  });
  assert.equal(u.staat, FOUT);
  assert.match(u.uitleg, /2026-09-09/);
  assert.match(u.uitleg, /2026-09-08/);
  assert.equal(u.getallen.dag_gezet, '2026-09-09');
  assert.equal(u.getallen.dag_van_de_run, '2026-09-08');
});

test('één dag vooruit is al fout — een drempel van "meer dan een dag" had dit gemist', () => {
  // De hele reden dat deze controle geen marge heeft. Zie de kop.
  const verschil = (Date.parse('2026-09-09') - Date.parse('2026-09-08')) / 86400000;
  assert.equal(verschil, 1);
  assert.equal(controleerDoorrol({
    merkteken: goed({ dag: '2026-09-09' }), taken: [], vandaag: VANDAAG,
  }).staat, FOUT);
});

test('een dag te ver TERUG is net zo fout', () => {
  // Symmetrisch: elke andere dag dan die van de run is verkeerd, want dan
  // staan de kaarten op een dag die niemand bekijkt.
  const u = controleerDoorrol({
    merkteken: goed({ dag: '2026-09-07' }), taken: [], vandaag: VANDAAG,
  });
  assert.equal(u.staat, FOUT);
});

test('een run van gisteren betekent dat hij vannacht niet gedraaid heeft', () => {
  const u = controleerDoorrol({
    merkteken: goed({ dag: '2026-09-07', gedraaid_op: '2026-09-06T23:59:00.000Z' }),
    taken: [], vandaag: VANDAAG,
  });
  assert.equal(u.staat, FOUT);
  assert.match(u.uitleg, /niet gedraaid/i);
});

test('geen merkteken is NIET GEMETEN, niet ok', () => {
  // De eerste ochtend na de deploy. Dat als groen boeken zou de controle
  // waardeloos maken op precies het moment dat je hem wilt vertrouwen.
  for (const m of [null, undefined, {}]) {
    assert.equal(controleerDoorrol({ merkteken: m, taken: [], vandaag: VANDAAG }).staat,
      NIET_GEMETEN, JSON.stringify(m));
  }
});

test('een merkteken met een onbruikbaar tijdstip meet niets in plaats van iets', () => {
  const u = controleerDoorrol({
    merkteken: goed({ gedraaid_op: 'gisternacht' }), taken: [], vandaag: VANDAAG,
  });
  assert.equal(u.staat, NIET_GEMETEN);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN DE RIJEN DIE HIJ ZELF ZEGT TE HEBBEN AANGERAAKT
// ═══════════════════════════════════════════════════════════════════════════

test('een aangeraakte kaart die niet op de dag van de run staat is fout', () => {
  const u = controleerDoorrol({
    merkteken: goed({ voorbeelden: ['a', 'b'] }),
    taken: [
      { id: 'a', naam: 'Klopt', due: VANDAAG },
      { id: 'b', naam: 'Achraf Deflaoui', due: '2026-09-09' },
    ],
    vandaag: VANDAAG,
  });
  assert.equal(u.staat, FOUT);
  assert.equal(u.getallen.rijen_mis, 1);
  assert.match(JSON.stringify(u.getallen), /Achraf Deflaoui/);
});

test('staan de aangeraakte kaarten goed, dan is het in orde', () => {
  const u = controleerDoorrol({
    merkteken: goed({ voorbeelden: ['a'] }),
    taken: [{ id: 'a', naam: 'Klopt', due: VANDAAG }],
    vandaag: VANDAAG,
  });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.rijen_gecontroleerd, 1);
});

test('een kaart die intussen door een mens is verzet telt niet als fout', () => {
  // Tussen de doorrol en 07:00 kan iemand een kaart vooruit gezet hebben. Dan
  // is de due terecht anders, en dat mag geen alarm geven. We herkennen dat
  // aan updated_at: die ligt dan ná de run.
  const u = controleerDoorrol({
    merkteken: goed({ voorbeelden: ['a'] }),
    taken: [{ id: 'a', naam: 'Verzet', due: '2026-09-20', updated_at: '2026-09-08T06:30:00.000Z' }],
    vandaag: VANDAAG,
  });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.rijen_gecontroleerd, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN OP DE PADEN DIE ECHT DRAAIEN
// ═══════════════════════════════════════════════════════════════════════════

test('het merkteken draagt alles wat de controle nodig heeft', () => {
  // Deze test bestaat omdat twee sabotages op de vorige versie NUL rood gaven:
  // het tijdstip hernoemen naar `gedraaid_op2` en de ids leegmaken. Beide
  // maken controle 7 blind, en beide zagen er in de bron nog goed uit. De
  // inhoud van het merkteken hoort dus hier getoetst te worden en niet met
  // een greep in de brontekst.
  const m = bouwMerkteken({
    vandaag: VANDAAG, gedraaidMs: Date.parse(GEDRAAID),
    doorgerold: 5, bekeken: 24, aangeraakt: ['a', 'b', 'c'],
  });
  assert.equal(m.dag, VANDAAG);
  assert.equal(m.gedraaid_op, GEDRAAID);
  assert.equal(m.doorgerold, 5);
  assert.equal(m.bekeken, 24);
  assert.deepEqual(m.voorbeelden, ['a', 'b', 'c']);
  // En de controle moet er zonder meer mee overweg kunnen.
  assert.equal(controleerDoorrol({ merkteken: m, taken: [], vandaag: VANDAAG }).staat, OK);
});

test('het merkteken zonder tijdstip of zonder ids maakt de controle blind — dus dat mag niet gebeuren', () => {
  const m = bouwMerkteken({
    vandaag: VANDAAG, gedraaidMs: Date.parse(GEDRAAID),
    doorgerold: 2, bekeken: 2, aangeraakt: ['a'],
  });
  // Zonder tijdstip valt de dag van de run niet af te leiden.
  const zonderTijd = { ...m }; delete zonderTijd.gedraaid_op;
  assert.equal(controleerDoorrol({ merkteken: zonderTijd, taken: [], vandaag: VANDAAG }).staat,
    NIET_GEMETEN);
  // En zonder ids kijkt de controle geen enkele rij meer na.
  const zonderIds = { ...m, voorbeelden: [] };
  const u = controleerDoorrol({
    merkteken: zonderIds,
    taken: [{ id: 'a', naam: 'Fout', due: '2026-09-09' }],
    vandaag: VANDAAG,
  });
  assert.equal(u.getallen.rijen_gecontroleerd, 0,
    'een leeg voorbeeldenlijstje betekent dat er niets nagekeken is');
});

test('de steekproef wordt begrensd, zodat het merkteken niet ongelimiteerd groeit', () => {
  const veel = Array.from({ length: 200 }, (_, i) => 'id-' + i);
  const m = bouwMerkteken({ vandaag: VANDAAG, gedraaidMs: Date.parse(GEDRAAID), aangeraakt: veel });
  assert.equal(m.voorbeelden.length, VOORBEELDEN_MAX);
});

test('de doorrol laat het merkteken ook echt achter', () => {
  const bron = readFileSync('api/cron-opvolging-doorrol.js', 'utf8')
    .split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.match(bron, /DOORROL_MERKTEKEN/,
    'zonder merkteken heeft de zevende controle niets om na te rekenen');
  assert.match(bron, /value: bouwMerkteken\(\{/);
  assert.match(bron, /from\('app_settings'\)/);
});

test('de ochtendcontrole voert de zevende controle ook echt uit', () => {
  const bron = readFileSync('api/cron-opvolging-gezondheid.js', 'utf8')
    .split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.match(bron, /uitkomsten\.push\(controleerDoorrol\(/);
  assert.match(bron, /DOORROL_MERKTEKEN/);
});
