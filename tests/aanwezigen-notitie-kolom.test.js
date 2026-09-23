// tests/aanwezigen-notitie-kolom.test.js
//
// DE KOLOM NOTITIE OP DE AANWEZIGENLIJST.
//
// Dit is de lijst waarmee de broodjes besteld worden, dus de notitie moet hier
// staan én hier te corrigeren zijn: een typefout mag niet vastzitten tot het
// event voorbij is.
//
// NIET HETZELFDE ALS `notes`. Die staat in het deelnemer-detailpaneel en is de
// vrije aantekening over de deelnemer ("Opgebeld door Chesney om 13u41"). Door
// elkaar halen betekent dat een broodjesbestelling iemands aantekening
// overschrijft — of andersom, dat de bestellijst vol gesprekverslagen staat.
//
// De cel wordt hier ECHT opgebouwd in een node:vm; de brontekst lezen zou niet
// laten zien of er daadwerkelijk iets getekend wordt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const VIEW = readFileSync('modules/klanten-v2/views/events-v2.js', 'utf8');

function knip(naam) {
  const start = VIEW.indexOf('  function ' + naam + '(');
  assert.ok(start > 0, naam + ' is niet gevonden in events-v2.js');
  const lichaam = VIEW.indexOf('{', VIEW.indexOf(')', start));
  let diep = 0; let eind = -1;
  for (let n = lichaam; n < VIEW.length; n += 1) {
    const ch = VIEW[n];
    if (ch === "'" || ch === '`' || ch === '"') { const q = VIEW.indexOf(ch, n + 1); if (q < 0) break; n = q; continue; }
    if (ch === '{') diep += 1;
    else if (ch === '}') { diep -= 1; if (diep === 0) { eind = n; break; } }
  }
  assert.ok(eind > lichaam, naam + ' loopt niet af — anker of code is stuk');
  return VIEW.slice(start, eind + 1);
}

