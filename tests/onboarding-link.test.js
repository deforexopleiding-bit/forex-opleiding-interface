// tests/onboarding-link.test.js — de persoonlijke onboarding-link achter de
// vlag onboarding_portal_live (27 okt 2026), {{onboarding.startcode}}, de
// opmaak van de automation-mail en de redirect op modules/onboarding.html.
//
// Bedoeld gedrag:
//   · vlag UIT (standaard) → alles exact zoals vroeger (klassieke wizard);
//   · vlag AAN → elke persoonlijke link = `${ONBOARDING_PORTAL_URL}?code=XXXX-XXXX`;
//   · alle plekken bouwen de link via api/_lib/onboarding-link.js — geen kopieën;
//   · een vlag die niet te lezen is = UIT (het beproefde pad).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  vlagAan, persoonlijkeLink, portalLive, klassiekeLink, linkVoorOnboarding, _resetVlagCache,
} from '../api/_lib/onboarding-link.js';
import { resolveVariableValue, AVAILABLE_VARIABLES, buildMetaVariablesFromMapping } from '../api/_lib/template-variables.js';
import { heeftOpmaak, bouwOpmaakMail } from '../api/_lib/onboarding-mail-opmaak.js';

const ROOT = new URL('..', import.meta.url).pathname;
const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

function vlagDb(waarde, { fout = null, startcode = 'ABCD2345' } = {}) {
  let lezingen = 0;
  const rij = { id: 'ob-1', startcode };
  return {
    get lezingen() { return lezingen; },
    from(t) {
      let upd = null;
      const q = {
        select() { return q; }, eq() { return q; }, is() { return q; },
        update(v) { upd = v; return q; },
        maybeSingle() {
          if (t === 'app_settings') { lezingen++; return Promise.resolve(fout ? { data: null, error: fout } : { data: waarde === undefined ? null : { value: waarde }, error: null }); }
          return Promise.resolve({ data: { ...rij }, error: null });
        },
        then(ok) {
          if (upd) { Object.assign(rij, upd); return Promise.resolve({ data: [{ ...rij }], error: null }).then(ok); }
          return Promise.resolve({ data: [{ ...rij }], error: null }).then(ok);
        },
      };
      return q;
    },
  };
}

test('vlag: alleen expliciet aan telt; ontbrekend of onleesbaar = uit', async () => {
  for (const w of [true, 'true', 'aan', { live: true }]) assert.equal(vlagAan(w), true, JSON.stringify(w));
  for (const w of [false, 'false', null, undefined, 0, {}, { live: false }]) assert.equal(vlagAan(w), false, JSON.stringify(w));
  _resetVlagCache();
  assert.equal(await portalLive(vlagDb(undefined), { vers: true }), false);
  assert.equal(await portalLive(vlagDb(true, { fout: { message: 'weg' } }), { vers: true }), false);
  assert.equal(await portalLive(vlagDb(true), { vers: true }), true);
  _resetVlagCache();
});

test('vlag: 30 s gecachet (geen databankvraag per mail)', async () => {
  _resetVlagCache();
  const db = vlagDb(true);
  await portalLive(db, { nu: 1_000_000 });
  await portalLive(db, { nu: 1_010_000 });
  assert.equal(db.lezingen, 1);
  await portalLive(db, { nu: 1_040_000 });
  assert.equal(db.lezingen, 2);
  _resetVlagCache();
});

