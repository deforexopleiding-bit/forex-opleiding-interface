// tests/opvolging-gezondheid-dagritme.test.js
//
// DE ZESDE CONTROLE: STAAT ER EEN OPEN KAART IN HET VERLEDEN?
//
// Op 8 september bleek dat de nachtelijke doorrol elke openstaande kaart een
// dag liet OVERSLAAN — vijf leads van 7 september stonden op de 9e en dus op de
// 8e nergens. De gezondheidscontrole draait elke ochtend om 07:00, meteen na de
// doorrol, en heeft dat NIET gezien. Vijf kaarten verdwenen uit de dag en er
// ging geen enkel belletje af.
//
// De vijf bestaande controles kijken allemaal naar een CIJFER: klopt een som,
// staat iemand dubbel, laat de brug iets door. Deze gaat over het DAGRITME
// zelf, en dat is een andere soort vraag.
//
// De regel is hard en heeft geen drempel nodig: een taak die OPEN staat hoort
// vandaag of later te staan. Een open kaart met een due in het verleden hoort
// per definitie niet te bestaan — hij staat op geen enkele lijst en niemand
// komt hem nog tegen.
//
// Twee kanten op, allebei even belangrijk:
//   · staat er zo'n kaart → FOUT, met de namen erbij, want anders weet je wel
//     dat er iets mis is maar niet bij wie;
//   · staan er nul open kaarten → NIET_GEMETEN, niet 'ok'. Een lege lijst is
//     geen bewijs dat het dagritme werkt. Zie de kop van
//     api/_lib/opvolging-gezondheid.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  controleerDagritme, OK, FOUT, NIET_GEMETEN,
} from '../api/_lib/opvolging-gezondheid.js';

const VANDAAG = '2026-09-08';

test('een open kaart met een due in het verleden is FOUT', () => {
  const u = controleerDagritme({
    taken: [{ naam: 'Achraf Deflaoui', due: '2026-09-07' }], vandaag: VANDAAG,
  });
  assert.equal(u.staat, FOUT);
  assert.equal(u.naam, 'dagritme');
});

test('de namen staan erbij — anders weet je niet bij wie het misging', () => {
  const namen = ['Achraf Deflaoui', 'Kris Sienaert', 'Said Hachemi',
    'Gevorg Khetchoumian', 'Werner De Kesel'];
  const u = controleerDagritme({
    taken: namen.map((naam) => ({ naam, due: '2026-09-07' })), vandaag: VANDAAG,
  });
  assert.equal(u.staat, FOUT);
  assert.equal(u.getallen.achterstallig, 5);
  for (const n of namen) assert.match(JSON.stringify(u.getallen), new RegExp(n));
});

test('kaarten van vandaag en later zijn gewoon in orde', () => {
  const u = controleerDagritme({
    taken: [
      { naam: 'Vandaag', due: VANDAAG },
      { naam: 'Bevestigd, slaapt tot de 19e', due: '2026-09-19' },
    ],
    vandaag: VANDAAG,
  });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.achterstallig, 0);
  assert.equal(u.getallen.bekeken, 2);
});

test('nul open kaarten is NIET GEMETEN, niet ok', () => {
  // Een lege lijst bewijst niets over het dagritme. Dit als groen boeken is
  // precies de val die de kop van opvolging-gezondheid.js beschrijft.
  const u = controleerDagritme({ taken: [], vandaag: VANDAAG });
  assert.equal(u.staat, NIET_GEMETEN);
});

test('een kaart zonder bruikbare due telt niet als achterstallig', () => {
  // Onbekend is geen verleden. Zo'n rij is een ander probleem en hoort niet als
  // 'de doorrol is stuk' gemeld te worden.
  const u = controleerDagritme({
    taken: [{ naam: 'Zonder due', due: null }, { naam: 'Rommel', due: '8 september' }],
    vandaag: VANDAAG,
  });
  assert.equal(u.staat, OK);
  assert.equal(u.getallen.achterstallig, 0);
  assert.equal(u.getallen.zonder_due, 2);
});

test('zonder geldige dag meet de controle niets in plaats van van alles', () => {
  const u = controleerDagritme({ taken: [{ naam: 'X', due: '2026-09-07' }], vandaag: 'vandaag' });
  assert.equal(u.staat, NIET_GEMETEN);
});

test('de uitleg noemt de doorrol, zodat de oorzaak niet opnieuw gezocht hoeft', () => {
  const u = controleerDagritme({ taken: [{ naam: 'X', due: '2026-09-01' }], vandaag: VANDAAG });
  assert.match(u.uitleg, /doorrol/i);
});

// ═══════════════════════════════════════════════════════════════════════════
// EN OP HET PAD DAT ELKE OCHTEND ECHT DRAAIT
// ═══════════════════════════════════════════════════════════════════════════

test('de ochtendcontrole voert deze zesde controle ook echt uit', () => {
  const bron = readFileSync('api/cron-opvolging-gezondheid.js', 'utf8')
    .split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.match(bron, /controleerDagritme/,
    'zonder aanroep is de controle een functie die niemand draait');
  assert.match(bron, /uitkomsten\.push\(controleerDagritme\(/);
});

test('hij leest de open kaarten met hun due, niet iets anders', () => {
  const bron = readFileSync('api/cron-opvolging-gezondheid.js', 'utf8');
  const blok = bron.slice(bron.indexOf('6 · '), bron.indexOf('6 · ') + 1200);
  assert.match(blok, /\.eq\('status', 'open'\)/);
  assert.match(blok, /select\('[^']*due[^']*'\)/);
});
