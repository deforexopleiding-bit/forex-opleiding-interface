// tests/meta-lead-poort.test.js — één Meta "Lead" per CRM-lead (2026-10-21).
// Spiegel van lib/meta-lead-poort.test.ts in dfo-website.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beslisMetaLead, isBotAgent, isTestAdres, metaLeadEventId } from '../api/_lib/meta-lead-poort.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120 Safari/537.36';

function nepSb(gedrag) {
  const log = [];
  return {
    log,
    from: (t) => ({ update: (v) => ({ eq: (c, id) => ({ is: (c2, n) => ({ select: async () => {
      log.push({ t, c, id, c2, n, gezet: typeof v.meta_lead_op });
      if (gedrag === 'kolom') return { data: null, error: { code: '42703', message: 'x' } };
      if (gedrag === 'fout') return { data: null, error: { code: '500', message: 'x' } };
      return { data: gedrag === 'claim' ? [{ id }] : [], error: null };
    } }) }) }) }),
  };
}

test('beslisMetaLead: productie + echt adres + mens → lead_<id> één keer', async () => {
  const b = { leadId: 'L1', email: 'jan@gmail.com', userAgent: UA, vercelEnv: 'production', toestemming: true };
  const sb = nepSb('claim');
  assert.deepEqual(await beslisMetaLead(sb, b), { eventId: 'lead_L1', reden: 'nieuw' });
  assert.deepEqual(sb.log[0], { t: 'leads', c: 'id', id: 'L1', c2: 'meta_lead_op', n: null, gezet: 'string' });
  assert.deepEqual(await beslisMetaLead(nepSb('al'), b), { eventId: null, reden: 'al_gemeld' });
  assert.deepEqual(await beslisMetaLead(nepSb('kolom'), b), { eventId: 'lead_L1', reden: 'zonder_kolom' });
  assert.deepEqual(await beslisMetaLead(nepSb('fout'), b), { eventId: null, reden: 'claim_fout' });
});

test('beslisMetaLead: preview, test, bot en geen lead → nooit een Lead (en geen claim)', async () => {
  const sb = nepSb('claim');
  const b = { leadId: 'L1', email: 'jan@gmail.com', userAgent: UA, vercelEnv: 'production', toestemming: true };
  assert.equal((await beslisMetaLead(sb, { ...b, vercelEnv: 'preview' })).reden, 'geen_productie');
  assert.equal((await beslisMetaLead(sb, { ...b, isTest: true })).reden, 'testadres');
  assert.equal((await beslisMetaLead(sb, { ...b, email: 'x+labtest@gmail.com' })).reden, 'testadres');
  assert.equal((await beslisMetaLead(sb, { ...b, userAgent: 'Googlebot/2.1' })).reden, 'bot');
  assert.equal((await beslisMetaLead(sb, { ...b, leadId: null })).reden, 'geen_lead');
  // Geen toestemming advertentiecookies (2026-10-25) — ook ontbreken telt als nee.
  assert.equal((await beslisMetaLead(sb, { ...b, toestemming: false })).reden, 'geen_toestemming');
  assert.equal((await beslisMetaLead(sb, { ...b, toestemming: undefined })).reden, 'geen_toestemming');
  assert.equal(sb.log.length, 0);
});

test('helpers', () => {
  assert.equal(metaLeadEventId('abc'), 'lead_abc');
  assert.equal(isTestAdres('a@example.com', ''), true);
  assert.equal(isTestAdres('a@gmail.com', ''), false);
  assert.equal(isTestAdres('a@deforexopleiding.nl', '@deforexopleiding.nl'), true);
  assert.equal(isBotAgent(''), true);
  assert.equal(isBotAgent(UA), false);
});
