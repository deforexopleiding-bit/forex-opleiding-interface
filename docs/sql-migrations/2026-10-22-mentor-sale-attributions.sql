-- =============================================================================
-- 2026-10-22 — Handmatige sale-toewijzing aan mentoren (commissie-cockpit)
--
-- WAAROM
--   Maxim wil zelf een getekende offerte (deal) aan één of meer mentoren
--   hangen, vooral bij een VERLENGING die de mentor zelf binnenhaalde. Zelfde
--   commissie (standaard 3%) en zelfde regel als de event-bonus: de mentor
--   verdient pas als de factuur van DIE deal effectief betaald is.
--
--   Tot nu toe kon een bonus alleen via "event afronden" ontstaan
--   (mentor_ledger_entries.event_id NOT NULL). Een toewijzing heeft geen event,
--   dus:
--     1. nieuwe tabel mentor_sale_attributions (1 rij per toewijzing);
--     2. mentor_ledger_entries.event_id mag NULL, mits attribution_id gezet is.
--
-- ADDITIEF — raakt geen bestaande rij. Alle bestaande ledger-rijen hebben een
-- event_id, dus de nieuwe CHECK valideert meteen.
--
-- Code is fail-soft zolang dit bestand niet gedraaid is: de cockpit toont dan
-- gewoon de event-bonussen en de knop "Sale toewijzen" meldt dat de migratie
-- nog moet draaien.
--
-- Supabase SQL-editor: elk statement draait los; er zit bewust geen DO-block
-- of temp-tabel in. Volgorde aanhouden.
-- =============================================================================

-- 1) Toewijzingen ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mentor_sale_attributions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id        uuid NOT NULL REFERENCES public.deals(id) ON DELETE RESTRICT,
  customer_id    uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  reden          text NOT NULL DEFAULT 'verlenging',
  pct            numeric(5,2) NOT NULL DEFAULT 3,
  basis          numeric(12,2) NOT NULL,
  basis_incl_btw boolean NOT NULL DEFAULT true,
  status         text NOT NULL DEFAULT 'actief',
  note           text,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.mentor_sale_attributions
  DROP CONSTRAINT IF EXISTS mentor_sale_attributions_reden_check;
ALTER TABLE public.mentor_sale_attributions
  ADD CONSTRAINT mentor_sale_attributions_reden_check
  CHECK (reden IN ('verlenging','upsell','handmatig'));

ALTER TABLE public.mentor_sale_attributions
  DROP CONSTRAINT IF EXISTS mentor_sale_attributions_status_check;
ALTER TABLE public.mentor_sale_attributions
  ADD CONSTRAINT mentor_sale_attributions_status_check
  CHECK (status IN ('actief','geannuleerd'));

ALTER TABLE public.mentor_sale_attributions
  DROP CONSTRAINT IF EXISTS mentor_sale_attributions_pct_check;
ALTER TABLE public.mentor_sale_attributions
  ADD CONSTRAINT mentor_sale_attributions_pct_check
  CHECK (pct > 0 AND pct <= 100);

-- Eén ACTIEVE toewijzing per deal. Een geannuleerde mag blijven staan
-- (geschiedenis) en een nieuwe actieve ernaast.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mentor_sale_attributions_deal_actief
  ON public.mentor_sale_attributions (deal_id)
  WHERE status = 'actief';

CREATE INDEX IF NOT EXISTS idx_mentor_sale_attributions_customer
  ON public.mentor_sale_attributions (customer_id);

COMMENT ON TABLE public.mentor_sale_attributions IS
  'Handmatige toewijzing van een getekende deal aan mentor(en) (verlenging/upsell/handmatig). Per mentor 1 parent in mentor_ledger_entries (attribution_id, event_id NULL, idempotency_key attr:<id>:<uid>). Vrijgave telt ALLEEN facturen van deze deal (invoices.deal_id of tl_subscription_id van de subs van de deal). Schrijven alleen via service-role endpoints (api/commissie-toewijzing-*).';

-- 2) Grootboek: event_id optioneel, attribution_id erbij ──────────────────────
ALTER TABLE public.mentor_ledger_entries
  ADD COLUMN IF NOT EXISTS attribution_id uuid
    REFERENCES public.mentor_sale_attributions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_attribution
  ON public.mentor_ledger_entries (attribution_id)
  WHERE attribution_id IS NOT NULL;

ALTER TABLE public.mentor_ledger_entries
  ALTER COLUMN event_id DROP NOT NULL;

-- Elke entry hoort bij een event OF een toewijzing. NOT VALID + VALIDATE: de
-- ADD neemt geen lange lock, de VALIDATE controleert de bestaande rijen (die
-- hebben allemaal een event_id).
ALTER TABLE public.mentor_ledger_entries
  DROP CONSTRAINT IF EXISTS mentor_ledger_entries_bron_check;
ALTER TABLE public.mentor_ledger_entries
  ADD CONSTRAINT mentor_ledger_entries_bron_check
  CHECK (event_id IS NOT NULL OR attribution_id IS NOT NULL) NOT VALID;
ALTER TABLE public.mentor_ledger_entries
  VALIDATE CONSTRAINT mentor_ledger_entries_bron_check;

COMMENT ON COLUMN public.mentor_ledger_entries.attribution_id IS
  'Handmatige toewijzing (mentor_sale_attributions). NULL voor event-bonussen en uitgaven. Bij attribution_id gezet is event_id NULL.';

-- 3) RLS — lezen: manager+ alles, mentor alleen toewijzingen waar hij zelf een
--    grootboekregel op heeft. Schrijven: alleen service_role (geen policies).
ALTER TABLE public.mentor_sale_attributions ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.mentor_sale_attributions FROM anon, authenticated;
REVOKE ALL ON public.mentor_sale_attributions FROM anon;

DROP POLICY IF EXISTS mentor_sale_attributions_select ON public.mentor_sale_attributions;
CREATE POLICY mentor_sale_attributions_select ON public.mentor_sale_attributions
  FOR SELECT TO authenticated USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
    OR EXISTS (
      SELECT 1 FROM public.mentor_ledger_entries e
       WHERE e.attribution_id = mentor_sale_attributions.id
         AND e.mentor_user_id = auth.uid()
    )
  );

-- =============================================================================
-- POST-CHECK
-- =============================================================================
-- SELECT is_nullable FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='mentor_ledger_entries'
--    AND column_name='event_id';                                   -- YES
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='mentor_ledger_entries'
--    AND column_name='attribution_id';                             -- 1 rij
-- SELECT convalidated FROM pg_constraint
--  WHERE conname='mentor_ledger_entries_bron_check';               -- true
-- SELECT policyname FROM pg_policies
--  WHERE tablename='mentor_sale_attributions';                     -- 1 rij
-- SELECT relrowsecurity FROM pg_class
--  WHERE relname='mentor_sale_attributions';                       -- true
--
-- =============================================================================
-- ROLLBACK (alleen als er nog GEEN toewijzingen zijn gemaakt — anders eerst
-- die ledger-rijen opruimen, want event_id NOT NULL faalt op attribution-rijen)
-- =============================================================================
-- ALTER TABLE public.mentor_ledger_entries DROP CONSTRAINT IF EXISTS mentor_ledger_entries_bron_check;
-- ALTER TABLE public.mentor_ledger_entries DROP COLUMN IF EXISTS attribution_id;
-- ALTER TABLE public.mentor_ledger_entries ALTER COLUMN event_id SET NOT NULL;
-- DROP TABLE IF EXISTS public.mentor_sale_attributions;
