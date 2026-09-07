-- 2026-09-07 — onboarding automatisch afronden op de eerste afgeronde sessie
-- DRAAIEN OP: forex-command-center (nsjnsvlmdhunzqkdvagm)
--
-- DE REGEL (Maxim, 7 september 2026): de VROEGSTE AFGERONDE sessie van een
-- student in het LMS sluit diens onboarding automatisch af. Geen soort-
-- onderscheid: geen kennismakingsgesprek, geen Alpha/Delta — elke
-- coachingsessie telt.
--
-- Was de eerste sessie een no-show, dan sluit er niets; dan komt er een
-- signaal met een EIGEN type, want daar moet iemand kort op zitten om te
-- voorkomen dat het een wanbetaler wordt.
--
-- ⚠ BLOKKEREND. api/cron/onboarding-eerste-sessie-afronden.js noemt de drie
-- nieuwe kolommen bij naam in zijn UPDATE. Draait deze migratie niet, dan
-- faalt elke afsluitpoging met een column-error. Draai 'm vóór of direct na
-- de merge.

BEGIN;

-- 1) WAAROM een onboarding is afgerond, niet alleen DAT hij afgerond is.
--    Een 'afgerond' zonder aanwijsbare oorzaak is precies het schermsoort
--    dat dit project al twee keer een halve dag heeft gekost.
ALTER TABLE public.onboardings
  ADD COLUMN IF NOT EXISTS auto_afgerond_sessie_id text,
  ADD COLUMN IF NOT EXISTS auto_afgerond_sessie_op timestamptz,
  ADD COLUMN IF NOT EXISTS auto_afgerond_op        timestamptz;

COMMENT ON COLUMN public.onboardings.auto_afgerond_sessie_id IS
  'hlms_sessie.id (dfo-lms) die deze onboarding automatisch afsloot. Geen FK: andere databank. Gevuld = nooit meer automatisch afsluiten, ook niet na handmatig heropenen.';
COMMENT ON COLUMN public.onboardings.auto_afgerond_sessie_op IS
  'start_tijd van die sessie.';
COMMENT ON COLUMN public.onboardings.auto_afgerond_op IS
  'Moment waarop de cron de onboarding afsloot.';

-- 2) Eigen signaaltype voor een gemiste EERSTE call. Spiegel van migratie 018.
--    Bewust GEEN tweede signaal naast het gewone: er staat een unique index
--    op student_signals.session_id, en twee meldingen voor één gebeurtenis
--    laten de mentor ook twee keer rinkelen. Eén signaal, ander type.
ALTER TABLE public.student_signals
  DROP CONSTRAINT IF EXISTS student_signals_type_check;

ALTER TABLE public.student_signals
  ADD CONSTRAINT student_signals_type_check CHECK (type IN (
    'eerste_call', 'reageert_niet', 'niet_bereikbaar',
    'geen_reactie_bellen', 'anders', 'no_show', 'eerste_call_no_show'));

COMMIT;

-- ── 3) ONTVANGERS van het eerste-call-signaal ────────────────────────────────
-- Dit is GEEN schema-wijziging maar een rechten-toekenning, en hij hoort bij
-- deze wijziging: zonder deze rijen levert een gemiste eerste call wel een
-- signaal op, maar gaat er GEEN bericht uit.
--
-- Waarom een recht en geen rol: 'hoofdmentor' staat niet in
-- VALID_SUPABASE_ROLES (api/_lib/roles.js) en de CHECK op user_roles.role laat
-- 'm niet toe — die rol invoeren is een migratie plus werk in het
-- gebruikersbeheer, en dat is een aparte beslissing. Waarom geen namen in de
-- code: dan verhuist de beslissing naar een deploy.
--
-- Zodra de rol 'hoofdmentor' wél bestaat, volstaat één rij in
-- role_permissions en kunnen deze persoonlijke rechten weg. De code hoeft
-- daarvoor niet te wijzigen: resolveOntvangersVoorRecht() leest role_permissions
-- × user_roles én user_permissions, en dedupliceert.
--
-- CHESNEY staat met uuid in migratie 044 (softphone.use) — die nemen we over,
-- geen gok op een e-mailadres. MAXIM gaat op e-mailadres; controleer met de
-- SELECT hieronder dát die rij gevonden wordt vóór je de INSERT draait.

-- Controle VOORAF — verwacht: 2 rijen (Chesney + Maxim).
--   SELECT id, email, full_name, is_active FROM public.profiles
--    WHERE id = '9f4cd827-9529-4647-bdd3-2db4cd340bab'
--       OR lower(email) = 'maxim@deforexopleiding.nl';

INSERT INTO public.user_permissions (user_id, feature_key, allowed)
SELECT p.id, 'signals.hoofdmentor.receive', true
  FROM public.profiles p
 WHERE p.id = '9f4cd827-9529-4647-bdd3-2db4cd340bab'          -- Chesney (uit migratie 044)
    OR lower(p.email) = 'maxim@deforexopleiding.nl'           -- Maxim
ON CONFLICT (user_id, feature_key) DO UPDATE SET allowed = true;

-- ⚠ CONTROLEER OOK `students.all.view`. De melding over een gemiste eerste
-- call wijst naar Aandachtspunten (/modules/students-overview.html?tab=signals);
-- afhandelen gebeurt daar via student-signals-handle.js, dat op
-- `students.all.view` gegate is. Heeft een van de twee dat recht niet, dan
-- landt 'ie op een scherm waar hij niks mee kan:
--   SELECT p.email, public.user_has_permission(p.id, 'students.all.view')
--     FROM public.profiles p
--    WHERE p.id = '9f4cd827-9529-4647-bdd3-2db4cd340bab'
--       OR lower(p.email) = 'maxim@deforexopleiding.nl';
-- Zo nodig bijzetten met dezelfde INSERT-vorm en feature_key 'students.all.view'.

-- Controle ACHTERAF — wie heeft het recht nu:
--   SELECT p.email, p.full_name, up.allowed
--     FROM public.user_permissions up
--     JOIN public.profiles p ON p.id = up.user_id
--    WHERE up.feature_key = 'signals.hoofdmentor.receive';

-- Controle:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'onboardings' AND column_name LIKE 'auto_afgerond%';
--
-- Rollback (handmatig, defensief):
--   ALTER TABLE public.onboardings
--     DROP COLUMN IF EXISTS auto_afgerond_sessie_id,
--     DROP COLUMN IF EXISTS auto_afgerond_sessie_op,
--     DROP COLUMN IF EXISTS auto_afgerond_op;
--   ALTER TABLE public.student_signals DROP CONSTRAINT IF EXISTS student_signals_type_check;
--   ALTER TABLE public.student_signals ADD CONSTRAINT student_signals_type_check CHECK (type IN (
--     'eerste_call','reageert_niet','niet_bereikbaar','geen_reactie_bellen','anders','no_show'));
