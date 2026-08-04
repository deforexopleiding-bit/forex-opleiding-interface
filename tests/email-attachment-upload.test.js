// tests/email-attachment-upload.test.js
//
// Unit-tests voor api/_lib/email-attachment-upload.js. Focus op:
//   * safeName + extFromMime (pure helpers, geen supabase-dep)
//   * uploadEmailAttachments met een gemockte supabaseAdmin.storage
//     - size-cap
//     - deadline-guard
//     - HARD_MAX_ATTACHMENTS
//     - fail-soft per attachment
//     - lege input → lege output
//     - happy path (2 bijlagen, beide OK)
//
// KRITIEK — de helper importeert `supabaseAdmin` op module-load. Voor tests
// zonder echte Supabase-config: process.env.SUPABASE_URL + KEY vullen met
// dummy waarden VOORDAT we importeren. supabaseAdmin.storage wordt gemockt
// via monkey-patching op de export.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// Env-stub voor supabase-init (nodig omdat api/supabase.js op module-load
// een createClient() aanroept; @supabase/supabase-js throwt bij lege key).
process.env.SUPABASE_URL              = process.env.SUPABASE_URL              || 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY         || 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

// Import ná env-stub.
const { uploadEmailAttachments, _internals } =
  await import('../api/_lib/email-attachment-upload.js');
const { extFromMime, safeName, HARD_MAX_ATTACHMENTS, DEFAULT_MAX_SIZE } = _internals;

// Ga supabaseAdmin.storage mocken door de import-chain. Simpelste manier:
// monkey-patch supabaseAdmin.storage in de shared supabase-module. Alle
// helpers die eruit importeren zien de mock.
const supabaseModule = await import('../api/supabase.js');
function mockStorage({ uploadResult, publicUrl }) {
  supabaseModule.supabaseAdmin.storage = {
    from(bucket) {
      return {
        async upload(path, buf, opts) {
          if (typeof uploadResult === 'function') return uploadResult({ path, buf, opts, bucket });
          return uploadResult ?? { error: null };
        },
        getPublicUrl(path) {
          if (typeof publicUrl === 'function') return { data: { publicUrl: publicUrl(path) } };
          return { data: { publicUrl: publicUrl ?? `https://example/${bucket}/${path}` } };
        },
      };
    },
  };
}

// ── Pure helpers ────────────────────────────────────────────────────

test('extFromMime: bekende typen', () => {
  assert.equal(extFromMime('application/pdf'), 'pdf');
  assert.equal(extFromMime('image/jpeg'), 'jpg');
  assert.equal(extFromMime('image/png'), 'png');
  assert.equal(extFromMime('APPLICATION/PDF'), 'pdf', 'case-insensitive');
});
test('extFromMime: image/audio/video prefix-fallback', () => {
  assert.equal(extFromMime('image/heif'), 'heif');
  assert.equal(extFromMime('audio/flac'), 'flac');
});
test('extFromMime: null/onbekend → bin', () => {
  assert.equal(extFromMime(null), 'bin');
  assert.equal(extFromMime('exotic/format'), 'bin');
});

