// tests/conv-reminder-no-reply-template.test.js
//
// Punt B van de no-reply-opdracht: reminder 1 krijgt een eigen, NEUTRALE
// Meta-template (`opvolging_geen_reactie`) achter een optionele config-sleutel.
//
// Wat hier vastligt:
//   1. De R1-tekst is neutraal — geen bedrag, geen factuurnummer, geen
//      vervaldatum, geen ondertekening met een persoonsnaam.
//   2. De aanhef valt netjes terug (voornaam → volledige naam → 'daar'), zodat
//      er nooit "Hey ," uitgaat.
//   3. De template-keuze: r1 gebruikt reminder_1_template_name als die gezet
//      is, en valt anders terug op reminder_2_template_name (= gedrag van vóór
//      deze branch, dus niets gaat vanzelf live). r2 gebruikt altijd de
//      R2-template.
//   4. emptyFallback vult lege body-parameters, want Meta weigert een lege
//      parameter — een klant zonder first_name zou de send anders laten falen.
//
// Zie docs/whatsapp-template-opvolging-geen-reactie.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReminder1Text,
  resolveReminderTemplateName,
} from '../api/cron-dunning-conversation-reminders.js';
import {
  buildReminderTemplatePayload,
  resetReminderTemplateCache,
} from '../api/_lib/conv-reminder-template.js';

// ── 1. Neutrale tekst ────────────────────────────────────────────────

test('R1-tekst bevat geen bedrag, factuurnummer of vervaldatum', () => {
  const txt = buildReminder1Text({ voornaam: 'Nanida', naam: 'Nanida Van Veen' });
  assert.ok(!/\d/.test(txt), 'geen enkel cijfer in de tekst: ' + txt);
  assert.ok(!/EUR|€/i.test(txt), 'geen bedrag');
  assert.ok(!/dagen te laat|vervald/i.test(txt), 'geen vervaldatum/achterstand');
});

test('R1-tekst noemt de openstaande factuur wél (UTILITY-grond), zonder cijfers', () => {
  // Beslissing Maxim: de bijzin blijft staan omdat de transactieverwijzing is
  // wat de Meta-template op UTILITY houdt. Zonder cijfers, dus geen
  // bedragen-bericht. Zelfde strekking als de template opvolging_geen_reactie.
  const txt = buildReminder1Text({ voornaam: 'Nanida' });
  assert.ok(/openstaande factuur/i.test(txt), txt);
  assert.ok(!/\d/.test(txt), 'nog steeds geen cijfers');
});

test('R1-tekst is niet ondertekend met een persoonsnaam', () => {
  const txt = buildReminder1Text({ voornaam: 'Nanida' });
  assert.ok(!/Joost/i.test(txt), 'geen "Joost"');
  assert.ok(!/Groet,/i.test(txt), 'geen ondertekenblok');
  assert.ok(!/De Forex Opleiding/i.test(txt), 'geen bedrijfsondertekening');
});

test('R1-tekst gebruikt de voornaam in de aanhef', () => {
  const txt = buildReminder1Text({ voornaam: 'Nanida', naam: 'Nanida Van Veen' });
  assert.ok(txt.startsWith('Hey Nanida,'), txt);
  assert.ok(/nog geen reactie van je ontvangen/.test(txt));
});

test('R1-tekst valt terug op de volledige naam als voornaam ontbreekt', () => {
  const txt = buildReminder1Text({ voornaam: '', naam: 'Handelsonderneming Veys' });
  assert.ok(txt.startsWith('Hey Handelsonderneming Veys,'), txt);
});

test('R1-tekst valt terug op "daar" als er helemaal geen naam is', () => {
  assert.ok(buildReminder1Text({}).startsWith('Hey daar,'));
  assert.ok(buildReminder1Text().startsWith('Hey daar,'));
  assert.ok(buildReminder1Text({ voornaam: '   ', naam: '  ' }).startsWith('Hey daar,'));
});

// ── 2. Template-keuze ────────────────────────────────────────────────

test('r1 zonder reminder_1_template_name valt terug op de R2-template (huidig gedrag)', () => {
  const cfg = { reminder_2_template_name: 'joost_reminder_2_nl' };
  const r = resolveReminderTemplateName('r1', cfg);
  assert.equal(r.name, 'joost_reminder_2_nl');
  assert.equal(r.isR1Template, false, 'geen eigen R1-template → geen R1-specifiek gedrag');
});

test('r1 met reminder_1_template_name gebruikt de neutrale opvolg-template', () => {
  const cfg = {
    reminder_1_template_name: 'opvolging_geen_reactie',
    reminder_2_template_name: 'joost_reminder_2_nl',
  };
  const r = resolveReminderTemplateName('r1', cfg);
  assert.equal(r.name, 'opvolging_geen_reactie');
  assert.equal(r.isR1Template, true);
});

