// scripts/doorrol-bewijs.mjs
//
// DE DOORROL, DRAAIEND TEGEN EEN GESIMULEERDE KLOK.
//
// Draaien:  node scripts/doorrol-bewijs.mjs
//
// Waarom dit naast de tests staat: op 8 september stond de suite groen met
// 2501 tests terwijl /api/opvolging-rapport 500 gaf. Een groene suite is sinds
// die dag geen bewijs meer, en dit script laat de ECHTE functies hun antwoord
// geven op de concrete momenten die ertoe doen — met het antwoord van de oude
// regel ernaast. Geen mocks van de functies zelf, alleen de klok is gezet.
//
// Exitcode 1 zodra een uitkomst afwijkt, zodat hij ook in een pipeline kan.

import { doorrolDag, bepaalDoorrol } from '../api/_lib/opvolging-doorrol.js';

const regel = (t) => console.log(t);
const toon = (label, waarde, verwacht) => {
  const ok = waarde === verwacht;
  regel(`  ${ok ? '✓' : '✗ FOUT'}  ${label}`);
  regel(`         uitkomst: ${waarde}   verwacht: ${verwacht}`);
  if (!ok) process.exitCode = 1;
};

regel('');
regel('══ 1 · DE CRON VAN VANNACHT ════════════════════════════════════════');
regel('   Vercel draait `59 23 * * *` in UTC. Dat is 2026-09-08T23:59Z,');
regel('   en dat is in Amsterdam (CEST, UTC+2) al 2026-09-09 om 01:59.');
regel('');
const NACHT = Date.parse('2026-09-08T23:59:00Z');
regel(`   klok: ${new Date(NACHT).toISOString()}  (UTC)`);
regel(`         ${new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' }).format(NACHT)}  (Amsterdam)`);
regel('');
toon('op welke dag richt de doorrol?', doorrolDag(NACHT), '2026-09-09');

regel('');
regel('   Een open taak die vandaag (8 september) op de lijst staat:');
const taak = [{ id: 't-vandaag', status: 'open', due: '2026-09-08', later: true }];
const patches = bepaalDoorrol({ taken: taak, vandaag: doorrolDag(NACHT) });
toon('krijgt due', patches[0]?.patch?.due, '2026-09-09');
toon('en later terug op false', String(patches[0]?.patch?.later), 'false');
regel('');
regel('   Ter vergelijking, wat de OUDE regel deed (dagInZone(nu + 24 uur)):');
const oudeDag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(NACHT + 24 * 3600 * 1000));
regel(`         die kwam uit op ${oudeDag}  → 9 september werd overgeslagen`);

regel('');
regel('══ 2 · EEN GEMISTE NACHT ═══════════════════════════════════════════');
regel('   Een taak die op 6 september is blijven staan, bij een run van nu.');
regel('');
const NU = Date.parse('2026-09-08T12:00:00Z');   // vandaag, midden op de dag
regel(`   klok: ${new Date(NU).toISOString()}  → dag ${doorrolDag(NU)}`);
const oud = bepaalDoorrol({ taken: [{ id: 't-oud', status: 'open', due: '2026-09-06' }], vandaag: doorrolDag(NU) });
toon('een taak van 6 september komt uit op', oud[0]?.patch?.due, '2026-09-08');
regel('         (de oude regel maakte hier 7 september van — opnieuw in het verleden)');

regel('');
regel('══ 3 · WINTERTIJD, want de klok schuift twee keer per jaar ══════════');
const WINTER = Date.parse('2026-12-08T23:59:00Z');   // CET, UTC+1 → 00:59 lokaal
regel(`   klok: ${new Date(WINTER).toISOString()}  (UTC)`);
regel(`         ${new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', dateStyle: 'short', timeStyle: 'short' }).format(WINTER)}  (Amsterdam)`);
toon('richt op', doorrolDag(WINTER), '2026-12-09');

regel('');
regel('══ 4 · IDEMPOTENT ══════════════════════════════════════════════════');
const dag = doorrolDag(NACHT);
const eerste = bepaalDoorrol({ taken: taak, vandaag: dag });
const na = taak.map((t) => ({ ...t, ...eerste[0].patch }));
toon('tweede run raakt nog iets aan?', String(bepaalDoorrol({ taken: na, vandaag: dag }).length), '0');

regel('');
regel('══ 5 · WAT HIJ MET RUST LAAT ═══════════════════════════════════════');
const gemengd = [
  { id: 'bevestigd-slaapt', status: 'open',         due: '2026-09-19' },
  { id: 'ingepland',        status: 'ingepland',    due: '2026-09-01' },
  { id: 'gearchiveerd',     status: 'gearchiveerd', due: '2026-09-01' },
  { id: 'staat-al-goed',    status: 'open',         due: '2026-09-09' },
  { id: 'loopt-achter',     status: 'open',         due: '2026-09-08' },
];
const geraakt = bepaalDoorrol({ taken: gemengd, vandaag: dag }).map((p) => p.id);
toon('alleen deze worden aangeraakt', JSON.stringify(geraakt), '["loopt-achter"]');
regel('');
