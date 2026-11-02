// tests/meta-testtool.test.js — Meta-toestemming-testtool (2026-11-02).
// Spiegel van lib/meta-testtool.test.ts in dfo-website.
//   1. leesTesttool / valideerTesttool / effectieveToestemming (puur);
//   2. haalTesttool: leesfout → normaal, cache ~15 s;
//   3. beslisMetaLead en leadHeeftToestemming volgen de testtool;
//   4. bedrading: zenders, endpoint (rechten), Meta-koppeling-kaart, webinar-fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NORMAAL, TESTTOOL_SLEUTEL, effectieveToestemming, haalTesttool, isActief, leesTesttool, valideerTesttool, wisTesttoolCache,
} from '../api/_lib/meta-testtool.js';
import { beslisMetaLead } from '../api/_lib/meta-lead-poort.js';
import { leadHeeftToestemming } from '../api/_lib/advertentie-toestemming.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';

/** Mini-db: app_settings geeft `stand`; de lead-claim lukt; leads-select geeft `toestemming`. */
function sb(stand, toestemming = false) {
  return {
    from(t) {
      if (t === 'app_settings') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stand === undefined ? null : { value: stand }, error: null }) }) }) };
      return {
        update: () => ({ eq: (c, id) => ({ is: () => ({ select: async () => ({ data: [{ id }], error: null }) }) }) }),
        select: () => { const q = { is: () => q, limit: () => q, eq: () => q, ilike: () => q, then: (r) => r({ data: [{ advertentie_toestemming: toestemming }], error: null }) }; return q; },
      };
    },
  };
}

test('leesTesttool en valideerTesttool', () => {
  assert.equal(TESTTOOL_SLEUTEL, 'meta_toestemming_testtool');
  for (const v of [null, undefined, 'x', [], {}, { modus: 'soms' }]) assert.deepEqual(leesTesttool(v), NORMAAL);
  assert.equal(leesTesttool({ modus: 'normaal', cookiebanner: 'uit' }).cookiebanner, 'aan');
  assert.deepEqual(leesTesttool({ modus: 'nooit', cookiebanner: 'uit', testadressen: true, test_event_code: ' T1 ', gezet_door: 'x' }),
    { modus: 'nooit', cookiebanner: 'uit', testadressen: true, testEventCode: 'T1' });
  assert.equal(isActief(NORMAAL), false);
  assert.equal(isActief(leesTesttool({ modus: 'altijd' })), true);

  assert.equal(valideerTesttool({}).ok, false);
  assert.match(valideerTesttool({ modus: 'normaal', cookiebanner: 'uit' }).fout, /alleen met/);
  assert.equal(valideerTesttool({ modus: 'altijd', test_event_code: 'TE ST' }).ok, false, 'spatie in de code');
  assert.deepEqual(valideerTesttool({ modus: 'altijd', cookiebanner: 'uit', testadressen: true, test_event_code: 'TEST123' }),
    { ok: true, waarde: { modus: 'altijd', cookiebanner: 'uit', testadressen: true, test_event_code: 'TEST123' } });

  assert.equal(effectieveToestemming(NORMAAL, true), true);
  assert.equal(effectieveToestemming(NORMAAL, false), false);
  assert.equal(effectieveToestemming(leesTesttool({ modus: 'altijd' }), false), true);
  assert.equal(effectieveToestemming(leesTesttool({ modus: 'nooit' }), true), false);
});

test('haalTesttool: leesfout → normaal; cache ~15 s', async () => {
  wisTesttoolCache();
  assert.deepEqual(await haalTesttool({ from: () => { throw new Error('weg'); } }, 1000), NORMAAL);
  assert.deepEqual(await haalTesttool(sb({ modus: 'altijd' }), 5000), NORMAAL, 'nog in de cache');
  assert.equal((await haalTesttool(sb({ modus: 'altijd' }), 20_000)).modus, 'altijd');
  wisTesttoolCache();
});

