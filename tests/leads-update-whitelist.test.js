// tests/leads-update-whitelist.test.js
//
// Bewijst dat de update-endpoint de vastleg-velden (kwalificatie/score/
// drempel/afwijzer/antwoorden) HARD weigert, ook als ze in de body zitten.
// Puur JS, geen Supabase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLeadUpdatePatch, ALLOWED_STATUS } from '../api/_lib/leads-update-whitelist.js';

// ── Happy paths ─────────────────────────────────────────────────────────────

test('lege body → lege patch, geen error', () => {
  const r = buildLeadUpdatePatch({});
  assert.deepEqual(r.patch, {});
  assert.equal(r.error, undefined);
});

test('alleen status: gewonnen → patch { status: "gewonnen" }', () => {
  const r = buildLeadUpdatePatch({ status: 'gewonnen' });
  assert.deepEqual(r.patch, { status: 'gewonnen' });
});

test('alle 4 toegestane statussen', () => {
  for (const s of ['nieuw', 'opgevolgd', 'gewonnen', 'verloren']) {
    const r = buildLeadUpdatePatch({ status: s });
    assert.equal(r.patch.status, s, `status ${s} mag door`);
  }
});

test('notitie leeg = NULL wordt', () => {
  const r = buildLeadUpdatePatch({ notitie: '' });
  assert.equal(r.patch.notitie, null);
});

test('notitie string wordt bewaard (max 10k)', () => {
  const r = buildLeadUpdatePatch({ notitie: 'kort briefje' });
  assert.equal(r.patch.notitie, 'kort briefje');
});

test('notitie > 10000 chars: wordt getruncated', () => {
  const long = 'x'.repeat(12000);
  const r = buildLeadUpdatePatch({ notitie: long });
  assert.equal(r.patch.notitie.length, 10000);
});

test('eigenaar_id UUID wordt bewaard', () => {
  const r = buildLeadUpdatePatch({ eigenaar_id: '11111111-2222-3333-4444-555555555555' });
  assert.equal(r.patch.eigenaar_id, '11111111-2222-3333-4444-555555555555');
});

test('eigenaar_id NULL/leeg wordt NULL (toewijzing weghalen)', () => {
  assert.equal(buildLeadUpdatePatch({ eigenaar_id: null }).patch.eigenaar_id, null);
  assert.equal(buildLeadUpdatePatch({ eigenaar_id: '' }).patch.eigenaar_id, null);
});

// ── HARDE WHITELIST — vastleg-velden ────────────────────────────────────────

test('kwalificatie in body → GEEN patch-veld, komt in rejected', () => {
  const r = buildLeadUpdatePatch({ status: 'opgevolgd', kwalificatie: 'toegang' });
  assert.deepEqual(r.patch, { status: 'opgevolgd' }, 'alleen status komt door');
  assert.ok(r.rejected.includes('kwalificatie'), 'kwalificatie moet in rejected staan');
});

test('score in body → geen patch-veld, in rejected', () => {
  const r = buildLeadUpdatePatch({ score: 999 });
  assert.deepEqual(r.patch, {});
  assert.ok(r.rejected.includes('score'));
});

test('drempel in body → geen patch-veld, in rejected', () => {
  const r = buildLeadUpdatePatch({ drempel: 5 });
  assert.deepEqual(r.patch, {});
  assert.ok(r.rejected.includes('drempel'));
});

test('afwijzer in body → geen patch-veld, in rejected', () => {
  const r = buildLeadUpdatePatch({ afwijzer: false });
  assert.deepEqual(r.patch, {});
  assert.ok(r.rejected.includes('afwijzer'));
});

test('antwoorden (jsonb) in body → geen patch-veld, in rejected', () => {
  const r = buildLeadUpdatePatch({ antwoorden: [{ vraag: 'X', antwoord: 'Y', punten: 5 }] });
  assert.deepEqual(r.patch, {});
  assert.ok(r.rejected.includes('antwoorden'));
});

test('ALLE 5 vastleg-velden tegelijk + toegestaan status → alleen status komt door', () => {
  const r = buildLeadUpdatePatch({
    status: 'gewonnen',
    kwalificatie: 'geen toegang',
    score: 42,
    drempel: 10,
    afwijzer: true,
    antwoorden: [{ vraag: 'hack', antwoord: 'ok', punten: 100 }],
  });
  assert.deepEqual(r.patch, { status: 'gewonnen' });
  assert.deepEqual(
    r.rejected.sort(),
    ['afwijzer', 'antwoorden', 'drempel', 'kwalificatie', 'score']
  );
});

test('bijgewerkt in body → in rejected (trigger doet dat zelf)', () => {
  const r = buildLeadUpdatePatch({ bijgewerkt: '2026-07-28T12:00:00Z' });
  assert.ok(r.rejected.includes('bijgewerkt'));
  assert.deepEqual(r.patch, {});
});

// ── Ongeldige inputs ───────────────────────────────────────────────────────

test('ongeldige status → error, geen patch', () => {
  const r = buildLeadUpdatePatch({ status: 'yolo' });
  assert.match(r.error, /Ongeldige status/);
  assert.deepEqual(r.patch, {});
});

test('status als getal → error', () => {
  const r = buildLeadUpdatePatch({ status: 42 });
  assert.match(r.error, /Ongeldige status/);
});

test('notitie als object → error', () => {
  const r = buildLeadUpdatePatch({ notitie: { hack: 1 } });
  assert.match(r.error, /notitie/);
});

test('eigenaar_id als getal → error', () => {
  const r = buildLeadUpdatePatch({ eigenaar_id: 42 });
  assert.match(r.error, /eigenaar_id/);
});

// ── Defensive ──────────────────────────────────────────────────────────────

test('null body → geen crash', () => {
  const r = buildLeadUpdatePatch(null);
  assert.deepEqual(r.patch, {});
});

test('undefined body → geen crash', () => {
  const r = buildLeadUpdatePatch(undefined);
  assert.deepEqual(r.patch, {});
});

test('array body → geen crash (behandeld als leeg object)', () => {
  const r = buildLeadUpdatePatch([]);
  assert.deepEqual(r.patch, {});
});

test('ALLOWED_STATUS bevat exact 4 waarden', () => {
  assert.equal(ALLOWED_STATUS.size, 4);
  assert.ok(ALLOWED_STATUS.has('nieuw'));
  assert.ok(ALLOWED_STATUS.has('opgevolgd'));
  assert.ok(ALLOWED_STATUS.has('gewonnen'));
  assert.ok(ALLOWED_STATUS.has('verloren'));
});

test('id-veld in body wordt niet als rejected gemarkeerd (endpoint gebruikt em zelf)', () => {
  const r = buildLeadUpdatePatch({ id: 'lead-1', status: 'opgevolgd' });
  assert.ok(!r.rejected.includes('id'), 'id staat op de allowed-keys-lijst');
});
