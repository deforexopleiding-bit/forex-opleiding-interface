// tests/opvolging-rondelabel-uitlijning.test.js
//
// HET RONDELABEL DRUKTE DE NAAM EN HET NUMMER WEG.
//
// Gemeten op productie: .row.rst is 633 breed, gap 14, drie kinderen.
//   .rnd  → flex-grow 0, flex-shrink 1, basis auto, min-width AUTO  → pakt 395
//   .act  → 178
//   .who  → flex 1 1 0% met min-width 0                            → houdt NUL over
//
// Gevolg op het scherm: de naam brak over twee regels en +32 473 97 98 12 viel
// uiteen in een cijfergroepje per regel. De omgekeerde wereld — .rnd mocht niet
// krimpen onder zijn inhoud, .who wél tot nul, dus de uitleg over de ronde won
// het van wie je moet bellen.
//
// Met drie kolommen past het simpelweg niet: .who wil ~312, .act 178, en het
// rondepaneel 741 als het niet mag afbreken, op 605 beschikbaar.
//
// WAT DEZE TEST WEL EN NIET DOET. Hij leest de ECHTE declaraties uit de view en
// rekent de flexverdeling na met de gemeten maten. Dat is meer dan een
// string-vergelijking: zet iemand .rnd terug op een krimpende kolom, dan rolt
// er weer nul uit voor .who en wordt dit rood. Wat hij NIET doet is de pagina
// in een browser openen; de echte proef is een smal venster met een lange naam
// erin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const VIEW = readFileSync('modules/klanten-v2/views/opvolging-v2.js', 'utf8');

/** De declaraties van één selector uit de view halen. */
function regels(selector) {
  const i = VIEW.indexOf(selector + '{');
  assert.ok(i > 0, 'selector niet gevonden: ' + selector);
  return VIEW.slice(i + selector.length + 1, VIEW.indexOf('}', i));
}

/**
 * De flexverdeling van .row met de gemeten maten.
 *
 * Geen volledige browser, wel het mechanisme dat de fout veroorzaakte: een kind
 * met min-width auto kan niet onder zijn inhoud krimpen, een kind met
 * min-width 0 wel — en wie er als laatste overblijft krijgt de rest.
 */
function verdeel({ rijBreedte = 633, gap = 14, rndCss, rowCss, rndInhoud = 741, actBreedte = 178 }) {
  const wrapt   = /flex-wrap:\s*wrap/.test(rowCss);
  const volleRegel = /flex:\s*1\s+0\s+100%/.test(rndCss);
  if (wrapt && volleRegel) {
    // De balk pakt een eigen regel; .who en .act delen de rij eronder.
    return { rnd: rijBreedte, who: rijBreedte - actBreedte - gap, act: actBreedte };
  }
  // Drie kolommen naast elkaar. .rnd mag niet onder zijn inhoud krimpen
  // wanneer min-width niet op 0 staat.
  const rndMin = /min-width:\s*0/.test(rndCss) ? 0 : rndInhoud;
  const beschikbaar = rijBreedte - 2 * gap;
  const rnd = Math.min(rndInhoud, Math.max(rndMin, beschikbaar - actBreedte));
  return { rnd, who: Math.max(0, beschikbaar - rnd - actBreedte), act: actBreedte };
}

test('de oude opzet gaf .who nul breedte — dat is de fout die gemeld is', () => {
  const uit = verdeel({
    rndCss: 'display:flex;width:100%',            // zoals het was: geen flex, min-width auto
    rowCss: 'display:flex;align-items:flex-start;gap:14px',
  });
  assert.equal(uit.who, 0, 'zo zag productie eruit');
});

test('met de balk over de volle breedte houdt .who ruim 440 over', () => {
  const uit = verdeel({ rndCss: regels('.opv .rnd'), rowCss: regels('.opv .row.rnd-boven') + regels('.opv .row') });
  assert.equal(uit.who, 633 - 178 - 14, 'de rekensom uit de melding');
  assert.ok(uit.who >= 312, 'genoeg voor de naam en het nummer op één regel, was ' + uit.who);
});

test('ook op een smaller venster blijft er genoeg over voor naam en nummer', () => {
  // De fout werd zichtbaar doordat de zijbalk en het paneel breedte innemen; hij
  // was er dus al op een gewone laptopbreedte, niet pas op een telefoon.
  for (const breedte of [633, 560, 500, 460]) {
    const uit = verdeel({ rijBreedte: breedte, rndCss: regels('.opv .rnd'),
      rowCss: regels('.opv .row.rnd-boven') + regels('.opv .row') });
    assert.ok(uit.who >= 260, `bij ${breedte} houdt .who maar ${uit.who} over`);
  }
});

test('een lang rondelabel EN een lange naam samen duwen niets meer weg', () => {
  // Het echte slechtste geval: Gevorg Khetchoumian of Oussama El Bourmaki El
  // Kabir met een opwarmronde-zin erboven, niet Achraf.
  const uit = verdeel({ rndInhoud: 900, rndCss: regels('.opv .rnd'),
    rowCss: regels('.opv .row.rnd-boven') + regels('.opv .row') });
  assert.equal(uit.who, 633 - 178 - 14, 'de lengte van de zin raakt .who niet meer');
});

test('.rnd kan niet meer als kolom meedoen: volle regel én mag krimpen', () => {
  const css = regels('.opv .rnd');
  assert.match(css, /flex:\s*1\s+0\s+100%/, 'een eigen regel, niet een derde kolom');
  assert.match(css, /min-width:\s*0/, 'en hij mag krimpen in plaats van de rest weg te duwen');
});

test('alleen rijen MET een balk breken af, de andere kaarten blijven zoals ze waren', () => {
  assert.match(regels('.opv .row.rnd-boven'), /flex-wrap:\s*wrap/);
  assert.doesNotMatch(regels('.opv .row'), /flex-wrap/, 'niet globaal aanzetten');
  // En de markup zet die klasse ook echt, op allebei de kaartvormen.
  assert.equal((VIEW.match(/\(strook \? ' rnd-boven' : ''\)/g) || []).length, 2);
});
