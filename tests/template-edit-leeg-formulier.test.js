// tests/template-edit-leeg-formulier.test.js
//
// 'EDIT' OP EEN TEMPLATE OPENDE EEN LEEG FORMULIER.
//
// GEMETEN 20 september, Instellingen > WhatsApp: de Edit-knop opende een leeg
// formulier — naam leeg, body leeg, mapje op 'Ongegroepeerd'. Maxim heeft
// geannuleerd, er is niets kapot.
//
// ── DE OORZAAK ──────────────────────────────────────────────────────────
// api/admin-meta-templates-detail.js returnt `{ item: <rij> }`.
// De editor las `j?.template || j`. `j.template` is undefined, dus de fallback
// pakte `j` ZELF: het omhullende object `{ item: {...} }`. Daarop is `t.name`
// undefined, en `String(undefined || '')` is een lege string. Elk veld viel
// terug op zijn default.
//
// ── WAT ER DAN VERLOREN GAAT, PRECIES ───────────────────────────────────
// Een volledig leeg formulier kán niet opslaan: _metaEdValidate eist een
// niet-lege naam én body. Maar wie die twee invult en opslaat, schrijft de
// lege defaults terug over de bestaande rij — footer_text, buttons,
// body_examples, meta_param_mapping en folder_id zijn dan weg. Naam en body
// overleven het, de rest niet, en niets op het scherm zegt dat.
//
// Twee lagen in de fix: de sleutelnaam (zodat het formulier vult) en een
// guard op opslaan (zodat een MISLUKTE lees-oproep niet alsnog overschrijft).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const zonderUitleg = (t) => t.split('\n')
  .filter((r) => { const x = r.trim(); return !x.startsWith('//') && !x.startsWith('*') && !x.startsWith('/*'); })
  .join('\n');

const VIEW = zonderUitleg(
  readFileSync(join(ROOT, 'modules/klanten-v2/views/instellingen-v2.js'), 'utf8'));
const API  = readFileSync(join(ROOT, 'api/admin-meta-templates-detail.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// 1 · DE SLEUTELNAAM
// ═══════════════════════════════════════════════════════════════════════════

test('het endpoint returnt `item` — dat is de sleutel die de editor moet lezen', () => {
  assert.match(API, /res\.status\(200\)\.json\(\{ item: data \}\)/,
    'als dit verandert, moet de editor mee');
});

test('de editor leest `item` en niet meer alleen `template`', () => {
  const i = VIEW.indexOf('meta-detail');
  assert.ok(i > 0);
  const blok = VIEW.slice(i, i + 900);
  assert.match(blok, /j\?\.item/, 'item hoort eerst gelezen te worden');
  // De oude vorm mag als fallback blijven staan, maar niet ALLEEN.
  assert.doesNotMatch(blok, /const t = j\?\.template \|\| j;/,
    'dat was de bug: de fallback pakte het omhullende object');
});

test('de kale `|| j`-fallback kan het omhullende object niet meer pakken', () => {
  // `{ item: {...} }` heeft geen string-id, dus de laatste fallback geeft null
  // en `if (t)` slaat het vullen over in plaats van alles op leeg te zetten.
  const i = VIEW.indexOf('const t = j?.item');
  assert.ok(i > 0);
  const regel = VIEW.slice(i, VIEW.indexOf('\n', i));
  assert.match(regel, /typeof j\.id === 'string'/,
    'een rauwe rij wordt herkend aan een echte id, niet aan "het is een object"');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 · DE TWEE KOLOMMEN DIE DE EDITOR NODIG HEEFT
// ═══════════════════════════════════════════════════════════════════════════

test('de detail-select levert meta_param_mapping en folder_id', () => {
  // De editor LEEST die twee (_metaEd.varMapping en _metaEd.folderId) maar ze
  // stonden niet in de select. Ook met de sleutelnaam gerepareerd zou het
  // mapje dus op 'Ongegroepeerd' blijven staan en de mapping leeg zijn.
  assert.match(API, /meta_param_mapping/, 'de variabele-mapping hoort mee');
  assert.match(API, /folder_id/, 'het mapje hoort mee');
  // En de editor gebruikt ze ook echt.
  assert.match(VIEW, /_metaEd\.varMapping\s*=.*meta_param_mapping/s);
  assert.match(VIEW, /_metaEd\.folderId\s*=\s*t\.folder_id/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · DE TWEEDE LAAG — NIET OVERSCHRIJVEN WAT JE NIET GEZIEN HEBT
// ═══════════════════════════════════════════════════════════════════════════

test('opslaan weigert als de bestaande rij niet is ingelezen', () => {
  // Dit is de laag die ook een mislukte fetch, een time-out of een 403 dekt.
  // Zonder deze guard hangt de veiligheid volledig aan één sleutelnaam.
  const i = VIEW.indexOf('async function _metaEdSave');
  assert.ok(i > 0);
  const blok = VIEW.slice(i, i + 1200);
  assert.match(blok, /_metaEd\.mode === 'edit' && _metaEd\.id && !_metaEd\.loaded/,
    'de guard hoort op edit-modus + niet-geladen te staan');
  // En hij staat VÓÓR de payload-opbouw, anders is hij zinloos.
  assert.ok(blok.indexOf('!_metaEd.loaded') < blok.indexOf('_metaSyncFieldsFromDom'),
    'de guard hoort vóór het lezen van het DOM en de payload-opbouw te staan');
  // Niet stil: er komt een leesbare melding op het scherm.
  assert.match(blok, /_metaEd\.error =/);
  assert.match(blok, /meta-detail/, 'de melding wijst naar de console-regel om te kijken');
});

test('de vlag staat alleen op true na een ECHTE inlezing', () => {
  // Reset zet hem op false, en alleen de tak die de velden vult zet hem op
  // true. Een fout-tak returnt vóór dat punt.
  assert.match(VIEW, /_metaEd\.loaded = false;/, 'reset hoort hem te wissen');
  assert.match(VIEW, /_metaEd\.loaded = true;/, 'en het vullen hoort hem te zetten');
  const iTrue  = VIEW.indexOf('_metaEd.loaded = true');
  const iFetch = VIEW.indexOf('meta-detail');
  assert.ok(iTrue > iFetch, 'true hoort NA de fetch gezet te worden, niet ervoor');
});

test("'create' wordt niet geblokkeerd — daar is niets te verliezen", () => {
  const i = VIEW.indexOf('async function _metaEdSave');
  const blok = VIEW.slice(i, i + 1200);
  assert.match(blok, /mode === 'edit'/,
    'de guard hoort op edit te filteren, niet op alles');
  // De 'Nieuwe versie'-flow van een approved template zet mode terug op
  // 'create' en id op null, dus die valt hier bewust buiten.
  assert.match(VIEW, /_metaEd\.mode = 'create'; _metaEd\.id = null;/);
});
