// tests/iris-post-breedtes.test.js
//
// DE KOLOM DIE ALS ENIGE MEEGAF.
//
// De Post stond als één inline grid-regel in de opmaak:
//
//     minmax(260px,320px)  minmax(0,1fr)  minmax(240px,300px)
//     └ lijst              └ DRAAD        └ dossierkaart
//
// Op een laptop van 994px breed, met de zijbalk van de schil ernaast, blijft
// er voor die drie te weinig over. De twee buitenste houden hun ondergrens
// vast; de middelste is de enige met ondergrens nul en geeft dus als enige
// mee. Gemeten op productie: de draad kromp tot 22 pixels. Een tekstvak van
// 22 pixels, en een microfoonknop die eronder buiten beeld viel op y≈1450.
// Antwoorden was daarmee onmogelijk — precies het enige wat je in dat scherm
// komt doen.
//
// Een inline stijl kan geen mediaquery dragen, dus de breedtes staan nu in
// een stijlblok. Deze test bewaakt het principe dat eraan ten grondslag ligt:
// DE DRAAD GEEFT NOOIT ALS EERSTE MEE. Een volgende hand die er een kolom bij
// zet, valt hier om in plaats van op het scherm van iemand die zit te werken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bron = readFileSync(join(ROOT, 'modules/iris/iris.js'), 'utf8');

/** Het stijlblok van de Post. */
function css() {
  const begin = bron.indexOf('const POST_CSS = `<style>');
  assert.ok(begin > -1, 'POST_CSS niet gevonden');
  const eind = bron.indexOf('</style>`', begin);
  return bron.slice(begin, eind);
}

