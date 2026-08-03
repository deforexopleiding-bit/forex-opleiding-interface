// tests/email-unread-invalidate.test.js
//
// Unit-tests voor invalidateEmailUnreadForCustomer — de cache-invalidate
// helper die na een mark-read-actie de per-klant unread-teller uit de
// module-cache wist zodat de badge direct op 0 kan gaan.
//
// Bewijst:
//   1) invalidate wist alleen die klant, andere klanten blijven in cache
//   2) invalidate case-insensitive op email
//   3) invalidate onbekende klant/module → false, geen crash
//   4) na invalidate + nieuwe fetch → alleen die klant wordt vers gefetcht,
//      andere klanten blijven cache-hit (bewijst granular wissen)
//   5) invalidate met lege input → false, no-op

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEmailUnreadByCustomerEmail,
  invalidateEmailUnreadForCustomer,
  resetEmailUnreadCache,
} from '../api/_lib/email-unread-per-customer.js';

function fakeImapFactory(messages) {
  return function () {
    return {
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      fetch() {
        return (async function* () {
          for (const m of messages) yield m;
        })();
      },
    };
  };
}

function makeMsg({ from, seen = false }) {
  return {
    envelope: { from: [{ address: from }] },
    flags: new Set(seen ? ['\\Seen'] : []),
    uid: Math.floor(Math.random() * 1000000),
  };
}

before(() => {
  process.env.IMAP_HOST = 'imap.example.test';
  process.env.IMAP_PORT = '993';
  process.env.IMAP_PASS_ADMINISTRATIE = 'test-pass';
});

after(() => {
  delete process.env.IMAP_HOST;
  delete process.env.IMAP_PORT;
  delete process.env.IMAP_PASS_ADMINISTRATIE;
});

// ── 1) Basis: invalidate wist alleen die klant ─────────────────────────

test('invalidate: wist alleen doel-klant, andere klanten blijven', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: 'a@x.nl', seen: false }),
    makeMsg({ from: 'a@x.nl', seen: false }),
    makeMsg({ from: 'b@x.nl', seen: false }),
  ]);
  // Vul cache
  await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });

  // Wis alleen klant a
  const wasWiped = invalidateEmailUnreadForCustomer('finance', 'a@x.nl');
  assert.equal(wasWiped, true);

  // Volgende call binnen TTL = nog steeds cache-hit, maar zonder a
  const after = await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  assert.equal(after.cached, true);
  assert.equal(after.unreadByEmail.get('a@x.nl'), undefined, 'a is gewist');
  assert.equal(after.unreadByEmail.get('b@x.nl'), 1, 'b blijft in cache');
});

// ── 2) Case-insensitive ────────────────────────────────────────────────

test('invalidate: case-insensitive op email', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: 'Klant@A.NL', seen: false }),
  ]);
  await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });

  // Invalidate met andere case → moet werken
  const wasWiped = invalidateEmailUnreadForCustomer('finance', 'KLANT@a.nl');
  assert.equal(wasWiped, true);

  const after = await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  assert.equal(after.unreadByEmail.size, 0);
});

// ── 3) Onbekende input → false, no-op ──────────────────────────────────

test('invalidate: onbekende klant → false zonder crash', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: 'exists@x.nl', seen: false }),
  ]);
  await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });

  const wasWiped = invalidateEmailUnreadForCustomer('finance', 'nonexistent@x.nl');
  assert.equal(wasWiped, false);

  // Bestaande entry moet nog steeds staan
  const after = await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  assert.equal(after.unreadByEmail.get('exists@x.nl'), 1);
});

test('invalidate: onbekende module → false, no-op', () => {
  resetEmailUnreadCache();
  const wasWiped = invalidateEmailUnreadForCustomer('non_bestaand', 'a@x.nl');
  assert.equal(wasWiped, false);
});

test('invalidate: lege email/module → false, no-op', () => {
  assert.equal(invalidateEmailUnreadForCustomer('', 'a@x.nl'), false);
  assert.equal(invalidateEmailUnreadForCustomer('finance', ''), false);
  assert.equal(invalidateEmailUnreadForCustomer(null, null), false);
  assert.equal(invalidateEmailUnreadForCustomer(undefined, undefined), false);
});

// ── 4) Granulariteit: 2e call na invalidate blijft cache-hit voor andere klanten ─

test('invalidate: 2e call blijft cache-hit; alleen doel-klant is nul', async () => {
  resetEmailUnreadCache();
  let fetchCount = 0;
  const factory = () => {
    fetchCount++;
    return {
      async connect() {},
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      fetch() {
        return (async function* () {
          yield makeMsg({ from: 'a@x.nl', seen: false });
          yield makeMsg({ from: 'b@x.nl', seen: false });
          yield makeMsg({ from: 'c@x.nl', seen: false });
        })();
      },
    };
  };
  await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  invalidateEmailUnreadForCustomer('finance', 'b@x.nl');
  const after = await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  assert.equal(fetchCount, 1, 'geen 2e IMAP-fetch — cache blijft geldig');
  assert.equal(after.cached, true);
  assert.equal(after.unreadByEmail.get('a@x.nl'), 1);
  assert.equal(after.unreadByEmail.get('b@x.nl'), undefined, 'b gewist');
  assert.equal(after.unreadByEmail.get('c@x.nl'), 1);
});

// ── 5) Cross-module isolatie ───────────────────────────────────────────

test('invalidate: finance-wis raakt onboarding-cache niet', async () => {
  resetEmailUnreadCache();
  process.env.IMAP_PASS_ONBOARDING = 'test-pass';
  const factory = fakeImapFactory([
    makeMsg({ from: 'shared@x.nl', seen: false }),
  ]);
  try {
    await getEmailUnreadByCustomerEmail({ module: 'finance',    imapFlowFactory: factory });
    await getEmailUnreadByCustomerEmail({ module: 'onboarding', imapFlowFactory: factory });
    invalidateEmailUnreadForCustomer('finance', 'shared@x.nl');
    const financeAfter    = await getEmailUnreadByCustomerEmail({ module: 'finance',    imapFlowFactory: factory });
    const onboardingAfter = await getEmailUnreadByCustomerEmail({ module: 'onboarding', imapFlowFactory: factory });
    assert.equal(financeAfter.unreadByEmail.get('shared@x.nl'),    undefined);
    assert.equal(onboardingAfter.unreadByEmail.get('shared@x.nl'), 1, 'onboarding intact');
  } finally {
    delete process.env.IMAP_PASS_ONBOARDING;
  }
});
