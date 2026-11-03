-- =============================================================================
-- 2026-11-03 — Incassostatus per klant (PR 3 mentorcommissie)
--
-- VOORWAARDE: 2026-10-22-commissie-incasso-en-koppeling.sql is gedraaid
-- (Maxim, 3 nov — mentor_commissie_incasso bestaat, 0 rijen).
--
-- WAAROM (beslissing Maxim)
--   Eén eenduidige status per klant: actief · bij_incasso · incasso_regeling ·
--   afgesloten (betaald of oninbaar), met datum, reden, wie en historiek.
--   bij_incasso → commissie staat stil; incasso_regeling → echte betalingen
--   tellen weer (wat effectief binnenkomt, niet het bedrag vóór een
--   bureaufee). Vervangt "alles na incasso telt nooit meer".
--
-- MODEL: we bouwen voort op mentor_commissie_incasso. De actieve rij van een
--   klant (deal_id NULL, opgeheven_op NULL) is zijn huidige status; elke
--   wijziging sluit die rij (opgeheven_op/door/opheffen_reden) en opent een
--   nieuwe → de historiek. Geen actieve rij = 'actief'. De unieke index
--   uq_mentor_commissie_incasso_actief_klant blijft: één huidige status.
--
-- NIET BLOKKEREND: zonder deze kolommen leest de code elke actieve rij als
--   'bij_incasso' (het oude gedrag) en kan enkel "bij incasso" en opheffen.
-- Supabase SQL-editor: losse statements, geen DO-blocks.
-- =============================================================================

ALTER TABLE public.mentor_commissie_incasso ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'bij_incasso';
ALTER TABLE public.mentor_commissie_incasso ADD COLUMN IF NOT EXISTS afgesloten_als text;
ALTER TABLE public.mentor_commissie_incasso ADD COLUMN IF NOT EXISTS incasso_sinds date;

ALTER TABLE public.mentor_commissie_incasso DROP CONSTRAINT IF EXISTS mentor_commissie_incasso_status_check;
ALTER TABLE public.mentor_commissie_incasso ADD CONSTRAINT mentor_commissie_incasso_status_check
  CHECK (status IN ('bij_incasso','incasso_regeling','afgesloten'));
ALTER TABLE public.mentor_commissie_incasso DROP CONSTRAINT IF EXISTS mentor_commissie_incasso_afgesloten_check;
ALTER TABLE public.mentor_commissie_incasso ADD CONSTRAINT mentor_commissie_incasso_afgesloten_check
  CHECK ((status = 'afgesloten' AND afgesloten_als IN ('betaald','oninbaar'))
      OR (status <> 'afgesloten' AND afgesloten_als IS NULL));

-- Bestaande rijen (gemeten 3 nov: 0): begin van de incasso = sinds.
UPDATE public.mentor_commissie_incasso SET incasso_sinds = sinds WHERE incasso_sinds IS NULL;

CREATE INDEX IF NOT EXISTS idx_mentor_commissie_incasso_klant ON public.mentor_commissie_incasso (customer_id, gezet_op DESC);

COMMENT ON TABLE public.mentor_commissie_incasso IS
  'Incassostatus per klant (deal_id NULL) — en optioneel per sale. Actieve rij = huidige status; gesloten rijen = historiek. bij_incasso: commissie staat stil vanaf sinds; incasso_regeling: echte betalingen tellen weer; afgesloten betaald/oninbaar. Schrijven alleen via api/klant-incassostatus.js en api/commissie-incasso.js.';
COMMENT ON COLUMN public.mentor_commissie_incasso.incasso_sinds IS 'Begin van de incasso-keten (blijft bij regeling/afsluiten). Oninbaar: niets telt vanaf deze datum.';

-- POST-CHECK
-- SELECT column_name FROM information_schema.columns WHERE table_name = 'mentor_commissie_incasso' AND column_name IN ('status','afgesloten_als','incasso_sinds');   -- 3
-- SELECT status, count(*) FROM public.mentor_commissie_incasso GROUP BY 1;
--
-- ROLLBACK
-- DROP INDEX IF EXISTS public.idx_mentor_commissie_incasso_klant;
-- ALTER TABLE public.mentor_commissie_incasso DROP CONSTRAINT IF EXISTS mentor_commissie_incasso_afgesloten_check;
-- ALTER TABLE public.mentor_commissie_incasso DROP CONSTRAINT IF EXISTS mentor_commissie_incasso_status_check;
-- ALTER TABLE public.mentor_commissie_incasso DROP COLUMN IF EXISTS incasso_sinds, DROP COLUMN IF EXISTS afgesloten_als, DROP COLUMN IF EXISTS status;
