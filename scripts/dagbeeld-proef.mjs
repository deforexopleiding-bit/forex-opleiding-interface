// scripts/dagbeeld-proef.mjs
//
// HET DAGBEELD VAN 8 SEPTEMBER, DOOR DE ECHTE SAMENVOEGING.
//
// Draaien:  node scripts/dagbeeld-proef.mjs
//
// De zeven rijen zoals ze op 9 september in follow_up_appointments stonden:
// vier echte afspraken en drie proefrijen. Het scherm toonde er tot voor kort
// EEN — alles wat een andere status kreeg viel weg achter het filter op
// `scheduled`.
//
// Dit script draait de ECHTE voegAgendaSamen(), niet een nabootsing, en zet
// exitcode 1 zodra het beeld afwijkt van wat het hoort te zijn:
//
//   · de vier echte afspraken staan er, alle vier;
//   · geen van de vier draagt een label, want geen van de vier is verzet —
//     hun status komt van buiten en die praat de module niet na;
//   · de drie proefrijen staan er niet, weggelaten op is_test en niet op naam;
//   · de ene verzette afspraak draagt wél een label, met bestemming.

import { voegAgendaSamen } from '../api/_lib/opvolging-agenda-merge.js';

const D = '2026-09-08';
const r = (naam, iso, status, extra = {}) => ({
  id: 'a-' + naam.replace(/\W/g, ''), lead_name: naam, status,
  scheduled_at: iso, eerst_gepland_op: iso,      // ← na de backfill gelijk
  is_test: false, ...extra,
});

const RIJEN = [
  // De vier echte, met de tijden zoals Maxim ze op het scherm heeft gemeten.
  r('Martin Van Pijkeren',    '2026-09-08T08:00:00Z', 'completed'),
  r('yeivi medinw',           '2026-09-08T13:00:00Z', 'scheduled'),
  r('Mehran Jahani',          '2026-09-08T16:00:00Z', 'no_show'),
  r('Sebastian Kolodziejski', '2026-09-08T18:30:00Z', 'no_show'),
  // De drie proefrijen, gemarkeerd door de migratie van 9 september.
  r('jeffrey-test', '2026-09-08T08:30:00Z', 'scheduled', { is_test: true }),
  r('jef testo',    '2026-09-08T12:00:00Z', 'scheduled', { is_test: true }),
  r('jef testo',    '2026-09-08T18:30:00Z', 'scheduled', { is_test: true }),
  // En een verzette: van 8 september naar de 15e, in dezelfde rij.
  { id: 'a-verzet', lead_name: 'Verzet naar later', status: 'scheduled', is_test: false,
    scheduled_at: '2026-09-15T13:00:00Z', eerst_gepland_op: '2026-09-08T11:00:00Z' },
];

const [dag] = voegAgendaSamen({ slots: [], afspraken: RIJEN, van: D, tot: D,
  nuMs: Date.parse('2026-09-09T09:00:00Z') });

console.log('\n8 SEPTEMBER — wat het scherm gaat tonen\n');
for (const g of dag.gepland) {
  console.log(`  ${g.doorgehaald ? '~~' : '  '} ${g.tijd}  ${g.naam.padEnd(24)} ${g.label || ''}`);
}

const fout = (regel) => { console.log('    ✗  ' + regel); process.exitCode = 1; };
const goed = (regel) => console.log('    ✓  ' + regel);

console.log('\n  De vier die Maxim op het scherm zag:');
for (const [naam, tijd] of [['Martin Van Pijkeren', '10:00'], ['yeivi medinw', '15:00'],
  ['Mehran Jahani', '18:00'], ['Sebastian Kolodziejski', '20:30']]) {
  const g = dag.gepland.find((x) => x.naam === naam);
  if (!g) fout(`${naam.padEnd(24)} ONTBREEKT`);
  else if (g.tijd !== tijd) fout(`${naam.padEnd(24)} staat op ${g.tijd}, verwacht ${tijd}`);
  else if (g.label) fout(`${naam.padEnd(24)} draagt een label uit zijn status: "${g.label}"`);
  else goed(`${naam.padEnd(24)} ${g.tijd}`);
}

console.log('\n  De drie proefrijen:');
const proef = dag.gepland.filter((g) => /test/i.test(g.naam));
if (proef.length) fout(`${proef.length} proefrij(en) staan er nog in: ` + proef.map((p) => p.tijd).join(', '));
else goed('geen van drieën staat in het dagbeeld');

console.log('\n  De verzette afspraak:');
const v = dag.gepland.find((g) => g.naam === 'Verzet naar later');
if (!v) fout('staat niet meer op 8 september — precies het gat dat dicht moest');
else if (!v.doorgehaald) fout('staat er, maar niet grijs');
else if (v.label !== 'verzet naar 15 september om 15:00') fout('label klopt niet: "' + v.label + '"');
else goed(v.tijd + '  grijs, ' + v.label);

console.log('');
