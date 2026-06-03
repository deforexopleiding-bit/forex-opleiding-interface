-- ============================================================================
-- CLEANUP test-geïmporteerde TL-records (voor re-import na de bedragen/term_count fix)
-- Datum: 2026-06-03 · Branch: feature/tl-integration
--
-- LET OP: line_items zitten als JSONB op subscriptions (er is GÉÉN
-- subscription_line_items tabel) → geen aparte delete nodig.
-- Volgorde respecteert FK's: subscriptions → ghost-deals → klanten.
-- Alleen VERS geïmporteerde klanten worden verwijderd (imported_from_tl_at gezet);
-- bestaande/gematchte klanten blijven ongemoeid (die hebben imported_from_tl_at NULL).
-- Idempotent: opnieuw draaien is veilig (verwijdert dan 0 rijen).
-- HANDMATIG draaien in Supabase — NIET automatisch.
-- ============================================================================

BEGIN;

-- 1. Geïmporteerde abonnementen.
DELETE FROM public.subscriptions WHERE imported_from_tl_at IS NOT NULL;

-- 2. Ghost-deals van de import (cascade verwijdert eventueel resterende subs).
DELETE FROM public.deals WHERE source = 'tl_import';

-- 3. Alleen de bij de import nieuw-aangemaakte klanten.
DELETE FROM public.customers WHERE imported_from_tl_at IS NOT NULL;

COMMIT;
