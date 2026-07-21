-- ============================================================================
-- 2026-07-21 — Enkel-factuur WhatsApp-templates: dot-notation + juiste #vars
--
-- PROBLEEM: de 5 enkel-factuur WhatsApp-aanmaningen (aanmaning_dag7/14/17/21/37)
-- faalden met Meta #132000. Database-body's gebruikten 4 legacy HOOFDLETTER-
-- vars; goedgekeurde Meta-templates gebruiken DOT-NOTATION met per template
-- een ander aantal/andere vars:
--   dag7  (5 vars): klant.voornaam, factuur.nummer, factuur.bedrag,
--                   factuur.vervaldatum, factuur.betaal_link
--   dag14 (4 vars): klant.voornaam, factuur.nummer, factuur.bedrag,
--                   factuur.dagen_overdue
--   dag17/21/37: idem dag14
--
-- FIX (deze migratie): UPDATE body van elke template naar de EXACTE Meta-body
-- (dot-notation), 1-op-1 in de goedgekeurde volgorde — anders klopt de
-- positionele volgorde ({{1}} .. {{N}}) niet.
--
-- BELANGRIJK: factuur.bedrag levert sinds deze PR een KAAL bedrag ("1.234,56"
-- zonder EUR-prefix). Meta-bodys hebben "EUR " typisch al hardcoded vóór de
-- placeholder — dubbele EUR ("EUR EUR 160,00") wordt zo vermeden.
--
-- BELANGRIJK: de e-mail-templates (kind='email') van deze stappen worden NIET
-- aangeraakt. Alleen de 5 whatsapp-body's.
--
-- VEILIG: dit stuurt WhatsApp naar echte wanbetalers met echte betaal-links.
-- De executor pre-fetcht de betaal-link via ensureInvoicePaymentLink; bij
-- fout wordt de stap fail-CLOSED geskipt (whatsapp_skipped_no_payment_link)
-- i.p.v. een kapotte link te sturen.
--
-- Idempotent: UPDATE-only met WHERE name = '<exact>' AND kind='whatsapp' —
-- herhaald draaien herstelt de body naar de canonical versie.
-- ============================================================================

BEGIN;

-- ── dag 7 (5 vars: voornaam · nummer · bedrag · vervaldatum · betaal_link) ──
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Misschien had je het gemist: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nog open. De vervaldatum was {{factuur.vervaldatum}}.\n' ||
           E'Zou je er even naar willen kijken? Als je al betaald hebt, mag je dit bericht negeren.\n' ||
           E'Hier is ook direct een link om de factuur te betalen {{factuur.betaal_link}}\n' ||
           E'Met vriendelijke groeten,\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag7'
  AND kind = 'whatsapp';

-- ── dag 14 (4 vars: voornaam · nummer · bedrag · dagen_overdue) ─────────────
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat inmiddels {{factuur.dagen_overdue}} dagen open. We hebben nog geen betaling ontvangen.\n' ||
           E'Wil je vandaag betalen, of laat je ons even weten wanneer het lukt? Dan houden we het netjes samen.\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag14'
  AND kind = 'whatsapp';

-- ── dag 17 (4 vars: voornaam · nummer · bedrag · dagen_overdue) ─────────────
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'We hebben nog niets van je gehoord over factuur {{factuur.nummer}} van EUR {{factuur.bedrag}}, nu {{factuur.dagen_overdue}} dagen open.\n' ||
           E'Laat je even weten hoe we dit oplossen? Een kort berichtje is genoeg.\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag17'
  AND kind = 'whatsapp';

-- ── dag 21 (4 vars: voornaam · nummer · bedrag · dagen_overdue) ─────────────
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat nu {{factuur.dagen_overdue}} dagen open. Wij hebben je meerdere keren benaderd zonder reactie.\n' ||
           E'Wij sturen je vandaag ook een brief. Als wij niets van je horen, bereiden wij juridische stappen voor.\n' ||
           E'Neem alsjeblieft contact op, dan lossen we het samen op.\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag21'
  AND kind = 'whatsapp';

-- ── dag 37 (4 vars: voornaam · nummer · bedrag · dagen_overdue) ─────────────
UPDATE public.dunning_templates
SET body = E'Hoi {{klant.voornaam}},\n' ||
           E'Laatste bericht: factuur {{factuur.nummer}} van EUR {{factuur.bedrag}} staat {{factuur.dagen_overdue}} dagen open.\n' ||
           E'Ontvangen wij binnen 24 uur geen betaling of reactie, dan dragen wij de vordering over aan ons incassobureau. De extra kosten komen dan voor jouw rekening.\n' ||
           E'Team De Forex Opleiding'
WHERE name = 'aanmaning_dag37'
  AND kind = 'whatsapp';

-- Sanity-check: bevestig dat elke template correct is bijgewerkt naar
-- dot-notation en géén legacy HOOFDLETTER-vars meer bevat. Alle 5 rijen
-- moeten heeft_legacy_bug=false hebben.
SELECT
  name,
  length(body) AS body_len,
  (body LIKE '%{{klant.voornaam}}%')     AS heeft_klant_voornaam,
  (body LIKE '%{{factuur.nummer}}%')     AS heeft_factuur_nummer,
  (body LIKE '%{{factuur.bedrag}}%')     AS heeft_factuur_bedrag,
  (body LIKE '%{{factuur.vervaldatum}}%') AS heeft_factuur_vervaldatum,
  (body LIKE '%{{factuur.betaal_link}}%') AS heeft_factuur_betaal_link,
  (body LIKE '%{{factuur.dagen_overdue}}%') AS heeft_factuur_dagen_overdue,
  (body LIKE '%{{NAAM}}%' OR body LIKE '%{{FACTUUR_NR}}%' OR body LIKE '%{{TOTAAL_BEDRAG}}%' OR body LIKE '%{{VERVAL_DATUM}}%') AS heeft_legacy_bug
FROM public.dunning_templates
WHERE name IN ('aanmaning_dag7','aanmaning_dag14','aanmaning_dag17','aanmaning_dag21','aanmaning_dag37')
  AND kind = 'whatsapp'
ORDER BY name;

COMMIT;
