// tests/meta-testtool.test.js — Meta-toestemming-testtool (2026-11-02).
// Spiegel van lib/meta-testtool.test.ts in dfo-website.
//   1. leesTesttool / valideerTesttool / effectieveToestemming / testadresToegestaan (puur);
//   2. haalTesttool: leesfout → normaal, cache ~15 s;
//   3. beslisMetaLead en leadHeeftToestemming: standaard alleen testadressen, of sitebreed;
//   4. bedrading: zenders, endpoint (rechten), Meta-koppeling-kaart (banner altijd), webinar-fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NORMAAL, TESTTOOL_SLEUTEL, effectieveToestemming, haalTesttool, isActief, leesTesttool, testadresToegestaan,
  valideerTesttool, wisTesttoolCache,
} from '../api/_lib/meta-testtool.js';
import { beslisMetaLead } from '../api/_lib/meta-lead-poort.js';
import { leadHeeftToestemming } from '../api/_lib/advertentie-toestemming.js';

const lees = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';
const SITEBREED = { alleen_testadressen: false };

/** Mini-db: app_settings geeft `stand`; de lead-claim lukt; leads-select geeft toestemming + e-mail. */
function sb(stand, toestemming = false, email = 'jan@gmail.com') {
  return {
    from(t) {
      if (t === 'app_settings') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stand === undefined ? null : { value: stand }, error: null }) }) }) };
      return {
        update: () => ({ eq: (c, id) => ({ is: () => ({ select: async () => ({ data: [{ id }], error: null }) }) }) }),
        select: () => { const q = { is: () => q, limit: () => q, eq: () => q, ilike: () => q, then: (r) => r({ data: [{ advertentie_toestemming: toestemming, email }], error: null }) }; return q; },
      };
    },
  };
}

test('leesTesttool, valideerTesttool, effectieveToestemming en testadresToegestaan', () => {
  assert.equal(TESTTOOL_SLEUTEL, 'meta_toestemming_testtool');
  for (const v of [null, undefined, 'x', [], {}, { modus: 'soms' }]) assert.deepEqual(leesTesttool(v), NORMAAL);
  assert.equal(NORMAAL.alleenTestadressen, true);
  assert.equal(leesTesttool({ modus: 'altijd' }).alleenTestadressen, true, 'ontbreekt → vangnet aan');
  assert.deepEqual(leesTesttool({ modus: 'nooit', alleen_testadressen: false, testadressen: true, test_event_code: ' T1 ', cookiebanner: 'uit' }),
    { modus: 'nooit', alleenTestadressen: false, testadressen: true, testEventCode: 'T1' });
  assert.equal(isActief(NORMAAL), false);
  assert.equal(isActief(leesTesttool({ modus: 'altijd' })), true);

  assert.equal(valideerTesttool({}).ok, false);
  assert.equal(valideerTesttool({ modus: 'altijd', test_event_code: 'TE ST' }).ok, false, 'spatie in de code');
  assert.deepEqual(valideerTesttool({ modus: 'altijd', test_event_code: 'TEST123' }),
    { ok: true, waarde: { modus: 'altijd', alleen_testadressen: true, testadressen: false, test_event_code: 'TEST123' } }, 'standaard alleen testadressen');
  assert.equal(valideerTesttool({ modus: 'altijd', alleen_testadressen: false }).waarde.alleen_testadressen, false);
  assert.equal('cookiebanner' in valideerTesttool({ modus: 'nooit', cookiebanner: 'uit' }).waarde, false, 'banner is geen instelling meer');

  const altijd = leesTesttool({ modus: 'altijd' });
  assert.equal(effectieveToestemming(altijd, false, false), false, 'echte lead: keuze telt');
  assert.equal(effectieveToestemming(altijd, false, true), true, 'testadres: override');
  assert.equal(effectieveToestemming(leesTesttool({ modus: 'nooit' }), true, false), true);
  assert.equal(effectieveToestemming(leesTesttool({ modus: 'altijd', ...SITEBREED }), false, false), true);
  assert.equal(effectieveToestemming(leesTesttool({ modus: 'nooit', ...SITEBREED }), true, false), false);
  assert.equal(testadresToegestaan(NORMAAL), false);
  assert.equal(testadresToegestaan(altijd), true);
  assert.equal(testadresToegestaan(leesTesttool({ testadressen: true })), true);
  assert.equal(testadresToegestaan(leesTesttool({ modus: 'altijd', ...SITEBREED })), false);
});

