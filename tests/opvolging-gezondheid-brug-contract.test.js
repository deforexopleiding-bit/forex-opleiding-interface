// tests/opvolging-gezondheid-brug-contract.test.js
//
// DE BEWAKER LAS EEN VELD DAT NIET BESTAAT.
//
// ── GEMETEN OP 10 SEPTEMBER ─────────────────────────────────────────────
// De handmatige Run van /api/cron-opvolging-gezondheid gaf:
//
//   "niet gemeten: brug (De brug is verbonden maar heeft sinds de laatste
//    herstart niets gezien…)"
//
// Terwijl /api/opvolging-whatsapp-status op datzelfde moment meldde:
//
//   gezien       message 87, message_create 165, message_ack 149
//   doorgelaten  23 / 36 / 59
//
// controleerBrug las `status.tellers`. De brug geeft die cijfers terug onder
// `gebeurtenissen` (server.js: `gebeurtenissen: wa.tellers()` — de METHODE
// heet tellers, de sleutel in het antwoord niet). `status.tellers` bestond dus
// niet, `gezien` was altijd 0, en de uitkomst was ALTIJD 'niet gemeten'.
//
// ── WAAROM DAT ERGER IS DAN EEN VERKEERD GETAL ──────────────────────────
// De tak eronder — gezien > 0 maar doorgelaten = 0 → FOUT — kon daardoor nooit
// afgaan. Dat is precies de storing van 8 september: de brug zag alles en liet
// niets door. De enige bewaker daartegen stond blind, en meldde elke ochtend
// keurig 'niet gemeten' alsof dat een toestand van de wereld was.
//
// ── EN WAAROM DE TESTS HET NIET ZAGEN ───────────────────────────────────
// Ze voedden controleerBrug met `{ tellers: … }` — een vorm die de echte brug
// nooit teruggeeft. Groen, en ondertussen kon de controle in productie geen
// enkele storing vinden. Dezelfde les als bij ronde A: een test die de
// verkeerde vorm vastlegt maakt de bug onzichtbaar in plaats van zichtbaar.
//
// Vandaar deze test. Hij verzint geen vorm maar LEEST server.js, en dwingt af
// dat de sleutel waaronder /status de tellers zet dezelfde is als die
// controleerBrug uitleest. Hernoemt iemand er één, dan wordt dit rood.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { controleerBrug, OK, NIET_GEMETEN } from '../api/_lib/opvolging-gezondheid.js';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'services/whatsapp-brug/server.js');
const CHECK  = join(ROOT, 'api/_lib/opvolging-gezondheid.js');

/**
 * Onder welke sleutel zet /status het resultaat van wa.tellers()?
 *
 * Uit de bron gelezen, niet uit het hoofd — dat laatste is precies hoe
 * `status.tellers` ontstond.
 */
function sleutelInStatus() {
  const bron = readFileSync(SERVER, 'utf8');
  const m = bron.match(/(\w+)\s*:\s*wa\.tellers\(\)/);
  assert.ok(m, 'server.js hoort wa.tellers() ergens in /status te zetten');
  return m[1];
}

// ═══════════════════════════════════════════════════════════════════════════
// HET CONTRACT
// ═══════════════════════════════════════════════════════════════════════════

test('de sleutel in /status is dezelfde die de gezondheidscheck uitleest', () => {
  const sleutel = sleutelInStatus();
  assert.equal(sleutel, 'gebeurtenissen', 'de bron heet gebeurtenissen');

  const check = readFileSync(CHECK, 'utf8');
  assert.match(check, new RegExp('status\\.' + sleutel + '\\b'),
    `controleerBrug hoort status.${sleutel} te lezen — hernoem je er één, hernoem dan allebei`);
});

test('en de check werkt ook echt op een antwoord met die sleutel', () => {
  // De contract-test hierboven leest tekst; deze draait de functie. Allebei,
  // want een regex kan kloppen terwijl de code er niets mee doet.
  const sleutel = sleutelInStatus();
  const status = {
    verbonden: true,
    [sleutel]: { gezien: { message: 87 }, doorgelaten: { message: 23 } },
  };
  const r = controleerBrug({ status });
  assert.equal(r.staat, OK);
  assert.equal(r.getallen.gezien, 87);
  assert.equal(r.getallen.doorgelaten, 23);
});

test('de cijfers van 10 september leveren nu ok op in plaats van niet-gemeten', () => {
  // Precies wat /status die dag teruggaf. Vóór de fix: 'niet gemeten'.
  const r = controleerBrug({ status: {
    verbonden: true,
    gebeurtenissen: {
      gezien     : { message: 87, message_create: 165, message_ack: 149 },
      doorgelaten: { message: 23, message_create: 36,  message_ack: 59  },
    },
  } });
  assert.equal(r.staat, OK);
  assert.match(r.uitleg, /118 van 401 gebeurtenissen doorgelaten/);
});

test('de oude, verzonnen vorm levert nu NIET GEMETEN op met een eigen reden', () => {
  // `{ tellers: {} }` zonder gezien/doorgelaten is geen brug die niets zag —
  // het is een brug die geen cijfers gaf. Dat onderscheid was er niet, en
  // daardoor las een ontbrekend veld als een gemeten nul.
  const r = controleerBrug({ status: { verbonden: true, iets_anders: {} } });
  assert.equal(r.staat, NIET_GEMETEN);
  assert.match(r.uitleg, /geen tellers terug/);
});

// ═══════════════════════════════════════════════════════════════════════════
// DE VORM VAN DE TELLERS ZELF
// ═══════════════════════════════════════════════════════════════════════════

test('gezien en doorgelaten zijn de namen die tellers.js teruggeeft', () => {
  // controleerBrug telt Object.values(t.gezien) en Object.values(t.doorgelaten)
  // op. Heten die velden ooit anders, dan telt hij weer nul.
  const tellers = readFileSync(join(ROOT, 'services/whatsapp-brug/lib/tellers.js'), 'utf8');
  const i = tellers.indexOf('status() {');
  assert.ok(i > 0, 'tellers.js hoort een status()-functie te hebben');
  const blok = tellers.slice(i, i + 900);
  assert.match(blok, /gezien\s*:/);
  assert.match(blok, /doorgelaten:/);
});

test('de storing van 8 september wordt nu wél gevonden', () => {
  // Alles gezien, niets doorgelaten. Dit is de tak die door de verkeerde
  // sleutel onbereikbaar was.
  const r = controleerBrug({ status: {
    verbonden: true,
    gebeurtenissen: { gezien: { message: 92 }, doorgelaten: { message: 0 } },
  } });
  assert.equal(r.staat, 'fout');
  assert.match(r.uitleg, /92 gebeurtenissen en liet er nul door/);
});
