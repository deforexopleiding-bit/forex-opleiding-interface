// tests/email-unread-per-customer.test.js
//
// Unit-tests voor de nieuwe email-unread-per-customer helper. Bewijst:
//   1) IMAP-fetch telt alleen mails zonder \Seen-flag per from_address
//   2) Case-insensitive match op email-adressen
//   3) filterEmails beperkt Map tot alleen de gevraagde adressen
//   4) Cache-gedrag: 2e call binnen TTL is cache-hit
//   5) resetEmailUnreadCache forceert nieuwe fetch
//   6) Onbekende module → warning + lege Map (geen throw)
//   7) Missende IMAP_HOST → warning + lege Map
//   8) IMAP-fout tijdens fetch → warning + lege Map (geen throw)
//
// IMAP wordt gemocked via imapFlowFactory-injectie. Geen SUPABASE_URL of
// echt IMAP-endpoint nodig.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  getEmailUnreadByCustomerEmail,
  resetEmailUnreadCache,
} from '../api/_lib/email-unread-per-customer.js';

// Fake IMAP-flow: krijgt een lijst messages, simuleert de imapflow-API.
function fakeImapFactory(messages, opts = {}) {
  return function () {
    return {
      async connect() { if (opts.throwOnConnect) throw new Error(opts.throwOnConnect); },
      async logout() {},
      async getMailboxLock() { return { release() {} }; },
      fetch() {
        // AsyncIterable over messages
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

// Env vars die de helper nodig heeft. Setten voor de test-run.
before(() => {
  process.env.IMAP_HOST = 'imap.example.test';
  process.env.IMAP_PORT = '993';
  process.env.IMAP_PASS_ADMINISTRATIE = 'test-pass';
  process.env.IMAP_PASS_ONBOARDING    = 'test-pass';
  process.env.IMAP_PASS_EVENTS        = 'test-pass';
});

after(() => {
  // Cleanup — laat andere tests in dezelfde process niet in de war raken.
  delete process.env.IMAP_HOST;
  delete process.env.IMAP_PORT;
  delete process.env.IMAP_PASS_ADMINISTRATIE;
  delete process.env.IMAP_PASS_ONBOARDING;
  delete process.env.IMAP_PASS_EVENTS;
});

// ── 1) Basis: tel alleen ongelezen per from ────────────────────────────

test('unread-count: 3 mails van klant, 2 ongelezen, 1 gelezen → 2', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: 'klant@a.nl', seen: false }),
    makeMsg({ from: 'klant@a.nl', seen: false }),
    makeMsg({ from: 'klant@a.nl', seen: true }),  // gelezen — telt niet
  ]);
  const { unreadByEmail } = await getEmailUnreadByCustomerEmail({
    module: 'finance',
    imapFlowFactory: factory,
  });
  assert.equal(unreadByEmail.get('klant@a.nl'), 2);
});

test('unread-count: meerdere klanten, correcte aggregatie per adres', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: 'a@x.nl', seen: false }),
    makeMsg({ from: 'a@x.nl', seen: false }),
    makeMsg({ from: 'b@x.nl', seen: false }),
    makeMsg({ from: 'c@x.nl', seen: true }),      // gelezen
  ]);
  const { unreadByEmail } = await getEmailUnreadByCustomerEmail({
    module: 'finance',
    imapFlowFactory: factory,
  });
  assert.equal(unreadByEmail.get('a@x.nl'), 2);
  assert.equal(unreadByEmail.get('b@x.nl'), 1);
  assert.equal(unreadByEmail.get('c@x.nl'), undefined, 'gelezen mails niet in Map');
});

test('geen from-adres in envelope → skip zonder crash', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: '', seen: false }),
    makeMsg({ from: 'ok@x.nl', seen: false }),
  ]);
  const { unreadByEmail } = await getEmailUnreadByCustomerEmail({
    module: 'finance',
    imapFlowFactory: factory,
  });
  assert.equal(unreadByEmail.size, 1);
  assert.equal(unreadByEmail.get('ok@x.nl'), 1);
});

// ── 2) Case-insensitive match ──────────────────────────────────────────

test('case-insensitive: Klant@A.NL wordt gematcht met klant@a.nl-filter', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: 'Klant@A.NL', seen: false }),
  ]);
  const { unreadByEmail } = await getEmailUnreadByCustomerEmail({
    module: 'finance',
    filterEmails: ['klant@a.nl'],
    imapFlowFactory: factory,
  });
  assert.equal(unreadByEmail.get('klant@a.nl'), 1);
});

// ── 3) filterEmails beperkt Map ────────────────────────────────────────

