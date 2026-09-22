// tests/softphone-uitgaand-nummer.test.js
//
// DAVE KIEST ZELF MET WELK NUMMER HIJ BELT.
//
// Dat nummer is wat de lead op zijn scherm ziet, en daar hangt af of er wordt
// opgenomen. Tot nu toe verscheen de keuzelijst alleen als er nummers WAREN;
// bij een lege lijst zag Dave niets — geen keuze, geen uitleg — en belde hij
// op 'Voys · standaard' zonder te weten dat er niets was ingesteld. Een leeg
// vak leest als 'het is geregeld'.
//
// ── WAT HIER BEWEZEN WORDT ────────────────────────────────────────────────
// De echte functies uit klx-softphone.js, uitgevoerd in een node:vm. Niet de
// brontekst gelezen: een test die naar woorden kijkt ziet niet of het vak
// daadwerkelijk getekend wordt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const BRON = readFileSync('modules/shared/klx-softphone.js', 'utf8');

/**
 * Eén functie uit het bestand knippen en draaien.
 *
 * Haakjes tellen vanaf het lichaam, niet vanaf de handtekening: een
 * parameterlijst met destructurering opent zelf al een accolade, en daarop
 * tellen knipt de functie af bij de parameters. Loopt de balans niet af, dan
 * faalt dit luid in plaats van een half stuk tekst te draaien.
 */
function knip(naam) {
  const start = BRON.indexOf('  function ' + naam + '(');
  assert.ok(start > 0, naam + ' is niet gevonden in klx-softphone.js');
  const lichaam = BRON.indexOf('{', BRON.indexOf(')', start));
  let diep = 0; let eind = -1;
  for (let n = lichaam; n < BRON.length; n += 1) {
    const ch = BRON[n];
    if (ch === "'" || ch === '`') { const q = BRON.indexOf(ch, n + 1); if (q < 0) break; n = q; continue; }
    if (ch === '{') diep += 1;
    else if (ch === '}') { diep -= 1; if (diep === 0) { eind = n; break; } }
  }
  assert.ok(eind > lichaam, naam + ' loopt niet af — anker of code is stuk');
  return BRON.slice(start, eind + 1);
}

/** Een omgeving met de vier functies die over het uitgaande nummer gaan. */
function omgeving({ nl = [], be = [], gekozen = {} } = {}) {
  const state = {
    config: { accounts: { nl: { caller_ids: nl }, be: { caller_ids: be } } },
    accByLine: {},
    callerIdByLine: { nl: '', be: '', ...gekozen },
  };
  const ctx = createContext({ state, console });
  runInContext(
    knip('callerIdsForLine') + '\n'
    + knip('selectedCallerIdForLine') + '\n'
    + knip('callerIdEnvVoor') + '\n'
    + knip('resolveEffectiveCallerId') + '\n'
    + knip('callbarOndertitel') + '\n'
    + 'const api = { callerIdsForLine, selectedCallerIdForLine, callerIdEnvVoor, '
    + 'resolveEffectiveCallerId, callbarOndertitel };\napi;',
    ctx, { filename: 'klx-softphone.js#cid' },
  );
  return { api: runInContext('api', ctx), state };
}

const NL = ['+31201234567', '+31612345678'];
const BE = ['+3231234567'];

// ═══════════════════════════════════════════════════════════════════════════
// EEN NL-NUMMER GAAT NOOIT OVER DE BE-LIJN
// ═══════════════════════════════════════════════════════════════════════════

test('de keuze wordt per lijn onthouden', () => {
  const { api } = omgeving({ nl: NL, be: BE, gekozen: { nl: NL[1], be: BE[0] } });
  assert.equal(api.selectedCallerIdForLine('nl'), NL[1]);
  assert.equal(api.selectedCallerIdForLine('be'), BE[0]);
});

test('een NL-nummer dat op de BE-lijn staat wordt weggefilterd', () => {
  // Dit vangnet zat er al en moest bewaard blijven. Met één globale sleutel
  // was dit de normale gang van zaken; nu is het de uitzondering.
  const { api } = omgeving({ nl: NL, be: BE, gekozen: { be: NL[0] } });
  assert.equal(api.resolveEffectiveCallerId('be'), '',
    'een NL-nummer mag nooit als beller-ID over de BE-lijn gaan');
});

test('een nummer dat wel bij de lijn hoort gaat gewoon mee', () => {
  const { api } = omgeving({ nl: NL, be: BE, gekozen: { nl: NL[0], be: BE[0] } });
  assert.equal(api.resolveEffectiveCallerId('nl'), NL[0]);
  assert.equal(api.resolveEffectiveCallerId('be'), BE[0]);
});

