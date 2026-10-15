-- ============================================================================
-- Strategie-scan — fase 2: privé storage-bucket voor rapport + certificaat
-- Datum: 2026-10-15
-- Branch: feat/scan-fase2
--
-- ⚠ BLOKKEREND voor "Verstuur rapport": api/scan-rapport.js uploadt beide PDF's
--   naar de bucket `scan-rapporten` VÓÓR het mailen. Zonder bucket faalt de
--   upload en wordt er niets gemaild (de scan blijft 'afgerond', er gaat niets
--   half mis). Het voorbeeld bekijken (PDF in de browser) werkt wél zonder.
--
-- Privé (public = false), alleen PDF, max 10 MB per bestand. Geen policies op
-- storage.objects: alleen de service-role (de API, na requirePermission
-- 'scan.use') leest en schrijft; bekijken gaat via een tijdelijke signed URL.
-- Zelfde patroon als `dunning-briefs` / `follow-up-screenshots`.
--
-- Idempotent: ON CONFLICT DO NOTHING.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('scan-rapporten', 'scan-rapporten', false, 10485760, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- ── CONTROLE ────────────────────────────────────────────────────────────────
-- Verwacht: één rij, public = false.
-- SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'scan-rapporten';

-- ── ROLLBACK (alleen als de bucket leeg is) ─────────────────────────────────
-- DELETE FROM storage.buckets WHERE id = 'scan-rapporten';