test('filterEmails: alleen gevraagde adressen komen in de Map', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: 'wel@x.nl', seen: false }),
    makeMsg({ from: 'niet@x.nl', seen: false }),
  ]);
  const { unreadByEmail } = await getEmailUnreadByCustomerEmail({
    module: 'finance',
    filterEmails: ['wel@x.nl'],
    imapFlowFactory: factory,
  });
  assert.equal(unreadByEmail.get('wel@x.nl'), 1);
  assert.equal(unreadByEmail.has('niet@x.nl'), false);
});

test('lege filterEmails-array: geen filter (alles komt door)', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([
    makeMsg({ from: 'a@x.nl', seen: false }),
  ]);
  const { unreadByEmail } = await getEmailUnreadByCustomerEmail({
    module: 'finance',
    filterEmails: [],
    imapFlowFactory: factory,
  });
  assert.equal(unreadByEmail.get('a@x.nl'), 1);
});

// ── 4) Cache-gedrag ────────────────────────────────────────────────────

test('cache: 2e call binnen TTL doet GEEN 2e IMAP-fetch', async () => {
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
          yield makeMsg({ from: 'cached@x.nl', seen: false });
        })();
      },
    };
  };
  await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  const second = await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  assert.equal(fetchCount, 1, '2e call moet cache-hit zijn');
  assert.equal(second.cached, true);
  assert.equal(second.unreadByEmail.get('cached@x.nl'), 1);
});

test('cache: resetEmailUnreadCache forceert opnieuw fetchen', async () => {
  resetEmailUnreadCache();
  let fetchCount = 0;
  const factory = () => {
    fetchCount++;
    return {
      async connect() {}, async logout() {},
      async getMailboxLock() { return { release() {} }; },
      fetch() {
        return (async function* () {
          yield makeMsg({ from: 'x@x.nl', seen: false });
        })();
      },
    };
  };
  await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  resetEmailUnreadCache();
  await getEmailUnreadByCustomerEmail({ module: 'finance', imapFlowFactory: factory });
  assert.equal(fetchCount, 2);
});

test('cache: verschillende modules cachen apart', async () => {
  resetEmailUnreadCache();
  let fetchCount = 0;
  const factory = () => {
    fetchCount++;
    return {
      async connect() {}, async logout() {},
      async getMailboxLock() { return { release() {} }; },
      fetch() {
        return (async function* () {
          yield makeMsg({ from: 'a@x.nl', seen: false });
        })();
      },
    };
  };
  await getEmailUnreadByCustomerEmail({ module: 'finance',    imapFlowFactory: factory });
  await getEmailUnreadByCustomerEmail({ module: 'onboarding', imapFlowFactory: factory });
  assert.equal(fetchCount, 2, 'elk module = eigen cache-key');
});

// ── 5) Fail-safe ───────────────────────────────────────────────────────

test('onbekende module → warning + lege Map', async () => {
  resetEmailUnreadCache();
  const result = await getEmailUnreadByCustomerEmail({
    module: 'ondoenlijk',
    imapFlowFactory: fakeImapFactory([]),
  });
  assert.equal(result.unreadByEmail.size, 0);
  assert.match(result.warning || '', /onbekende module/);
});

test('IMAP-connect fout → warning + lege Map', async () => {
  resetEmailUnreadCache();
  const factory = fakeImapFactory([], { throwOnConnect: 'ECONNREFUSED' });
  const result = await getEmailUnreadByCustomerEmail({
    module: 'finance',
    imapFlowFactory: factory,
  });
  assert.equal(result.unreadByEmail.size, 0);
  assert.match(result.warning || '', /IMAP-fout/);
});

test('missende env var → warning + lege Map', async () => {
  resetEmailUnreadCache();
  const savedPass = process.env.IMAP_PASS_ADMINISTRATIE;
  delete process.env.IMAP_PASS_ADMINISTRATIE;
  try {
    const result = await getEmailUnreadByCustomerEmail({
      module: 'finance',
      imapFlowFactory: fakeImapFactory([]),
    });
    assert.equal(result.unreadByEmail.size, 0);
    assert.match(result.warning || '', /IMAP_PASS_ADMINISTRATIE/);
  } finally {
    process.env.IMAP_PASS_ADMINISTRATIE = savedPass;
  }
});

test('missende IMAP_HOST → warning + lege Map', async () => {
  resetEmailUnreadCache();
  const savedHost = process.env.IMAP_HOST;
  delete process.env.IMAP_HOST;
  try {
    const result = await getEmailUnreadByCustomerEmail({
      module: 'finance',
      imapFlowFactory: fakeImapFactory([]),
    });
    assert.equal(result.unreadByEmail.size, 0);
    assert.match(result.warning || '', /IMAP_HOST/);
  } finally {
    process.env.IMAP_HOST = savedHost;
  }
});
