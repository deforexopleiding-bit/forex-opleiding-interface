// tests/opvolging-wachtrij-controle.test.js
//
// Controle 6 — de wachtrij die blijft hangen.
//
// De aanleiding is een LEEGTE, geen storing: de 48-uurcontrole draait sinds
// zijn oplevering elk uur en heeft nog nooit iets gedaan. Eén taak kreeg ooit
// een agenda, nul afspraken gevonden, nul kaarten teruggezet. De beslisfunctie
// is met de hand nagerekend en klopt; of de cron 's nachts ook echt schrijft is
// nooit gebleken. Deze controle is het vangnet daaronder.
//
// WAT DEZE TESTS NIET BEWIJZEN: dat de cron draait. Dat blijkt uit de mail van
// overmorgenochtend. Hier staat alleen dat de BEOORDELING klopt zodra de
// gegevens er zijn — en dat is precies het onderscheid dat deze week zes keer
// misging.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controleerWachtrij, WACHT_MARGE_UREN, OK, FOUT, NIET_GEMETEN,
} from '../api/_lib/opvolging-gezondheid.js';
import { WACHT_UREN } from '../api/_lib/opvolging-doorrol.js';

const NU = Date.parse('2026-09-12T06:00:00Z');
const urenGeleden = (n) => new Date(NU - n * 3600 * 1000).toISOString();
const meet = (taken) => controleerWachtrij({ taken, nu: NU, wachtUren: WACHT_UREN });

const wachter = (extra = {}) => ({
  id: 't-1', naam: 'Testpersoon', status: 'wacht_inplanning',
  agenda_doorgestuurd_at: urenGeleden(1), ...extra,
});

// ── DE EIS, LETTERLIJK ─────────────────────────────────────────────────────

test('een kaart die langer dan 48 uur plus marge wacht, is een melding', () => {
  const r = meet([wachter({ naam: 'Sofia Vanat', agenda_doorgestuurd_at: urenGeleden(WACHT_UREN + WACHT_MARGE_UREN) })]);
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.verlopen, 1);
  assert.match(r.getallen.namen.join(' '), /Sofia Vanat/);
  // Het getal moet in de mail staan, anders is de melding niet na te rekenen.
  assert.match(r.getallen.namen.join(' '), new RegExp(`${WACHT_UREN + WACHT_MARGE_UREN} uur`));
});

test('binnen de marge is geen melding — de cron mag een ronde missen', () => {
  // Precies één uur voor de grens. De cron draait per uur; wie hier al aan de
  // bel trekt, stuurt elke nacht een vals alarm en wordt genegeerd.
  const r = meet([wachter({ agenda_doorgestuurd_at: urenGeleden(WACHT_UREN + WACHT_MARGE_UREN - 1) })]);
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.wachtend, 1);
});

test('de klok van 48 uur alleen is nog geen melding', () => {
  // Op het moment dat de 48 uur vol zijn hoort de cron het over te nemen. Pas
  // als hij dat drie rondes lang niet doet, is er iets aan de hand.
  const r = meet([wachter({ agenda_doorgestuurd_at: urenGeleden(WACHT_UREN) })]);
  assert.equal(r.staat, OK);
});

// ── DE STILLE VARIANT ──────────────────────────────────────────────────────

test('een kaart zonder doorstuurmoment hangt voor altijd en is meteen een melding', () => {
  // beslisWachtInplanning() geeft hier bewust 'wacht' terug — "laat het
  // opvallen" — maar tot nu toe was er niets dat het liet opvallen. Er is geen
  // klok die kan aflopen, dus wachten verandert hier niets.
  const r = meet([wachter({ naam: 'Zonder klok', agenda_doorgestuurd_at: null })]);
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.zonder_klok, 1);
  assert.equal(r.getallen.verlopen, 0);
});

test('een onleesbaar tijdstip telt als geen klok, niet als vers', () => {
  const r = meet([wachter({ agenda_doorgestuurd_at: 'gisteren' })]);
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.zonder_klok, 1);
});

// ── DE TWEEDE TAK ──────────────────────────────────────────────────────────