test('beslisMetaLead volgt de testtool', async () => {
  const b = { leadId: 'L1', email: 'jan@gmail.com', userAgent: UA, vercelEnv: 'production' };
  wisTesttoolCache();
  assert.equal((await beslisMetaLead(sb(undefined), { ...b, toestemming: false })).reden, 'geen_toestemming');
  wisTesttoolCache();
  assert.equal((await beslisMetaLead(sb({ modus: 'altijd' }), { ...b, toestemming: false })).eventId, 'lead_L1');
  wisTesttoolCache();
  assert.equal((await beslisMetaLead(sb({ modus: 'nooit' }), { ...b, toestemming: true })).reden, 'testtool_nooit');
  wisTesttoolCache();
  assert.equal((await beslisMetaLead(sb({}), { ...b, email: 'jan+test@gmail.com', toestemming: true })).reden, 'testadres');
  wisTesttoolCache();
  assert.equal((await beslisMetaLead(sb({ testadressen: true }), { ...b, email: 'jan+test@gmail.com', isTest: true, toestemming: true })).eventId, 'lead_L1');
  wisTesttoolCache();
  assert.equal((await beslisMetaLead(sb({ modus: 'altijd' }), { ...b, userAgent: 'curl/8', toestemming: false })).reden, 'bot', 'bots blijven tegengehouden');
  wisTesttoolCache();
  assert.equal((await beslisMetaLead(sb({ modus: 'altijd' }), { ...b, vercelEnv: 'preview', toestemming: false })).reden, 'geen_productie');
  wisTesttoolCache();
});

test('leadHeeftToestemming volgt de testtool (altijd ja / nooit nee / normaal = de lead)', async () => {
  // Cache vullen met de mock: leadHeeftToestemming leest de testtool via de standaardclient.
  wisTesttoolCache();
  await haalTesttool(sb({ modus: 'altijd' }));
  assert.equal(await leadHeeftToestemming(sb(undefined, false), { leadId: 'L1' }), true);
  wisTesttoolCache();
  await haalTesttool(sb({ modus: 'nooit' }));
  assert.equal(await leadHeeftToestemming(sb(undefined, true), { leadId: 'L1' }), false);
  wisTesttoolCache();
  await haalTesttool(sb({ modus: 'normaal' }));
  assert.equal(await leadHeeftToestemming(sb(undefined, true), { leadId: 'L1' }), true);
  assert.equal(await leadHeeftToestemming(sb(undefined, false), { leadId: 'L1' }), false);
  wisTesttoolCache();
});

test('bedrading: zenders, endpoint, kaart en de webinar-fix', () => {
  const lab = lees('api/_lib/lab-meta.js');
  assert.match(lab, /if \(effectieveToestemming\(tt, toestemming\) !== true\) \{/);
  assert.match(lab, /const effTestCode = tt\.testEventCode \|\| \(testCode === undefined \? cfg\.testCode : testCode\);/);
  assert.match(lees('api/_lib/crm-lead-meta.js'), /if \(ttCode \|\| testCode\) body\.test_event_code = ttCode \|\| testCode;/);
  assert.match(lees('api/cron-meta-capi.js'), /postCapiEvents\(\{ event, testCode: ttCode \|\| cfg\.testCode \}\)/);

  const ep = lees('api/meta-testtool.js');
  assert.match(ep, /requirePermission\(req, 'leads\.view'\)/);
  assert.match(ep, /requirePermission\(req, 'leads\.update'\)/);
  assert.match(ep, /const v = valideerTesttool\(req\.body\);/);
  assert.match(ep, /wisTesttoolCache\(\);/);

  const ui = lees('modules/klanten-v2/views/leadsonderhoud-v2.js');
  assert.match(ui, /tryFetch\('meta-testtool', '\/api\/meta-testtool'\)/);
  assert.match(ui, /const blok3 = _metaTesttoolKaart\(st\);/);
  for (const k of ['normaal', 'altijd', 'nooit']) assert.match(ui, new RegExp(`\\['${k}', '`));
  assert.match(ui, /'Cookiebanner uitschakelen'/);
  assert.match(ui, /'Testadressen ook versturen'/);
  assert.doesNotMatch(ui, /Toestemming \(vergrendeld\)/);

  // Webinar: advertentie-toestemming = cookie_toestemming, niet het berichtenvinkje.
  const web = lees('api/public-webinar-aanmelding.js');
  assert.match(web, /toestemming: toestemmingUitBody\(b\),/);
  assert.doesNotMatch(web, /verwerkLeadMeta\([\s\S]{0,300}toestemming: v\.waarden\.toestemming/);
});
