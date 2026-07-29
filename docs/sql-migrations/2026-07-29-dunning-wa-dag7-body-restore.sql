-- ============================================================================
-- 2026-07-29 — Restore aanmaning_dag7 WhatsApp-body naar canonical (5 vars)
--
-- PROBLEEM: Op 15 juli 2026 (updated_at 2026-07-15T19:20:12) is de body van
-- template 'Aanmaning dag 7 (WhatsApp)' (id 861cf8ea-4c47-4515-ac47-026ec27a84a6,
-- meta_template_name aanmaning_dag7) handmatig gewijzigd. Daarbij is de regel
-- met {{factuur.betaal_link}} weggehaald + tekst-variatie op de laatste regel.
--
-- Gevolg: DB-body heeft 4 vars (klant.voornaam, factuur.nummer, factuur.bedrag,
-- factuur.vervaldatum), de goedgekeurde Meta-template heeft 5 vars (5e is
-- {{factuur.betaal_link}}). Onze code stuurt 4 params, Meta verwacht 5 →
-- API #132000 "Number of parameters does not match" bij ELKE WA-send met dit
-- template. Sinds 21 juli valt daardoor de WA-druk in de dag-7 aanmaning
-- volledig weg; alleen e-mail loopt nog.
--
-- FIX: UPDATE body terug naar de canonical versie uit
-- 2026-07-21-dunning-wa-enkel-factuur-5-templates.sql. Idempotent (WHERE +
-- exact-match). Alleen deze ene template — dag14/17/21/37 zijn ongewijzigd
-- (die matchten wél op 15 juli).
--
-- VEILIG:
--   1) Body-tekst is 1-op-1 kopie van de 21-juli-seed (de canonical versie
--      die eerder al Meta-approval had). Klanten krijgen exact het bericht
--      dat oorspronkelijk was goedgekeurd.
--   2) {{factuur.betaal_link}} wordt door de executor pre-fetched via
--      ensureInvoicePaymentLink; bij fetch-fout wordt de stap fail-CLOSED
--      geskipt (whatsapp_skipped_no_payment_link) i.p.v. kapotte link
--      versturen.
--   3) UPDATE muteert alleen kind='whatsapp' + exacte name-match. E-mail-
--      template (kind='email') met dezelfde naam blijft ongewijzigd.
--
-- BEVESTIG VÓÓR DRAAIEN: Meta Business Manager laat zien dat de goedgekeurde
-- 'aanmaning_dag7'-template 5 body-placeholders ({{1}}..{{5}}) heeft. Zo ja:
-- deze migratie herstelt de body-match. Zo nee (bv. Meta-template is intussen
-- ook geupdate naar 4 params): NIET draaien; dan is een andere fix nodig.
--
-- Idempotent: UPDATE-only met WHERE name=... AND kind='whatsapp' — herhaald
-- draaien is no-op tenzij de body inmiddels opnieuw gedrift is.
-- ============================================================================

BEGIN;

UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' ||
           E'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren.\n' ||
           E'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}\n' ||
           E'Met vriendelijke groeten,\n' ||
           E'Team De Forex Opleiding',
    updated_at = now()
WHERE name = 'Aanmaning dag 7 (WhatsApp)'
  AND kind = 'whatsapp'
  AND meta_template_name = 'aanmaning_dag7';

COMMIT;

-- Verificatie (draai na de UPDATE):
--   SELECT id, name, meta_template_name,
--          (SELECT COUNT(DISTINCT m[1]) FROM regexp_matches(body, '\{\{([^{}]+)\}\}', 'g') m) AS n_vars,
--          ARRAY(SELECT DISTINCT m[1] FROM regexp_matches(body, '\{\{([^{}]+)\}\}', 'g') m ORDER BY 1) AS vars
--   FROM public.dunning_templates
--   WHERE id = '861cf8ea-4c47-4515-ac47-026ec27a84a6';
-- Verwacht: n_vars = 5, vars = {klant.voornaam,factuur.nummer,factuur.bedrag,factuur.vervaldatum,factuur.betaal_link}

-- ROLLBACK (indien nodig — herstelt de kapotte body van 15 juli):
--   BEGIN;
--   UPDATE public.dunning_templates
--   SET body = E'Hoi {{klant.voornaam}},\n' ||
--              E'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' ||
--              E'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren of bevestig het eventjes.\n' ||
--              E'Met vriendelijke groeten,\n' ||
--              E'Team De Forex Opleiding'
--   WHERE id = '861cf8ea-4c47-4515-ac47-026ec27a84a6';
--   COMMIT;