test('geen keuze betekent Voys · standaard, en dat is leeg', () => {
  const { api } = omgeving({ nl: NL, be: BE });
  assert.equal(api.resolveEffectiveCallerId('nl'), '');
});

// ═══════════════════════════════════════════════════════════════════════════
// BIJ EEN LEGE LIJST STAAT ER WAT ER ONTBREEKT
// ═══════════════════════════════════════════════════════════════════════════

test('elke lijn noemt zijn eigen env-var', () => {
  const { api } = omgeving();
  assert.equal(api.callerIdEnvVoor('nl'), 'VOYS_CALLER_IDS');
  assert.equal(api.callerIdEnvVoor('be'), 'VOYS_BE_CALLER_IDS');
});

test('het vak voor het uitgaande nummer staat er ALTIJD', () => {
  // Ook bij nul nummers, en ook bij precies één. Het blok stond vroeger achter
  // `availableCids.length ?` en verdween dan helemaal.
  const sjabloon = BRON.slice(BRON.indexOf('Uitgaand nummer') - 400,
                              BRON.indexOf('Uitgaand nummer') + 900);
  assert.doesNotMatch(sjabloon, /\$\{availableCids\.length \? `\s*<div class="klx-call-sheet-top"/,
    'het hele blok hangt weer aan een niet-lege lijst');
  assert.match(sjabloon, /klxCallCidLeeg/, 'de lege-toestand hoort een eigen regel te hebben');
});

test('bij een lege lijst staat de ontbrekende env-var op het scherm', () => {
  const i = BRON.indexOf('klxCallCidLeeg');
  const regel = BRON.slice(i - 200, i + 200);
  assert.match(regel, /Geen uitbelnummers ingesteld/);
  assert.match(regel, /esc\(cidEnv\)/, 'de naam van de env-var hoort erbij te staan');
});

test('met één nummer verschijnt de keuzelijst gewoon', () => {
  const { api } = omgeving({ nl: ['+31201234567'] });
  assert.deepEqual(api.callerIdsForLine('nl'), ['+31201234567']);
});

// ═══════════════════════════════════════════════════════════════════════════
// TIJDENS HET GESPREK ZIE JE WAARMEE JE BELT
// ═══════════════════════════════════════════════════════════════════════════

test('de callbar toont het uitgaande nummer', () => {
  const { api } = omgeving({ be: BE, gekozen: { be: BE[0] } });
  assert.equal(api.callbarOndertitel('Sofia', '+32470112233', 'be'),
    'Sofia — +32470112233 · via ' + BE[0]);
});

test('zonder keuze staat er niets over "via"', () => {
  // 'via Voys · standaard' zou een keuze suggereren die niemand gemaakt heeft.
  const { api } = omgeving({ nl: NL });
  assert.equal(api.callbarOndertitel('Sofia', '+31612345678', 'nl'), 'Sofia — +31612345678');
});

test('zonder naam blijft alleen het nummer over', () => {
  const { api } = omgeving({ nl: NL, gekozen: { nl: NL[0] } });
  assert.equal(api.callbarOndertitel('', '+31612345678', 'nl'), '+31612345678 · via ' + NL[0]);
});

test('een weggefilterd nummer staat ook niet in de callbar', () => {
  // Anders staat er 'via +31…' terwijl er over de BE-lijn met de standaard
  // wordt gebeld, en dan liegt de balk.
  const { api } = omgeving({ nl: NL, be: BE, gekozen: { be: NL[0] } });
  assert.equal(api.callbarOndertitel('Sofia', '+32470112233', 'be'), 'Sofia — +32470112233');
});

// ═══════════════════════════════════════════════════════════════════════════
// DE OUDE KEUZE GAAT NIET VERLOREN
// ═══════════════════════════════════════════════════════════════════════════

test('de oude globale sleutel wordt nog één keer gelezen', () => {
  const i = BRON.indexOf('callerIdByLine: (function');
  const blok = BRON.slice(i, i + 700);
  assert.match(blok, /klx-softphone-caller-id-nl/);
  assert.match(blok, /klx-softphone-caller-id-be/);
  assert.match(blok, /lees\('klx-softphone-caller-id'\)/,
    'een bestaande keuze hoort niet zomaar te verdwijnen');
});

test('opslaan gebeurt per lijn, niet meer globaal', () => {
  const i = BRON.indexOf("cidSel.addEventListener('change'");
  const blok = BRON.slice(i, i + 700);
  assert.match(blok, /'klx-softphone-caller-id-' \+ huidige/);
  assert.doesNotMatch(blok, /setItem\('klx-softphone-caller-id',/,
    'de globale sleutel schrijven maakt de per-lijn-keuze weer stuk');
});
