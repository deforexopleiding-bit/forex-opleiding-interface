// tests/events-afronden-helpers.test.js
//
// Twee kleine besluiten uit api/_lib/events-complete-core.js die stil fout
// kunnen gaan, en dan pas opvallen als er iemand niet gebeld is.
//
//  · isGesloten bepaalt of het afronden van een event een oude, afgesloten
//    belrij weer openzet. Klopt die lijst niet, dan blijft iemand onzichtbaar
//    — precies wat er op 26 augustus gebeurde.
//  · datumOverDagen zet het standaard-belmoment. Een dag ernaast valt niemand
//    op; een lege of ongeldige datum betekent dat de lead op geen enkele lijst
//    staat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isGesloten, datumOverDagen, AFWEZIG_BELMOMENT_DAGEN, AFWEZIG_REDENEN,
} from '../api/_lib/events-complete-core.js';

test('alleen verlengd en verloren gelden als afgesloten', () => {
  assert.equal(isGesloten('verlengd'), true);
  assert.equal(isGesloten('verloren'), true);
  // Deze vier lopen nog en mogen dus NIET als heropening behandeld worden.
  for (const open of ['nieuw', 'benaderd', 'terugbellen', 'niet_bereikbaar']) {
    assert.equal(isGesloten(open), false, `${open} hoort een lopende status te zijn`);
  }
});

test('onbekende of lege status telt niet als afgesloten', () => {
  for (const raar of [null, undefined, '', '  ', 'VERLOREN', 'weg']) {
    assert.equal(isGesloten(raar), false, `${JSON.stringify(raar)} hoort niet gesloten te zijn`);
  }
});

test('het belmoment heeft de vorm die de databank verwacht', () => {
  for (const d of [0, 1, 3, 30]) {
    assert.match(datumOverDagen(d), /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('no-show belt morgen, afgemeld over drie dagen', () => {
  assert.equal(AFWEZIG_BELMOMENT_DAGEN.no_show, 1);
  assert.equal(AFWEZIG_BELMOMENT_DAGEN.afgemeld, 3);
  const dag = 86400000;
  assert.equal(new Date(datumOverDagen(1)) - new Date(datumOverDagen(0)), dag);
  assert.equal(new Date(datumOverDagen(3)) - new Date(datumOverDagen(0)), 3 * dag);
});

test('onzin-invoer geeft vandaag, geen Invalid Date', () => {
  for (const raar of [null, undefined, 'x', NaN]) {
    assert.equal(datumOverDagen(raar), datumOverDagen(0));
  }
});

test('de vier afwezig-redenen staan vast, inclusief onbekend als terugval', () => {
  assert.equal(AFWEZIG_REDENEN.size, 4);
  for (const r of ['kon_niet', 'niet_gereageerd', 'afgemeld_bericht', 'onbekend']) {
    assert.ok(AFWEZIG_REDENEN.has(r), `${r} hoort erbij`);
  }
  // 'onbekend' is de waarde waar een niet-aangeklikte reden op terugvalt.
  // Verdwijnt die uit de lijst, dan wordt elke notitie zonder reden geweigerd
  // en zijn we terug bij het probleem van 26 augustus.
  assert.ok(AFWEZIG_REDENEN.has('onbekend'));
});