test('haalTesttool: leesfout → normaal; cache ~15 s', async () => {
  wisTesttoolCache();
  assert.deepEqual(await haalTesttool({ from: () => { throw new Error('weg'); } }, 1000), NORMAAL);
  assert.deepEqual(await haalTesttool(sb({ modus: 'altijd' }), 5000), NORMAAL, 'nog in de cache');
  assert.equal((await haalTesttool(sb({ modus: 'altijd' }), 20_000)).modus, 'altijd');
  wisTesttoolCache();
});

test('beslisMetaLead: standaard alleen testadressen, sitebreed voor iedereen', async () => {
  const b = { leadId: 'L1', email: 'jan@gmail.com', userAgent: UA, vercelEnv: 'production' };
  const r = async (stand, extra) => { wisTesttoolCache(); return beslisMetaLead(sb(stand), { ...b, ...extra }); };
  assert.equal((await r(undefined, { toestemming: false })).reden, 'geen_toestemming');
  assert.equal((await r({ modus: 'altijd' }, { toestemming: false })).reden, 'geen_toestemming', 'echte lead blijft veilig');
  assert.equal((await r({ modus: 'altijd' }, { email: 'jan+test@gmail.com', toestemming: false })).eventId, 'lead_L1');
  assert.equal((await r({ modus: 'altijd' }, { isTest: true, toestemming: false })).eventId, 'lead_L1', 'is_test telt als testadres');
  assert.equal((await r({ modus: 'nooit' }, { toestemming: true })).eventId, 'lead_L1', 'echte lead met toestemming gaat gewoon');
  assert.equal((await r({ modus: 'nooit' }, { email: 'jan+test@gmail.com', toestemming: true })).reden, 'testtool_nooit');
  assert.equal((await r({ modus: 'altijd', ...SITEBREED }, { toestemming: false })).eventId, 'lead_L1');
  assert.equal((await r({ modus: 'nooit', ...SITEBREED }, { toestemming: true })).reden, 'testtool_nooit');
  assert.equal((await r({}, { email: 'jan+test@gmail.com', toestemming: true })).reden, 'testadres');
  assert.equal((await r({ testadressen: true }, { email: 'jan+test@gmail.com', toestemming: true })).eventId, 'lead_L1');
  assert.equal((await r({ modus: 'altijd', ...SITEBREED }, { userAgent: 'curl/8', toestemming: false })).reden, 'bot');
  assert.equal((await r({ modus: 'altijd', ...SITEBREED }, { vercelEnv: 'preview', toestemming: false })).reden, 'geen_productie');
  wisTesttoolCache();
});

test('leadHeeftToestemming: standaard alleen voor testadressen (e-mail van de lead), sitebreed voor iedereen', async () => {
  // Cache vullen met de mock: leadHeeftToestemming leest de testtool via de standaardclient.
  const met = async (stand, lead) => { wisTesttoolCache(); await haalTesttool(sb(stand)); return leadHeeftToestemming(lead, { leadId: 'L1' }); };
  assert.equal(await met({ modus: 'altijd' }, sb(undefined, false)), false, 'echte lead zonder toestemming: nee');
  assert.equal(await met({ modus: 'altijd' }, sb(undefined, false, 'jan+test@gmail.com')), true, 'testlead: ja');
  assert.equal(await met({ modus: 'nooit' }, sb(undefined, true)), true, 'echte lead met toestemming: ja');
  assert.equal(await met({ modus: 'nooit' }, sb(undefined, true, 'jan+test@gmail.com')), false);
  assert.equal(await met({ modus: 'altijd', ...SITEBREED }, sb(undefined, false)), true);
  assert.equal(await met({ modus: 'nooit', ...SITEBREED }, sb(undefined, true)), false);
  assert.equal(await met({ modus: 'normaal' }, sb(undefined, true)), true);
  assert.equal(await met({ modus: 'normaal' }, sb(undefined, false)), false);
  wisTesttoolCache();
});

test('bedrading: zenders, endpoint, kaart (banner altijd) en de webinar-fix', () => {
  const lab = lees('api/_lib/lab-meta.js');
  assert.match(lab, /const ttHier = tt\.alleenTestadressen \? \{ \.\.\.tt, modus: 'normaal' \} : tt;/, 'Lab-event: override alleen sitebreed');
  assert.match(lab, /const effTestCode = tt\.testEventCode \|\| \(testCode === undefined \? cfg\.testCode : testCode\);/);
  assert.match(lees('api/lab-aanmelding.js'), /bronUrl: d\.landingspagina,[\s\S]{0,200}toestemming: true,/);
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
  assert.match(ui, /'Alleen voor testadressen'/);
  assert.doesNotMatch(ui, /Cookiebanner uitschakelen|_lsMetaTtBanner/, 'de banner is geen optie meer');

  const web = lees('api/public-webinar-aanmelding.js');
  assert.match(web, /toestemming: toestemmingUitBody\(b\),/);
});
