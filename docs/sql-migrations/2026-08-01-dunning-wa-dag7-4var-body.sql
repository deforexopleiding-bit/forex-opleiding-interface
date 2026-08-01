-- ============================================================================
-- 2026-08-01 — aanmaning_dag7 body: 5-var → 4-var (matcht Meta-approval)
--
-- PROBLEEM (bewezen 1 aug 2026):
--   Meta-approval van `aanmaning_dag7` verwacht EXACT 4 positional params:
--     {{1}} = klantnaam
--     {{2}} = factuurnummer
--     {{3}} = bedrag (kaal getal, "EUR" zit al hardcoded in template-tekst)
--     {{4}} = vervaldatum (dd-mm-yyyy)
--   DB-body na migratie 2026-07-21 heeft 5 placeholders (voegde
--   {{factuur.betaal_link}} toe). Elke send → Meta #132000 "Number of
--   parameters does not match" — 11 fails vandaag.
--
-- FIX: DB-body terugbrengen naar 4 placeholders die MATCHEN met Meta-approval.
-- De betaal-link-regel + inleiding-zin worden verwijderd; rest ongewijzigd.
--
-- GEVOLG voor klant: geen inline betaal-link meer in dag7-bericht. Alternatief
-- (later, aparte PR): Meta template opnieuw indienen met 5-var incl. link →
-- na re-approval body weer op 5-var zetten. Voor NU is werking (bericht komt
-- door) belangrijker dan link-inline.
--
-- Idempotent: UPDATE-only met exacte WHERE clause. Herhaald draaien geeft
-- dezelfde canonical body.
--
-- Andere templates (dag14/17/21/37) NIET aangeraakt.
-- ============================================================================

BEGIN;

-- Vóór-controle: log de huidige body-length zodat we in COMMIT-output zien
-- dat we de juiste rij bijwerken.
SELECT name, length(body) AS body_len_before, meta_template_name
FROM public.dunning_templates
WHERE name = 'aanmaning_dag7' AND kind = 'whatsapp';

-- Update naar 4-var canonical (matcht Meta-approval).
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' ||
           E'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren.\n' ||
           E'Met vriendelijke groeten,\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag7'
  AND kind = 'whatsapp';

-- Sanity: 4 placeholders (voornaam/nummer/bedrag/vervaldatum), GEEN betaal_link.
SELECT
  name,
  length(body) AS body_len_after,
  (body LIKE '%{{klant.voornaam}}%')      AS heeft_voornaam,
  (body LIKE '%{{factuur.nummer}}%')      AS heeft_nummer,
  (body LIKE '%{{factuur.bedrag}}%')      AS heeft_bedrag,
  (body LIKE '%{{factuur.vervaldatum}}%') AS heeft_vervaldatum,
  (body LIKE '%{{factuur.betaal_link}}%') AS heeft_betaal_link_MOET_FALSE_ZIJN
FROM public.dunning_templates
WHERE name = 'aanmaning_dag7' AND kind = 'whatsapp';

COMMIT;
