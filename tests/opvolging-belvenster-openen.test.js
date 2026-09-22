// tests/opvolging-belvenster-openen.test.js
//
// BELLEN OPENT HET VENSTER, EN BELT NIET METEEN.
//
// Tot nu toe riep de Bellen-knop KlxSoftphone.call() aan: het systeem koos
// zelf de lijn en het uitgaande nummer, en Dave zag niet waarmee hij belde.
// Juist het nummer dat de lead op zijn scherm ziet bepaalt of er wordt
// opgenomen, dus die keuze hoort vóór het bellen te staan.
//
// WAT HIER BEWEZEN WORDT is niet dat de brontekst het juiste woord bevat, maar
// dat de ECHTE functie uit de view de softphone aanroept zoals het hoort. De
// functie wordt uit het bestand geknipt en uitgevoerd in een node:vm.
//
// De taak-id is het gevoeligste deel: zonder hem maakt
// /api/softphone-call-log geen belpoging die aan de juiste kaart hangt, en
// dan telt het gesprek nergens mee.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const VIEW = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');

/**
 * De echte belVenster() uit de view halen en draaien.
 *
 * Haakjes tellen in plaats van op een letterlijk einde mikken: een anker dat
 * een tekststuk zoekt breekt stil zodra de code eromheen verschuift, en een
 * test die niet meer draait terwijl hij groen oogt is precies wat we hier aan
 * het uitroeien zijn.
 */
function laadBelVenster() {
  const start = VIEW.indexOf('  function belVenster(plek, {');
  assert.ok(start > 0, 'belVenster is niet gevonden in de view');
  // NIET vanaf de handtekening tellen: de parameterlijst opent zelf al een
  // accolade (de destructurering), en die sluit vóór het lichaam. Daarop
  // tellen knipt de functie af bij de parameters, en dan draait de test een
  // stuk tekst dat geen functie is. Begin dus bij de accolade ná ')'.
  const lichaam = VIEW.indexOf('{', VIEW.indexOf('})', start) + 2);
  assert.ok(lichaam > start, 'het lichaam van de functie is niet gevonden');
  let diep = 0;
  let eind = -1;
  let begonnen = false;
  for (let n = lichaam; n < VIEW.length; n += 1) {
    const ch = VIEW[n];
    if (ch === "'") { n = VIEW.indexOf("'", n + 1); if (n < 0) break; continue; }
    if (ch === '{') { diep += 1; begonnen = true; }
    else if (ch === '}') { diep -= 1; if (begonnen && diep === 0) { eind = n; break; } }
  }
  assert.ok(eind > lichaam, 'de functie loopt niet af — anker of code is stuk');

  const gezien = { open: [], call: [], alerts: [] };
  const ctx = createContext({
    window: {
      KlxSoftphone: {
        open : (a) => gezien.open.push(a),
        call : (...a) => gezien.call.push(a),
      },
    },
    alert: (m) => gezien.alerts.push(m),
    console,
  });
  runInContext(VIEW.slice(start, eind + 1) + '\nbelVenster;', ctx, { filename: 'opvolging-v2.js#belVenster' });
  return { bel: runInContext('belVenster', ctx), gezien, ctx };
}

// ═══════════════════════════════════════════════════════════════════════════
// HET VENSTER GAAT OPEN, ER WORDT NIET GEBELD
// ═══════════════════════════════════════════════════════════════════════════

test('Bellen opent het belvenster in plaats van meteen te bellen', () => {
  const { bel, gezien } = laadBelVenster();
  bel('werklijst', { nummer: '+31612345678', naam: 'Sofia', taakId: 'taak-1' });
  assert.equal(gezien.open.length, 1);
  assert.equal(gezien.call.length, 0, 'call() belt meteen — dat is precies wat eruit moest');
});

test('de taak-id gaat mee, want daar hangt de belpoging aan', () => {
  const { bel, gezien } = laadBelVenster();
  bel('werklijst', { nummer: '+31612345678', naam: 'Sofia', taakId: 'taak-1' });
  assert.equal(gezien.open[0].opvolgingTaakId, 'taak-1');
  assert.equal(gezien.open[0].phone, '+31612345678');
  assert.equal(gezien.open[0].name, 'Sofia');
});

