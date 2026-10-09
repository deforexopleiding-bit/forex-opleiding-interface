// tests/klanten-v2-abo-edit-knop.test.js
//
// Klantdetail › Abonnementen (2026-10-09): het potlood (✎) deed niets. Oorzaak:
// bij een gefactureerd abonnement (has_any_invoice) kreeg de knop een échte
// `disabled` — een disabled <button> vuurt geen click — en zag hij er normaal
// uit (37% van de lopende abo's). Nu:
//   1. geen `disabled` meer; wel aria-disabled + zichtbaar vergrendeld;
//   2. elke rij opent het modal met ZIJN abonnement (meerdere abo's per klant);
//      het modal zelf weigert een gefactureerd abo met een toast (zoals de server);
//   3. een onvindbaar abonnement of een fout in het modal wordt gelogd + gemeld.
//
// Bewust geen jsdom (niet overal geïnstalleerd): een kleine nep-root die de
// knoppen uit de gerenderde HTML haalt, genoeg voor deze view.

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url  = (p) => pathToFileURL(join(ROOT, p)).href;

const SUBS = [
  { id: 'sub-gefactureerd', description: 'Opleiding termijnen', amount: 100, vat_percentage: 21, term_count: 12,
    start_date: '2026-01-01', end_date: '2026-12-01', status: 'active', teamleader_subscription_id: 'tl-1', has_any_invoice: true },
  { id: 'sub-nieuw', description: 'Mentorship', amount: 50, vat_percentage: 21, term_count: 6,
    start_date: '2026-10-01', end_date: '2027-03-01', status: 'active', teamleader_subscription_id: null, has_any_invoice: false },
];

// Nep-root: bewaart innerHTML en levert knoppen voor [data-…]-selectors.
function nepRoot() {
  const knoppen = new Map(); // attr → [{ id, el }]
  let html = '';
  const maakKnoppen = (attr) => {
    const re = new RegExp(`<button([^>]*)\\s${attr}="([^"]*)"([^>]*)>`, 'g');
    const lijst = [];
    for (const m of html.matchAll(re)) {
      const attrs = m[1] + ' ' + m[3];
      const luisteraars = [];
      lijst.push({
        id: m[2],
        disabled: /\sdisabled(\s|=|$)/.test(' ' + attrs),
        bron: m[0],
        getAttribute: (a) => (a === attr ? m[2] : null),
        addEventListener: (type, fn) => { if (type === 'click') luisteraars.push(fn); },
        // Een disabled knop vuurt in een echte browser géén click.
        klik() { if (this.disabled) return false; luisteraars.forEach((fn) => fn({ preventDefault() {} })); return true; },
      });
    }
    return lijst;
  };
  return {
    set innerHTML(v) { html = String(v); knoppen.clear(); },
    get innerHTML() { return html; },
    querySelectorAll(sel) {
      const m = /^\[([a-z0-9-]+)\]$/.exec(sel);
      if (!m) return [];
      if (!knoppen.has(m[1])) knoppen.set(m[1], maakKnoppen(m[1]));
      return knoppen.get(m[1]);
    },
    querySelector: () => null,
  };
}

async function laadTab({ updateGooit = false } = {}) {
  const geopend = [];
  const toasts = [];
  const errors = [];
  globalThis.window = {
    KV: {
      esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
      toast: (m) => toasts.push(m),
      navigate: () => {},
      authedJson: async () => ({ subscriptions: SUBS.map((s) => ({ ...s })) }),
    },
    location: { href: '' },
  };
  const modalUrl = url('modules/klanten-v2/views/modals/subscription-actions.js') + '?v=1';
  mock.module(modalUrl, {
    namedExports: {
      openSubscriptionUpdateModal: ({ sub }) => {
        if (updateGooit) throw new Error('modal kapot');
        geopend.push(['update', sub.id]);
        // Zelfde regel als het echte modal (subscription-actions.js).
        if (sub.has_any_invoice) toasts.push('Al gefactureerd — bewerken niet toegestaan. Gebruik crediteren + nieuw abo.');
      },
      openSubscriptionPostponeModal: ({ sub }) => geopend.push(['postpone', sub.id]),
      openSubscriptionPostponeAllModal: () => geopend.push(['postpone-all']),
      openSubscriptionDeleteModal: ({ sub }) => geopend.push(['delete', sub.id]),
    },
  });
  const origErr = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  const mod = await import(url('modules/klanten-v2/views/tabs/abonnementen.js') + '?t=' + Date.now() + Math.random());
  const root = nepRoot();
  await mod.renderAbonnementenTab(root, { customer: { id: 'klant-1' } });
  await new Promise((r) => setTimeout(r, 0));   // actLoad → tweede render + wire
  const herstel = () => { console.error = origErr; mock.reset(); delete globalThis.window; };
  return { root, geopend, toasts, errors, herstel };
}

