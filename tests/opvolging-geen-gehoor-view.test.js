// tests/opvolging-geen-gehoor-view.test.js
//
// DE KNOP ZELF: staat hij er, staat hij op slot als het moet, en schrijft de
// actie erachter geen poging weg?
//
// Drie dingen zijn met een nep-databank niet te meten omdat ze in de opbouw van
// het venster en in de vorm van de update zitten. Die leest deze test uit de
// bron — hetzelfde patroon als tests/opvolging-scrim-zichtbaar.test.js en
// tests/opvolging-aanmeldkaart-design.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = readFileSync(join(ROOT, 'modules/klanten-v2/views/opvolging-v2.js'), 'utf8');
const API  = readFileSync(join(ROOT, 'api/opvolging-aanmelding-actie.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// DE VIEW
// ═══════════════════════════════════════════════════════════════════════════

test('de knop staat in "Wat nu?" op de aanmeldkaart', () => {
  assert.match(VIEW, /window\.__opvAanmeldActie\('geen_gehoor'\)/);
  assert.match(VIEW, /Geen gehoor &mdash; niemand te bereiken/);
});

test('de knop is uitgeschakeld zolang de drempel niet gehaald is', () => {
  // `opt(..., uit)` zet disabled zodra het laatste argument waar is. Hier hoort
  // dat `bezig || !dr.gehaald` te zijn: niet alleen tijdens een lopende actie,
  // maar ook zolang er te weinig moeite is gedaan.
  assert.match(VIEW, /bezig \|\| !dr\.gehaald/);
});

test('de reden staat er letterlijk bij, uit de gedeelde drempelhelper', () => {
  assert.match(VIEW, /const dr = drempelTekort\(t\)/);
  assert.match(VIEW, /'Nog niet: ' \+ esc\(dr\.redenen\.join\(' en '\)\)/);
});

test('de view bouwt geen tweede drempel — alleen de twee constanten', () => {
  // Precies één definitie van elk getal in de view (de tweeling van de lib),
  // en drempelTekort leest die. Een tweede hard getal ernaast is precies de
  // fout waar de opdracht voor waarschuwt.
  assert.equal((VIEW.match(/const ARCHIEF_MIN_DAGEN = /g) || []).length, 1);
  assert.equal((VIEW.match(/const ARCHIEF_MIN_WA = /g) || []).length, 1);
  assert.match(VIEW, /const dagenTekort = ARCHIEF_MIN_DAGEN - dagen/);
  assert.match(VIEW, /const waTekort = ARCHIEF_MIN_WA - wa/);
});

test('het bevestigingsvenster weigert alsnog als de drempel niet gehaald is', () => {
  // Tweede poort, voor een oud tabblad of een dubbele render. Zonder deze zou
  // de vastleg-knop bereikbaar blijven terwijl de knop ernaar toe op slot zat.
  assert.match(VIEW, /if \(!drB\.gehaald\)/);
});

test('het venster rendert als "scrim on"', () => {
  // De globale .scrim-regel houdt opacity op 0 en pointer-events op none
  // zonder `on`; dan blijft elk venster van deze module onzichtbaar.
  assert.match(VIEW, /class="scrim on"/);
});

test('het venster zegt dat de inschrijving blijft staan', () => {
  // Zonder die zin denkt Dave dat hij iemand net heeft afgemeld die alleen
  // maar niet opnam.
  assert.match(VIEW, /blijft staan<\/b> &mdash; geen gehoor is geen /);
});

// ═══════════════════════════════════════════════════════════════════════════
// HET ENDPOINT — wat er NIET gebeurt is hier het punt
// ═══════════════════════════════════════════════════════════════════════════

/** De tekst van de geen_gehoor-tak, tot aan de volgende tak. */
function geenGehoorTak() {
  const van = API.indexOf("if (actie === 'geen_gehoor') {");
  assert.ok(van > 0, "de tak 'geen_gehoor' hoort in het endpoint te staan");
  const tot = API.indexOf("if (actie === 'verplaats_naar_event')", van);
  assert.ok(tot > van);
  return API.slice(van, tot);
}

test("'geen_gehoor' is een erkende actie", () => {
  assert.match(API, /'annuleer_in_event', 'verplaats_naar_event', 'geen_gehoor',/);
});

test('de tak schrijft GEEN poging weg', () => {
  // Dat is het verschil met 'bevestigd' en 'gesprek gehad', die een poging
  // 'gesproken: ...' schrijven zodat isEchtContact() ze herkent. Hier was er
  // geen contact; 'gesproken' zou de historiek laten liegen.
  assert.doesNotMatch(geenGehoorTak(), /schrijfPoging/);
});

test('de tak raakt de inschrijvings-status niet aan', () => {
  const tak = geenGehoorTak();
  // Geen zetKomtNiet (die zet status op 'geannuleerd' + capaciteitscascade),
  // geen losse status-patch op event_attendees.
  assert.doesNotMatch(tak, /zetKomtNiet/);
  assert.doesNotMatch(tak, /geannuleerd/);
});

test('de kaart gaat naar gearchiveerd met reden "geen gehoor" en een datumregel', () => {
  const tak = geenGehoorTak();
  assert.match(tak, /status\s*:\s*'gearchiveerd'/);
  assert.match(tak, /archief_reden\s*:\s*'geen gehoor'/);
  assert.match(tak, /\$\{vandaag\} · Geen gehoor/);
});

test('de uitkomst gaat terug zoals bij de andere uitgangen', () => {
  // De view meldt het aan Dave; stil mislukken zou betekenen dat de
  // laatste-kans-mail nooit uitgaat en niemand dat merkt.
  assert.match(geenGehoorTak(), /belstatus/);
});

test('de belstatus-schrijver staat NA het vastzetten van de kaart', () => {
  const tak = geenGehoorTak();
  assert.ok(tak.indexOf('opvolging_taken') < tak.indexOf('zetBelstatusGeenGehoor'),
    'de eventmodule mag nooit bijgewerkt zijn voor een kaart die zelf niet is weggeschreven');
});