test('zonder taak wordt het veld WEGGELATEN, niet leeg meegestuurd', () => {
  // Een lege waarde valt in de softphone door de UUID-check en is dan niet
  // meer te onderscheiden van een vergeten koppeling.
  const { bel, gezien } = laadBelVenster();
  bel('zoomcalls', { nummer: '+31612345678', naam: 'Onbekend', taakId: null });
  assert.ok(!('opvolgingTaakId' in gezien.open[0]));
});

test('elke plek noemt zichzelf in de bron, zodat de call-log het laat zien', () => {
  const { bel, gezien } = laadBelVenster();
  for (const plek of ['werklijst', 'aanmeldkaart', 'nog-af-te-ronden', 'zoomcalls']) {
    bel(plek, { nummer: '+31612345678', naam: 'X', taakId: 'taak-1' });
  }
  assert.deepEqual(gezien.open.map((o) => o.source), [
    'opvolging.werklijst', 'opvolging.aanmeldkaart',
    'opvolging.nog-af-te-ronden', 'opvolging.zoomcalls',
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE RANDEN
// ═══════════════════════════════════════════════════════════════════════════

test('zonder nummer gebeurt er niets, met een melding', () => {
  const { bel, gezien } = laadBelVenster();
  bel('werklijst', { nummer: '', naam: 'Sofia', taakId: 'taak-1' });
  assert.equal(gezien.open.length, 0);
  assert.equal(gezien.alerts.length, 1);
});

test('zonder softphone op de pagina gebeurt er niets, met een melding', () => {
  const { bel, gezien, ctx } = laadBelVenster();
  ctx.window.KlxSoftphone = undefined;
  bel('werklijst', { nummer: '+31612345678', naam: 'Sofia', taakId: 'taak-1' });
  assert.equal(gezien.open.length, 0);
  assert.equal(gezien.alerts.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// ALLE VIER DE KNOPPEN KOMEN HIER UIT
// ═══════════════════════════════════════════════════════════════════════════

test('geen enkele Bellen-knop belt nog rechtstreeks', () => {
  // Eén weg, geen tweede implementatie. Zou er ergens een sp.call() terugkomen,
  // dan kiest het systeem daar weer zelf de lijn en het uitgaande nummer.
  assert.doesNotMatch(VIEW, /sp\.call\(/, 'er staat nog een rechtstreekse call() in de view');
});

test('er zijn precies vier Bellen-knoppen, en ze komen allemaal hier uit', () => {
  // De definities heten `window.__opvBel = ` en tellen dus niet mee in deze
  // telling; wat hier staat zijn de aanroepen in de knoppen zelf.
  const werklijst    = [...VIEW.matchAll(/__opvBel\(/g)].length;
  const uitDeAgenda  = [...VIEW.matchAll(/__opvCallBel\(/g)].length;
  assert.equal(werklijst, 2, 'werklijst + aanmeldkaart');
  assert.equal(uitDeAgenda, 2, 'nog af te ronden + zoomcalls');
});

test('de werklijst en de aanmeldkaart geven hun eigen plek door', () => {
  assert.match(VIEW, /__opvBel\(\\'' \+ t\.id \+ '\\', \\'werklijst\\'\)/);
  assert.match(VIEW, /__opvBel\(\\'' \+ t\.id \+ '\\', \\'aanmeldkaart\\'\)/);
});

test('de achterstand en de zoomcalls worden uit elkaar gehouden', () => {
  // callOp() gebruikt een 'a'-prefix voor de achterstand. Zou dat onderscheid
  // wegvallen, dan staat er in de call-log dat er vanuit de zoomcalls gebeld
  // is terwijl het een nabeltaak van gisteren was.
  const i = VIEW.indexOf('window.__opvCallBel = async');
  const blok = VIEW.slice(i, i + 900);
  assert.match(blok, /startsWith\('a'\)/);
  assert.match(blok, /nog-af-te-ronden/);
  assert.match(blok, /zoomcalls/);
});