test('safeName: strips onveilige tekens', () => {
  assert.equal(safeName('bewijs betaling.pdf'), 'bewijs_betaling.pdf');
  assert.equal(safeName('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeName('naam met spatie.txt'), 'naam_met_spatie.txt');
});
test('safeName: cap 80 chars', () => {
  const long = 'a'.repeat(200) + '.pdf';
  assert.equal(safeName(long).length, 80);
});
test('safeName: null/undefined → "file"', () => {
  assert.equal(safeName(null), 'file');
  assert.equal(safeName(undefined), 'file');
});

// ── uploadEmailAttachments ─────────────────────────────────────────

function makeAtt({ filename = 'test.pdf', contentType = 'application/pdf', size = 100 } = {}) {
  return {
    filename,
    contentType,
    size,
    content: Buffer.alloc(size, 0xAB),
  };
}

test('upload: lege input → lege rows', async () => {
  mockStorage({});
  const out = await uploadEmailAttachments([], { mailbox: 'administratie', imapUid: 1 });
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.warnings, []);
});

test('upload: mailbox/uid missing → warning + lege rows', async () => {
  mockStorage({});
  const out = await uploadEmailAttachments([makeAtt()], { imapUid: 1 }); // geen mailbox
  assert.equal(out.rows.length, 0);
  assert.ok(out.warnings[0].includes('mailbox+imapUid vereist'));
});

test('upload: happy path — 2 bijlagen, beide OK', async () => {
  mockStorage({
    uploadResult: { error: null },
    publicUrl: (path) => `https://cdn.test/${path}`,
  });
  const atts = [makeAtt({ filename: 'a.pdf' }), makeAtt({ filename: 'b.png', contentType: 'image/png' })];
  const out = await uploadEmailAttachments(atts, { mailbox: 'administratie', imapUid: 42 });
  assert.equal(out.rows.length, 2);
  assert.equal(out.rows[0].filename, 'a.pdf');
  assert.equal(out.rows[0].mime_type, 'application/pdf');
  assert.equal(out.rows[0].size_bytes, 100);
  assert.match(out.rows[0].path, /inbound\/administratie\/\d{4}\/\d{2}\/42-0-[a-f0-9]{8}\.pdf$/);
  assert.match(out.rows[0].public_url, /^https:\/\/cdn\.test\//);
  assert.equal(out.rows[1].mime_type, 'image/png');
  assert.match(out.rows[1].path, /inbound\/administratie\/\d{4}\/\d{2}\/42-1-[a-f0-9]{8}\.png$/);
  assert.equal(out.warnings.length, 0);
});

test('upload: size > maxSize → skipped met warning', async () => {
  mockStorage({ uploadResult: { error: null }, publicUrl: 'https://x/' });
  const big = makeAtt({ filename: 'big.pdf', size: 5 * 1024 * 1024 });
  const out = await uploadEmailAttachments([big], {
    mailbox: 'administratie', imapUid: 1, maxSize: 1024 * 1024, // 1MB cap
  });
  assert.equal(out.rows.length, 0);
  assert.ok(out.warnings[0].includes('skipped'));
});

test('upload: 0-byte attachment → skipped', async () => {
  mockStorage({ uploadResult: { error: null }, publicUrl: 'https://x/' });
  const empty = { filename: 'x', contentType: 'text/plain', content: Buffer.alloc(0) };
  const out = await uploadEmailAttachments([empty], { mailbox: 'administratie', imapUid: 1 });
  assert.equal(out.rows.length, 0);
  assert.ok(out.warnings[0].includes('0 bytes'));
});

test('upload: geen buffer content → skipped', async () => {
  mockStorage({ uploadResult: { error: null }, publicUrl: 'https://x/' });
  const bad = { filename: 'x', contentType: 'text/plain', content: null };
  const out = await uploadEmailAttachments([bad], { mailbox: 'administratie', imapUid: 1 });
  assert.equal(out.rows.length, 0);
  assert.ok(out.warnings[0].includes('geen buffer'));
});

test('upload: HARD_MAX_ATTACHMENTS cap', async () => {
  mockStorage({ uploadResult: { error: null }, publicUrl: 'https://x/' });
  const many = Array.from({ length: HARD_MAX_ATTACHMENTS + 5 }, () => makeAtt());
  const out = await uploadEmailAttachments(many, { mailbox: 'administratie', imapUid: 1 });
  assert.equal(out.rows.length, HARD_MAX_ATTACHMENTS);
  assert.ok(out.warnings.some((w) => w.includes(`limited to ${HARD_MAX_ATTACHMENTS}`)));
});

test('upload: deadline reached → skip rest met warning', async () => {
  mockStorage({ uploadResult: { error: null }, publicUrl: 'https://x/' });
  const atts = [makeAtt({ filename: 'a.pdf' }), makeAtt({ filename: 'b.pdf' })];
  // Deadline reeds in het verleden — helper moet immediately skippen.
  const out = await uploadEmailAttachments(atts, {
    mailbox: 'administratie', imapUid: 1, deadlineMs: Date.now() - 1000,
  });
  assert.equal(out.rows.length, 0);
  assert.ok(out.warnings.some((w) => w.includes('deadline reached')));
});

test('upload: supabase upload-error → fail-soft, andere gaan door', async () => {
  let call = 0;
  mockStorage({
    uploadResult: () => {
      call++;
      if (call === 1) return { error: { message: 'bucket vol' } };
      return { error: null };
    },
    publicUrl: 'https://cdn/x',
  });
  const atts = [makeAtt({ filename: 'a.pdf' }), makeAtt({ filename: 'b.pdf' })];
  const out = await uploadEmailAttachments(atts, { mailbox: 'administratie', imapUid: 1 });
  assert.equal(out.rows.length, 1, 'tweede attachment moet slagen');
  assert.equal(out.rows[0].filename, 'b.pdf');
  assert.ok(out.warnings[0].includes('bucket vol'));
});

test('upload: publicUrl leeg → warning + skip', async () => {
  mockStorage({ uploadResult: { error: null }, publicUrl: () => null });
  const out = await uploadEmailAttachments([makeAtt()], { mailbox: 'administratie', imapUid: 1 });
  assert.equal(out.rows.length, 0);
  assert.ok(out.warnings[0].includes('getPublicUrl leverde niks'));
});

test('upload: default DEFAULT_MAX_SIZE is 10MB', () => {
  assert.equal(DEFAULT_MAX_SIZE, 10 * 1024 * 1024);
});