test('persoonlijke link: uit → klassiek; aan → portal met code; aan zonder code → klassiek', () => {
  const klassiek = klassiekeLink('tok-1');
  assert.equal(klassiek, 'https://crm.deforexopleiding.nl/modules/onboarding.html?t=tok-1');
  assert.equal(persoonlijkeLink({ token: 'tok-1', startcode: 'ABCD2345', live: false }), klassiek);
  assert.equal(persoonlijkeLink({ token: 'tok-1', startcode: 'ABCD2345', live: true }), 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345');
  assert.equal(persoonlijkeLink({ token: 'tok-1', startcode: null, live: true }), klassiek);
});

test('linkVoorOnboarding: leest de vlag en de code (ook voor {{onboarding.startcode}} bij vlag uit)', async () => {
  _resetVlagCache();
  const aan = await linkVoorOnboarding(vlagDb(true), { id: 'ob-1', token: 'tok-1' });
  assert.deepEqual(aan, { link: 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345', live: true, startcode: 'ABCD2345' });
  _resetVlagCache();
  const uit = await linkVoorOnboarding(vlagDb(false), { id: 'ob-1', token: 'tok-1' });
  assert.equal(uit.link, 'https://crm.deforexopleiding.nl/modules/onboarding.html?t=tok-1');
  assert.equal(uit.startcode, 'ABCD2345');
  _resetVlagCache();
});

test('templatevariabelen: {{onboarding.startcode}} geformatteerd; links volgen de voorberekende link', () => {
  assert.ok(AVAILABLE_VARIABLES.some((v) => v.key === 'onboarding.startcode'));
  const ctx = { onboarding: { token: 'tok-1', startcode: 'ABCD2345', persoonlijke_link: 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345' } };
  assert.equal(resolveVariableValue('onboarding.startcode', ctx), 'ABCD-2345');
  assert.equal(resolveVariableValue('onboarding.persoonlijke_link', ctx), 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345');
  assert.equal(resolveVariableValue('onboarding.wizard_link', ctx), 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345');
  // Zonder voorberekende link: precies zoals vroeger.
  assert.equal(resolveVariableValue('onboarding.persoonlijke_link', { onboarding: { token: 'tok-1' } }),
    'https://crm.deforexopleiding.nl/modules/onboarding.html?t=tok-1');
  // De WhatsApp-template welkom_onboarding: {{2}} = onboarding.persoonlijke_link (gemeten 27 okt).
  const vars = buildMetaVariablesFromMapping({ 1: 'klant.voornaam', 2: 'onboarding.persoonlijke_link' },
    { customer: { first_name: 'Wim' }, ...ctx });
  assert.equal(vars[2], 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345');
  assert.match(lees('modules/shared/finance-instellingen.js'), /key: 'onboarding\.startcode'/);
});

test('mailopmaak: zonder de twee regels blijft de oude mail; met → code groot + knop', () => {
  const oud = 'Hi {{klant.voornaam}},\n\nStart hier: {{onboarding.wizard_link}}';
  assert.equal(heeftOpmaak(oud), false);
  const body = 'Hi {{klant.voornaam}},\n\nWelkom.\n\n{{onboarding.startcode}}\n\n[knop: Start je onboarding]\n\nTot snel,\nTeam';
  assert.equal(heeftOpmaak(body), true);
  const link = 'https://www.deforexopleiding.nl/onboarding?code=ABCD-2345';
  const m = bouwOpmaakMail({ subject: 'Welkom {{klant.voornaam}}', body, link,
    waarden: { '{{klant.voornaam}}': 'Wim <b>', '{{onboarding.startcode}}': 'ABCD-2345' } });
  assert.match(m.html, /ABCD-2345/);
  assert.match(m.html, /Jouw startcode/);
  assert.match(m.html, new RegExp(`href="${link.replace(/[.?]/g, '\\$&')}"[^>]*>Start je onboarding</a>`));
  assert.match(m.html, /Hi Wim &lt;b&gt;,/);          // klantdata ge-escaped
  assert.doesNotMatch(m.html, /\[knop:/);
  assert.match(m.text, /Jouw startcode: ABCD-2345/);
  assert.match(m.text, /Start je onboarding: https:\/\/www\.deforexopleiding\.nl\/onboarding\?code=ABCD-2345/);
  // De startcode midden in een zin is gewoon tekst (geen kader).
  assert.equal(heeftOpmaak('Je code is {{onboarding.startcode}}.'), false);
});

test('de mailstap van de automations gebruikt de helper, de nieuwe variabelen en de opmaak', () => {
  const e = lees('api/_lib/onboarding-automation-engine.js');
  assert.match(e, /const persoonlijk = await linkVoorOnboarding\(supabaseAdmin, onboarding\)/);
  assert.match(e, /'\{\{onboarding\.persoonlijke_link\}\}': wizardLink/);
  assert.match(e, /'\{\{onboarding\.startcode\}\}':/);
  assert.match(e, /if \(heeftOpmaak\(body\)\)/);
});

test('redirect: wizard-get geeft portal_url achter de vlag; de pagina stuurt door, behalve ?klassiek=1', () => {
  const g = lees('api/onboarding-wizard-get.js');
  assert.match(g, /if \(await portalLive\(supabaseAdmin\)\) portalUrl = portalLink\(await kenStartcodeToe\(supabaseAdmin, ob\.id\)\)/);
  assert.match(g, /portal_url\s+: portalUrl/);
  const p = lees('modules/onboarding.html');
  assert.match(p, /d\?\.portal_url && params\.get\('klassiek'\) !== '1'/);
  assert.match(p, /location\.replace\(d\.portal_url\)/);
});

function bestanden(dir) {
  const uit = [];
  for (const n of readdirSync(join(ROOT, dir))) {
    const p = join(dir, n);
    if (statSync(join(ROOT, p)).isDirectory()) uit.push(...bestanden(p));
    else if (/\.(js|html)$/.test(n)) uit.push(p);
  }
  return uit;
}

test('geen losse linkbouwers meer: de server gaat altijd via onboarding-link.js', () => {
  const fout = [];
  for (const f of bestanden('api')) {
    if (f === 'api/_lib/onboarding-link.js') continue;
    const code = lees(f).split('\n').filter((r) => !/^\s*(\/\/|\*)/.test(r)).join('\n');
    // Een klassieke link bouwen mag alleen nog als terugval in template-variables
    // (zonder voorberekende link) en als relatief `link` in onboarding-create.
    const treffers = code.match(/modules\/onboarding\.html\?t=/g) || [];
    const toegestaan = { 'api/_lib/template-variables.js': 1, 'api/onboarding-create.js': 1 }[f] || 0;
    if (treffers.length > toegestaan) fout.push(`${f}: ${treffers.length}×`);
  }
  assert.deepEqual(fout, []);
  // De kopieerknoppen in de backoffice nemen de link van de server.
  assert.match(lees('modules/klanten-v2/views/onboarding-v2.js'), /row\?\.persoonlijke_link \|\|/);
  assert.match(lees('modules/shared/onboarding-overzicht.js'), /rij && rij\.persoonlijke_link/);
  assert.match(lees('modules/shared/onboarding-overzicht.js'), /o\.portal\?\.persoonlijke_link \|\|/);
  assert.match(lees('modules/klanten-v2/views/modals/onboarding-detail.js'), /o\.portal\?\.persoonlijke_link/);
  for (const f of ['modules/offerte-detail.html', 'modules/offerte-detail-v2.html', 'modules/klanten-v2/views/offerte-detail-v2.js']) {
    assert.match(lees(f), /d\?\.persoonlijke_link \|\|/, f);
  }
  assert.match(lees('api/onboarding-create.js'), /persoonlijke_link: \(await linkVoorOnboarding\(supabaseAdmin, inserted\)\)\.link/);
});

test('migratie 1 zette de vlag standaard UIT', () => {
  assert.match(lees('docs/sql-migrations/2026-10-27-onboarding-portal.sql'), /'onboarding_portal_live', 'false'::jsonb/);
});
