-- ============================================================================
-- 2026-08-02 — Dunning-WA body-fix: WHERE op meta_template_name (niet name)
--
-- BUG (bewezen 2026-08-02 uit Supabase-query):
--   `dunning_templates.name`               = display-label (bv. "Aanmaning
--                                              dag 7 (WhatsApp)")
--   `dunning_templates.meta_template_name` = Meta-side approved key (bv.
--                                              "aanmaning_dag7")
--
--   Vorige migratie (2026-08-01-dunning-wa-dag7-4var-body.sql) deed
--   WHERE name = 'aanmaning_dag7' → **0 rijen geraakt**. De echte rij
--   (id 861cf8ea-4c47-4515-ac47-026ec27a84a6, name="Aanmaning dag 7
--   (WhatsApp)", meta_template_name="aanmaning_dag7") bleef ongewijzigd
--   met 5 placeholders → Meta bleef #132000 gooien.
--
-- FIX: WHERE op meta_template_name. Body naar exact 4 named placeholders
-- die matchen met Meta-approval (voornaam / nummer / bedrag / vervaldatum).
--
-- Andere fix in dezelfde PR: sandbox-endpoint lookup ook op
-- meta_template_name (was 'name' — vond de rij dus niet en gaf misleidend
-- "geen whatsapp-template met name=..."-error).
--
-- Idempotent: UPDATE-only met exacte WHERE clause.
-- Andere templates (dag17/21/37 + niet-dunning) NIET aangeraakt.
-- ============================================================================

BEGIN;

-- ── Vóór-check: welke rijen worden geraakt ───────────────────────────────
SELECT id, name, meta_template_name, length(body) AS body_len_before,
       (body LIKE '%{{factuur.betaal_link}}%') AS heeft_betaal_link_before
FROM public.dunning_templates
WHERE meta_template_name IN ('aanmaning_dag7', 'aanmaning_dag14')
  AND kind = 'whatsapp'
ORDER BY meta_template_name;

-- ── DAG 7: 4 placeholders (voornaam/nummer/bedrag/vervaldatum) ────────────
-- Verwijderd: 'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}'
-- Toegevoegd: 'of bevestig het eventjes' in negeer-regel (Meta canonical body).
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' ||
           E'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren of bevestig het eventjes.\n' ||
           E'Met vriendelijke groeten,\n' ||
           E'Team De Forex Opleiding'
WHERE meta_template_name = 'aanmaning_dag7'
  AND kind = 'whatsapp';

-- ── DAG 14: 4 placeholders (voornaam/nummer/bedrag/dagen_overdue) ─────────
-- Idempotent — body was al 4-var volgens jouw check, maar herzetting dekt
-- eventuele drift en garandeert canonical.
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat inmiddels {{factuur.dagen_overdue}} dagen open. We hebben nog geen betaling ontvangen.\n' ||
           E'Wil je vandaag betalen, of laat je ons even weten wanneer het lukt? Dan houden we het netjes samen.\n' ||
           E'Team De Forex Opleiding'
WHERE meta_template_name = 'aanmaning_dag14'
  AND kind = 'whatsapp';

-- ── Sanity-check: bewijs count = 4 en betaal_link weg bij dag7 ────────────
SELECT id, name, meta_template_name, length(body) AS body_len_after,
       (body LIKE '%{{klant.voornaam}}%')          AS heeft_voornaam,
       (body LIKE '%{{factuur.nummer}}%')          AS heeft_nummer,
       (body LIKE '%{{factuur.bedrag}}%')          AS heeft_bedrag,
       (body LIKE '%{{factuur.vervaldatum}}%')     AS heeft_vervaldatum,
       (body LIKE '%{{factuur.dagen_overdue}}%')   AS heeft_dagen_overdue,
       (body LIKE '%{{factuur.betaal_link}}%')     AS heeft_betaal_link_MOET_FALSE
FROM public.dunning_templates
WHERE meta_template_name IN ('aanmaning_dag7', 'aanmaning_dag14')
  AND kind = 'whatsapp'
ORDER BY meta_template_name;

COMMIT;
