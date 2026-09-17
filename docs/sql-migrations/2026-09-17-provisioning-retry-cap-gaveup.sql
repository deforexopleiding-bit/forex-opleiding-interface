-- 2026-09-17 · provisioning-retry cap + backoff + give-up-markering.
--
-- ⚠ MOET DRAAIEN VÓÓR of DIRECT NA de code-merge in de begeleidende PR.
-- Zonder deze kolommen faalt de retry-branch met "column ... does not exist".
--
-- CONTEXT
-- ─────────────────────────────────────────────────────────────────────────
-- api/cron-toegang-aanvragen.js stap 2b (PROVISIONING RETRY) probeerde tot
-- deze wijziging elke */2-min tick opnieuw een structureel-falende lead te
-- provisioneren, tot reacted_at >72u oud was. Voor de biemold-lead op
-- 17-09-2026 betekent dat ~2160 identieke 502-pogingen zonder mens-signaal.
-- Nu: max 7 pogingen, exponentiële backoff (1m -> 60m capped), daarna
-- provisioning_gaveup_at + eenmalige admin-mail.
--
-- SCHEMA
-- ─────────────────────────────────────────────────────────────────────────
-- provisioning_attempts           tellen van gedane pogingen (0..7)
-- provisioning_last_attempt_at    tijd van laatste poging (voor backoff-check)
-- provisioning_gaveup_at          NULL zolang we nog proberen; timestamp
--                                 wanneer we opgeven (attempts >= cap)
-- provisioning_gaveup_reason      laatste error-tekst (kopie van provisioned_error
--                                 op het moment van opgeven), zodat we die
--                                 blijven zien ook als een handmatige retry
--                                 de provisioned_error nulled.
-- provisioning_gaveup_notified    true zodra de admin-alarm-mail is verstuurd.
--                                 Voorkomt herhaal-mail op elke tick.
--
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────
-- Twee partial indexes gefocust op de hot paths in de cron:
--   1) retry-candidates: gereageerd + not gaveup + provisioned failed
--   2) notify-candidates: gaveup zonder mail uit
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_toegang_aanvragen_provisioning_notify_pending;
-- DROP INDEX IF EXISTS public.idx_toegang_aanvragen_provisioning_retry_ready;
-- ALTER TABLE public.toegang_aanvragen
--   DROP COLUMN IF EXISTS provisioning_gaveup_notified,
--   DROP COLUMN IF EXISTS provisioning_gaveup_reason,
--   DROP COLUMN IF EXISTS provisioning_gaveup_at,
--   DROP COLUMN IF EXISTS provisioning_last_attempt_at,
--   DROP COLUMN IF EXISTS provisioning_attempts;
--
-- 0 incasso-writes. Read-additive schema-wijziging.

ALTER TABLE public.toegang_aanvragen
  ADD COLUMN IF NOT EXISTS provisioning_attempts        integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS provisioning_last_attempt_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS provisioning_gaveup_at       timestamptz NULL,
  ADD COLUMN IF NOT EXISTS provisioning_gaveup_reason   text        NULL,
  ADD COLUMN IF NOT EXISTS provisioning_gaveup_notified boolean     NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_provisioning_retry_ready
  ON public.toegang_aanvragen (provisioning_last_attempt_at)
  WHERE status = 'gereageerd'
    AND provisioned_at IS NULL
    AND provisioned_error IS NOT NULL
    AND provisioning_gaveup_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_provisioning_notify_pending
  ON public.toegang_aanvragen (provisioning_gaveup_at)
  WHERE provisioning_gaveup_at IS NOT NULL
    AND provisioning_gaveup_notified = false;

NOTIFY pgrst, 'reload schema';
