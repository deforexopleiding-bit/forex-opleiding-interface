-- ============================================================================
-- 2026-07-21 — Enkel-factuur WhatsApp-templates: dot-notation + 5e variabele
--
-- PROBLEEM: de 5 enkel-factuur WhatsApp-aanmaningen (aanmaning_dag7/14/17/
-- 21/37) faalden met Meta #132000 "Number of parameters does not match".
-- Goedgekeurde Meta-templates verwachten 5 dot-notation vars:
--   {{klant.voornaam}}, {{factuur.nummer}}, {{factuur.bedrag}},
--   {{factuur.vervaldatum}}, {{factuur.betaal_link}}
-- Maar dunning_templates.body gebruikte 4 legacy HOOFDLETTER-vars:
--   {{NAAM}}, {{FACTUUR_NR}}, {{TOTAAL_BEDRAG}}, {{VERVAL_DATUM}}
-- → verkeerd aantal (4≠5) én verkeerde notatie.
--
-- FIX (deze migratie): UPDATE de body van elk van de 5 templates naar de
-- dot-notation, IN DE EXACTE VOLGORDE van de goedgekeurde Meta-template
-- body — anders klopt de positionele volgorde ({{1}} .. {{5}}) niet.
--
-- BELANGRIJK: de Meta-body heeft "EUR " HARDCODED vóór {{factuur.bedrag}}.
-- We gebruiken daarom {{factuur.bedrag_kaal}} (nieuwe key in deze PR;
-- levert "160,00" zonder EUR-prefix) om DUBBELE EUR ("EUR EUR 160,00") te
-- voorkomen. factuur.bedrag zelf blijft "EUR 160,00" leveren voor bestaande
-- inbox-templates die daarop rekenen.
--
-- VEILIG: dit stuurt WhatsApp naar echte wanbetalers met een echte betaal-
-- link. De executor pre-fetcht de betaal-link via ensureInvoicePaymentLink;
-- bij fout wordt de stap fail-CLOSED geskipt (whatsapp_skipped_no_payment_
-- link) i.p.v. een kapotte link te sturen.
--
-- Idempotent: UPDATE-only met WHERE name = '<exact>' — herhaald draaien
-- herstelt de body naar de canonical versie.
--
-- ⚠ ACTIE VEREIST: dag14 / dag17 / dag21 / dag37 body's zijn placeholders
-- in deze file. Jeffrey moet ze VERVANGEN met de EXACTE Meta-body voor
-- elke template VOOR het draaien van de migratie. Volgorde van {{...}}
-- MOET matchen met wat in Meta Business Manager staat goedgekeurd.
-- ============================================================================

BEGIN;

-- ── dag 7 (spec-body, exact) ────────────────────────────────────────────
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag_kaal}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' ||
           E'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren.\n' ||
           E'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}\n' ||
           E'Met vriendelijke groeten,\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag7'
  AND kind = 'whatsapp';

-- ── dag 14 (⚠ VERVANG met exacte Meta-body voor dag14) ──────────────────
-- Verwachte structuur: 5 vars in de volgorde die de goedgekeurde Meta-
-- template gebruikt. Voorbeeld-shape (VERVANGEN):
-- UPDATE public.dunning_templates
-- SET body = E'<exacte dag14 body met 5 dot-notation vars>'
-- WHERE name = 'aanmaning_dag14' AND kind = 'whatsapp';

-- ── dag 17 (⚠ VERVANG met exacte Meta-body voor dag17) ──────────────────
-- UPDATE public.dunning_templates
-- SET body = E'<exacte dag17 body met 5 dot-notation vars>'
-- WHERE name = 'aanmaning_dag17' AND kind = 'whatsapp';

-- ── dag 21 (⚠ VERVANG met exacte Meta-body voor dag21) ──────────────────
-- UPDATE public.dunning_templates
-- SET body = E'<exacte dag21 body met 5 dot-notation vars>'
-- WHERE name = 'aanmaning_dag21' AND kind = 'whatsapp';

-- ── dag 37 (⚠ VERVANG met exacte Meta-body voor dag37) ──────────────────
-- UPDATE public.dunning_templates
-- SET body = E'<exacte dag37 body met 5 dot-notation vars>'
-- WHERE name = 'aanmaning_dag37' AND kind = 'whatsapp';

-- Sanity: bevestig hoeveel templates zijn bijgewerkt (moet 1 zijn na dag7-
-- alleen-run, 5 na alle vijf-run).
SELECT name, length(body) AS body_len,
       (body LIKE '%{{klant.voornaam}}%')         AS heeft_klant_voornaam,
       (body LIKE '%{{factuur.nummer}}%')         AS heeft_factuur_nummer,
       (body LIKE '%{{factuur.bedrag_kaal}}%')    AS heeft_factuur_bedrag_kaal,
       (body LIKE '%{{factuur.vervaldatum}}%')    AS heeft_factuur_vervaldatum,
       (body LIKE '%{{factuur.betaal_link}}%')    AS heeft_factuur_betaal_link,
       (body LIKE '%{{NAAM}}%')                   AS heeft_legacy_NAAM_bug
FROM public.dunning_templates
WHERE name IN ('aanmaning_dag7','aanmaning_dag14','aanmaning_dag17','aanmaning_dag21','aanmaning_dag37')
  AND kind = 'whatsapp'
ORDER BY name;

COMMIT;