/** De echte _notitieCel draaien tegen een gezette staat. */
function cel(attendee, { ontbreekt = [], bewerkt = null, bezig = {} } = {}) {
  const ctx = createContext({
    esc: (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    _live: { attendees: { ontbreekt: { 'ev-1': ontbreekt } } },
    _ui: { notitieEdit: bewerkt, notitieBusy: bezig },
    console,
  });
  runInContext(knip('_notitieCel') + '\n_notitieCel;', ctx, { filename: 'events-v2.js#notitie' });
  return runInContext('_notitieCel', ctx)(attendee, 'ev-1');
}

const SOFIA = { id: 'a-1', notitie: '2x kaas' };
const LEEG  = { id: 'a-2', notitie: null };

// ═══════════════════════════════════════════════════════════════════════════
// WAT ER STAAT
// ═══════════════════════════════════════════════════════════════════════════

test('de notitie staat in de kolom', () => {
  assert.match(cel(SOFIA), /2x kaas/);
});

test('zonder notitie staat er een uitnodiging, geen streepje', () => {
  // Een streepje leest als 'niet van toepassing'. Hier moet er nog iets
  // gevraagd worden, en dat hoort zichtbaar te zijn.
  const h = cel(LEEG);
  assert.match(h, /\+ notitie/);
  assert.match(h, /Klik om een notitie toe te voegen/);
});

test('een lange notitie breekt de tabel niet', () => {
  const h = cel({ id: 'a-3', notitie: 'x'.repeat(400) });
  assert.match(h, /text-overflow:ellipsis/);
  assert.match(h, /white-space:nowrap/);
});

test('de hele tekst staat in de tooltip', () => {
  // Afgekapt in beeld, maar wel te lezen zonder te klikken.
  assert.match(cel({ id: 'a-4', notitie: '1x hesp 1x kaas, geen tomaat' }), /title="1x hesp 1x kaas, geen tomaat/);
});

test('een notitie met aanhalingstekens breekt het attribuut niet', () => {
  const h = cel({ id: 'a-5', notitie: 'kaas "extra" <b>' });
  assert.doesNotMatch(h, /<b>/);
  assert.match(h, /&quot;|&#39;|&lt;/);
});

// ═══════════════════════════════════════════════════════════════════════════
// BEWERKEN
// ═══════════════════════════════════════════════════════════════════════════

test('klikken opent een invoerveld', () => {
  assert.match(cel(SOFIA), /__evNotitieBewerk\('a-1'\)/);
});

test('in bewerkmodus staat er een veld met de huidige tekst', () => {
  const h = cel(SOFIA, { bewerkt: { attId: 'a-1', waarde: '2x kaas' } });
  assert.match(h, /<input/);
  assert.match(h, /value="2x kaas"/);
});

test('Enter slaat op, Escape laat het zoals het was', () => {
  const h = cel(SOFIA, { bewerkt: { attId: 'a-1', waarde: '2x kaas' } });
  assert.match(h, /Enter.*__evNotitieBewaar/s);
  assert.match(h, /Escape.*__evNotitieStop/s);
});

test('wegklikken slaat ook op', () => {
  // Anders is typen-en-doorklikken stil verlies.
  // Op de ATTRIBUUTGRENS matchen. Zonder de \s ervoor matcht deze regex ook
  // binnen 'data-onblur="…"', en dan glipt een attribuut dat de browser
  // nergens voor gebruikt er gewoon doorheen.
  assert.match(cel(SOFIA, { bewerkt: { attId: 'a-1', waarde: 'x' } }),
    /\sonblur="window\.__evNotitieBewaar/);
});

test('leegmaken is wissen, en dat staat er', () => {
  const h = cel(SOFIA, { bewerkt: { attId: 'a-1', waarde: '' } });
  assert.match(h, /leeg laten wist de notitie/);
});

test('alleen de aangeklikte rij staat in bewerkmodus', () => {
  const h = cel(LEEG, { bewerkt: { attId: 'a-1', waarde: '2x kaas' } });
  assert.doesNotMatch(h, /<input/);
});

test('tijdens opslaan staat er opslaan…', () => {
  assert.match(cel(SOFIA, { bezig: { 'a-1': true } }), /opslaan…/);
});

// ═══════════════════════════════════════════════════════════════════════════
// ZONDER DE MIGRATIE
// ═══════════════════════════════════════════════════════════════════════════

test('zonder de kolom staat er dat het nog niet ingericht is', () => {
  // Een lege kolom leest als 'niemand heeft iets opgegeven', en dan wordt er
  // niets besteld voor mensen die het wel gezegd hebben.
  const h = cel(LEEG, { ontbreekt: ['notitie'] });
  assert.match(h, /nog niet ingericht/);
  assert.match(h, /2026-09-23-event-attendees-notitie\.sql/);
});

test('en dan is er niets te klikken', () => {
  assert.doesNotMatch(cel(LEEG, { ontbreekt: ['notitie'] }), /__evNotitieBewerk/);
});

test('een andere ontbrekende kolom raakt deze niet', () => {
  assert.match(cel(SOFIA, { ontbreekt: ['bonus_excluded'] }), /2x kaas/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE KOLOM STAAT IN DE TABEL, EN SCHRIJFT NAAR HET JUISTE VELD
// ═══════════════════════════════════════════════════════════════════════════

test('de kolomkop Notitie staat tussen Belstatus en de kebab', () => {
  const i = VIEW.indexOf("{l:'Belstatus'}");
  assert.ok(i > 0);
  assert.match(VIEW.slice(i, i + 80), /\{l:'Notitie'\}/);
});

test('de cel wordt ook echt in de rij gezet', () => {
  // Een kolomkop zonder cel schuift elke kolom erna een plek op.
  const i = VIEW.indexOf('_belStatusDropdown(a, id),');
  assert.match(VIEW.slice(i, i + 120), /_notitieCel\(a, id\)/);
});

test('opslaan schrijft naar notitie, niet naar notes', () => {
  const i = VIEW.indexOf('window.__evNotitieBewaar = async');
  const blok = VIEW.slice(i, i + 1800);
  assert.match(blok, /notitie: nieuw \|\| null/);
  assert.doesNotMatch(blok, /notes:/, 'dit zou de aantekening in het detailpaneel overschrijven');
});

test('niets veranderd betekent geen schrijfactie', () => {
  const i = VIEW.indexOf('window.__evNotitieBewaar = async');
  assert.match(VIEW.slice(i, i + 1800), /if \(nieuw === oud\)/);
});

test('een server die zegt dat de kolom ontbreekt wordt NIET genegeerd', () => {
  // Stil doorgaan zou de lijst een bestelling laten tonen die nergens staat.
  const i = VIEW.indexOf('window.__evNotitieBewaar = async');
  assert.match(VIEW.slice(i, i + 1800), /notitie_opgeslagen === false/);
});

test('typen tekent niet opnieuw — anders springt de focus weg', () => {
  // NAUW AFBAKENEN tot deze ene functie. Een venster van een paar honderd
  // tekens loopt door in __evNotitieStop, die wél opnieuw tekent — en dan
  // faalt deze test op code die er niets mee te maken heeft, of slaagt hij
  // om de verkeerde reden.
  const i = VIEW.indexOf('window.__evNotitieTyp = ');
  assert.ok(i > 0, 'de definitie van __evNotitieTyp is niet gevonden');
  const eind = VIEW.indexOf('window.__evNotitieStop = ', i);
  assert.ok(eind > i, 'het einde van de functie is niet gevonden');
  const blok = VIEW.slice(i, eind);
  assert.doesNotMatch(blok, /DFO\.render/,
    'opnieuw tekenen tijdens typen haalt de focus uit het veld');
});
