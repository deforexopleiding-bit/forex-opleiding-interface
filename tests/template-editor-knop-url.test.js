// tests/template-editor-knop-url.test.js
//
// Instellingen → WhatsApp → template-editor: de URL van een knop overleeft
// het bevestigingsvenster, en 'Opslaan + Submit → Meta' dient echt in.
//
// GEMETEN OORZAAK (2 okt). De knopvelden zijn uncontrolled en kwamen pas in
// _metaSyncFieldsFromDom() (binnen _metaEdSave) in de state. Maar openConfirm()
// én __setConfirmOk() roepen render() aan vóór onOk: de modal werd opnieuw
// opgebouwd uit de state (url ''), en de save las daarna een leeg veld →
// "buttons[0].url: string vereist bij type URL [HTTP 400]".
//
// TWEEDE BUG. 'Opslaan + Submit' vroeg na het opslaan nog eens bevestiging via
//   new Promise((res) => openConfirm(…, () => res(true)) || res(false))
// openConfirm() geeft undefined terug, dus de promise resolvede METEEN met
// false: de submit liep nooit, de template bleef op LOCAL.
//
// Deze test draait de echte view in jsdom: typen in het DOM, klikken op de
// knoppen, en kijken wat er naar de server gaat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lees = (p) => readFileSync(join(ROOT, p), 'utf8');
const wacht = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function laadEditor() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="c"></div></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;
  const calls = [];
  const container = w.document.getElementById('c');
  w.DFO = {
    VIEWS: {}, S: {}, F: {}, setF() {},
    I: new Proxy({}, { get: () => '' }), svg: () => '',
    render: () => { container.innerHTML = w.KV_V2.metaTemplates.render(); },
  };
  w.KV = {
    authedJson: async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });
      if (url.startsWith('/api/admin-whatsapp-modules-list')) return { items: [{ business_account_id: 'waba1', is_active: true, module: 'leadsonderhoud' }] };
      if (url.startsWith('/api/admin-meta-templates-list')) return { items: [], folders: [] };
      if (url.startsWith('/api/admin-template-variables-list')) return { variables: [] };
      if (url.startsWith('/api/admin-meta-templates-upsert')) return { template: { id: 'tpl-1' } };
      if (url.startsWith('/api/admin-meta-templates-submit')) return { ok: true };
      return {};
    },
  };
  w.console.debug = () => {};
  w.eval(lees('modules/klanten-v2/views/_shared-v2.js'));
  w.eval(lees('modules/klanten-v2/views/instellingen-v2.js'));
  w.KV_V2.metaTemplates.init();
  await wacht(30);
  w.DFO.render();
  return { w, calls, container };
}

/** Vul een nieuwe template met één URL-knop, zoals iemand dat doet: in het DOM. */
async function vulIn(w) {
  w.__setMetaEdOpen();
  await wacht();
  const q = (s) => w.document.querySelector(s);
  q('[data-metaed-name]').value = 'agenda_doorsturen_v1';
  w.__setMetaEdField('name', 'agenda_doorsturen_v1');
  q('[data-metaed-body]').value = 'Hey {{1}}, kies hier een moment.';
  w.__setMetaEdField('body_text', 'Hey {{1}}, kies hier een moment.');
  w.__setMetaAddBtn();
  await wacht();
  q('[data-btn-idx="0"][data-btn-field="text"]').value = 'Kies een moment';
  // Alleen in het DOM, precies zoals de browser het doet: geen setter.
  q('[data-btn-idx="0"][data-btn-field="url"]').value = 'https://deforexopleiding.nl/agenda/planning';
}

test('URL getypt → Opslaan → bevestigen → de payload bevat de url', async (t) => {
  const { w, calls } = await laadEditor();
  t.after(() => w.close());
  await vulIn(w);
  w.__setMetaEdSave();          // opent het bevestigingsvenster (render!)
  await wacht();
  w.__setConfirmOk();           // render vóór onOk
  await wacht(30);
  const upsert = calls.find((c) => c.url.startsWith('/api/admin-meta-templates-upsert'));
  assert.ok(upsert, 'er hoort een upsert te zijn');
  assert.deepEqual(upsert.body.buttons, [{ type: 'URL', text: 'Kies een moment', url: 'https://deforexopleiding.nl/agenda/planning' }]);
  assert.ok(!calls.some((c) => c.url.startsWith('/api/admin-meta-templates-submit')), 'gewoon opslaan dient niet in');
});

test('Opslaan + Submit → één bevestiging → opgeslagen MET url én echt ingediend', async (t) => {
  const { w, calls } = await laadEditor();
  t.after(() => w.close());
  await vulIn(w);
  w.__setMetaEdSaveSubmit();
  await wacht();
  w.__setConfirmOk();
  await wacht(30);
  const upsert = calls.find((c) => c.url.startsWith('/api/admin-meta-templates-upsert'));
  assert.equal(upsert.body.buttons[0].url, 'https://deforexopleiding.nl/agenda/planning');
  const submit = calls.find((c) => c.url.startsWith('/api/admin-meta-templates-submit'));
  assert.ok(submit, 'de submit hoort te lopen — dit was de tweede bug');
  assert.match(submit.url, /template_id=tpl-1/);
  assert.equal(submit.method, 'POST');
});

test('de oude valkuil staat er niet meer: geen `openConfirm(...) || res(false)`', () => {
  const view = lees('modules/klanten-v2/views/instellingen-v2.js')
    .split('\n').filter((r) => !r.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(view, /openConfirm\([^;]*\)\s*\|\|\s*res\(false\)/);
});
