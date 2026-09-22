// tests/kv2-geen-ongedeclareerde-helpers.test.js
//
// Een aanroep op een naam die niet bestaat.
//
// ── DE VAL ───────────────────────────────────────────────────────────────────
// `showToast?.('...')` ziet eruit als "roep aan als hij bestaat". Dat is hij
// niet. Optional chaining dekt een waarde die null of undefined IS; een naam
// die nergens gedeclareerd is, gooit gewoon een ReferenceError. Het vangnet dat
// je denkt te hebben, is er niet.
//
// Dat is dubbel gemeen als zo'n aanroep in een FOUT-tak staat, want dan gaat
// hij pas stuk op het moment dat er al iets anders misging — en dan krijg je
// niet de melding die er hoort te staan, maar een lege console-fout.
//
// ── WAAROM JUIST IN DEZE BESTANDEN ───────────────────────────────────────────
// modules/klanten-v2/index.html laadt agent-shared.js NIET. Helpers als
// showToast() bestaan daar dus niet, terwijl ze in andere modules wel gewoon
// werken — dus kopieer je een regel van daar naartoe en lijkt er niets aan de
// hand. Dit is dezelfde les als nummer 11 in CLAUDE.md (onerror=
// "handleLogoError()" op pagina's die agent-shared niet laden), nu voor de
// v2-views.
//
// Deze test kwam er na een echte fout: de G8-knop "toon oudere berichten"
// riep bij een mislukte ophaling showToast?.() aan, en dat gooide in plaats
// van een melding te tonen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const MAP = new URL('../modules/klanten-v2/views/', import.meta.url);
const BESTANDEN = readdirSync(MAP).filter((f) => f.endsWith('.js'));

/** Helpers die in agent-shared.js wonen en op deze pagina's dus NIET bestaan. */
const NIET_HIER = ['showToast', 'formatMd', 'relTime', 'showReport', 'handleLogoError', 'getAvatarUrl'];

test('er zijn v2-views om na te kijken', () => {
  assert.ok(BESTANDEN.length > 0);
});

for (const naam of BESTANDEN) {
  const src = readFileSync(new URL(naam, MAP), 'utf8');

  test(`${naam}: geen aanroep met ?. op een kale naam`, () => {
    // `iets?.()` op een kale naam is geen vangnet maar een ReferenceError.
    // Op een eigenschap (window.x?.() of a.b?.()) is het wel veilig, dus die
    // laten we staan.
    const treffers = [...src.matchAll(/(?:^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\?\.\(/g)]
      .map((m) => m[1])
      .filter((n) => !['function', 'return', 'await', 'typeof'].includes(n));
    assert.deepEqual([...new Set(treffers)], [],
      'gebruik een helper die in dit bestand staat, of window.X?.()');
  });

  test(`${naam}: geen helper uit agent-shared zonder eigen versie in dit bestand`, () => {
    for (const helper of NIET_HIER) {
      // window.AgentShared.showToast(...) mag wel — dat is een eigenschap en
      // levert hoogstens undefined op, geen ReferenceError.
      const kaal = new RegExp(`(?:^|[^.\\w$'"\`])${helper}\\s*(\\?\\.)?\\(`, 'g');
      if (![...src.matchAll(kaal)].length) continue;

      // Een eigen versie in ditzelfde bestand is prima — dan is de naam
      // toevallig hetzelfde en bestaat hij gewoon. Het gaat om de gevallen
      // waar de naam NERGENS vandaan komt.
      const eigen = new RegExp(`(?:function|const|let|var)\\s+${helper}\\b`);
      assert.ok(eigen.test(src),
        `${helper}() wordt aangeroepen maar nergens in dit bestand gedeclareerd; ` +
        'hij woont in agent-shared.js, en modules/klanten-v2/index.html laadt dat niet');
    }
  });
}
