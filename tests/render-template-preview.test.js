// tests/render-template-preview.test.js
//
// Unit-tests voor de nieuwe render-template-preview helper. Bewijst:
//   1) mapping-scenario: 4-var joost_reminder_2_nl-shape → volledige leesbare
//      tekst met alle placeholders vervangen.
//   2) fallback: template niet gevonden in DB → oude '[template] naam'-label.
//   3) fallback: geen templateName → '[bericht]'.
//   4) placeholder-substitutie edge cases: missing key blijft {{N}} staan,
//      extra key wordt genegeerd, whitespace binnen {{ }} tolerant.
//   5) cache-gedrag: 2e call binnen TTL hit cache (geen 2e DB-fetch).
//
// Geen SUPABASE_URL nodig — helper accepteert een fake supabase-client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderTemplatePreview,
  substituteNumericPlaceholders,
  resetTemplatePreviewCache,
} from '../api/_lib/render-template-preview.js';

// Fake supabase — tracked hoevaak 'ie is aangeroepen (voor cache-test).
function fakeSupabase({ templatesByName = {} } = {}) {
  const calls = { count: 0 };
  const client = {
    from(table) {
      assert.equal(table, 'whatsapp_meta_templates');
      let match = null;
      const chain = {
        select() { return chain; },
        eq(col, val) {
          if (col === 'name' && templatesByName[val]) match = [templatesByName[val]];
          return chain;
        },
        limit() { return chain; },
        then(resolve) {
          calls.count++;
          return Promise.resolve({ data: match || [], error: null }).then(resolve);
        },
      };
      return chain;
    },
    _calls: calls,
  };
  return client;
}

// ── substituteNumericPlaceholders (pure) ──────────────────────────────

test('substituteNumericPlaceholders: basis 4-var subst', () => {
  const body = 'Hoi {{1}}, factuur {{2}} van EUR {{3}}, {{4}} dagen open.';
  const out = substituteNumericPlaceholders(body, {
    '1': 'Alexandre', '2': '2026 / 543', '3': '400,00', '4': '128',
  });
  assert.equal(out, 'Hoi Alexandre, factuur 2026 / 543 van EUR 400,00, 128 dagen open.');
});

test('substituteNumericPlaceholders: tolerant voor whitespace binnen {{ }}', () => {
  const out = substituteNumericPlaceholders('Hoi {{ 1 }}', { '1': 'X' });
  assert.equal(out, 'Hoi X');
});

test('substituteNumericPlaceholders: missende key laat {{N}} letterlijk staan', () => {
  const out = substituteNumericPlaceholders('Hoi {{1}}, jouw {{2}}', { '1': 'A' });
  assert.equal(out, 'Hoi A, jouw {{2}}');
});

test('substituteNumericPlaceholders: extra key wordt genegeerd (geen crash)', () => {
  const out = substituteNumericPlaceholders('Hoi {{1}}', { '1': 'A', '99': 'ONGEBRUIKT' });
  assert.equal(out, 'Hoi A');
});

test('substituteNumericPlaceholders: null-value → lege string', () => {
  const out = substituteNumericPlaceholders('Hoi {{1}} en {{2}}', { '1': null, '2': 'B' });
  assert.equal(out, 'Hoi  en B');
});

test('substituteNumericPlaceholders: non-numeric keys worden overgeslagen', () => {
  // Alleen numerieke keys worden vervangen — 'source' e.d. mogen niet als
  // placeholder gebruikt worden.
  const out = substituteNumericPlaceholders('Hoi {{1}} en {{source}}', {
    '1': 'A', 'source': 'workflow',
  });
  assert.equal(out, 'Hoi A en {{source}}');
});

test('substituteNumericPlaceholders: lege body → lege string (geen crash)', () => {
  assert.equal(substituteNumericPlaceholders('', { '1': 'A' }), '');
  assert.equal(substituteNumericPlaceholders(null, { '1': 'A' }), '');
});

// ── renderTemplatePreview (async, met fake supabase) ──────────────────

test('renderTemplatePreview: mapping-pad — joost_reminder_2_nl scenario', async () => {
  resetTemplatePreviewCache();
  const supabase = fakeSupabase({
    templatesByName: {
      joost_reminder_2_nl: {
        name: 'joost_reminder_2_nl',
        status: 'approved',
        body_text: 'Hoi {{1}}, Ik heb nog geen reactie van je gekregen over factuur {{2}} van EUR {{3}}, inmiddels {{4}} dagen open. Laat je even weten hoe je het wilt oplossen?',
      },
    },
  });
  const out = await renderTemplatePreview({
    templateName: 'joost_reminder_2_nl',
    templateVariables: { '1': 'Alexandre Jansen', '2': '2026 / 543', '3': '400,00', '4': '128' },
    supabase,
  });
  assert.equal(out.source, 'meta_template');
  assert.equal(
    out.body,
    'Hoi Alexandre Jansen, Ik heb nog geen reactie van je gekregen over factuur 2026 / 543 van EUR 400,00, inmiddels 128 dagen open. Laat je even weten hoe je het wilt oplossen?'
  );
});

