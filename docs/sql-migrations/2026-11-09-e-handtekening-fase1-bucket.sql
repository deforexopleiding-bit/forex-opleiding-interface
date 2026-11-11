-- ============================================================================
-- E-handtekening — fase 1: privé storage-bucket
-- Datum: 2026-11-09
-- Branch: feat/e-handtekening-fase1
--
-- ⚠ BLOKKEREND voor uploaden en afronden: de originele PDF, de handtekening-
--   beelden en het getekende eindbestand staan in de bucket `e-handtekening`.
--
-- Privé (public = false). Geen policies op storage.objects: alleen de service
-- role (de API, na requirePermission 'esign.view'/'esign.send', of na een
-- geldig teken-token) leest en schrijft. Bekijken gaat via een signed URL van
-- enkele minuten. Supabase versleutelt opslag at-rest (AES-256).
-- Zelfde patroon als `scan-rapporten`.
--
-- PDF tot 25 MB; PNG voor de handtekening- en paraafbeelden.
-- Paden: envelopes/<envelope_id>/origineel-<n>.pdf
--        envelopes/<envelope_id>/handtekeningen/<ontvanger_id>-<soort>.png
--        envelopes/<envelope_id>/getekend.pdf
--
-- Idempotent: ON CONFLICT DO NOTHING.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('e-handtekening', 'e-handtekening', false, 26214400, ARRAY['application/pdf', 'image/png'])
ON CONFLICT (id) DO NOTHING;

-- ── CONTROLE ────────────────────────────────────────────────────────────────
-- Verwacht: één rij, public = false.
-- SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'e-handtekening';

-- ── ROLLBACK (alleen als de bucket leeg is) ─────────────────────────────────
-- DELETE FROM storage.buckets WHERE id = 'e-handtekening';
