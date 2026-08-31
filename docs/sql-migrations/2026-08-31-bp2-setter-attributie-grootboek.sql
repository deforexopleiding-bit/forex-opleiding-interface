-- 2026-08-31-bp2-setter-attributie-grootboek.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
--
-- Bouwpakket 2 (Romy's commissie-systeem op deal-niveau) — SQL-foundation.
--
-- Wat dit doet:
--   1. booking_sources.owner_user_id (nieuwe kolom) — koppelt slug 'romy'
--      aan Romy's auth.users-id zodat de setter bij boeking bekend is.
--   2. follow_up_appointments.setter_user_id (nieuwe kolom) — gevuld door
--      create-appointment-from-lead.js uit booking_sources.owner_user_id.
--   3. deals.setter_user_id (nieuwe kolom) — auto-gevuld in sales-deal-create
--      uit lead → boeking, of handmatig via wizard-picker. Onafhankelijk
--      van sales_user_id (verkoper).
--   4. setter_config — commissie-% per setter (Romy: 3.00).
--   5. setter_ledger_entries — grootboek (gespiegeld op mentor_ledger_entries,
--      maar realize-on-payment: enkel 'vrijgegeven'/'uitbetaald', geen
--      voorgeboekte pending/geannuleerd).
--   6. setter_payouts — payout-bundels per periode.
--   7. RBAC-seed: setter.ledger.view/admin + setter.payout.manage.
--
-- Wat dit NIET doet:
--   - Geen incasso-tabellen aangeraakt (payment_arrangements/pending_actions/
--     dunning_*/finance.html/_lib/dunning-*/_lib/register-payment-internal.js/
--     _lib/mentor-*).
--   - Geen setter-vulling van bestaande deals (start schoon vanaf livegang).
--
-- 0 incasso-writes. Alle nieuwe tabellen zijn setter-scope; RLS zorgt dat
-- een setter alleen eigen entries ziet.

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) booking_sources.owner_user_id
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.booking_sources
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.booking_sources.owner_user_id IS
  'Auth-user die als setter gekoppeld is aan deze bron-slug. NULL = geen '
  'setter-attributie (bv. nieuwsbrief/direct/opvolging). Bij boeking wordt '
  'deze user als setter_user_id op follow_up_appointments gestempeld.';

CREATE INDEX IF NOT EXISTS idx_booking_sources_owner
  ON public.booking_sources (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 2) follow_up_appointments.setter_user_id
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE public.follow_up_appointments
  ADD COLUMN IF NOT EXISTS setter_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.follow_up_appointments.setter_user_id IS
  'Setter die deze call heeft geboekt — auto-gevuld door create-appointment-'
  'from-lead.js uit booking_sources.owner_user_id op de bijhorende slug. '
  'NULL bij bronnen zonder owner (nieuwsbrief/direct) of onbekende slug.';

CREATE INDEX IF NOT EXISTS idx_follow_up_appointments_setter
  ON public.follow_up_appointments (setter_user_id)
  WHERE setter_user_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 3) deals.setter_user_id
-- ═══════════════════════════════════════════════════════════════════════
--
-- Onafhankelijk van sales_user_id (verkoper) — Romy boekt, iemand anders
-- sluit. Bij deal-creatie: auto-lookup via source_lead_id → oudste
-- boeking. Optioneel handmatig via wizard-picker.

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS setter_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.deals.setter_user_id IS
  'Setter die de call heeft geboekt die tot deze deal leidde. Auto-gevuld '
  'via lead-boeking-brug of handmatig ingesteld in de wizard. NULL = geen '
  'setter-attributie → geen commissie. Onafhankelijk van sales_user_id '
  '(verkoper).';

CREATE INDEX IF NOT EXISTS idx_deals_setter
  ON public.deals (setter_user_id)
  WHERE setter_user_id IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 4) setter_config — commissie-% per setter
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.setter_config (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  pct            numeric(5,2) NOT NULL DEFAULT 3.00 CHECK (pct >= 0 AND pct <= 100),
  is_active      boolean NOT NULL DEFAULT true,
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  created_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.setter_config IS
  'Commissie-configuratie per setter. Romy start op 3.00%.';

-- ═══════════════════════════════════════════════════════════════════════
-- 5) setter_payouts — payout-bundels (eerst — FK-target voor ledger)
-- ═══════════════════════════════════════════════════════════════════════
--
-- Manager bundelt alle vrijgegeven ledger-entries van een setter over een
-- periode in 1 payouts-rij; alle entries → status='uitbetaald' + payout_id.