/** Alle `grid-template-columns`-regels, met de breedte waarbij ze gelden. */
function kolomRegels() {
  const blok = css();
  const uit = [];
  // De basisregel staat buiten elke mediaquery; daarna volgt er per query één.
  const stukken = blok.split(/@media[^{]*\(max-width:\s*(\d+)px\)/);
  // stukken = [basis, breedte1, blok1, breedte2, blok2, …]
  const pak = (tekst) => {
    const m = tekst.match(/grid-template-columns:\s*([^;]+);/);
    return m ? m[1].trim() : null;
  };
  const basis = pak(stukken[0]);
  if (basis) uit.push({ tot: Infinity, kolommen: basis });
  for (let i = 1; i < stukken.length; i += 2) {
    const k = pak(stukken[i + 1] || '');
    if (k) uit.push({ tot: Number(stukken[i]), kolommen: k });
  }
  return uit;
}

/** De kolomdefinities uit één grid-template-columns, als losse stukken. */
function splitsKolommen(regel) {
  // minmax(a,b) bevat een komma, dus niet op komma splitsen maar op spaties
  // buiten de haakjes.
  const uit = [];
  let diep = 0;
  let huidig = '';
  for (const teken of regel) {
    if (teken === '(') diep++;
    if (teken === ')') diep--;
    if (teken === ' ' && diep === 0) {
      if (huidig.trim()) uit.push(huidig.trim());
      huidig = '';
      continue;
    }
    huidig += teken;
  }
  if (huidig.trim()) uit.push(huidig.trim());
  return uit;
}

/** De ondergrens van een kolomdefinitie in pixels. `minmax(360px,1fr)` → 360. */
function ondergrens(def) {
  const m = def.match(/minmax\(\s*(\d+)px/);
  if (m) return Number(m[1]);
  if (/^minmax\(\s*0/.test(def)) return 0;
  const vast = def.match(/^(\d+)px$/);
  if (vast) return Number(vast[1]);
  return null;   // fr, auto, % — geen harde ondergrens
}

test('er zijn drie standen: breed, middel en smal', () => {
  const regels = kolomRegels();
  assert.equal(regels.length, 3, 'verwacht een basis plus twee mediaqueries');
  const grenzen = regels.map((r) => r.tot);
  assert.deepEqual(grenzen, [Infinity, 1199, 899]);
});

test('de draad houdt in elke stand een ondergrens', () => {
  // Dit is de fout, in één regel: de draad had ondergrens nul en was daarmee
  // de enige die kon verdwijnen.
  for (const r of kolomRegels()) {
    const kolommen = splitsKolommen(r.kolommen);
    // In de brede en de middelste stand is de draad de tweede kolom; in de
    // smalle stand is er maar één kolom, en dat is de draad (of de lijst).
    const label = r.tot === Infinity ? 'breed' : `tot ${r.tot}px`;

    if (kolommen.length === 1) {
      // Eén kolom: de draad IS de volle breedte. `minmax(0,1fr)` hoort hier
      // juist wél — zonder die nul kan een rasterkind niet krimpen en loopt
      // het over de rand in plaats van mee te schalen. Een ondergrens eisen
      // zou hier het tegenovergestelde bereiken van wat we willen.
      assert.match(kolommen[0], /1fr/, `${label}: de enige kolom hoort de volle breedte te nemen`);
      continue;
    }

    const draad = kolommen[1];
    const min = ondergrens(draad);
    assert.ok(min !== 0 && min !== null, `${label}: de draad heeft geen ondergrens (${draad})`);
    assert.ok(min >= 300, `${label}: de draad mag niet onder 300px kunnen (${draad})`);
  }
});

test('de draad is nooit de smalste kolom van de rij', () => {
  for (const r of kolomRegels()) {
    const kolommen = splitsKolommen(r.kolommen);
    if (kolommen.length < 2) continue;
    const draadMin = ondergrens(kolommen[1]);
    for (let i = 0; i < kolommen.length; i++) {
      if (i === 1) continue;
      const anderMin = ondergrens(kolommen[i]);
      if (anderMin === null) continue;
      assert.ok(draadMin >= anderMin,
        `bij max-width ${r.tot}: kolom ${i} (${kolommen[i]}) heeft een hogere ondergrens dan de draad (${kolommen[1]})`);
    }
  }
});

test('boven 1200px staan alle drie de kolommen er', () => {
  assert.equal(splitsKolommen(kolomRegels()[0].kolommen).length, 3);
});

test('onder 1200px schuift de dossierkaart onder de draad', () => {
  const blok = css();
  assert.match(blok, /\.iris-post-dossier\{[^}]*grid-column:2;\s*grid-row:2/,
    'de dossierkaart hoort onder de draad te komen, niet ernaast');
  assert.match(blok, /\.iris-post\.dossier-open \.iris-post-dossier\{display:block\}/);
  assert.match(blok, /\.iris-dossier-knop\{display:inline-flex\}/, 'zonder knop valt hij niet open te krijgen');
});

test('onder 900px zijn lijst en draad stappen', () => {
  const blok = css();
  assert.match(blok, /\.iris-post\.heeft-keuze \.iris-post-lijst\{display:none\}/);
  assert.match(blok, /\.iris-post\.heeft-keuze \.iris-post-draad\{display:block/);
  assert.match(blok, /\.iris-terug-knop\{display:inline-flex\}/, 'zonder weg terug zit je vast in de draad');
});

test('de knoppen staan standaard uit en de klassen worden gezet', () => {
  const blok = css();
  assert.match(blok, /\.iris-dossier-knop\{display:none\}/);
  assert.match(blok, /\.iris-terug-knop\{display:none\}/);
  // En het scherm hangt de twee toestanden als klasse aan de grid.
  assert.match(bron, /if \(S\.gekozen\) klassen\.push\('heeft-keuze'\);/);
  assert.match(bron, /if \(S\.dossierOpen\) klassen\.push\('dossier-open'\);/);
});

test('de draad blijft een flex-kolom, zodat de schrijfbalk onderaan plakt', () => {
  // De berichten scrollen, de kop en de schrijfbalk niet. Valt dit weg, dan
  // schuift het tekstvak mee naar beneden en staat de microfoon weer buiten
  // beeld — een andere weg naar precies dezelfde klacht.
  const blok = css();
  // De rastercel mag niet meegroeien met zijn inhoud; de flex-kolom zit
  // binnenin, in draadKolom(). Zonder min-height:0 weigert een rastercel
  // kleiner te worden dan zijn inhoud, en dan scrollt de draad niet maar
  // groeit hij — met de schrijfbalk ergens onder de vouw.
  assert.match(blok, /\.iris-post > \*\{min-width:0;min-height:0;overflow:hidden\}/);
  const fn = bron.slice(bron.indexOf('function draadKolom()'));
  assert.match(fn.slice(0, 2000), /flex:1;overflow-y:auto/);
});
