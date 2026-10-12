// tests/iris-dode-knop.test.js
//
// De eerste klik die niets deed.
//
// ── WAT ER GEBEURDE ─────────────────────────────────────────────────────────
// Eerste klik op Uitzoeken direct na het laden: de knop werd uitgeschakeld, er
// vertrok GEEN verzoek (de serverlogs waren leeg), en na tachtig seconden
// stond het er nog zo. Na herladen werkte dezelfde klik meteen.
//
// ── DE OORZAAK ──────────────────────────────────────────────────────────────
// `haalRuw()` deed `await window.AuthShared.getAccessToken()` zonder eerst
// `window._authSharedReady` te awaiten — precies de regel die CLAUDE.md
// "ALTIJD" noemt. Vlak na het laden bestaat `window.supabase` soms nog niet en
// houdt supabase-js een slot vast terwijl het de sessie vernieuwt; dan geeft
// getAccessToken() nooit antwoord en hangt alles erachter. Geen fout, geen
// melding, geen log — alleen een knop op "Bezig…".
//
// `authedFetch()` in klanten-v2.js had hetzelfde gat, en die wordt door de
// hele v2-schil gebruikt.
//
// ── WAAROM OOK EEN PLAFOND, EN NIET ALLEEN DE HUISREGEL ─────────────────────
// De huisregel dicht de oorzaak die wij kennen. Het plafond dicht de klasse:
// welke belofte hier ook ooit blijft hangen, hij wordt een zichtbare fout die
// je kúnt oplossen in plaats van een scherm dat niets zegt. Dat is het
// verschil tussen een storing en een raadsel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const IRIS = readFileSync(new URL('../modules/iris/iris.js', import.meta.url), 'utf8');
const SCHIL = readFileSync(new URL('../modules/klanten-v2/klanten-v2.js', import.meta.url), 'utf8');
const INDEX = readFileSync(new URL('../modules/klanten-v2/index.html', import.meta.url), 'utf8');

/** Zonder commentaar, want deze toetsen zoeken CODE en niet uitleg erover. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

test('nergens wordt AuthShared aangesproken zonder _authSharedReady ervoor', () => {
  // Eén overgeslagen plek is genoeg om de dode knop terug te krijgen, dus dit
  // meet op het hele bestand en niet op één functie.
  for (const [naam, src] of [['iris.js', code(IRIS)], ['klanten-v2.js', code(SCHIL)]]) {
    const ruw = [...src.matchAll(/AuthShared[\s\S]{0,40}?getAccessToken\(\)/g)];
    for (const m of ruw) {
      const voor = src.slice(Math.max(0, m.index - 600), m.index);
      assert.ok(
        /_authSharedReady/.test(voor) || /metPlafond\(\s*$/.test(voor.trimEnd()),
        `${naam}: getAccessToken() zonder _authSharedReady ervoor — dat is de dode knop`,
      );
    }
  }
});

test('iris.js vraagt het token via één functie, niet op drie plekken', () => {
  // Drie kopieën van hetzelfde token-blok betekent dat de volgende reparatie
  // er twee mist. Dat is precies hoe dit gat ontstond.
  assert.match(IRIS, /async function haalToken\(\)/);
  assert.match(IRIS, /await metPlafond\(\s*window\._authSharedReady,/);
  const kopieen = (code(IRIS).match(/AuthShared[\s\S]{0,40}?getAccessToken\(\)/g) || []).length;
  assert.equal(kopieen, 1, 'er hoort precies één plek te zijn die het token opvraagt');
});

test('het token heeft een plafond van acht seconden', () => {
  // Ruim voor een token, kort genoeg om een vastloper te laten zien in plaats
  // van te laten hangen.
  for (const [naam, src] of [['iris.js', IRIS], ['klanten-v2.js', SCHIL]]) {
    assert.match(src, /const TOKEN_WACHT_MS = 8000;/, naam);
  }
});

test('en de aanroep zelf ook, ruim boven de 60 s van Vercel', () => {
  // Zou dit plafond onder de 60 s liggen, dan breken we een aanroep af die de
  // server nog aan het afmaken is — en dan weet niemand of het gelukt is.
  assert.match(IRIS, /const AANROEP_WACHT_MS = 70000;/);
  const m = IRIS.match(/const AANROEP_WACHT_MS = (\d+);/);
  assert.ok(Number(m[1]) > 60000, 'het plafond hoort boven de Vercel-grens te liggen');
});

test('bij een vastloper komt er een fout, geen aanroep zonder token', () => {
  // Doorgaan zonder token geeft een 401 en ziet eruit als een rechtenprobleem,
  // terwijl het een vastgelopen sessie is. Liever de echte reden.
  assert.match(IRIS, /De aanmelding reageert niet\. Herlaad de pagina\./);
  assert.match(IRIS, /Je sessie reageert niet\. Herlaad de pagina\./);
  assert.match(SCHIL, /De aanmelding reageert niet\. Herlaad de pagina\./);
  assert.match(SCHIL, /Je sessie reageert niet\. Herlaad de pagina\./);
});

test('metPlafond ruimt zijn eigen klok op', () => {
  // Zonder clearTimeout houdt elke geslaagde aanroep een timer in de lucht.
  // Bij een scherm dat de hele dag openstaat tikt dat aan.
  for (const [naam, src] of [['iris.js', IRIS], ['klanten-v2.js', SCHIL]]) {
    const i = src.indexOf('async function metPlafond');
    assert.ok(i > 0, naam + ': metPlafond hoort te bestaan');
    const lijf = src.slice(i, i + 500);
    assert.match(lijf, /finally \{/, naam);
    assert.match(lijf, /clearTimeout\(klok\)/, naam);
  }
});

test('het scherm zegt dat Iris aan het denken is', () => {
  // De knop zei "Bezig…" en verder niets. Uitzoeken duurt tien tot twintig
  // seconden; zonder iets erbij lijkt dat op niets.
  assert.match(IRIS, /Iris zoekt het uit — dit duurt meestal tien tot twintig seconden\./);
  assert.match(IRIS, /\$\{st\.maakt \?/);
});

test('beide gewijzigde bestanden hebben een nieuw nummer', () => {
  // Zonder bump laadt de browser de oude kopie en is de reparatie er voor
  // niemand — en dit is juist een reparatie die je pas ziet bij de eerste klik
  // na het laden.
  assert.match(INDEX, /\.\.\/iris\/iris\.js\?v=21/);
  assert.match(INDEX, /klanten-v2\.js\?v=1f6/);
});
