// tests/offerte-verwijderen-commissie-los.test.js — "Definitief verwijderen
// (TL + CRM)" op de LOSSE modules/offerte-detail-v2.html vraagt bij een open
// mentorcommissie dezelfde keuze als de shell-offertepagina (#1982), en stuurt
// commissie_keuze mee naast onboarding_bevestigd (Maxim, 13 nov 2026). Eén
// bron voor de vraag: views/_commissie-ui.js (keuzeBijVerwijderen).
//
// jsdom: de echte scripts, met een nep-API. Er gaat niets naar Teamleader.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const COMMISSIE_UI = lees('modules/klanten-v2/views/_commissie-ui.js');
const LOS_HTML = lees('modules/offerte-detail-v2.html');
const SHELL_VIEW = lees('modules/klanten-v2/views/offerte-detail-v2.js');

const tick = () => new Promise((r) => setTimeout(r, 15));
async function wacht(n = 6) { for (let i = 0; i < n; i++) await tick(); }

const COMMISSIE = {
  heeft_commissie: true, open: true, pct: 10, basis: 3950, basis_incl_btw: false,
  bron: 'event', mentoren: [{ naam: 'Mentor Test', bedrag: 395, vrijgegeven: 0, geannuleerd: false }],
};

function preflight({ metCommissie = true, metOnboarding = false } = {}) {
  return {
    ok: true, deletable: true,
    deal: { offerte_referentie: 'OFF-TEST', klant: { naam: 'Test Klant' }, tl_quotation_status: 'accepted' },
    blockers: [], cascade: [], set_null: [],
    commissie: metCommissie ? COMMISSIE : null,
    commissie_keuze_nodig: metCommissie,
    onboarding_waarschuwing: metOnboarding
      ? { onboardings: [{ id: 'ob-1', naam: 'Test Klant', status: 'aangemeld', start_date: '2027-03-01', reden: 'lopend' }], uitleg: 'UITLEG', bevestiging_nodig: true }
      : null,
  };
}

/** Een jsdom met nep-fetch. Geeft { w, posts }. */
function maakDom(url, pf) {
  // De doorverwijzing na het verwijderen kan jsdom niet uitvoeren: die melding is ruis.
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/navigation/i.test(String(e?.message))) console.error(e); });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url, pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  const posts = [];
  w.fetch = async (u, o = {}) => {
    const pad = String(u);
    const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b) });
    if (pad.includes('sales-hard-delete-preflight')) return json(pf);
    if (pad.includes('sales-hard-delete-quotation')) {
      const body = JSON.parse(o.body);
      posts.push(body);
      if (pf.commissie_keuze_nodig && !body.commissie_keuze) return json({ error: 'COMMISSIE_KEUZE_VEREIST', detail: 'Kies.' }, 409);
      return json({ ok: true, commissie: body.commissie_keuze ? { reden: 'Klant geannuleerd', geannuleerd_regels: 1, al_vrijgegeven: 0 } : null });
    }
    if (pad.includes('sales-deal-detail')) return json({ deal: { id: 'd1', tl_quotation_status: 'accepted' }, customer: { id: 'c1' }, line_items: [] });
    return json({});
  };
  return { w, posts };
}

/** Het hoofdscript van de losse pagina, met de eigen DOM erbij. */
function laadLos(pf) {
  const { w, posts } = maakDom('https://crm.test/modules/offerte-detail-v2.html?id=d1', pf);
  const body = LOS_HTML.slice(LOS_HTML.indexOf('<body'), LOS_HTML.indexOf('</body>'));
  w.document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, '').replace(/^<body[^>]*>/, '');
  assert.match(LOS_HTML, /<script src="\.\/klanten-v2\/views\/_commissie-ui\.js\?v=\d+"><\/script>/, 'de losse pagina laadt het gedeelde onderdeel');
  w.eval(COMMISSIE_UI);
  const hoofd = [...LOS_HTML.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  w.eval(hoofd);
  w.__odvRole = 'super_admin';
  return { w, posts, run: () => w.__odvHdRun() };
}

/** De shell-offertepagina, voor de vergelijking. */
function laadShell(pf) {
  const { w, posts } = maakDom('https://crm.test/modules/klanten-v2/?v2preview=sales', pf);
  w.DFO = { S: { role: 'super_admin' }, render() {}, goMod() {}, goTab() {} };
  w.AuthShared = { getAccessToken: async () => 'x' };
  w.eval(COMMISSIE_UI);
  w.eval(SHELL_VIEW);
  w.document.body.insertAdjacentHTML('beforeend', '<div>' + w.__odvRender('d1') + '</div>');
  return { w, posts, run: () => w.__odvDoHardDelete() };
}

