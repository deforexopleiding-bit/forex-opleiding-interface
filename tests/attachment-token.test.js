// tests/attachment-token.test.js
//
// /api/email-attachment had geen enkele auth-check: mailbox+uid+index in de
// URL was genoeg om elke bijlage uit elke gekoppelde mailbox te downloaden.
// Een Bearer-header is daar geen oplossing — de links worden geopend via
// <a href download> en window.open(), en zulke browser-navigaties kunnen geen
// header meesturen. Vandaar een kortlevend HMAC-token in de query-string.
//
// Deze test borgt de eigenschappen waar de beveiliging op leunt: binding aan
// (mailbox, uid), verloop, en onvervalsbaarheid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { signAttachmentToken, verifyAttachmentToken } from '../api/_lib/attachment-token.js';

const MAILBOX = 'info@deforexopleiding.nl';
const UID     = '4242';

// ── Happy path ──────────────────────────────────────────────────────────────

test('een vers token valideert voor dezelfde mailbox+uid', () => {
  const { token, expiresAt } = signAttachmentToken({ mailbox: MAILBOX, uid: UID });
  assert.equal(verifyAttachmentToken(token, { mailbox: MAILBOX, uid: UID }).ok, true);
  assert.ok(new Date(expiresAt).getTime() > Date.now(), 'expiresAt moet in de toekomst liggen');
});

test('uid mag als string of number binnenkomen', () => {
  const { token } = signAttachmentToken({ mailbox: MAILBOX, uid: 4242 });
  assert.equal(verifyAttachmentToken(token, { mailbox: MAILBOX, uid: '4242' }).ok, true);
});

// ── Binding aan mailbox + uid ───────────────────────────────────────────────

test('token van mailbox A werkt NIET voor mailbox B', () => {
  const { token } = signAttachmentToken({ mailbox: MAILBOX, uid: UID });
  const r = verifyAttachmentToken(token, { mailbox: 'leads@deforexopleiding.nl', uid: UID });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('token van uid 4242 werkt NIET voor een andere uid', () => {
  const { token } = signAttachmentToken({ mailbox: MAILBOX, uid: UID });
  const r = verifyAttachmentToken(token, { mailbox: MAILBOX, uid: '4243' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

// ── Verloop ─────────────────────────────────────────────────────────────────

test('een verlopen token wordt geweigerd', () => {
  const { token } = signAttachmentToken({ mailbox: MAILBOX, uid: UID, ttlSeconds: -10 });
  const r = verifyAttachmentToken(token, { mailbox: MAILBOX, uid: UID });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('de exp in het token is niet op te hogen zonder de sleutel', () => {
  const { token } = signAttachmentToken({ mailbox: MAILBOX, uid: UID, ttlSeconds: -10 });
  const [versie, exp, sig] = token.split('.');
  const opgehoogd = [versie, String(Number(exp) + 86400), sig].join('.');
  const r = verifyAttachmentToken(opgehoogd, { mailbox: MAILBOX, uid: UID });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

// ── Onzin-invoer ────────────────────────────────────────────────────────────

test('ontbrekend of misvormd token wordt geweigerd', () => {
  assert.equal(verifyAttachmentToken(undefined, { mailbox: MAILBOX, uid: UID }).reason, 'missing');
  assert.equal(verifyAttachmentToken('',        { mailbox: MAILBOX, uid: UID }).reason, 'missing');
  assert.equal(verifyAttachmentToken('rommel',  { mailbox: MAILBOX, uid: UID }).reason, 'malformed');
  assert.equal(verifyAttachmentToken('v1.abc.def', { mailbox: MAILBOX, uid: UID }).reason, 'malformed');
  assert.equal(verifyAttachmentToken('v9.9999999999.xx', { mailbox: MAILBOX, uid: UID }).reason, 'malformed');
});

test('een verzonnen handtekening van de juiste lengte wordt geweigerd', () => {
  const { token } = signAttachmentToken({ mailbox: MAILBOX, uid: UID });
  const [versie, exp, sig] = token.split('.');
  // Zelfde lengte, andere inhoud — dwingt de timingSafeEqual-tak af.
  const nep = Buffer.from(sig, 'base64url');
  nep[0] = nep[0] ^ 0xff;
  const r = verifyAttachmentToken([versie, exp, nep.toString('base64url')].join('.'),
    { mailbox: MAILBOX, uid: UID });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_signature');
});

test('signAttachmentToken eist mailbox en uid', () => {
  assert.throws(() => signAttachmentToken({ mailbox: null, uid: UID }));
  assert.throws(() => signAttachmentToken({ mailbox: MAILBOX, uid: '' }));
});

// ── Wiring ──────────────────────────────────────────────────────────────────

test('email-attachment.js accepteert token OF Bearer en weigert anders met 403', () => {
  const src = readFileSync(new URL('../api/email-attachment.js', import.meta.url), 'utf8');
  assert.ok(src.includes('verifyAttachmentToken'), 'token-check ontbreekt');
  assert.ok(src.includes('requireCrmStaff'),       'Bearer-tak ontbreekt');
  assert.match(src, /status\(403\)/,               '403-tak ontbreekt');

  const handler = src.slice(src.indexOf('export default async function handler'));
  const poort   = handler.indexOf('verifyAttachmentToken');
  const imap    = handler.indexOf('new ImapFlow');
  assert.ok(poort > -1 && imap > -1 && poort < imap, 'auth moet vóór de IMAP-connect staan');
});

test('email-body.js mint een token voor de frontend', () => {
  const src = readFileSync(new URL('../api/email-body.js', import.meta.url), 'utf8');
  assert.ok(src.includes('signAttachmentToken'), 'mint ontbreekt');
  assert.ok(src.includes('attachment_token:'),   'token zit niet in de respons');
});
