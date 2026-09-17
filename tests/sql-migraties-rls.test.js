// tests/sql-migraties-rls.test.js
//
// ELKE NIEUWE TABEL KRIJGT RLS IN HETZELFDE MIGRATIEBESTAND.
//
// ── DE AANLEIDING, EN WAAROM EEN TOETS ───────────────────────────────────
// Op 17 september 2026 maakte de overdracht-migratie
// (2026-09-17-noshow-signalen-naar-lms.sql) een logtabel aan met studentnamen
// erin, zonder RLS. Postgres zet RLS standaard UIT, en in Supabase betekent
// dat: leesbaar via PostgREST met de ANON-sleutel. Supabase waarschuwde
// erover en Cowork heeft het bij de hand rechtgezet.
//
// Dat het goed kwam is precies het probleem: het hing aan een waarschuwing
// die iemand toevallig las. Deze toets maakt er een regel van, en die regel
// is bewust simpel — hij kijkt niet naar productie (dat kan hij niet) maar
// naar het BESTAND: wie hier een tabel aanmaakt, zet in datzelfde bestand
// ook RLS aan. Eén bestand lezen is dan genoeg om te weten hoe de tabel
// erbij staat.
//
// ── WAT DEZE TOETS NIET IS ───────────────────────────────────────────────
// Geen uitspraak over de stand van productie. RLS kan daar aan staan zonder
// dat het uit een migratiebestand komt — bij een flink deel van de lijst
// hieronder is dat aantoonbaar zo (customers is in productie afgeschermd,
// zie docs/crm-rls-role-check-hardening.md, maar de ALTER staat in geen
// enkel bestand in deze repo). Wie wil weten hoe het ER ECHT voor staat,
// kijkt in Supabase; deze toets bewaakt alleen dat nieuwe bestanden het
// zelf regelen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAPPEN = ['docs/sql-migrations', 'migrations'];

// ───────────────────────────────────────────────────────────────────────────
// DE BESTAANDE GATEN — nulmeting 17 september 2026
// ───────────────────────────────────────────────────────────────────────────
//
// Deze bestanden zijn AL GEDRAAID op productie. Ze worden met opzet NIET
// achteraf bijgewerkt: een migratiebestand hoort te beschrijven wat er
// gedraaid is, niet wat er had moeten gebeuren. Een ALTER erbij zetten zou
// het bestand laten liegen over de databank.
//
// Wat je hier dus leest is: "dit bestand maakt een tabel aan en zet er zelf
// geen RLS op". Of die tabel in productie WEL afgeschermd is, staat er niet
// bij en is per tabel iets om na te kijken in Supabase. Voor `customers`
// weten we dat het goed zit; voor `student_signals_lms_overdracht` bleek het
// mis, en dat is de reden dat deze toets bestaat.
//
// Deze lijst hoort te KRIMPEN, nooit te groeien. Een nieuwe regel hierin
// toevoegen is hetzelfde als de toets uitzetten — doe dat niet; zet RLS in
// het nieuwe bestand.
const BESTAANDE_GATEN = Object.freeze({
  // ── docs/sql-migrations ──
  'docs/sql-migrations/2026-05-19-commit-c-velden.sql': ['follow_up_notities'],
  'docs/sql-migrations/2026-05-30-finance-fase-1-fundament.sql': ['deals', 'subscriptions', 'bonuses', 'sales_bonus_configs', 'invoices', 'payments', 'bank_accounts', 'bank_categories', 'bank_transactions', 'bank_category_rules', 'dunning_trajectories', 'dunning_phases', 'payment_promises', 'forecast_scenarios', 'monthly_reports', 'lead_sources', 'user_dashboard_layouts'],
  'docs/sql-migrations/2026-05-30-sales-fase-2-wizard.sql': ['products', 'sales_wizard_drafts', 'teamleader_oauth_tokens'],
  'docs/sql-migrations/2026-05-31-quotation-send-webhook.sql': ['teamleader_webhooks', 'teamleader_webhook_events', 'teamleader_settings'],
  'docs/sql-migrations/2026-06-01-trajecten.sql': ['trajects', 'traject_variants', 'traject_variant_products'],
  'docs/sql-migrations/2026-06-05-finance-creditnotes.sql': ['credit_notes'],
  'docs/sql-migrations/2026-06-18-whatsapp-template-folders.sql': ['whatsapp_template_folders'],
  'docs/sql-migrations/2026-07-18-lead-attribution.sql': ['lead_attribution'],
  'docs/sql-migrations/2026-07-18-meta-ads-sync.sql': ['meta_ad_entities', 'meta_insights_daily'],
  'docs/sql-migrations/2026-07-19-meta-capi-events.sql': ['meta_capi_events'],
  'docs/sql-migrations/2026-07-30-leadsonderhoud-sjablonen.sql': ['onderhoud_sjablonen'],
  'docs/sql-migrations/2026-08-02-dunning-gesprek-analyse-cache.sql': ['dunning_gesprek_analyse'],
  'docs/sql-migrations/2026-08-20-crm-rls-open-tables-hardening.sql': ['rls_hardening_log'],
  'docs/sql-migrations/2026-08-24-dunning-test-cockpit-fundament.sql': ['test_cockpit_audit'],
  // Draait op dfo-lms, niet op het CRM. Het LMS heeft zijn eigen
  // RLS-inrichting; de regel hierboven gaat over de CRM-databank.
  'docs/sql-migrations/2026-09-07-hlms-crm-onboarding-spiegel.sql': ['hlms_crm_onboarding'],

  // ── migrations ──
  'migrations/012_klanten_module_foundation.sql': ['audit_log', 'customers', 'customer_tag_definitions', 'customer_tags', 'whatsapp_numbers', 'whatsapp_templates', 'whatsapp_messages', 'letter_templates', 'letters', 'avg_data_requests'],
  'migrations/013_customer_notes.sql': ['customer_notes'],
  'migrations/031_dunning_bulk_jobs.sql': ['dunning_bulk_jobs', 'dunning_bulk_recipients'],
  'migrations/034_dunning_pipeline_foundation.sql': ['dunning_pipeline_stages', 'dunning_pipeline_customers', 'dunning_pipeline_log', 'dunning_pipeline_appointments'],
  'migrations/037_incasso_foundation.sql': ['dunning_incasso_bureaus', 'dunning_incasso_dossiers'],
});

