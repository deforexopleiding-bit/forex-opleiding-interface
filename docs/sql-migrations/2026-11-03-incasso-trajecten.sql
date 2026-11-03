-- =============================================================================
-- 2026-11-03 — Incasso-overzicht: het TRAJECT per klant (LMS › Administratie › Incasso)
--
-- NOG NIET DRAAIEN vóór #1957 (klant-incassostatus) gedraaid is. Daarna mag dit
-- vóór of na de merge: de code is fail-soft (zonder tabel toont de tab enkel de
-- lijst "Nog te bepalen" en weigert elke actie met 503 TRAJECTEN_NIET_ACTIEF).
--
-- WAAROM (beslissing Maxim, 3 nov 2026)
--   Eén overzicht van wie naar incasso gaat, met vijf fases. De STATUS van een
--   klant (actief / bij_incasso / incasso_regeling / afgesloten) blijft ENKEL in
--   mentor_commissie_incasso (#1957). Deze tabel bewaart alleen wat die status
--   niet kent: wie voorstelde, wie selecteerde, de afvinklijst, het bureau, het
--   overgedragen bedrag, de volgende check en het logboek. De fase wordt
--   AFGELEID (api/_lib/incasso-traject.js → faseVan):
--     actief                         → Mag naar incasso (aanmaningen lopen door)
--     bij_incasso, dossier niet weg  → Doorgezet       (aanmaningen staan stil, #1958)
--     bij_incasso, dossier verstuurd → Bij incasso     (check om de 14 dagen)
--     incasso_regeling               → Regeling        (maandlijst #1958)
--     gesloten_op / afgesloten       → Afgesloten      (betaald · oninbaar · teruggekomen)
--   Wie al op incasso staat zonder traject, staat in "Nog te bepalen": daar
--   kiest Maxim per persoon de fase. Er wordt NIETS automatisch verplaatst en
--   deze migratie maakt GEEN rijen aan.
--
-- ADDITIEF: één nieuwe tabel, geen bestaande kolom of rij wordt geraakt.
-- RLS aan + REVOKE: alleen de service role (api/lms-incasso.js).
-- Supabase SQL-editor: losse statements, geen DO-blocks, geen puntkomma's in tekst.
-- =============================================================================

-- CONTROLE VOORAF (alleen lezen) — verwacht 3 nov: 7 · 1 · 0
-- SELECT count(*) FROM public.onboardings WHERE incasso_op IS NOT NULL AND incasso_terug_op IS NULL;
-- SELECT count(*) FROM public.dunning_incasso_dossiers;
-- SELECT count(*) FROM information_schema.tables WHERE table_name = 'incasso_trajecten';

CREATE TABLE IF NOT EXISTS public.incasso_trajecten (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  onboarding_id        uuid REFERENCES public.onboardings(id) ON DELETE SET NULL,
  lms_student_id       uuid,
  naam                 text,
  herkomst             text NOT NULL DEFAULT 'handmatig',
  voorgesteld_door     text,
  voorgesteld_op       timestamptz NOT NULL DEFAULT now(),
  voorstel_notitie     text,
  geselecteerd_door    text,
  geselecteerd_op      timestamptz,
  bureau_id            uuid REFERENCES public.dunning_incasso_bureaus(id) ON DELETE SET NULL,
  incasso_dossier_id   uuid REFERENCES public.dunning_incasso_dossiers(id) ON DELETE SET NULL,
  checklist            jsonb NOT NULL DEFAULT '{}'::jsonb,
  overgedragen_bedrag  numeric(12,2),
  overgedragen_op      date,
  volgende_check       date,
  logboek              jsonb NOT NULL DEFAULT '[]'::jsonb,
  gesloten_op          timestamptz,
  gesloten_als         text,
  gesloten_door        text,
  gesloten_reden       text,
  aangemaakt_op        timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.incasso_trajecten DROP CONSTRAINT IF EXISTS incasso_trajecten_herkomst_check;
ALTER TABLE public.incasso_trajecten ADD CONSTRAINT incasso_trajecten_herkomst_check
  CHECK (herkomst IN ('brief_2', 'onboarding', 'bestaand', 'handmatig'));
ALTER TABLE public.incasso_trajecten DROP CONSTRAINT IF EXISTS incasso_trajecten_gesloten_check;
ALTER TABLE public.incasso_trajecten ADD CONSTRAINT incasso_trajecten_gesloten_check
  CHECK ((gesloten_op IS NULL AND gesloten_als IS NULL)
      OR (gesloten_op IS NOT NULL AND gesloten_als IN ('betaald', 'oninbaar', 'teruggekomen', 'niet_naar_incasso')));

-- Eén OPEN traject per klant. Gesloten trajecten blijven staan (historiek).
CREATE UNIQUE INDEX IF NOT EXISTS uq_incasso_trajecten_open_klant
  ON public.incasso_trajecten (customer_id) WHERE gesloten_op IS NULL;
CREATE INDEX IF NOT EXISTS idx_incasso_trajecten_gesloten ON public.incasso_trajecten (gesloten_op DESC);

ALTER TABLE public.incasso_trajecten ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.incasso_trajecten FROM anon, authenticated;

COMMENT ON TABLE public.incasso_trajecten IS
  'Incasso-overzicht per klant (LMS › Administratie › Incasso). De STATUS staat enkel in mentor_commissie_incasso (#1957); hier alleen voorstel, selectie, afvinklijst, bureau, overgedragen bedrag, volgende check en logboek. De fase wordt afgeleid in api/_lib/incasso-traject.js. Schrijven alleen via api/lms-incasso.js.';
COMMENT ON COLUMN public.incasso_trajecten.checklist IS
  'Afvinklijst Doorgezet: { bureau_gekozen, facturen_gekrediteerd, restfactuur, abonnement_gestopt, dossier_verstuurd } elk { op, door }. dossier_verstuurd = fase Bij incasso.';

-- POST-CHECK
-- SELECT count(*) FROM public.incasso_trajecten;   -- 0 (niets automatisch)
-- SELECT indexname FROM pg_indexes WHERE tablename = 'incasso_trajecten';
--
-- ROLLBACK (alleen zolang er geen echte rijen in staan)
-- DROP TABLE IF EXISTS public.incasso_trajecten;
