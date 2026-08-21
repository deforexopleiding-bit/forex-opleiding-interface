-- 2026-08-21 · Dunning grace-periode bij "alles betaald"
-- ---------------------------------------------------------------------------
-- Voegt resolve_scheduled_at toe aan dunning_pipeline_customers. Wanneer een
-- klant volledig betaalt, sluit de pipeline hem niet meer meteen af (dat rukte
-- iemand met wie je in gesprek bent bruusk uit het overzicht). In plaats
-- daarvan wordt resolve_scheduled_at op now()+60min gezet; de klant blijft die
-- tijd zichtbaar in zijn huidige fase met een aftel-badge. De dunning-engine
-- (hourly cron) zet de klant daarna op 'opgelost' als er nog steeds 0 open
-- facturen zijn, of wist de planning weer als er een factuur reopent.
--
-- Idempotent: veilig meerdere keren te draaien.
-- Bestaande betaalde/gecrediteerde klanten worden NIET geraakt (kolom start NULL).
-- ---------------------------------------------------------------------------

ALTER TABLE public.dunning_pipeline_customers
  ADD COLUMN IF NOT EXISTS resolve_scheduled_at timestamptz NULL;

COMMENT ON COLUMN public.dunning_pipeline_customers.resolve_scheduled_at IS
  'Gepland moment (now()+grace) waarop de engine deze klant automatisch naar '
  '''opgelost'' zet omdat alle facturen betaald zijn. NULL = geen afsluiting '
  'gepland. Wordt gewist bij elke stage-wijziging en als er weer een factuur '
  'openstaat.';

-- Partiële index: de engine-sweep selecteert alleen rijen met een openstaande
-- planning. Klein en goedkoop want in de praktijk staan hier weinig rijen in.
CREATE INDEX IF NOT EXISTS idx_dunning_pipeline_resolve_scheduled
  ON public.dunning_pipeline_customers (resolve_scheduled_at)
  WHERE resolve_scheduled_at IS NOT NULL;
