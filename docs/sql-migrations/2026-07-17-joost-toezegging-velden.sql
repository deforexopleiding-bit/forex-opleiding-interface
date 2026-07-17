-- 2026-07-17 — joost_suggestions.promised_date_{raw,hint} voor payment_promise
--
-- Achtergrond (#801):
--   Joost detecteert een payment_promise-intent maar legt nu NIETS vast. De
--   klant hoort "genoteerd" terwijl er geen datum, arrangement of taak is.
--   Dag 17 uit de dunning-workflow vuurt "we hebben nog niets gehoord" —
--   vertrouwensbreuk.
--
--   Deze migratie voegt twee nullable kolommen toe:
--     promised_date_raw   : het letterlijke klantwoord ("vrijdag", "eind van
--                            de maand", "na mijn salaris"). Altijd citaat,
--                            nooit door Joost herformuleerd. Voor Jeffrey in
--                            Fase 2's modal, zodat 'ie ziet WAAROM Joost een
--                            datum voorstelt (of niet).
--     promised_date_hint  : YYYY-MM-DD als LLM 'em ondubbelzinnig kan
--                            afleiden uit klantwoord + huidige datum (die we
--                            in de prompt-context zetten, zie #801 code).
--                            null bij vaag ("zsm", "na mijn salaris").
--                            Voor Jeffrey een pre-selected voorstel in Fase 2's
--                            datum-dropdown. Nooit voor de klant — Joost mag
--                            de afgeleide datum NIET hardop noemen.
--
-- Beleid Jeffrey (#801):
--   Optie (a) — Joost legt zelf een TOEZEGGING vast — is afgewezen wegens
--   datum-interpretatie-risico ("welke vrijdag?"). Optie (c) — taak in Open
--   Acties — is gekozen. Deze migratie is de datalaag voor die taak.
--
-- Idempotent (IF NOT EXISTS). Nullable → bestaande rijen worden niet geraakt.
--
-- Supabase-editor-proof: alleen ALTER en COMMENT statements. Geen TEMP-
-- tabellen, geen DO-blocks — de editor knipt statements op eigen transactie-
-- grenzen (zie CLAUDE.md).

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS promised_date_raw  text,
  ADD COLUMN IF NOT EXISTS promised_date_hint date;

COMMENT ON COLUMN public.joost_suggestions.promised_date_raw IS
  '#801 — Letterlijk klantwoord uit payment_promise-intent ("vrijdag", "eind van de maand", "na mijn salaris"). NULL als geen date-indicatie. Fase 2 modal toont dit als bewijs waarom Joost een datum voorstelt.';

COMMENT ON COLUMN public.joost_suggestions.promised_date_hint IS
  '#801 — YYYY-MM-DD als LLM datum ondubbelzinnig kon afleiden (huidige datum staat in prompt-context). NULL bij vage input. Voor mens in Fase 2 modal, NIET voor klant — Joost mag afgeleide datum niet hardop noemen.';