CREATE TABLE IF NOT EXISTS public.setter_payouts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setter_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  total_amount    numeric(10,2) NOT NULL CHECK (total_amount >= 0),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','uitbetaald')),
  period_start    date NOT NULL,
  period_end      date NOT NULL,
  entry_count     integer NOT NULL DEFAULT 0,
  note            text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_setter_payouts_setter  ON public.setter_payouts (setter_user_id);
CREATE INDEX IF NOT EXISTS idx_setter_payouts_status  ON public.setter_payouts (status);

COMMENT ON TABLE public.setter_payouts IS
  'Setter-payout-bundels. Draai via /api/setter-payout-run: bundelt '
  'vrijgegeven ledger-entries van een setter over een periode.';

-- ═══════════════════════════════════════════════════════════════════════
-- 6) setter_ledger_entries — grootboek (realize-on-payment)
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1 rij per (setter, payment). Alleen 2 statussen: 'vrijgegeven' (gerealiseerd
-- door binnengekomen betaling, klaar voor volgende payout-ronde) en
-- 'uitbetaald' (in een setter_payouts-bundel gestort). Forecast/vervallen
-- worden BEREKEND in de overview-endpoint uit subscriptions-stand, niet
-- voorgeboekt.

CREATE TABLE IF NOT EXISTS public.setter_ledger_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setter_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  appointment_id  uuid REFERENCES public.follow_up_appointments(id) ON DELETE SET NULL,
  deal_id         uuid REFERENCES public.deals(id) ON DELETE SET NULL,
  customer_id     uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  invoice_id      uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  payment_id      uuid REFERENCES public.payments(id) ON DELETE SET NULL,
  basis           numeric(10,2) NOT NULL,
  basis_incl_btw  boolean NOT NULL DEFAULT true,
  pct             numeric(5,2) NOT NULL,
  amount          numeric(10,2) NOT NULL,
  status          text NOT NULL DEFAULT 'vrijgegeven'
                    CHECK (status IN ('vrijgegeven','uitbetaald')),
  idempotency_key text UNIQUE NOT NULL,
  payout_id       uuid REFERENCES public.setter_payouts(id) ON DELETE SET NULL,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz
);

CREATE INDEX IF NOT EXISTS idx_setter_ledger_setter    ON public.setter_ledger_entries (setter_user_id);
CREATE INDEX IF NOT EXISTS idx_setter_ledger_status    ON public.setter_ledger_entries (status);
CREATE INDEX IF NOT EXISTS idx_setter_ledger_deal      ON public.setter_ledger_entries (deal_id);
CREATE INDEX IF NOT EXISTS idx_setter_ledger_customer  ON public.setter_ledger_entries (customer_id);
CREATE INDEX IF NOT EXISTS idx_setter_ledger_created   ON public.setter_ledger_entries (created_at DESC);

COMMENT ON TABLE public.setter_ledger_entries IS
  'Setter-commissie-grootboek. Realize-on-payment: 1 rij per (setter, '
  'payment). Statussen: vrijgegeven (klaar voor payout), uitbetaald (in '
  'bundel). Forecast/vervallen worden berekend uit subscriptions-stand '
  'in de overview-endpoint.';

-- ═══════════════════════════════════════════════════════════════════════
-- 7) setter_watermark — cron-tracking mini-tabel
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.setter_watermark (
  key            text PRIMARY KEY,
  last_seen_at   timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.setter_watermark IS
  'Cron-watermark voor cron-setter-cash-release. key=cash_release; '
  'last_seen_at = laatste payment_date die is verwerkt.';

ALTER TABLE public.setter_watermark ENABLE ROW LEVEL SECURITY;
-- Geen SELECT-policy → default deny → alleen service_role kan lezen.

-- ═══════════════════════════════════════════════════════════════════════
-- 8) RLS (setter_config / ledger / payouts)
-- ═══════════════════════════════════════════════════════════════════════