test('wacht_verplaatsing wordt op zijn eigen klok beoordeeld', () => {
  const r = meet([{
    id: 't-2', naam: 'Verplaatste', status: 'wacht_verplaatsing',
    bron_ref: { event_id: 'ev-oud', verplaatst_gemeld_at: urenGeleden(WACHT_UREN + WACHT_MARGE_UREN + 10) },
  }]);
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.verlopen, 1);
  assert.match(r.getallen.namen.join(' '), /wacht_verplaatsing/);
});

test('een verplaatsing zonder meldmoment is dezelfde stille hangkaart', () => {
  const r = meet([{ id: 't-3', naam: 'Beloofd', status: 'wacht_verplaatsing', bron_ref: { event_id: 'ev-oud' } }]);
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.zonder_klok, 1);
});

test('de klok van de ene tak wordt niet op de andere gelezen', () => {
  // Een wacht_verplaatsing met een gevulde agenda_doorgestuurd_at is GEEN
  // lopende klok: die tak wacht op een aanmelding, niet op een agenda. Wie hier
  // het verkeerde veld leest, ziet een hangende kaart als gezond.
  const r = meet([{
    id: 't-4', naam: 'Kruislings', status: 'wacht_verplaatsing',
    agenda_doorgestuurd_at: urenGeleden(1), bron_ref: {},
  }]);
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.zonder_klok, 1);
});

// ── LEEG IS NIET GOED ──────────────────────────────────────────────────────

test('nul wachtenden is niet gemeten, niet in orde', () => {
  // Dit is de stand van vandaag. Zou dit groen zijn, dan meldt de mail elke
  // ochtend dat de wachtrij gezond is terwijl er nog nooit iets doorheen is
  // gegaan — precies het valse groen waar deze hele bewaking tegen is.
  const r = meet([]);
  assert.equal(r.staat, NIET_GEMETEN);
  assert.equal(r.getallen.bekeken, 0);
});

test('een gezonde wachtrij telt de wachtenden op', () => {
  const r = meet([
    wachter({ id: 'a', agenda_doorgestuurd_at: urenGeleden(2) }),
    wachter({ id: 'b', agenda_doorgestuurd_at: urenGeleden(30) }),
  ]);
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.wachtend, 2);
  assert.equal(r.getallen.bekeken, 2);
});

test('de grens staat in de getallen, ook als alles goed is', () => {
  // Anders is een groene regel in de mail niet na te rekenen: 'in orde' zonder
  // te zeggen waartegen gemeten is, is precies het alibi dat we opruimen.
  const r = meet([wachter()]);
  assert.equal(r.getallen.grens_uren, WACHT_UREN + WACHT_MARGE_UREN);
  assert.equal(meet([]).getallen.grens_uren, WACHT_UREN + WACHT_MARGE_UREN);
});

// ── HET ECHTE GEVAL VAN 9 SEPTEMBER ────────────────────────────────────────

test('Sofia en Shudino zouden hier opgevallen zijn', () => {
  // Ze stonden op wacht_inplanning met agenda_doorgestuurd_at op 09:57 en 09:58,
  // en de knop die ze moest terughalen deed niets. Zonder die knopfix zouden ze
  // er 48 uur later nog hebben gestaan — dan had deze controle ze opgesomd in
  // plaats van te wachten tot Maxim ze zag.
  const r = meet([
    { id: 's', naam: 'Sofia Vanat',     status: 'wacht_inplanning', agenda_doorgestuurd_at: urenGeleden(52) },
    { id: 'h', naam: 'Shudino Andrade', status: 'wacht_inplanning', agenda_doorgestuurd_at: urenGeleden(52) },
  ]);
  assert.equal(r.staat, FOUT);
  assert.equal(r.getallen.verlopen, 2);
  assert.match(r.uitleg, /staan op geen enkele lijst meer/);
});

// ── EEN KAPOTTE AANROEP IS EEN FOUT, GEEN GROEN ────────────────────────────

test('zonder wachttermijn faalt de controle luid in plaats van groen te worden', () => {
  // Zou de cron WACHT_UREN vergeten door te geven, dan wordt de grens NaN en is
  // 'uren >= grens' voor elke kaart onwaar: alles telt als gezond wachtend en
  // de mail meldt opgewekt dat het goed gaat, terwijl er niets beoordeeld is.
  const r = controleerWachtrij({ taken: [wachter({ agenda_doorgestuurd_at: urenGeleden(500) })], nu: NU });
  assert.equal(r.staat, FOUT);
  assert.match(r.uitleg, /zonder geldige wachttermijn/);
});
