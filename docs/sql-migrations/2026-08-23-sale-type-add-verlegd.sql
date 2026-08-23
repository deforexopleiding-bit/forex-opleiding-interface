-- 2026-08-23-sale-type-add-verlegd.sql
-- ===========================================================================
-- SCHEMA-MIGRATIE. HANDMATIG draaien in Supabase, MET review.
-- Doel: sale_type-CHECK op public.deals uitbreiden met de waarde 'verlegd'
--       (binnenlandse B2B-verlegging / medecontractant). SUPERSET — er wordt
--       niets verwijderd; bestaande 'domestic'/'intracommunautair'/'outside_eu'
--       blijven geldig. Geen data-mutatie, geen backfill (dat is stap 3).
--
-- STATUS: STAP 1 is op 2026-08-23 gedraaid en bevestigd (constraint bevat nu 4
--         waarden incl. 'verlegd'). Dit bestand rijdt mee in de stap-2-PR als
--         schema-documentatie/audit-trail.
-- ===========================================================================


-- ── STAP 0 — DIAGNOSE (read-only) ──────────────────────────────────────────
-- 0a. Huidige CHECK-definitie ophalen. Bevestig dat de constraint 'verlegd' NIET
--     bevat en dat de naam 'deals_sale_type_check' is (die DROPpen we in STAP 1).
SELECT con.conname                         AS constraint_naam,
       pg_get_constraintdef(con.oid)       AS huidige_definitie
FROM pg_constraint con
JOIN pg_class rel   ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid  = rel.relnamespace
WHERE n.nspname = 'public'
  AND rel.relname = 'deals'
  AND con.contype = 'c'
  AND pg_get_constraintdef(con.oid) ILIKE '%sale_type%';

-- 0b. Tellingen per bestaande waarde — momentopname vóór de wijziging.
SELECT COALESCE(sale_type, '(null)') AS sale_type, COUNT(*) AS aantal_deals
FROM public.deals
GROUP BY sale_type
ORDER BY aantal_deals DESC;


-- ── STAP 1 — CHECK UITBREIDEN (schema-mutatie, in transactie) ──────────────
-- DROP de bestaande CHECK en voeg de superset-CHECK toe (nu expliciet benoemd,
-- zodat toekomstige migraties een stabiele naam hebben). Alle bestaande rijen
-- blijven valideren (superset), dus de ADD kan niet falen op bestaande data.
BEGIN;

ALTER TABLE public.deals
  DROP CONSTRAINT IF EXISTS deals_sale_type_check;

ALTER TABLE public.deals
  ADD CONSTRAINT deals_sale_type_check
  CHECK (sale_type IN ('domestic', 'intracommunautair', 'outside_eu', 'verlegd'));

-- Controle binnen de transactie: de nieuwe definitie moet nu 4 waarden tonen.
SELECT pg_get_constraintdef(con.oid) AS nieuwe_definitie
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace n ON n.oid = rel.relnamespace
WHERE n.nspname = 'public' AND rel.relname = 'deals'
  AND con.conname = 'deals_sale_type_check';
-- 4 waarden incl. 'verlegd'? → COMMIT;   Iets anders? → ROLLBACK;

COMMIT;
-- ROLLBACK;


-- ── ROLLBACK (indien later terugdraaien nodig) ─────────────────────────────
-- LET OP: dit kan alleen als er GEEN deals met sale_type='verlegd' bestaan
-- (anders faalt de oude 3-waarde-CHECK). Draai dus vóór stap 3, of zet die deals
-- eerst terug op 'domestic'.
-- BEGIN;
--   ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_sale_type_check;
--   ALTER TABLE public.deals ADD CONSTRAINT deals_sale_type_check
--     CHECK (sale_type IN ('domestic', 'intracommunautair', 'outside_eu'));
-- COMMIT;