test('potlood: geen echte disabled meer; gefactureerd abo zichtbaar vergrendeld', async () => {
  const t = await laadTab();
  try {
    const potloden = t.root.querySelectorAll('[data-kv-abo-update]');
    assert.equal(potloden.length, 2);
    for (const p of potloden) assert.equal(p.disabled, false, 'disabled slikt de klik: ' + p.bron);
    const slot = potloden.find((p) => p.id === 'sub-gefactureerd');
    assert.match(slot.bron, /aria-disabled="true"/);
    assert.match(slot.bron, /opacity:\.45/);
    assert.match(slot.bron, /crediteren \+ nieuw abonnement/);
    assert.doesNotMatch(potloden.find((p) => p.id === 'sub-nieuw').bron, /aria-disabled/);
  } finally { t.herstel(); }
});

test('meerdere abo\'s: elk potlood opent het modal met ZIJN abonnement', async () => {
  const t = await laadTab();
  try {
    const potloden = t.root.querySelectorAll('[data-kv-abo-update]');
    assert.equal(potloden.find((p) => p.id === 'sub-nieuw').klik(), true);
    assert.equal(potloden.find((p) => p.id === 'sub-gefactureerd').klik(), true, 'klik komt nu door');
    assert.deepEqual(t.geopend, [['update', 'sub-nieuw'], ['update', 'sub-gefactureerd']]);
    // Gefactureerd: het modal legt uit waarom het niet kan (geen stille no-op).
    assert.deepEqual(t.toasts, ['Al gefactureerd — bewerken niet toegestaan. Gebruik crediteren + nieuw abo.']);
    // Uitstellen/deactiveren blijven per rij werken.
    t.root.querySelectorAll('[data-kv-abo-postpone]').find((p) => p.id === 'sub-gefactureerd').klik();
    t.root.querySelectorAll('[data-kv-abo-delete]').find((p) => p.id === 'sub-nieuw').klik();
    assert.deepEqual(t.geopend.slice(2), [['postpone', 'sub-gefactureerd'], ['delete', 'sub-nieuw']]);
    assert.deepEqual(t.errors, []);
  } finally { t.herstel(); }
});

test('onvindbaar abonnement → console.error + toast i.p.v. stil niets', async () => {
  const t = await laadTab();
  try {
    const p = t.root.querySelectorAll('[data-kv-abo-update]')[0];
    p.getAttribute = () => 'bestaat-niet';
    p.klik();
    assert.deepEqual(t.geopend, []);
    assert.ok(t.errors.some((e) => e.includes('[klanten-v2 abonnementen] Aanpassen: abonnement bestaat-niet niet in de geladen lijst')));
    assert.ok(t.toasts.includes('Abonnement niet gevonden — herlaad de pagina.'));
  } finally { t.herstel(); }
});

test('fout in het modal → gelogd en gemeld', async () => {
  const t = await laadTab({ updateGooit: true });
  try {
    t.root.querySelectorAll('[data-kv-abo-update]').find((p) => p.id === 'sub-nieuw').klik();
    assert.ok(t.errors.some((e) => e.includes('[klanten-v2 abonnementen] Aanpassen openen mislukt:') && e.includes('modal kapot')));
    assert.ok(t.toasts.includes('Aanpassen openen mislukt — zie console.'));
  } finally { t.herstel(); }
});

test('cache-buster: detail.js laadt abonnementen.js?v=10', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(join(ROOT, 'modules/klanten-v2/views/detail.js'), 'utf8'), /\.\/tabs\/abonnementen\.js\?v=10'/);
});
