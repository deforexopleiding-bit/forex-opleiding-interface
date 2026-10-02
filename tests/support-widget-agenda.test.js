// tests/support-widget-agenda.test.js
//
// Op de agenda-/boekpagina's (/agenda, /agenda/planning, /agenda/romy, …)
// staat de zwevende supportknop NIET: op mobiel zat hij over de tijdsloten.
// Elders blijft alles zoals het was. Expliciete kaarten blijven werken, en de
// site wisselt pagina's zonder reload (Next.js), dus het pad wordt ook bij
// pushState/popstate opnieuw bekeken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { laad, wacht } from './support-widget-harness.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = {
  status: 200,
  body: {
    aan: true, titel: 'Hulp nodig?', live: false, reden: 'niemand_online',
    bereikbaarheid: 'ma–vr 09:00–17:30', antwoord_mailbox: 'info@deforexopleiding.nl',
    onderwerpen: { klant: [{ id: 'lms', label: 'LMS' }], bezoeker: [{ id: 'informatie', label: 'Informatie' }] },
  },
};

/** Is de zwevende knop zichtbaar volgens de widget? (klasse op .wrap + CSS-regel) */
function knopVerborgen(w) {
  const wrap = w.sr().querySelector('.wrap');
  return wrap.classList.contains('zonder-knop');
}

test('/agenda/planning: geen zwevende knop, geen teaser — al vóór de config binnen is', async () => {
  const w = laad({ pad: '/agenda/planning', routes: { 'support-widget-config': CONFIG } });
  await wacht(1);
  // Zodra de widget in de pagina staat — de config is dan nog onderweg.
  assert.ok(w.sr(), 'widget staat in de pagina');
  assert.equal(knopVerborgen(w), true, 'meteen bij het opbouwen');
  await wacht();
  assert.equal(knopVerborgen(w), true);
  // De CSS die het effect geeft staat in de shadow-stijl.
  const css = w.sr().querySelector('style').textContent;
  assert.match(css, /\.wrap\.zonder-knop \.knop,\.wrap\.zonder-knop \.teaser\{display:none!important\}/);
  // De teaser staat verborgen.
  assert.equal(w.sr().querySelector('.teaser').hidden, true);
});

test('/agenda, /agenda/romy en /AGENDA/ ook; /agendapunt en /cursus niet', async () => {
  for (const pad of ['/agenda', '/agenda/romy', '/AGENDA/']) {
    const w = laad({ pad, routes: { 'support-widget-config': CONFIG } });
    await wacht();
    assert.equal(knopVerborgen(w), true, pad);
  }
  for (const pad of ['/agendapunt', '/cursus', '/']) {
    const w = laad({ pad, routes: { 'support-widget-config': CONFIG } });
    await wacht();
    assert.equal(knopVerborgen(w), false, pad);
    assert.ok(w.sr().querySelector('.knop'), pad + ': knop bestaat');
  }
});

test('SPA-navigatie: pushState naar /agenda verbergt, terug (popstate) toont weer', async () => {
  const w = laad({ pad: '/cursus', routes: { 'support-widget-config': CONFIG } });
  await wacht();
  assert.equal(knopVerborgen(w), false);
  w.window.history.pushState({}, '', '/agenda/planning');
  assert.equal(knopVerborgen(w), true, 'na pushState');
  w.window.history.pushState({}, '', '/contact');
  assert.equal(knopVerborgen(w), false, 'weer weg van de agenda');
  w.window.history.replaceState({}, '', '/agenda');
  assert.equal(knopVerborgen(w), true, 'na replaceState');
  // Terug via de browserknop: het pad verandert en popstate vuurt.
  w.window.history.replaceState({}, '', '/cursus');
  w.window.dispatchEvent(new w.window.PopStateEvent('popstate'));
  assert.equal(knopVerborgen(w), false, 'na popstate');
});

test('op /agenda blijft het paneel te openen (DFOSupport.open) — alleen de zwevende knop is weg', async () => {
  const w = laad({ pad: '/agenda/planning', routes: { 'support-widget-config': CONFIG } });
  await wacht();
  w.window.DFOSupport.open();
  await wacht();
  assert.ok(w.sr().querySelector('.paneel').classList.contains('open'));
  assert.equal(knopVerborgen(w), true);
});

test('één lijst bovenaan, makkelijk uit te breiden', () => {
  const bron = readFileSync(join(ROOT, 'widget/support.js'), 'utf8');
  assert.match(bron, /var GEEN_KNOP_OP = \['\/agenda'\];/);
  assert.ok(bron.indexOf('GEEN_KNOP_OP') < bron.indexOf('var BASIS'), 'staat bovenaan, vóór de rest');
});
