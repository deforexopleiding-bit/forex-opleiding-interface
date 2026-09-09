// scripts/dagbeeld-proef.mjs
//
// HET DAGBEELD VAN 8 SEPTEMBER, DOOR DE ECHTE SAMENVOEGING.
//
// Draaien:  node scripts/dagbeeld-proef.mjs
//
// De zeven rijen zoals ze op 9 september in follow_up_appointments stonden, na
// de migratie (eerst_gepland_op gelijk aan scheduled_at door de backfill). Het
// scherm toonde er tot nu toe EEN — alles met een uitkomst viel weg achter het
// statusfilter.
//
// Exitcode 1 zodra een van de vier echte afspraken ontbreekt of een ander
// label krijgt.

import { voegAgendaSamen } from '../api/_lib/opvolging-agenda-merge.js';

const D = '2026-09-08';
const r = (naam, iso, status) => ({
  id: 'a-' + naam.replace(/\W/g, ''), lead_name: naam, status,
  scheduled_at: iso, eerst_gepland_op: iso,      // ← na de backfill gelijk
});
const ZEVEN = [
  r('Martin Van Pijkeren',    '2026-09-08T08:00:00Z', 'completed'),
  r('yeivi medinw',           '2026-09-08T13:00:00Z', 'scheduled'),
  r('Mehran Jahani',          '2026-09-08T16:00:00Z', 'no_show'),
  r('Sebastian Kolodziejski', '2026-09-08T18:30:00Z', 'no_show'),
  r('jeffrey-test',           '2026-09-08T09:00:00Z', 'cancelled'),
  r('jef testo',              '2026-09-08T10:00:00Z', 'completed'),
  r('jef testo 2',            '2026-09-08T11:00:00Z', 'no_show'),
];

const [dag] = voegAgendaSamen({ slots: [], afspraken: ZEVEN, van: D, tot: D,
  nuMs: Date.parse('2026-09-09T09:00:00Z') });

console.log('\n8 SEPTEMBER — wat het scherm gaat tonen\n');
for (const g of dag.gepland) {
  const test = /test/i.test(g.naam);
  console.log(`  ${g.doorgehaald ? '~~' : '  '} ${g.tijd}  ${g.naam.padEnd(24)} ${(g.label || 'ingepland').padEnd(30)} ${test ? '← TESTRIJ' : ''}`);
}
const echt = dag.gepland.filter((g) => !/test/i.test(g.naam));
console.log(`\n  echte afspraken: ${echt.length}   (nu op productie: 1)`);
console.log(`  testrijen:       ${dag.gepland.length - echt.length}`);
console.log(`\n  De vier die Maxim verwacht:`);
for (const [naam, label] of [['Martin Van Pijkeren', 'geweest'], ['yeivi medinw', 'ingepland'],
  ['Mehran Jahani', 'niet gekomen'], ['Sebastian Kolodziejski', 'niet gekomen']]) {
  const g = echt.find((x) => x.naam === naam);
  const ok = g && (g.label || 'ingepland') === label;
  console.log(`    ${ok ? '✓' : '✗'}  ${naam.padEnd(24)} ${g ? (g.tijd + '  ' + (g.label || 'ingepland')) : 'ONTBREEKT'}`);
  if (!ok) process.exitCode = 1;
}
console.log('');
