// tests/opvolging-terug-in-lijst.test.js
//
// 'TERUG IN DE LIJST' DEED LETTERLIJK NIETS.
//
// Gemeten op 9 september. Dave klikte per ongeluk bij Sofia Vanat en Shudino
// Andrade op 'agenda doorgestuurd'. Beide stonden daarna op status
// `wacht_inplanning` met `agenda_doorgestuurd_at` gevuld (09:57 en 09:58) en
// `afspraak_gevonden_at` leeg. Op 'Terug in de lijst' drukken deed niets: geen
// zichtbare verandering, geen foutmelding.
//
// De oorzaak, gevonden in de gedeployde code: de knop postte
// `actie: 'verplaats'` met `due: vandaag`. Dat verzet alleen de DATUM. De status
// bleef wacht_inplanning en agenda_doorgestuurd_at bleef staan — en omdat de due
// al op vandaag stond, veranderde er niets.
//
// Twee mensen zaten daardoor vast zonder weg terug, en het scherm gaf geen
// enkel signaal. Bijkomend bewijs dat de weergavekant die toestand niet kende:
// het woord `wacht_inplanning` kwam in de hele view NUL keer voor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { terugInLijstPatch, staatInDaglijst } from '../api/_lib/opvolging-terug-in-lijst.js';

const VANDAAG = '2026-09-09';

/** Sofia Vanat zoals ze vanochtend in de databank stond. */
const SOFIA = {
  id: 'sofia', naam: 'Sofia Vanat',
  status: 'wacht_inplanning',
  agenda_doorgestuurd_at: '2026-09-09T07:57:00.000Z',
  afspraak_gevonden_at: null,
  due: VANDAAG, later: false,
};

const na = (taak, patch) => ({ ...taak, ...patch });

// ═══════════════════════════════════════════════════════════════════════════
// DE EIS, LETTERLIJK
// ═══════════════════════════════════════════════════════════════════════════

test('een taak in wacht_inplanning staat na deze knop weer als OPEN in de daglijst', () => {
  // De test die de opdracht letterlijk stelt. Hij rekent na tegen de ECHTE
  // voorwaarde van api/opvolging-taken.js: status = 'open' en due <= vandaag.
  assert.equal(staatInDaglijst(SOFIA, VANDAAG), false, 'vooraf staat ze er niet in');

  const patch = terugInLijstPatch({ vandaag: VANDAAG });
  const daarna = na(SOFIA, patch);

  assert.equal(daarna.status, 'open');
  assert.equal(staatInDaglijst(daarna, VANDAAG), true, 'na de knop hoort ze in de daglijst te staan');
});

test('en agenda_doorgestuurd_at wordt leeggemaakt', () => {
  // Zonder dit blijft de kaart een wachtende kaart die alleen toevallig open
  // staat, en pakt cron-opvolging-wacht-check hem alsnog op.
  const daarna = na(SOFIA, terugInLijstPatch({ vandaag: VANDAAG }));
  assert.equal(daarna.agenda_doorgestuurd_at, null);
});

test('de due komt op vandaag en later gaat terug op false', () => {
  const p = terugInLijstPatch({ vandaag: VANDAAG });
  assert.equal(p.due, VANDAAG);
  assert.equal(p.later, false);
});

test('DE OUDE KNOP DEED NIETS — dit is waarom', () => {
  // 'verplaats' zette alleen de due. Op een kaart waarvan de due al op vandaag
  // stond, leverde dat een patch op die niets veranderde.
  const oudePatch = { due: VANDAAG, later: false };
  const daarna = na(SOFIA, oudePatch);
  assert.equal(daarna.status, 'wacht_inplanning', 'de status bleef staan');
  assert.equal(staatInDaglijst(daarna, VANDAAG), false, 'en dus bleef ze onzichtbaar');
});

test('een onbruikbare dag levert geen patch op in plaats van een onzin-datum', () => {
  for (const d of [null, '', 'vandaag', '2026-9-9']) {
    assert.equal(terugInLijstPatch({ vandaag: d }), null, String(d));
  }
});

test('afspraak_ref en afspraak_gevonden_at blijven met rust', () => {
  // Die horen bij de actie 'ingepland' en zijn een vondst, geen toestand die
  // deze knop heeft gezet. Weggooien vernietigt informatie die niemand
  // terughaalt.
  const p = terugInLijstPatch({ vandaag: VANDAAG });
  assert.equal('afspraak_ref' in p, false);
  assert.equal('afspraak_gevonden_at' in p, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN OP DE PADEN DIE ECHT DRAAIEN
// ═══════════════════════════════════════════════════════════════════════════

test('het endpoint kent de actie en zet hem niet meer via verplaats', () => {
  const bron = readFileSync('api/opvolging-taak-update.js', 'utf8');
  assert.match(bron, /b\.actie === 'terug_in_lijst'/);
  assert.match(bron, /terugInLijstPatch\(\{ vandaag: dagInZone\(Date\.now\(\)\) \}\)/,
    'de dag hoort in Amsterdamse tijd gerekend te worden, niet in UTC');
});

test('de knop in de view post de nieuwe actie', () => {
  const view = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');
  // Op de DEFINITIE anker, niet op de naam: de eerste treffer is de onclick in
  // de HTML en die zegt niets over wat de knop doet.
  const i = view.indexOf('window.__opvTerug = async');
  assert.ok(i > 0, 'de definitie van __opvTerug is niet gevonden');
  const blok = view.slice(i, i + 700);
  assert.match(blok, /actie: 'terug_in_lijst'/);
  assert.doesNotMatch(blok.replace(/\/\/[^\n]*/g, ''), /actie: 'verplaats'/,
    'de knop hangt weer aan verplaats, en dan doet hij opnieuw niets');
});
