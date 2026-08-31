-- 2026-08-30-toegang-aanvragen-uniq-index.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
-- Draai deze migratie pas NA:
--   1. Optie 1 (webhook-fix) + Optie 2 (dedup-at-source) leven ≥ enkele
--      dagen zonder regressie.
--   2. 2026-08-30-toegang-aanvragen-cleanup.sql SECTIE B is uitgevoerd
--      en de post-review-verificatie geeft 0 duplicate-groepen.
-- Als er nog duplicate 'wachtend'-rijen per email bestaan, faalt de
-- CREATE INDEX. Fix eerst de cleanup, draai dan deze migratie.
--
-- Doel: partial UNIQUE index als hard-guard tegen dubbele openstaande
-- toegang-aanvragen. Vangt races op die de app-side dedup in
-- toegang-aanvraag-start.js zou missen (bv. 2 concurrent submits binnen
-- ms van elkaar die beide door de SELECT-then-INSERT komen).
--
-- Ontwerp-keuzes:
--   - Alleen op lower(email). Telefoon-based unique zou een functionele
--     expressie-index vergen (right(regexp_replace(telefoon,'\D','','g'),9))
--     wat kwetsbaar is voor NULL-telefoon en internationale nummers zonder
--     landcode. Email is authoritative in de funnel-flow (verplicht veld
--     in toegang-aanvraag-start.js validatie).
--   - `WHERE status = 'wachtend'` — een lead die legitiem opnieuw
--     aanmeldt NÁ provisioning (dus na 'gereageerd') moet dat kunnen. De
--     index blokkeert alleen dubbele OPENSTAANDE aanvragen.
--   - `CONCURRENTLY` — bouwt de index zonder ACCESS EXCLUSIVE lock op
--     `toegang_aanvragen`. Draait iets langer maar blokkeert geen webhook-
--     writes tijdens de build. Vereist dat je 'em BUITEN een transactie
--     draait (Supabase SQL-editor: elk statement default eigen tx, dus OK).
--   - `IF NOT EXISTS` — idempotent bij re-run.
--
-- Effect na live:
--   - toegang-aanvraag-start.js insert die door de app-side dedup ontsnapt
--     wordt door Postgres met SQLSTATE 23505 geweigerd. De endpoint
--     retourneert 500 met dedup-error. Vang die af als je 'em netjes
--     wilt (409 met existing-id retry) — voor nu: 500 is acceptabel
--     want de app-side dedup zou 't sowieso al moeten vangen.
--
-- 0 incasso-writes. Raakt geen finance-/incasso-tabellen.

-- ═══════════════════════════════════════════════════════════════════════
-- PRE-CHECK (draai eerst; verwacht: 0 rijen)
-- ═══════════════════════════════════════════════════════════════════════

SELECT lower(email) AS email_lc, count(*)
FROM public.toegang_aanvragen
WHERE status = 'wachtend'
GROUP BY 1
HAVING count(*) > 1;
-- Als deze ≥1 rij oplevert: STOP. Draai eerst de cleanup-migratie.

-- ═══════════════════════════════════════════════════════════════════════
-- INDEX (draai apart, buiten transactie)
-- ═══════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  uniq_toegang_wachtend_email
ON public.toegang_aanvragen (lower(email))
WHERE status = 'wachtend';

COMMENT ON INDEX public.uniq_toegang_wachtend_email IS
  'Hard-guard tegen dubbele openstaande toegang-aanvragen voor dezelfde persoon. '
  'App-side dedup zit in api/toegang-aanvraag-start.js; deze index vangt races '
  'die tussen de SELECT en INSERT vallen. Alleen wachtend — een lead die na '
  'gereageerd legitiem opnieuw aanmeldt is geen duplicate.';

-- ═══════════════════════════════════════════════════════════════════════
-- POST-CHECK (verifieer dat de index bestaat en actief is)
-- ═══════════════════════════════════════════════════════════════════════

SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'toegang_aanvragen'
  AND indexname = 'uniq_toegang_wachtend_email';
-- Verwacht: 1 rij, indexdef bevat "UNIQUE" + "WHERE (status = 'wachtend'::text)".

-- ═══════════════════════════════════════════════════════════════════════
-- ROLLBACK (indien nodig)
-- ═══════════════════════════════════════════════════════════════════════
--
-- DROP INDEX CONCURRENTLY IF EXISTS public.uniq_toegang_wachtend_email;
