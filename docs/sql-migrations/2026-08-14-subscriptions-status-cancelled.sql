-- Migratie 2026-08-14: subscriptions.status mag 'cancelled' zijn.
--
-- Aanleiding: de "Deactiveren"-knop pusht de deactivering naar Teamleader en
-- zet daarna lokaal status='cancelled' (api/sales-subscription-delete.js). Maar
-- de CHECK-constraint stond op ('active','paused','completed') → de lokale
-- update gooide een 23514 CHECK-violation NÁ de geslaagde TL-push: TL uit,
-- lokaal bleef 'active', en de knop bleef "Deactiveren" tonen.
--
-- 'cancelled' is de bedoelde waarde (sales.html SUB_STATUS + de knop-verberg-
-- conditie gebruiken 'cancelled'; abonnementen.js mapt 'cancelled'→'Beëindigd').
-- Deze migratie voegt 'cancelled' toe aan de toegestane set.

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active','paused','completed','cancelled'));

-- Rollback (alleen mogelijk als er geen 'cancelled'-rijen zijn):
-- ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_status_check;
-- ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_status_check
--   CHECK (status IN ('active','paused','completed'));