-- setter_config: setter ziet eigen rij, manager/admin ziet alles.
ALTER TABLE public.setter_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS setter_config_select ON public.setter_config;
CREATE POLICY setter_config_select ON public.setter_config
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- setter_ledger_entries: setter ziet eigen rijen, manager/admin ziet alles.
ALTER TABLE public.setter_ledger_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS setter_ledger_select ON public.setter_ledger_entries;
CREATE POLICY setter_ledger_select ON public.setter_ledger_entries
  FOR SELECT TO authenticated USING (
    setter_user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- setter_payouts: idem.
ALTER TABLE public.setter_payouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS setter_payouts_select ON public.setter_payouts;
CREATE POLICY setter_payouts_select ON public.setter_payouts
  FOR SELECT TO authenticated USING (
    setter_user_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- Writes gaan via service_role — geen INSERT/UPDATE/DELETE policies.

-- ═══════════════════════════════════════════════════════════════════════
-- 9) RBAC-seed
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  -- APPOINTMENTSETTER (Romy): mag eigen grootboek + payouts zien.
  ('appointmentsetter', 'setter.ledger.view',   true),

  -- MANAGER + ADMIN: mogen alle setter-data zien én beheren + payouts draaien.
  ('manager', 'setter.ledger.view',    true),
  ('manager', 'setter.ledger.admin',   true),
  ('manager', 'setter.payout.manage',  true),

  ('admin',   'setter.ledger.view',    true),
  ('admin',   'setter.ledger.admin',   true),
  ('admin',   'setter.payout.manage',  true)
ON CONFLICT (role, feature_key) DO NOTHING;

-- super_admin bypasst via wildcard, geen grants nodig.

-- ═══════════════════════════════════════════════════════════════════════
-- 10) SEED Romy's setter_config + koppel 'romy'-slug
-- ═══════════════════════════════════════════════════════════════════════
--
-- HANDMATIG NA MIGRATIE (want Romy's user_id is niet bekend in dit script).
-- Draai deze 2 statements zodra Romy's auth.users-rij bestaat:
--
--   -- 1. Pak Romy's id (of via admin-panel visueel).
--   -- SELECT id, email FROM public.profiles WHERE email = '<romy-email>';
--
--   -- 2. Setter-config aanmaken (3% default).
--   INSERT INTO public.setter_config (user_id, pct, is_active)
--   VALUES ('<romy-user-id>', 3.00, true)
--   ON CONFLICT (user_id) DO NOTHING;
--
--   -- 3. Koppel de 'romy'-slug aan haar auth-user.
--   UPDATE public.booking_sources
--   SET owner_user_id = '<romy-user-id>'
--   WHERE slug = 'romy';

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. Kolommen toegevoegd:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='booking_sources'
--      AND column_name='owner_user_id';
--    SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='follow_up_appointments'
--      AND column_name='setter_user_id';
--    SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='deals'
--      AND column_name='setter_user_id';
--    -- verwacht: 3 kolommen aangemaakt.
--
-- 2. Setter-tabellen bestaan:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_schema='public' AND table_name LIKE 'setter_%';
--    -- verwacht: setter_config, setter_ledger_entries, setter_payouts.
--
-- 3. RBAC-grants:
--    SELECT role, feature_key FROM public.role_permissions
--    WHERE feature_key LIKE 'setter.%' ORDER BY role, feature_key;
--    -- verwacht: 7 rijen (appointmentsetter x1, manager x3, admin x3).
--
-- 4. RLS-policies:
--    SELECT tablename, policyname, cmd FROM pg_policies
--    WHERE tablename LIKE 'setter_%' ORDER BY tablename;
--    -- verwacht: 3 SELECT-policies (setter_config/ledger/payouts).
--
-- 5. Draai de handmatige seeds uit sectie 10 zodra Romy is aangemaakt.
--
-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════
--
-- BEGIN;
--   DELETE FROM public.role_permissions
--     WHERE feature_key IN ('setter.ledger.view','setter.ledger.admin','setter.payout.manage');
--   DROP TABLE IF EXISTS public.setter_ledger_entries CASCADE;
--   DROP TABLE IF EXISTS public.setter_payouts CASCADE;
--   DROP TABLE IF EXISTS public.setter_config CASCADE;
--   ALTER TABLE public.deals DROP COLUMN IF EXISTS setter_user_id;
--   ALTER TABLE public.follow_up_appointments DROP COLUMN IF EXISTS setter_user_id;
--   ALTER TABLE public.booking_sources DROP COLUMN IF EXISTS owner_user_id;
-- COMMIT;
