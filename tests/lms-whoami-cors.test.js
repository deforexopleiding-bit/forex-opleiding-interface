// tests/lms-whoami-cors.test.js
//
// /api/lms-whoami stond met CORS hard op alleen het productie-origin van het
// LMS. Gevolg: op elke Vercel-preview van het LMS blokkeerde de browser de
// call en toonde het LMS "tijdelijk niet beschikbaar" — inloggen was daar
// onmogelijk, terwijl previews juist bedoeld zijn om te testen.
//
// De oplossing reflecteert het request-origin, maar alleen wanneer dat een
// preview van HETZELFDE LMS-project is. Dat is een beveiligingsgrens: er gaat
// een Bearer-token overheen, dus '*' mag hier nooit en de match moet strak
// blijven. Deze test borgt beide kanten: previews erdoor, al het andere niet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAllowedOrigin } from '../api/lms-whoami.js';

const PROD = 'https://dfo-lms-prototype.vercel.app';

// ── Wat erdoor moet ─────────────────────────────────────────────────────────

test('het productie-origin wordt teruggegeven zoals voorheen', () => {
  assert.equal(resolveAllowedOrigin(PROD), PROD);
});

test('branch-previews van hetzelfde project worden gereflecteerd', () => {
  const previews = [
    // Zoals Vercel ze vandaag uitdeelt, inclusief de ingekorte variant.
    'https://dfo-lms-prototype-git-c-461f3c-de-forex-opleiding-bv-s-projects.vercel.app',
    'https://dfo-lms-prototype-git-main-de-forex-opleiding-bv-s-projects.vercel.app',
    'https://dfo-lms-prototype-abc123xyz-de-forex-opleiding-bv-s-projects.vercel.app',
  ];
  for (const origin of previews) {
    assert.equal(resolveAllowedOrigin(origin), origin, origin);
  }
});

// ── Wat niet ────────────────────────────────────────────────────────────────

test('een vreemd origin krijgt het productie-origin terug, nooit zichzelf', () => {
  const vreemd = [
    'https://kwaadaardig.example',
    'https://dfo-lms-prototype.vercel.app.kwaadaardig.example', // suffix erachter
    'https://kwaadaardig.example/dfo-lms-prototype.vercel.app', // pad, geen host
    'http://dfo-lms-prototype.vercel.app',                       // geen https
    'https://dfo-lms-prototype.vercel.app:8443',                 // poort erbij
    'https://ander-project.vercel.app',
    'https://dfo-lms-prototype.netlify.app',                     // ander platform
  ];
  for (const origin of vreemd) {
    assert.equal(resolveAllowedOrigin(origin), PROD, origin);
  }
});

test('een ontbrekend of onbruikbaar origin valt terug op productie', () => {
  for (const origin of [undefined, null, '', 0, {}, []]) {
    assert.equal(resolveAllowedOrigin(origin), PROD, String(origin));
  }
});

test("er komt nooit een '*' uit", () => {
  // De hele reden dat dit endpoint een strikte check heeft: de browser stuurt
  // er een Bearer-token overheen.
  for (const origin of [PROD, 'https://dfo-lms-prototype-git-x-y.vercel.app', '*', undefined]) {
    assert.notEqual(resolveAllowedOrigin(origin), '*', String(origin));
  }
});
