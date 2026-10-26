// tests/contentmachine-demo2.test.js — Contentmachine 2.0, fase 6: twee demo-edities.
//
// docs/contentmachine/v2/demo/demo-22-10-26-demo2.json (training 22/10, met video) en
// demo-26-10-26-demo.json (update zonder video, payouts) zijn de bron van de rijen in
// content_drops (status 'gegenereerd', NIET gepubliceerd). Gebouwd met bouw-demo.mjs.
// Deze test houdt ze geldig met dezelfde regels als de generator en toont de variatie.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { valideerV2 } from '../api/_lib/contentmachine-regie.js';
import { controleerGrenzen, grensOpties, metVasteTeksten } from '../api/_lib/contentmachine-generator.js';
import { teaserFouten, renderNieuwsbrief } from '../api/_lib/nieuwsbrief-render.js';
import { combinatie, isWeekeditie } from '../api/_lib/weekeditie.js';
import { socialCombinatie, isSocialV2, captions } from '../api/_lib/contentmachine-social.js';
import { SLUG_RE } from '../api/_lib/contentmachine-core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (n) => JSON.parse(readFileSync(join(ROOT, 'docs/contentmachine/v2/demo', n), 'utf8'));
const A = lees('demo-22-10-26-demo2.json');
const B = lees('demo-26-10-26-demo.json');
// De beelden uit de bibliotheek (id → soort/toestemming), zoals in content_assets op 26 okt.
const ASSETS = [
  ['266f71e7-ee79-4fef-a209-eab4e1fa33f7', 'chart'], ['c0902297-a369-4f49-a157-9e47713fe6ea', 'masterclass'],
  ['458ca098-f7f0-4685-94d9-1d43f28b3467', 'team'], ['41878bb3-7e37-41fd-8f59-b840e3cc00ef', 'team'], ['ce6b5f12-d602-46ec-85b0-27d3de53bff1', 'team'], ['4ad87bef-5d08-454d-8f66-f178498c4f24', 'team'],
  ['4ca54f25-0c95-43dc-bb39-c0a7ccb70155', 'payout', 'Karl', 'Payout Karl — Alpha Capital · 24.580'], ['6cda51cf-32ad-431a-af01-0f2480e4874c', 'payout', 'Leslie', 'Payout Leslie — FTMO · 6.721'],
  ['ef0b94d7-7916-4c23-aa94-4f8582400467', 'payout', 'Shani', 'Payout Shani — FTMO · 25.016'], ['63ad070a-cd5b-4020-aa3e-6e0a74416aee', 'payout', 'Maxim', 'Payout Maxim — Traders Global · 28.983'],
].map(([id, soort, persoon_naam = null, bijschrift = '']) => ({ id, soort, persoon_naam, toestemming_publiek: !!persoon_naam, bijschrift }));

for (const [naam, d, vorige] of [['A (training 22/10)', A, []], ['B (update, geen video)', B, [{ slug: A.slug, output: A.output }]]]) {
  test(`demo ${naam}: geldig volgens de generator (schema, editie, cijfers, grenzen, teaser, social 2.0)`, () => {
    assert.ok(SLUG_RE.test(d.slug));
    assert.equal(d.status, 'gegenereerd', 'niet gepubliceerd');
    assert.equal(isWeekeditie(d.output.pagina), true);
    assert.equal(isSocialV2(d.output), true);
    const v = valideerV2(d.output, { metVideo: !!d.input.vimeo_id, assets: ASSETS, vorige, regie: d.output.regie, input: d.input });
    assert.deepEqual(v.fouten, []);
    assert.deepEqual(v.cijfers, [], 'elk cijfer uit de feitenbank of de invoer');
    const { meta, regie, ...rest } = d.output;
    assert.deepEqual(controleerGrenzen(rest, grensOpties(d.input, meta.verboden_namen)).map((x) => x.pad + ': ' + x.regel), []);
    assert.deepEqual(teaserFouten(d.output.nieuwsbrief, d.output.pagina), []);
    assert.deepEqual(metVasteTeksten(d.output, { drop: d, input: d.input }), d.output, 'vaste formulierteksten erin');
    const r = renderNieuwsbrief({ drop: d, output: { ...d.output, social: { bestanden: { nieuwsbrief: { url: 'https://cdn.test/nb.png' } } } }, assets: [] });
    assert.match(r.html, /Lees de volledige weekeditie/);
    assert.match(captions(d.output, d.slug).linkedin, new RegExp(`/${d.slug}\\?src=linkedin`));
  });
}

test('demo\'s: andere combinatie van thema/hero/interactie en van social-varianten (variatie)', () => {
  const ca = combinatie(A.output.pagina); const cb = combinatie(B.output.pagina);
  assert.notEqual(ca.sleutel, cb.sleutel);
  assert.equal(ca.sleutel, 'goud|video-poort|funded-calculator+quiz+replay-sweep-bos');
  assert.equal(cb.sleutel, 'data|groot-getal|rr-sliders+trechter');
  assert.notEqual(socialCombinatie(A.output), socialCombinatie(B.output));
  assert.notEqual(A.output.format_key, B.output.format_key);
});

test('demo B: zonder video (inschrijven, geen video-poort) en payouts enkel met toestemming', () => {
  const t = B.output.pagina.blokken.map((b) => b.type);
  assert.ok(!B.input.vimeo_id); assert.equal(B.soort, 'update');
  assert.ok(t.includes('inschrijven') && !t.includes('video-poort') && B.output.pagina.blokken[0].variant !== 'video-poort');
  const muur = B.output.pagina.blokken.find((b) => b.type === 'payout-muur').props.payouts;
  const metToestemming = new Set(ASSETS.filter((a) => a.toestemming_publiek).map((a) => a.id));
  assert.ok(muur.length >= 3 && muur.every((p) => metToestemming.has(p.asset_id)));
  assert.ok(B.output.pagina.blokken.some((b) => b.type === 'verhaal' && /geen garantie voor de toekomst/.test(b.props.tekst)), 'nuance bij het bewijs');
});

test('demo A: de training van 22/10 (video, startpunt 10:00, EUR/USD-long uit de invoer)', () => {
  assert.equal(A.input.vimeo_id, '1238714790'); assert.equal(A.input.start_sec, 600); assert.equal(A.input.training_datum, '2026-10-22');
  const t = A.output.pagina.blokken.find((b) => b.type === 'trade-ontleed').props;
  assert.equal(t.paar, 'EUR/USD'); assert.equal(t.richting, 'long'); assert.equal(t.resultaat_r, undefined, 'geen verzonnen resultaat');
  assert.match(A.output.pagina.ontgrendeld_tekst, /10:00/);
});
