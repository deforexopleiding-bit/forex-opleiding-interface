// tests/contentmachine-demo.test.js — Contentmachine fase 6: de demo-drop 22-10-26-demo.
//
// docs/contentmachine/demo-drop-22-10-26.json is de bron van de demo-rij in content_drops
// (status 'gegenereerd', NIET gepubliceerd). Deze test houdt hem geldig: zelfde schema-
// en grenscontrole als de generator, en de nieuwsbrief rendert met de GHL-uitschrijftag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { valideerOutput, controleerGrenzen, toegelatenFormats, gebruikteAssetIds } from '../api/_lib/contentmachine-generator.js';
import { renderNieuwsbrief, UITSCHRIJF_TAG } from '../api/_lib/nieuwsbrief-render.js';
import { SLUG_RE, parseVimeo } from '../api/_lib/contentmachine-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const demo = JSON.parse(readFileSync(join(ROOT, 'docs/contentmachine/demo-drop-22-10-26.json'), 'utf8'));
// Teamnamen zonder toestemming zoals ze op 26 okt in de context zaten.
const VERBODEN = ['Chesney', 'Danny', 'Jeffrey', 'Karl', 'Kjento', 'Muddasir', 'Ricardo', 'Rogier', 'Romy', 'Seppe'];

test('demo: slug, status en video uit de bouwopdracht', () => {
  assert.equal(demo.slug, '22-10-26-demo');
  assert.ok(SLUG_RE.test(demo.slug));
  assert.equal(demo.status, 'gegenereerd', 'niet gepubliceerd');
  assert.equal(demo.datum, '2026-10-22');
  const v = parseVimeo(demo.input.vimeo_url);
  assert.deepEqual([v && v.vimeo_id, v && v.vimeo_hash, demo.input.vimeo_id, demo.input.vimeo_hash, demo.input.start_sec], ['1238714790', '4822ada5ee', '1238714790', '4822ada5ee', 600]);
});

test('demo: geldige output (schema, rotatie t.o.v. de vooruitblik van 26-10-26, enkel gekozen beelden)', () => {
  const toegelaten = toegelatenFormats([{ format_key: 'vooruitblik' }]);
  const v = valideerOutput(demo.output, { toegelaten, assetIds: demo.input.gekozen_asset_ids });
  assert.deepEqual(v.fouten, []);
  for (const id of gebruikteAssetIds(demo.output)) assert.ok(demo.input.gekozen_asset_ids.includes(id), id);
});

test('demo: geen grensovertredingen (Dave enkel bij het cadeau, geen namen zonder toestemming)', () => {
  assert.deepEqual(controleerGrenzen(demo.output, { verbodenNamen: VERBODEN }), []);
});

test('demo: nieuwsbrief rendert met video-knop en GHL-uitschrijftag', () => {
  const assets = demo.input.gekozen_asset_ids.map((id) => ({ id, publieke_url: `https://cdn.test/${id}.png`, bijschrift: 'x', persoon_naam: null, toestemming_publiek: true }));
  const r = renderNieuwsbrief({ drop: { slug: demo.slug, datum: demo.datum, soort: demo.soort, input: demo.input }, output: demo.output, assets });
  assert.equal(r.onderwerp, demo.output.nieuwsbrief.onderwerpen[0]);
  assert.ok(r.html.includes(UITSCHRIJF_TAG));
  assert.match(r.html, /utm_source=nieuwsbrief/);
  assert.match(r.html, /training\.deforexopleiding\.nl\/22-10-26-demo/);
});
