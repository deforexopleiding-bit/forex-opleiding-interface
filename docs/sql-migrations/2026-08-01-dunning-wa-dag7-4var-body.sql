-- ============================================================================
-- 2026-08-01 — Definitieve fix: aanmaning_dag7 + aanmaning_dag14 → EXACT 4
-- named placeholders per template, matcht Meta-approval.
--
-- BEWEZEN (Jeffrey, Meta Business Manager, 2026-08-02):
--   aanmaning_dag7  : 4 params ({{1}}=voornaam, {{2}}=factuurnummer,
--                     {{3}}=bedrag-kaal, {{4}}=vervaldatum)
--   aanmaning_dag14 : 4 params ({{1}}=voornaam, {{2}}=factuurnummer,
--                     {{3}}=bedrag-kaal, {{4}}=dagen_overdue)
--
-- Beide templates: geen 'EUR ' in {{3}} (staat hardcoded in Meta-tekst).
-- Resolver factuur.bedrag levert al KAAL getal via formatEurAmountOnly
-- (api/_lib/template-variables.js:400). Geen dubbele EUR.
--
-- BUG dag7 (132000): DB-body had 5 placeholders (+{{factuur.betaal_link}}).
-- buildMetaTemplateVariables scant body → stuurt 5 → Meta wil 4 → weigert.
-- FIX: {{factuur.betaal_link}}-regel eruit; body naar exact 4.
--
-- BUG dag14 (131008): Count klopt (4=4), maar 1 param leeg per fail. Body
-- herzetten naar canonical is idempotent (was al 4-var); empty-param guard
-- in api/_lib/dunning-step-executors.js (deze zelfde PR #1045) vangt lege
-- params vóór send af zodat data-issue zichtbaar wordt zonder Meta-call.
--
-- Idempotent: UPDATE-only, exacte WHERE. Herhaald draaien = zelfde canonical.
-- Andere templates (dag17/21/37) NIET aangeraakt.
-- ============================================================================

BEGIN;

-- ── Vóór-check: laat huidige body-lengths zien ───────────────────────────
SELECT name, length(body) AS body_len_before, meta_template_name
FROM public.dunning_templates
WHERE name IN ('aanmaning_dag7', 'aanmaning_dag14')
  AND kind = 'whatsapp'
ORDER BY name;

-- ── DAG 7: 4 placeholders (voornaam/nummer/bedrag/vervaldatum) ────────────
-- Verwijderd: 'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}'
-- Toegevoegd: 'of bevestig het eventjes' in negeer-regel (Jeffrey's canonical).
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' ||
           E'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren of bevestig het eventjes.\n' ||
           E'Met vriendelijke groeten,\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag7'
  AND kind = 'whatsapp';

-- ── DAG 14: 4 placeholders (voornaam/nummer/bedrag/dagen_overdue) ─────────
-- Body al canonical sinds mig 2026-07-21; herzet idempotent voor de zekerheid
-- (dekt scenario waarin iemand via admin-UI heeft gerommeld).
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat inmiddels {{factuur.dagen_overdue}} dagen open. We hebben nog geen betaling ontvangen.\n' ||
           E'Wil je vandaag betalen, of laat je ons even weten wanneer het lukt? Dan houden we het netjes samen.\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag14'
  AND kind = 'whatsapp';

-- ── Sanity-check: bewijs dat count klopt en betaal_link weg is bij dag7 ──
SELECT
  name,
  length(body) AS body_len_after,
  -- Alle 4 placeholders per template:
  (body LIKE '%{{klant.voornaam}}%')          AS heeft_voornaam,
  (body LIKE '%{{factuur.nummer}}%')          AS heeft_nummer,
  (body LIKE '%{{factuur.bedrag}}%')          AS heeft_bedrag,
  (body LIKE '%{{factuur.vervaldatum}}%')     AS heeft_vervaldatum_dag7_only,
  (body LIKE '%{{factuur.dagen_overdue}}%')   AS heeft_dagen_overdue_dag14_only,
  -- Betaal_link mag NIET meer voorkomen (dag7 bug):
  (body LIKE '%{{factuur.betaal_link}}%')     AS heeft_betaal_link_MOET_FALSE
FROM public.dunning_templates
WHERE name IN ('aanmaning_dag7', 'aanmaning_dag14')
  AND kind = 'whatsapp'
ORDER BY name;

COMMIT;
