-- 2026-11-06-cash-ontvangsten.sql
--
-- CASHBETALING REGISTREREN (beslissing Maxim, 6 nov 2026).
-- Een contante betaling op een open factuur loopt via de gewone betaalflow
-- (register-payment-internal: Teamleader + payments + invoices + factuurmotor).
-- De factuur blijft staan en wordt NIET gecrediteerd. Deze tabel bewaart wat
-- de gewone payments-rij niet kent: wie het geld ontving, de verplichte
-- notitie en het nummer van het ontvangstbewijs (PDF).
--
-- ⚠ BLOKKEREND voor de knop: zonder deze tabel weigert
-- POST /api/finance-invoice-register-cash met 503 CASH_NIET_ACTIEF, VÓÓR er
-- iets naar Teamleader gaat. De rest van het CRM werkt ongewijzigd.
--
-- Plakken in de Supabase SQL-editor (elk statement staat op zichzelf).

CREATE SEQUENCE IF NOT EXISTS public.cash_ontvangst_nr_seq START 1;

CREATE TABLE IF NOT EXISTS public.cash_ontvangsten (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bewijsnummer            text NOT NULL UNIQUE
                          DEFAULT ('KAS-' || to_char(now() AT TIME ZONE 'Europe/Brussels', 'YYYY') || '-'
                                   || lpad(nextval('public.cash_ontvangst_nr_seq')::text, 4, '0')),
  payment_id              uuid UNIQUE REFERENCES public.payments(id) ON DELETE SET NULL,
  invoice_id              uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  customer_id             uuid,
  bedrag                  numeric(12,2) NOT NULL CHECK (bedrag > 0),
  ontvangen_op            date NOT NULL,
  ontvangen_door          text NOT NULL CHECK (length(btrim(ontvangen_door)) > 0),
  ontvangen_door_user_id  uuid,
  notitie                 text NOT NULL CHECK (length(btrim(notitie)) >= 5),
  geregistreerd_door      uuid,
  tl_betaalmethode_id     text,
  tl_betaalmethode_naam   text,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_ontvangsten_invoice ON public.cash_ontvangsten (invoice_id, created_at DESC);

ALTER TABLE public.cash_ontvangsten ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cash_ontvangsten FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.cash_ontvangst_nr_seq FROM anon, authenticated;

-- Optioneel: vaste Teamleader-betaalmethode voor cash (anders zoekt de code
-- via paymentMethods.list een methode met de naam cash/contant/kas).
-- INSERT INTO public.app_settings (key, value)
-- VALUES ('teamleader_cash_payment_method_id', '{"id":"<uuid uit Teamleader>"}'::jsonb)
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- POST-CHECK (verwacht: 1 rij, rls = true, 0 rijen data)
SELECT c.relname, c.relrowsecurity AS rls, (SELECT count(*) FROM public.cash_ontvangsten) AS rijen
FROM pg_class c WHERE c.relname = 'cash_ontvangsten';

-- ROLLBACK (alleen zolang er geen echte ontvangsten in staan — anders
-- verlies je de bewijsnummers en notities):
-- DROP TABLE IF EXISTS public.cash_ontvangsten;
-- DROP SEQUENCE IF EXISTS public.cash_ontvangst_nr_seq;