test('renderTemplatePreview: fallback — template niet gevonden in DB', async () => {
  resetTemplatePreviewCache();
  const supabase = fakeSupabase({ templatesByName: {} });
  const out = await renderTemplatePreview({
    templateName: 'onbekend_template_xyz',
    templateVariables: { '1': 'X' },
    supabase,
  });
  assert.equal(out.source, 'legacy_label');
  assert.equal(out.body, '[template] onbekend_template_xyz');
});

test('renderTemplatePreview: fallback — geen templateName', async () => {
  resetTemplatePreviewCache();
  const supabase = fakeSupabase({});
  const out = await renderTemplatePreview({
    templateName: '',
    templateVariables: { '1': 'X' },
    supabase,
  });
  assert.equal(out.source, 'no_template_name');
  assert.equal(out.body, '[bericht]');
});

test('renderTemplatePreview: fallback — pending template (niet approved) → label', async () => {
  resetTemplatePreviewCache();
  const supabase = fakeSupabase({
    templatesByName: {
      pending_tpl: {
        name: 'pending_tpl',
        status: 'pending',
        body_text: 'Hoi {{1}}',
      },
    },
  });
  const out = await renderTemplatePreview({
    templateName: 'pending_tpl',
    templateVariables: { '1': 'A' },
    supabase,
  });
  assert.equal(out.source, 'legacy_label');
  assert.equal(out.body, '[template] pending_tpl');
});

test('renderTemplatePreview: mapping-pad met lege variables → placeholders blijven staan', async () => {
  resetTemplatePreviewCache();
  const supabase = fakeSupabase({
    templatesByName: {
      naam_only: {
        name: 'naam_only',
        status: 'approved',
        body_text: 'Hoi {{1}}, welkom.',
      },
    },
  });
  const out = await renderTemplatePreview({
    templateName: 'naam_only',
    templateVariables: null,
    supabase,
  });
  assert.equal(out.source, 'meta_template');
  assert.equal(out.body, 'Hoi {{1}}, welkom.');
});

// ── Cache-gedrag ──────────────────────────────────────────────────────

test('cache: 2e call binnen TTL doet GEEN 2e DB-fetch', async () => {
  resetTemplatePreviewCache();
  const supabase = fakeSupabase({
    templatesByName: {
      cached_tpl: { name: 'cached_tpl', status: 'approved', body_text: 'Hoi {{1}}' },
    },
  });
  await renderTemplatePreview({
    templateName: 'cached_tpl',
    templateVariables: { '1': 'A' },
    supabase,
  });
  await renderTemplatePreview({
    templateName: 'cached_tpl',
    templateVariables: { '1': 'B' },
    supabase,
  });
  assert.equal(supabase._calls.count, 1, 'tweede call moet cache-hit zijn');
});

test('cache: resetTemplatePreviewCache forceert opnieuw fetchen', async () => {
  resetTemplatePreviewCache();
  const supabase = fakeSupabase({
    templatesByName: {
      cached_tpl: { name: 'cached_tpl', status: 'approved', body_text: 'Hoi {{1}}' },
    },
  });
  await renderTemplatePreview({
    templateName: 'cached_tpl', templateVariables: { '1': 'A' }, supabase,
  });
  resetTemplatePreviewCache();
  await renderTemplatePreview({
    templateName: 'cached_tpl', templateVariables: { '1': 'B' }, supabase,
  });
  assert.equal(supabase._calls.count, 2, 'na reset moet 2e call opnieuw fetchen');
});

// ── Fail-safe ─────────────────────────────────────────────────────────

test('renderTemplatePreview: supabase-fout → graceful fallback naar label', async () => {
  resetTemplatePreviewCache();
  const brokenSupabase = {
    from() {
      const chain = {
        select() { return chain; },
        eq() { return chain; },
        limit() { return chain; },
        then(resolve) {
          return Promise.resolve({ data: null, error: { message: 'PG connection lost' } }).then(resolve);
        },
      };
      return chain;
    },
  };
  const out = await renderTemplatePreview({
    templateName: 'anything',
    templateVariables: { '1': 'X' },
    supabase: brokenSupabase,
  });
  assert.equal(out.source, 'legacy_label');
  assert.equal(out.body, '[template] anything');
});

test('renderTemplatePreview: geen supabase → graceful fallback naar label', async () => {
  resetTemplatePreviewCache();
  const out = await renderTemplatePreview({
    templateName: 'anything',
    templateVariables: { '1': 'X' },
    supabase: null,
  });
  assert.equal(out.source, 'legacy_label');
  assert.equal(out.body, '[template] anything');
});
