-- 2026-07-17 — #809 mandate.splitsing.max_dagen_tot_eerste_termijn + kolom
--
-- ⚠ MIGRATIE BLOKKEREND: joost_suggest_core.js persisteert de nieuwe kolom
-- proposal_eerste_termijn_datum bij naam in de insert. Zonder deze migratie
-- faalt elke nieuwe Joost-suggestie met
--   column "proposal_eerste_termijn_datum" of relation "joost_suggestions" does not exist
-- → Joost is stuk voor finance-conversaties. Draai VOOR of DIRECT NA merge.
--
-- Achtergrond (#809):
--   In het oefengesprek (17 juli) accepteerde Joost een regeling die op
--   6 december moest starten — 142 dagen weg. Er was geen grens: prompt niet,
--   evaluateAutonomy niet, arrangements-propose niet.
--   Beleid Jeffrey: een SPLITSING moet binnen 45 dagen starten. Later is geen
--   regeling meer maar uitstel; UITSTEL heeft z'n eigen grens
--   (mandate.uitstel.max_dagen_total = 90, bewust ruimer).
--
-- Wat deze migratie doet (in 2 statements — Supabase-editor-proof):
--   1. ALTER TABLE joost_suggestions ADD COLUMN proposal_eerste_termijn_datum date.
--      Nullable — bestaande rijen krijgen NULL; nieuwe rijen persist wat Joost
--      als eerste-termijn-datum voorstelt.
--   2. UPDATE joost_config SET autonomy_config = ... jsonb_set met
--      arrangement_mandate.splitsing.max_dagen_tot_eerste_termijn = 45.
--
-- De helper api/_lib/splitsing-start-grens.js valt terug op 45 als de key
-- ontbreekt in DB — deze migratie zorgt dat de config expliciet is (dat
-- Jeffrey de waarde ook kan tunen via admin UI in Fase 2).

ALTER TABLE public.joost_suggestions
  ADD COLUMN IF NOT EXISTS proposal_eerste_termijn_datum date;

COMMENT ON COLUMN public.joost_suggestions.proposal_eerste_termijn_datum IS
  '#809 — YYYY-MM-DD van de eerste termijn bij SPLITSING-voorstel. Wordt gecheckt tegen mandate.splitsing.max_dagen_tot_eerste_termijn (default 45 dagen) voor autonome verzending. NULL bij niet-splitsing intents of als Joost geen concrete startdatum voorstelt.';

UPDATE public.joost_config
   SET autonomy_config = jsonb_set(
     COALESCE(autonomy_config, '{}'::jsonb),
     '{arrangement_mandate,splitsing,max_dagen_tot_eerste_termijn}',
     to_jsonb(45),
     true
   ),
   updated_at = now()
 WHERE module = 'finance';

SELECT autonomy_config -> 'arrangement_mandate' -> 'splitsing' -> 'max_dagen_tot_eerste_termijn' AS max_dagen_tot_eerste_termijn
  FROM public.joost_config
 WHERE module = 'finance';