// ───────────────────────────────────────────────────────────────────────────
// De scanner
// ───────────────────────────────────────────────────────────────────────────

/**
 * Commentaar eruit. Zonder deze stap telt een uitgecommentarieerde
 * `-- CREATE TABLE ...` in een rollback-blok als een echte tabel, en dan
 * meldt de toets gaten die er niet zijn.
 */
export function zonderCommentaar(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((r) => { const i = r.indexOf('--'); return i === -1 ? r : r.slice(0, i); })
    .join('\n');
}

const RE_CREATE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z0-9_."]+)/gi;
const RE_RLS    = /ALTER\s+TABLE\s+(?:ONLY\s+)?([a-z0-9_."]+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;

const norm = (naam) => String(naam).replace(/"/g, '').replace(/^public\./, '').toLowerCase();

/** @returns {{gemaakt: string[], metRls: Set<string>}} */
export function scanSql(sql) {
  const schoon = zonderCommentaar(sql);
  const gemaakt = [...new Set([...schoon.matchAll(RE_CREATE)]
    .map((m) => norm(m[1]))
    // Tijdelijke tabellen leven binnen één sessie en kennen geen RLS.
    .filter((t) => !t.startsWith('temp') && !t.includes('tmp_')))];
  const metRls = new Set([...schoon.matchAll(RE_RLS)].map((m) => norm(m[1])));
  return { gemaakt, metRls };
}

function alleBestanden() {
  const uit = [];
  for (const map of MAPPEN) {
    for (const f of readdirSync(join(ROOT, map)).filter((f) => f.endsWith('.sql')).sort()) {
      uit.push({ kort: map + '/' + f, sql: readFileSync(join(ROOT, map, f), 'utf8') });
    }
  }
  return uit;
}

// ───────────────────────────────────────────────────────────────────────────
// 1) DE REGEL
// ───────────────────────────────────────────────────────────────────────────

test('elke CREATE TABLE zet in hetzelfde bestand ook RLS aan', () => {
  const nieuweGaten = [];
  for (const { kort, sql } of alleBestanden()) {
    const { gemaakt, metRls } = scanSql(sql);
    const bekend = new Set(BESTAANDE_GATEN[kort] || []);
    for (const tabel of gemaakt) {
      if (metRls.has(tabel) || bekend.has(tabel)) continue;
      nieuweGaten.push(kort + ' :: ' + tabel);
    }
  }
  assert.deepEqual(nieuweGaten, [],
    'Deze migratie(s) maken een tabel aan zonder er RLS op te zetten.\n'
    + 'Postgres zet RLS standaard UIT, en in Supabase betekent dat: leesbaar\n'
    + 'via PostgREST met de anon-sleutel. Zet in hetzelfde bestand:\n'
    + '  ALTER TABLE public.<tabel> ENABLE ROW LEVEL SECURITY;\n'
    + 'Geen policies erbij = alleen de service-role komt erbij; dat is de\n'
    + 'juiste stand voor alles wat het CRM zelf via supabaseAdmin leest.\n'
    + 'Zet de tabel NIET op de lijst BESTAANDE_GATEN — die hoort te krimpen.');
});

test('de logtabel van de LMS-overdracht heeft RLS — dat was de aanleiding', () => {
  const bestand = 'docs/sql-migrations/2026-09-17-noshow-signalen-naar-lms.sql';
  const { gemaakt, metRls } = scanSql(readFileSync(join(ROOT, bestand), 'utf8'));
  assert.ok(gemaakt.includes('student_signals_lms_overdracht'),
    'de logtabel wordt niet meer aangemaakt in dat bestand');
  assert.ok(metRls.has('student_signals_lms_overdracht'),
    'de logtabel krijgt geen ENABLE ROW LEVEL SECURITY — daar begon dit mee');
  assert.equal(
    (BESTAANDE_GATEN[bestand] || []).includes('student_signals_lms_overdracht'), false,
    'de logtabel staat op de lijst met bestaande gaten; hij is juist gedicht');
});

// ───────────────────────────────────────────────────────────────────────────
// 2) DE LIJST MAG NIET ROTTEN
// ───────────────────────────────────────────────────────────────────────────

test('de lijst met bestaande gaten bevat geen bestanden die niet meer bestaan', () => {
  const bestaand = new Set(alleBestanden().map((b) => b.kort));
  const wezen = Object.keys(BESTAANDE_GATEN).filter((k) => !bestaand.has(k));
  assert.deepEqual(wezen, [],
    'deze bestanden staan op de gaten-lijst maar bestaan niet meer — haal ze eruit');
});

test('de lijst met bestaande gaten bevat geen tabellen die inmiddels RLS hebben', () => {
  // Zo krimpt de lijst vanzelf zodra iemand een oud bestand alsnog dicht
  // zet, en blijft hij een eerlijke weergave van wat er nog open staat.
  const opgelost = [];
  for (const { kort, sql } of alleBestanden()) {
    const bekend = BESTAANDE_GATEN[kort];
    if (!bekend) continue;
    const { gemaakt, metRls } = scanSql(sql);
    for (const tabel of bekend) {
      if (metRls.has(tabel)) opgelost.push(kort + ' :: ' + tabel + ' (heeft nu RLS)');
      else if (!gemaakt.includes(tabel)) opgelost.push(kort + ' :: ' + tabel + ' (wordt hier niet meer aangemaakt)');
    }
  }
  assert.deepEqual(opgelost, [],
    'deze regels op de gaten-lijst kloppen niet meer — haal ze eruit');
});

// ───────────────────────────────────────────────────────────────────────────
// 3) DE SCANNER ZELF — anders bewaakt hij niets
// ───────────────────────────────────────────────────────────────────────────

test('een tabel mét RLS in hetzelfde bestand is geen gat', () => {
  const { gemaakt, metRls } = scanSql(`
    CREATE TABLE IF NOT EXISTS public.iets (id uuid);
    ALTER TABLE public.iets ENABLE ROW LEVEL SECURITY;
  `);
  assert.deepEqual(gemaakt, ['iets']);
  assert.equal(metRls.has('iets'), true);
});

test('TEGENPROEF: een tabel zonder RLS wordt wél gezien', () => {
  const { gemaakt, metRls } = scanSql('CREATE TABLE public.iets (id uuid);');
  assert.deepEqual(gemaakt, ['iets']);
  assert.equal(metRls.has('iets'), false);
});

test('TEGENPROEF: RLS op een ANDERE tabel telt niet mee', () => {
  // Dit is de fout die een naïeve "staat ENABLE ROW LEVEL SECURITY ergens in
  // het bestand?"-check zou maken: een bestand met twee tabellen waarvan er
  // één afgeschermd is, zou dan helemaal goedgekeurd worden.
  const { gemaakt, metRls } = scanSql(`
    CREATE TABLE public.een (id uuid);
    CREATE TABLE public.twee (id uuid);
    ALTER TABLE public.een ENABLE ROW LEVEL SECURITY;
  `);
  assert.deepEqual(gemaakt, ['een', 'twee']);
  assert.equal(metRls.has('een'), true);
  assert.equal(metRls.has('twee'), false);
});

test('uitgecommentarieerde SQL telt niet mee', () => {
  // Rollback-blokken staan vol met `-- DROP TABLE ...` en soms een
  // `-- CREATE TABLE ...`. Die tellen als echte opdrachten zou gaten melden
  // die er niet zijn — en een toets die onzin meldt, wordt genegeerd.
  const { gemaakt } = scanSql(`
    -- CREATE TABLE public.uitgecommentarieerd (id uuid);
    /* CREATE TABLE public.ook_niet (id uuid); */
    CREATE TABLE public.wel (id uuid);
    ALTER TABLE public.wel ENABLE ROW LEVEL SECURITY;
  `);
  assert.deepEqual(gemaakt, ['wel']);
});

test('schema-prefix en aanhalingstekens veranderen het antwoord niet', () => {
  const { gemaakt, metRls } = scanSql(`
    CREATE TABLE IF NOT EXISTS "public"."Met_Hoofdletters" (id uuid);
    ALTER TABLE public.met_hoofdletters ENABLE ROW LEVEL SECURITY;
  `);
  assert.deepEqual(gemaakt, ['met_hoofdletters']);
  assert.equal(metRls.has('met_hoofdletters'), true);
});

test('tijdelijke tabellen vallen buiten de regel', () => {
  const { gemaakt } = scanSql('CREATE TEMP TABLE tmp_iets (id uuid);');
  assert.deepEqual(gemaakt, []);
});