test('r2 gebruikt altijd de R2-template, ook als de R1-template gezet is', () => {
  const cfg = {
    reminder_1_template_name: 'opvolging_geen_reactie',
    reminder_2_template_name: 'joost_reminder_2_nl',
  };
  const r = resolveReminderTemplateName('r2', cfg);
  assert.equal(r.name, 'joost_reminder_2_nl');
  assert.equal(r.isR1Template, false);
});

test('lege config levert geen template-naam op (cron skipt met NO_TEMPLATE_CONFIGURED)', () => {
  assert.equal(resolveReminderTemplateName('r1', {}).name, null);
  assert.equal(resolveReminderTemplateName('r2', {}).name, null);
  assert.equal(resolveReminderTemplateName('r1').name, null);
});

// ── 3. emptyFallback op het mapping-pad ──────────────────────────────

function fakeSupabase(templatesByName) {
  return {
    from() {
      let where = null;
      const chain = {
        select() { return chain; },
        eq(col, val) { where = val; return chain; },
        limit() { return chain; },
        then(resolve) {
          const rows = where && templatesByName[where] ? templatesByName[where] : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return chain;
    },
  };
}

const OPVOLGING_TEMPLATE = {
  name: 'opvolging_geen_reactie',
  language: 'nl',
  status: 'APPROVED',
  header_type: 'NONE',
  body_text: 'Hey {{1}}, ik heb nog geen reactie van je ontvangen op mijn bericht over je openstaande factuur. Laat je even weten hoe we dit kunnen afronden? Alvast bedankt.',
  meta_param_mapping: { body: { 1: 'klant.voornaam' } },
  buttons: null,
};

const LEGACY_VARS = {
  NAAM: 'Nanida Van Veen', FACTUUR_NR: '2026/1780', TOTAAL_BEDRAG: 'EUR 320,00',
  DAGEN_OVERDUE: '3', VERVAL_DATUM: '08-09-2026',
};

test('opvolg-template stuurt precies 1 parameter: de voornaam', async () => {
  resetReminderTemplateCache();
  const payload = await buildReminderTemplatePayload({
    templateName: 'opvolging_geen_reactie',
    ctx: { customer: { first_name: 'Nanida', last_name: 'Van Veen' }, openInvoices: [], invoice: null },
    legacyVars: LEGACY_VARS,
    supabase: fakeSupabase({ opvolging_geen_reactie: [OPVOLGING_TEMPLATE] }),
    emptyFallback: 'daar',
  });
  assert.equal(payload.mode, 'mapping');
  const body = payload.components.find((c) => c.type === 'body');
  assert.equal(body.parameters.length, 1);
  assert.equal(body.parameters[0].text, 'Nanida');
});

test('klant zonder voornaam levert geen LEGE parameter op (Meta weigert die)', async () => {
  resetReminderTemplateCache();
  const payload = await buildReminderTemplatePayload({
    templateName: 'opvolging_geen_reactie',
    ctx: { customer: { first_name: '', company_name: 'Handelsonderneming Veys' }, openInvoices: [], invoice: null },
    legacyVars: LEGACY_VARS,
    supabase: fakeSupabase({ opvolging_geen_reactie: [OPVOLGING_TEMPLATE] }),
    emptyFallback: 'daar',
  });
  const body = payload.components.find((c) => c.type === 'body');
  assert.equal(body.parameters[0].text, 'daar');
  assert.ok(payload.warnings.some((w) => /lege waarde/.test(w)), payload.warnings.join(' | '));
});

test('zonder emptyFallback blijft het bestaande gedrag (R2 wordt niet geraakt)', async () => {
  resetReminderTemplateCache();
  const payload = await buildReminderTemplatePayload({
    templateName: 'opvolging_geen_reactie',
    ctx: { customer: { first_name: '' }, openInvoices: [], invoice: null },
    legacyVars: LEGACY_VARS,
    supabase: fakeSupabase({ opvolging_geen_reactie: [OPVOLGING_TEMPLATE] }),
  });
  const body = payload.components.find((c) => c.type === 'body');
  assert.equal(body.parameters[0].text, '', 'ongewijzigd gedrag zonder de nieuwe optie');
});

test('niet-approved opvolg-template wordt niet gebruikt (val terug op legacy)', async () => {
  resetReminderTemplateCache();
  const payload = await buildReminderTemplatePayload({
    templateName: 'opvolging_geen_reactie',
    ctx: { customer: { first_name: 'Nanida' }, openInvoices: [], invoice: null },
    legacyVars: LEGACY_VARS,
    supabase: fakeSupabase({ opvolging_geen_reactie: [{ ...OPVOLGING_TEMPLATE, status: 'LOCAL' }] }),
    emptyFallback: 'daar',
  });
  assert.equal(payload.mode, 'legacy', 'LOCAL-template mag niet als approved gelden');
  assert.ok(payload.warnings.some((w) => /niet approved/.test(w)));
});
