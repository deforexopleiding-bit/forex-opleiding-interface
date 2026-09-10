// tests/onboarding-spiegel-kolommen.test.js
//
// WAT HIER MIS GING. De spiegel las `onboarding_trajecten.select('structure')`.
// Die kolom bestaat niet. Gevolg: alle 25 onboardings faalden met
// `column onboarding_trajecten.structure does not exist`, en omdat
// spiegelOnboarding() faalzacht is, bleef `hlms_crm_onboarding` gewoon leeg.
// Ik had een kolomnaam bedacht die paste bij wat ik verwachtte, in plaats van
// te kijken waar de wizard-structuur echt staat
// (`onboarding_wizard.published_structure`, id = 1).
//
// ── DE REGEL DIE HIER GEBORGD WORDT ────────────────────────────────────────
// De spiegel mag geen kolom noemen die NERGENS ANDERS in api/ genoemd wordt.
// Elke kolom die hij leest moet ook door minstens één ander endpoint gelezen
// of geschreven worden — een endpoint dat in productie draait en dus bewijst
// dat de kolom bestaat. Een kolomnaam die maar op één plek voorkomt is niet
// gecorroboreerd, en dat is precies de handtekening van deze bug.
//
// ── WAAROM DEZE REGEL NIET REPO-BREED STAAT ────────────────────────────────
// Gemeten voor hij geschreven werd: over alle 210 tabellen in api/ zijn er
// 785 kolommen die maar in één bestand voorkomen. Veel daarvan zijn
// volkomen legitiem (een endpoint dat als enige een kolom nodig heeft).
// Repo-breed zou deze regel dus 785 keer vals alarm slaan en binnen een week
// uitgezet worden. Daarom staat hij op de bestanden waar hij verdiend is: de
// spiegel, die naar een ANDERE databank schrijft en waar een stille
// mislukking dagenlang onzichtbaar blijft.
//
// Moet de spiegel ooit een echt unieke kolom lezen, dan hoort die in
// ALLEEN_HIER te staan MET een reden. Dat is de bedoeling: niet onmogelijk,
// wel expliciet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const ONDER_TOEZICHT = [
  'api/_lib/onboarding-spiegel.js',
  'api/_lib/onboarding-spiegel-sync.js',
];

/**
 * Kolommen die de spiegel als enige mag noemen, met de reden erbij.
 * Leeg is goed nieuws.
 */
const ALLEEN_HIER = {
  // 'tabel.kolom': 'reden waarom niets anders deze kolom leest',
};

const lees = (p) => readFileSync(path.resolve(process.cwd(), p), 'utf8');

/** Alle .from('tabel').select('a, b, c') uit een bron. */
function selecties(bron) {
  const uit = [];
  const re = /\.from\(\s*['"]([a-z_]+)['"]\s*\)\s*\.select\(\s*(['"`])([\s\S]*?)\2/g;
  let m;
  while ((m = re.exec(bron))) {
    const tabel = m[1];
    const ruw = m[3];
    if (/\(/.test(ruw)) continue;   // embedded joins hebben hun eigen vorm
    for (let kol of ruw.split(',')) {
      kol = kol.trim().split(':').pop().trim();  // alias:kolom → kolom
      if (!kol || kol === '*' || /\s/.test(kol)) continue;
      uit.push({ tabel, kol });
    }
  }
  return uit;
}

/** Noemt een bron deze kolom van deze tabel ergens — lezend of schrijvend? */
function noemt(bron, tabel, kol) {
  if (!bron.includes("'" + tabel + "'") && !bron.includes('"' + tabel + '"')) return false;
  // In een select-lijst, of als sleutel in een object dat weggeschreven wordt.
  const inSelect = selecties(bron).some((s) => s.tabel === tabel && s.kol === kol);
  const alsVeld  = new RegExp('[\\s{,\'"]' + kol + '\\s*[:,]').test(bron);
  return inSelect || alsVeld;
}

const ALLE_API = execSync("find api -name '*.js'").toString().trim().split('\n');

test('KOLOMMEN — de spiegel noemt geen kolom die nergens anders bestaat', () => {
  const onbevestigd = [];

  for (const bestand of ONDER_TOEZICHT) {
    const bron = lees(bestand);
    for (const { tabel, kol } of selecties(bron)) {
      const sleutel = tabel + '.' + kol;
      if (ALLEEN_HIER[sleutel]) continue;

      const elders = ALLE_API.filter((f) => {
        if (ONDER_TOEZICHT.some((t) => path.resolve(process.cwd(), t) === path.resolve(process.cwd(), f))) return false;
        return noemt(readFileSync(f, 'utf8'), tabel, kol);
      });

      if (elders.length === 0) onbevestigd.push(sleutel + '  (in ' + bestand + ')');
    }
  }

  assert.deepEqual(onbevestigd, [],
    'de spiegel leest kolommen die verder nergens in api/ voorkomen:\n  '
    + onbevestigd.join('\n  ')
    + '\n\nDat is de handtekening van een verzonnen kolomnaam — zo faalde de '
    + 'spiegel op alle 25 onboardings met "column onboarding_trajecten.structure '
    + 'does not exist". Klopt de kolom wél, zet hem dan in ALLEEN_HIER met een '
    + 'reden erbij.');
});

test('KOLOMMEN — de wizard-structuur komt uit dezelfde bron als de admin-lijst', () => {
  // Harde eis: de vier feiten worden op DEZELFDE manier berekend als in
  // admin-future-students-list.js. Voor de structuur betekent dat: tabel
  // onboarding_wizard, kolom published_structure, id = 1 — niet per traject.
  const spiegel = lees('api/_lib/onboarding-spiegel.js');
  const admin   = lees('api/admin-future-students-list.js');

  for (const bron of [spiegel, admin]) {
    assert.match(bron, /from\(['"]onboarding_wizard['"]\)/);
    assert.match(bron, /published_structure/);
    assert.match(bron, /\.eq\(['"]id['"],\s*1\)/,
      'de gepubliceerde structuur hoort op id = 1 gelezen te worden');
  }

  // Op de GEPARSEERDE aanroep toetsen, niet op de tekst. De toelichting
  // bovenaan de functie noemt de oude, foute lezing met opzet — dat is de
  // uitleg waarom hij weg is, en een test die daarop afgaat dwingt je om het
  // commentaar te slopen in plaats van de code te repareren. Dat is deze week
  // al drie keer gebeurd.
  const fout = selecties(spiegel).find(
    (x) => x.tabel === 'onboarding_trajecten' && x.kol === 'structure');
  assert.equal(fout, undefined,
    'de spiegel leest de structuur nog van onboarding_trajecten — die kolom bestaat niet');
});

test('KOLOMMEN — een mislukte wizard-lezing laat de rij bestaan, maar liegt niet', () => {
  const bron = lees('api/_lib/onboarding-spiegel.js');
  // Niet gooien: één hapering mag niet 25 klanten onzichtbaar maken.
  assert.ok(!/throw new Error\('wizard/.test(bron),
    'een mislukte wizard-lezing gooit nog, en dan is er van niemand een rij');
  // Maar wel opschrijven dat de bron haperde.
  assert.match(bron, /bron_status\s*:\s*wizard\.fout\s*\?\s*BRON_ONBEREIKBAAR/,
    'bij een mislukte wizard-lezing hoort bron_status op onbereikbaar te staan');
  assert.match(bron, /bron_fout\s*:\s*wizard\.fout/,
    'de reden hoort in bron_fout te belanden');
});
