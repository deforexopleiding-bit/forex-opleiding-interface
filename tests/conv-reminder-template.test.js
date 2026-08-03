// tests/conv-reminder-template.test.js
//
// Unit-tests voor de nieuwe reminder-template-resolver (GAT 5 / Bug 2 fix).
// Bewijst dat de cron nu de whatsapp_meta_templates.meta_param_mapping.body
// respecteert i.p.v. blind 5 hardcoded params te sturen.
//
// Drie scenarios:
//   1. MAPPING pad — template gevonden + 4-param mapping → components-array
//      met 4 body-parameters, in de mapping-volgorde. Voorkomt 132001-mismatch.
//   2. FALLBACK pad — template NIET gevonden → legacy 5-positional variables
//      (backward-compat, voorkomt regressie op deployments zonder DB-registratie).
//   3. MAPPING pad met 5-param template (backward-compat mapping die identiek
//      aan legacy uitkomt).
//
// Geen supabase-init: we injecteren een fake supabase-client via de opts-hook
// in buildReminderTemplatePayload({supabase}). resolveVariableValue uit
// template-variables.js draait wel echt — die is pure JS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReminderTemplatePayload,
  buildLegacyPositionalVariables,
  resetReminderTemplateCache,
} from '../api/_lib/conv-reminder-template.js';