/** Klik door het verloop; geeft wat er te zien was. */
async function verwijder(pagina, { kies = 'klant_annuleert', vinkOnboarding = true } = {}) {
  const { w } = pagina;
  const bezig = pagina.run();
  await wacht();
  const zicht = {};
  // Stap 1 — samenvatting.
  const dlg = [...w.document.querySelectorAll('div[style*="9600"]')].pop();
  zicht.samenvatting = dlg.textContent;
  const vinkje = dlg.querySelector('#hdVinkje, [data-vinkje]');
  if (vinkje && vinkOnboarding) { vinkje.checked = true; vinkje.dispatchEvent(new w.Event('change')); }
  (dlg.querySelector('#hdOk') || dlg.querySelector('[data-ok]')).click();
  await wacht();
  // Stap 2 — commissiekeuze (enkel als er open commissie is).
  const keuzeDlg = [...w.document.querySelectorAll('div[style*="9650"]')].pop();
  zicht.keuze = keuzeDlg ? {
    titel: keuzeDlg.textContent.includes('Mentorcommissie op deze offerte'),
    opties: [...keuzeDlg.querySelectorAll('input[name="kv-comm-keuze"]')].map((r) => r.value),
    tekst: keuzeDlg.textContent.replace(/\s+/g, ' ').trim(),
    okGrijsVoorKeuze: keuzeDlg.querySelector('[data-ok]').disabled,
  } : null;
  if (keuzeDlg) {
    if (kies) {
      const r = keuzeDlg.querySelector(`input[value="${kies}"]`);
      r.checked = true; r.dispatchEvent(new w.Event('change'));
      keuzeDlg.querySelector('[data-ok]').click();
    } else {
      keuzeDlg.querySelector('[data-x]').click();
    }
    await wacht();
  }
  // Stap 3 — typ VERWIJDER.
  const inp = w.document.querySelector('#hdConfirmInput') || [...w.document.querySelectorAll('input[type=text]')].pop();
  if (inp && w.document.body.contains(inp)) {
    inp.value = 'VERWIJDER'; inp.dispatchEvent(new w.Event('input'));
    await tick();
    const knop = w.document.querySelector('#hdConfirmOk') || [...w.document.querySelectorAll('button')].filter((b) => !b.disabled && /verwijder/i.test(b.textContent)).pop();
    knop?.click();
  }
  await wacht(10);
  // Stap 4 — melding achteraf.
  const meld = [...w.document.querySelectorAll('div[style*="9650"]')].pop();
  zicht.melding = meld ? meld.textContent.replace(/\s+/g, ' ').trim() : null;
  meld?.querySelector('[data-ok]')?.click();
  await bezig;
  return zicht;
}

test('LOS: open commissie → dezelfde keuze, commissie_keuze + onboarding_bevestigd mee, melding achteraf', async () => {
  const p = laadLos(preflight({ metCommissie: true, metOnboarding: true }));
  const z = await verwijder(p, { kies: 'vervangen' });
  assert.match(z.samenvatting, /Aan deze offerte hangt mentorcommissie/, 'waarschuwing in de samenvatting');
  assert.match(z.samenvatting, /Er hangt een onboarding aan deze klant/);
  assert.ok(z.keuze, 'het keuzevenster verschijnt');
  assert.equal(z.keuze.titel, true);
  assert.deepEqual(z.keuze.opties, ['klant_annuleert', 'vervangen']);
  assert.equal(z.keuze.okGrijsVoorKeuze, true, 'niets vooraf gekozen');
  assert.deepEqual(p.posts, [{ deal_id: 'd1', confirm: 'VERWIJDER', onboarding_bevestigd: true, commissie_keuze: 'vervangen' }]);
  assert.match(z.melding, /Mentorcommissie geannuleerd/);
});

test('LOS: keuze afgebroken → er wordt niets verwijderd (geen POST)', async () => {
  const p = laadLos(preflight({ metCommissie: true }));
  await verwijder(p, { kies: null });
  assert.deepEqual(p.posts, []);
});

test('LOS: zonder commissie geen keuzevenster; commissie_keuze null (gedrag zoals voorheen)', async () => {
  const p = laadLos(preflight({ metCommissie: false }));
  const z = await verwijder(p);
  assert.equal(z.keuze, null);
  assert.deepEqual(p.posts, [{ deal_id: 'd1', confirm: 'VERWIJDER', onboarding_bevestigd: false, commissie_keuze: null }]);
});

test('LOS = SHELL: zelfde keuzetekst, zelfde POST', async () => {
  const pf = preflight({ metCommissie: true, metOnboarding: true });
  const los = laadLos(pf);
  const shell = laadShell(pf);
  const zLos = await verwijder(los, { kies: 'klant_annuleert' });
  const zShell = await verwijder(shell, { kies: 'klant_annuleert' });
  assert.equal(zLos.keuze.tekst, zShell.keuze.tekst, 'het keuzevenster is identiek');
  assert.deepEqual(los.posts, shell.posts);
  assert.deepEqual(los.posts[0], { deal_id: 'd1', confirm: 'VERWIJDER', onboarding_bevestigd: true, commissie_keuze: 'klant_annuleert' });
});

test('BRON: één bron voor de keuze; geen kopie van de opties in de schermen; caches opgehoogd', () => {
  assert.match(COMMISSIE_UI, /function keuzeBijVerwijderen\(commissie\)/);
  assert.match(COMMISSIE_UI, /function meldingNaVerwijderen\(c\)/);
  for (const [naam, bron] of [['shell', SHELL_VIEW], ['los', LOS_HTML]]) {
    assert.match(bron, /KV_COMM\.keuzeBijVerwijderen\(/, naam);
    assert.doesNotMatch(bron, /v: 'klant_annuleert', l: 'Klant annuleert', d: 'Commissie → Geannuleerd, reden "Klant geannuleerd". De mentor/, naam + ': geen kopie van de opties');
  }
  assert.match(LOS_HTML, /onboarding_bevestigd: !!obW, commissie_keuze: commissieKeuze/);
  const index = lees('modules/klanten-v2/index.html');
  assert.match(index, /views\/_commissie-ui\.js\?v=5/);
  assert.match(index, /views\/offerte-detail-v2\.js\?v=18/);
});
