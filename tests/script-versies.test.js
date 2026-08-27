// tests/script-versies.test.js
//
// Bewaakt dat elk script in modules/klanten-v2/index.html een v-nummer heeft
// dat is opgehoogd sinds het bestand voor het laatst gewijzigd werd.
//
// WAAROM DIT BESTAAT
// De .js-bestanden worden mét cache uitgeserveerd (alleen .html krijgt
// no-store, zie vercel.json). Het cijfer achter ?v= is dus het enige dat een
// browser vertelt dat er iets nieuws is. Wordt dat vergeten, dan staat de fix
// wel op productie maar draait iedereen met een warme cache gewoon door op de
// oude versie — en niemand ziet het, want de deploy is geslaagd en het bestand
// klopt.
//
// Dat is in augustus 2026 drie keer achter elkaar gebeurd: bij
// wanbetalers-v2.js (drie wijzigingen, nummer bleef staan), bij followup-v2.js
// en bij klx-softphone.js (negentig regels call-logging die niemand bereikte).
// Drie keer dezelfde omissie is geen toeval maar een gat in het proces.
//
// HOE HET WERKT — EN WAAROM NIET ANDERS
// De regel is: raakt deze branch een script aan, dan hoogt deze branch ook het
// v-nummer op. De test vergelijkt daarom `origin/main..HEAD`: welke scripts
// zijn hier gewijzigd, en is voor elk daarvan het nummer in index.html
// meeveranderd?
//
// De voor de hand liggende variant — "is het bestand gewijzigd ná de commit die
// het huidige nummer zette" — heb ik geprobeerd en weer weggehaald. Die kijkt
// per commit, terwijl een browser per DEPLOY kijkt. Bump je in commit 1 en pas
// je hetzelfde bestand nog eens aan in commit 3 van dezelfde branch, dan is dat
// volstrekt in orde: alles gaat in één push naar productie en iedereen krijgt
// de laatste inhoud onder het nieuwe nummer. Die variant noemde dat toch fout,
// en een controle die terecht werk afkeurt leert mensen hem te negeren.
//
// Wat deze versie NIET doet: bestaande achterstand op main opsporen. Dat is een
// eenmalige opruiming (gedaan op 27-08-2026), geen dagelijkse bewaking.
//
// FAIL-SOFT BIJ ONTBREKENDE HISTORIE
// Zonder origin/main of in een shallow clone is de vraag niet te beantwoorden.
// Dan slaat de test zichzelf over met een melding in plaats van vals rood te
// worden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = 'modules/klanten-v2/index.html';
const INDEX_DIR = dirname(INDEX);

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/** Het vergelijkingspunt: wat er nu op productie staat. */
function basis() {
  try {
    git('rev-parse', '--is-inside-work-tree');
    if (git('rev-parse', '--is-shallow-repository') === 'true') return null;
    const ref = git('rev-parse', '--verify', 'origin/main');
    const punt = git('merge-base', ref, 'HEAD');
    return punt || null;
  } catch (_) {
    return null;
  }
}

/** Alle <script src="...?v=N"> uit index.html, met hun pad ten opzichte van de repo. */
function scriptsUitIndex() {
  const html = readFileSync(join(ROOT, INDEX), 'utf8');
  const uit = [];
  for (const m of html.matchAll(/<script\s+src="([^"?]+)\?v=([^"]+)"/g)) {
    const [, src, versie] = m;
    if (/^https?:/i.test(src)) continue;               // extern, niet van ons
    const pad = resolve('/', join(INDEX_DIR, src)).slice(1);  // normaliseert ../
    uit.push({ src, versie, pad });
  }
  return uit;
}

/** Welke bestanden heeft deze branch gewijzigd t.o.v. het vergelijkingspunt? */
function gewijzigdSinds(punt) {
  const uit = git('diff', '--name-only', `${punt}..HEAD`);
  return new Set(uit ? uit.split('\n').filter(Boolean) : []);
}

/** Het v-nummer van dit script op het vergelijkingspunt, of null. */
function versieOpBasis(punt, src) {
  let oud;
  try { oud = git('show', `${punt}:${INDEX}`); } catch (_) { return null; }
  const m = oud.match(new RegExp(`<script\\s+src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?v=([^"]+)"`));
  return m ? m[1] : null;
}

test('wie een script wijzigt, hoogt ook het v-nummer op', (t) => {
  const punt = basis();
  if (!punt) {
    t.skip('geen origin/main of geen volledige historie — overgeslagen');
    return;
  }

  const scripts = scriptsUitIndex();
  assert.ok(scripts.length > 10, `verwacht een rij scripts in ${INDEX}, gevonden: ${scripts.length}`);

  const gewijzigd = gewijzigdSinds(punt);
  if (gewijzigd.size === 0) return;   // niets veranderd, niets te controleren

  const vergeten = [];
  for (const s of scripts) {
    if (!gewijzigd.has(s.pad)) continue;         // dit script is niet geraakt
    const oudeVersie = versieOpBasis(punt, s.src);
    if (oudeVersie === null) continue;           // nieuw script — geen oude waarde
    if (oudeVersie === s.versie) {
      vergeten.push(`  ${s.src} — gewijzigd, maar staat nog steeds op ?v=${s.versie}`);
    }
  }

  assert.equal(
    vergeten.length, 0,
    `\n\nDeze scripts zijn in deze branch gewijzigd zonder dat hun v-nummer\n` +
    `omhoog ging. De .js-bestanden worden mét cache uitgeserveerd (alleen .html\n` +
    `krijgt no-store), dus browsers met een warme cache blijven de oude versie\n` +
    `draaien: de wijziging staat wél op productie maar bereikt niemand.\n\n` +
    vergeten.join('\n') +
    `\n\nOphogen in ${INDEX}. Eén cijfer per bestand; het maakt niet uit welk,\n` +
    `als het maar verandert.\n`,
  );
});