// ── Fake supabase-client die alleen .from().select().eq().limit() ondersteunt.
// Retourneert `rows` uit een lookup-tabel per template-naam.
function fakeSupabase({ templatesByName = {} } = {}) {
  return {
    from(table) {
      assert.equal(table, 'whatsapp_meta_templates', 'alleen deze tabel wordt bevraagd');
      let where = null;
      const chain = {
        select() { return chain; },
        eq(col, val) { where = { col, val }; return chain; },
        limit() { return chain; },
        then(resolve) {
          const rows = where && templatesByName[where.val] ? templatesByName[where.val] : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

const CUSTOMER = {
  id: 'cust-1',
  first_name: 'Ingrid',
  last_name:  'Van Den Eede',
  company_name: null,
  is_company: false,
  email: 'ingrid@example.nl',
  phone: '+31612345678',
};

const INVOICE = {
  id: 'inv-1',
  invoice_number: '2024-0512',
  amount_total: 320,
  amount_paid:  0,
  credited_amount: 0,
  due_date: '2026-07-15',
  issue_date: '2026-06-15',
  status: 'open',
};

const CTX = {
  customer: CUSTOMER,
  openInvoices: [INVOICE],
  invoice: INVOICE,
};

const LEGACY_VARS = {
  NAAM:          'Ingrid Van Den Eede',
  FACTUUR_NR:    '2024-0512',
  TOTAAL_BEDRAG: 'EUR 320,00',
  DAGEN_OVERDUE: '19',
  VERVAL_DATUM:  '15-07-2026',
};

// ── Scenario 1: MAPPING pad (joost_reminder_2_nl — 4 params) ─────────

test('mapping-pad: 4-param template levert 4 body-parameters op (voorkomt 132001)', async () => {
  resetReminderTemplateCache();
  const supabase = fakeSupabase({
    templatesByName: {
      joost_reminder_2_nl: [{
        name: 'joost_reminder_2_nl',
        language: 'nl',
        status: 'approved',
        body_text: 'Hoi {{1}}, factuur {{2}} van EUR {{3}}, {{4}} dagen open.',
        header_type: 'NONE',
        meta_param_mapping: {
          body: {
            '1': 'klant.voornaam',
            '2': 'factuur.nummer',
            '3': 'factuur.bedrag',
            '4': 'factuur.dagen_overdue',
          },
        },
        buttons: null,
      }],
    },
  });
  const payload = await buildReminderTemplatePayload({
    templateName: 'joost_reminder_2_nl',
    ctx: CTX,
    legacyVars: LEGACY_VARS,
    supabase,
  });
  assert.equal(payload.mode, 'mapping');
  assert.equal(payload.variables, null, 'mapping-mode gebruikt components, niet variables');
  assert.ok(Array.isArray(payload.components), 'components moet array zijn');
  const body = payload.components.find((c) => c.type === 'body');
  assert.ok(body, 'moet een body-component hebben');
  assert.equal(body.parameters.length, 4, 'exact 4 body-parameters (matcht template)');
  // Voornaam-only (niet volledige naam).
  assert.equal(body.parameters[0].text, 'Ingrid');
  assert.equal(body.parameters[1].text, '2024-0512');
  // KAAL bedrag zonder EUR-prefix (voorkomt "EUR EUR 320,00"-drift).
  assert.equal(body.parameters[2].text, '320,00');
  assert.ok(!/EUR/i.test(body.parameters[2].text), 'geen EUR-prefix in positie 3');
  // dagen_overdue moet numeric-string zijn.
  assert.match(body.parameters[3].text, /^\d+$/);
  // usedVariables voor persist in whatsapp_messages.template_variables.
  assert.deepEqual(Object.keys(payload.usedVariables).sort(), ['1', '2', '3', '4']);
});

// ── Scenario 2: FALLBACK pad (template niet in DB) ───────────────────

test('fallback-pad: template niet gevonden → legacy 5-positional variables', async () => {
  resetReminderTemplateCache();
  const supabase = fakeSupabase({ templatesByName: {} });
  const payload = await buildReminderTemplatePayload({
    templateName: 'onbekend_template_xyz',
    ctx: CTX,
    legacyVars: LEGACY_VARS,
    supabase,
  });
  assert.equal(payload.mode, 'legacy');
  assert.equal(payload.components, null, 'legacy-mode gebruikt variables, niet components');
  assert.deepEqual(payload.variables, [
    'Ingrid Van Den Eede',
    '2024-0512',
    'EUR 320,00',
    '19',
    '15-07-2026',
  ], 'exact 5 params in vaste NAAM/FACTUUR/TOTAAL/DAGEN/VERVAL-volgorde');
  assert.deepEqual(Object.keys(payload.usedVariables).sort(),
    ['1', '2', '3', '4', '5']);
  assert.ok(payload.warnings.some((w) => /niet gevonden/i.test(w)),
    'moet warning bevatten dat template niet gevonden is');
});

// ── Scenario 3: MAPPING pad met 5 keys (backward-compat) ─────────────

test('mapping-pad: 5-key template werkt óók (backward-compat pattern)', async () => {
  resetReminderTemplateCache();
  const supabase = fakeSupabase({
    templatesByName: {
      legacy_5param_tpl: [{
        name: 'legacy_5param_tpl',
        language: 'nl',
        status: 'approved',
        body_text: 'Hoi {{1}}, factuur {{2}}, totaal {{3}}, {{4}} dagen te laat sinds {{5}}',
        header_type: 'NONE',
        meta_param_mapping: {
          body: {
            '1': 'klant.naam',
            '2': 'factuur.nummer',
            '3': 'klant.totaal_open',
            '4': 'factuur.dagen_overdue',
            '5': 'factuur.vervaldatum',
          },
        },
        buttons: null,
      }],
    },
  });
  const payload = await buildReminderTemplatePayload({
    templateName: 'legacy_5param_tpl',
    ctx: CTX,
    legacyVars: LEGACY_VARS,
    supabase,
  });
  assert.equal(payload.mode, 'mapping');
  const body = payload.components.find((c) => c.type === 'body');
  assert.equal(body.parameters.length, 5, '5 body-parameters bij 5-key mapping');
  assert.equal(body.parameters[0].text, 'Ingrid Van Den Eede'); // klant.naam = full
});

// ── Scenario 4: template gevonden maar niet approved → fallback ──────

test('template gevonden maar status!=approved → legacy fallback + warning', async () => {
  resetReminderTemplateCache();
  const supabase = fakeSupabase({
    templatesByName: {
      pending_tpl: [{
        name: 'pending_tpl',
        language: 'nl',
        status: 'pending',
        body_text: 'x',
        header_type: 'NONE',
        meta_param_mapping: { body: { '1': 'klant.naam' } },
      }],
    },
  });
  const payload = await buildReminderTemplatePayload({
    templateName: 'pending_tpl',
    ctx: CTX,
    legacyVars: LEGACY_VARS,
    supabase,
  });
  assert.equal(payload.mode, 'legacy');
  assert.ok(payload.warnings.some((w) => /niet approved/i.test(w)));
});

// ── Scenario 5: template zonder mapping.body → fallback ──────────────

test('template zonder meta_param_mapping.body → legacy fallback', async () => {
  resetReminderTemplateCache();
  const supabase = fakeSupabase({
    templatesByName: {
      no_mapping_tpl: [{
        name: 'no_mapping_tpl',
        language: 'nl',
        status: 'approved',
        body_text: 'static template',
        header_type: 'NONE',
        meta_param_mapping: null,
      }],
    },
  });
  const payload = await buildReminderTemplatePayload({
    templateName: 'no_mapping_tpl',
    ctx: CTX,
    legacyVars: LEGACY_VARS,
    supabase,
  });
  assert.equal(payload.mode, 'legacy');
  assert.ok(payload.warnings.some((w) => /geen meta_param_mapping\.body/i.test(w)));
});

// ── Helper-test: buildLegacyPositionalVariables volgorde is contract ─

test('buildLegacyPositionalVariables: vaste 5-key volgorde', () => {
  const out = buildLegacyPositionalVariables(LEGACY_VARS);
  assert.deepEqual(out, [
    'Ingrid Van Den Eede', // NAAM
    '2024-0512',           // FACTUUR_NR
    'EUR 320,00',          // TOTAAL_BEDRAG
    '19',                  // DAGEN_OVERDUE
    '15-07-2026',          // VERVAL_DATUM
  ]);
});

test('buildLegacyPositionalVariables: ontbrekende keys → lege strings (5 lengte)', () => {
  const out = buildLegacyPositionalVariables({});
  assert.equal(out.length, 5);
  assert.ok(out.every((v) => v === ''));
});
