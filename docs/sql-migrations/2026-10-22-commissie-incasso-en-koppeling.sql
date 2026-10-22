-- =============================================================================
-- 2026-10-22 — Mentorcommissie: incasso-markering + koppeling van
--              regelingsfacturen aan een sale
--
-- WAAROM
--   1. Wanbetaler → Maxim crediteert de open facturen en maakt nieuwe facturen
--      volgens een regeling. Die nieuwe facturen hebben GEEN deal_id en GEEN
--      tl_subscription_id (gemeten 22 okt: alle 6 bij de 4 commissieklanten).
--      Heeft de klant maar één commissie-sale, dan koppelt de code ze
--      automatisch (zonder schrijven). Bij twijfel kiest Maxim in de cockpit;
--      die keuze staat in commissie_factuur_koppeling. invoices.deal_id wordt
--      NOOIT overschreven (dat is de Teamleader-waarheid).
--   2. Incasso: vanaf de incassodatum is de klant niet meer voor de mentor.
--      mentor_commissie_incasso legt dat per klant (deal_id NULL) of per sale
--      vast. De grootboekregels blijven ONGEMOEID: de vrijgave-engine en het
--      overzicht laten betalingen vanaf `sinds` gewoon niet meer meetellen.
--      Opheffen = opgeheven_op invullen; dan telt het weer mee.
--
-- ADDITIEF. Code is fail-soft zolang dit bestand niet gedraaid is (geen
-- markeringen, alleen automatische koppeling).
-- Supabase SQL-editor: losse statements, geen DO-blocks.
-- =============================================================================

-- 1) Incasso-markering ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mentor_commissie_incasso (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES public.deals(id) ON DELETE CASCADE,   -- NULL = alle sales van de klant
  sinds           date NOT NULL,
  reden           text NOT NULL,
  bron            text NOT NULL DEFAULT 'handmatig',                   -- handmatig | voorstel
  gezet_door      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  gezet_op        timestamptz NOT NULL DEFAULT now(),
  opgeheven_op    timestamptz,
  opgeheven_door  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  opheffen_reden  text
);

ALTER TABLE public.mentor_commissie_incasso
  DROP CONSTRAINT IF EXISTS mentor_commissie_incasso_bron_check;
ALTER TABLE public.mentor_commissie_incasso
  ADD CONSTRAINT mentor_commissie_incasso_bron_check
  CHECK (bron IN ('handmatig','voorstel'));

-- Eén actieve markering per (klant, sale) en één per klant (deal_id NULL).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mentor_commissie_incasso_actief_deal
  ON public.mentor_commissie_incasso (customer_id, deal_id)
  WHERE opgeheven_op IS NULL AND deal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_mentor_commissie_incasso_actief_klant
  ON public.mentor_commissie_incasso (customer_id)
  WHERE opgeheven_op IS NULL AND deal_id IS NULL;

COMMENT ON TABLE public.mentor_commissie_incasso IS
  'Incasso voor de mentorcommissie: betalingen met datum >= sinds tellen niet meer voor de mentor (vrijgave + projectie). Al vrijgegeven/uitbetaald blijft. Grootboek wordt niet aangeraakt. Opheffen via opgeheven_op. Schrijven alleen via api/commissie-incasso.js.';

-- 2) Koppeling regelingsfactuur → sale ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.commissie_factuur_koppeling (
  invoice_id   uuid PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES public.customers(id) ON DELETE CASCADE,
  deal_id      uuid REFERENCES public.deals(id) ON DELETE CASCADE,       -- NULL = hoort bij geen commissie-sale
  bron         text NOT NULL DEFAULT 'handmatig',
  note         text,
  gezet_door   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  gezet_op     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.commissie_factuur_koppeling
  DROP CONSTRAINT IF EXISTS commissie_factuur_koppeling_bron_check;
ALTER TABLE public.commissie_factuur_koppeling
  ADD CONSTRAINT commissie_factuur_koppeling_bron_check
  CHECK (bron IN ('auto','handmatig'));

CREATE INDEX IF NOT EXISTS idx_commissie_factuur_koppeling_customer
  ON public.commissie_factuur_koppeling (customer_id);

COMMENT ON TABLE public.commissie_factuur_koppeling IS
  'Welke commissie-sale (deal) hoort bij een factuur zonder deal/abonnement (typisch een regeling na creditering). deal_id NULL = bewust bij geen enkele sale. Overschrijft invoices.deal_id NIET. Schrijven alleen via api/commissie-factuur-koppelen.js.';

-- 3) RLS — lezen manager+, schrijven alleen service_role ────────────────────────
ALTER TABLE public.mentor_commissie_incasso ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commissie_factuur_koppeling ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.mentor_commissie_incasso FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.commissie_factuur_koppeling FROM anon, authenticated;
REVOKE ALL ON public.mentor_commissie_incasso FROM anon;
REVOKE ALL ON public.commissie_factuur_koppeling FROM anon;

DROP POLICY IF EXISTS mentor_commissie_incasso_select ON public.mentor_commissie_incasso;
CREATE POLICY mentor_commissie_incasso_select ON public.mentor_commissie_incasso
  FOR SELECT TO authenticated USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

DROP POLICY IF EXISTS commissie_factuur_koppeling_select ON public.commissie_factuur_koppeling;
CREATE POLICY commissie_factuur_koppeling_select ON public.commissie_factuur_koppeling
  FOR SELECT TO authenticated USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- =============================================================================
-- POST-CHECK
-- =============================================================================
-- SELECT to_regclass('public.mentor_commissie_incasso'), to_regclass('public.commissie_factuur_koppeling');
-- SELECT tablename, policyname FROM pg_policies
--  WHERE tablename IN ('mentor_commissie_incasso','commissie_factuur_koppeling');   -- 2 rijen
-- SELECT relname, relrowsecurity FROM pg_class
--  WHERE relname IN ('mentor_commissie_incasso','commissie_factuur_koppeling');      -- beide true
--
-- ROLLBACK
-- DROP TABLE IF EXISTS public.commissie_factuur_koppeling;
-- DROP TABLE IF EXISTS public.mentor_commissie_incasso;
