-- ============================================================================
-- FASE 1 (TER REVIEW — NIET auto-draaien) — Mini-cursus-rollensysteem: backfill
-- Datum: 2026-08-01  (draaien NA fase 0: 2026-08-01-lms-producten-fase0.sql)
--
-- Vult het fundament uit fase 0 met de bestaande situatie, PUUR ADDITIEF en
-- IDEMPOTENT (ON CONFLICT DO NOTHING). Er wordt GEEN leespad gewijzigd: de LMS
-- blijft in fase 1 op de oude `gratis + toegang_tot`-check lezen, dus de live
-- 7-daagse blijft gewoon werken. Deze data wordt pas gebruikt vanaf fase 2.
--
-- Wat:
--   1) Per bestaande lms_gebruikers → een lms_toegang-grant voor het
--      '7-daagse'-product, met toegang_van/toegang_tot uit de gebruiker-velden
--      (bron='backfill').
--   2) Junction vullen: de huidige gratis-videos → 7-daagse-product, en de
--      gratis-documenten → 7-daagse-product.
-- ============================================================================

-- ── 1) Grant per bestaande gebruiker → 7-daagse-product ─────────────────────
-- toegang_van valt terug op aangemaakt als 'ie onverhoopt leeg is (NOT NULL).
-- toegang_tot wordt 1-op-1 overgenomen (NULL = onbeperkt; behoudt bestaand gedrag).
INSERT INTO public.lms_toegang (gebruiker_id, product_id, toegang_van, toegang_tot, bron)
SELECT g.id, p.id, COALESCE(g.toegang_van, g.aangemaakt), g.toegang_tot, 'backfill'
FROM public.lms_gebruikers g
CROSS JOIN public.lms_producten p
WHERE p.slug = '7-daagse'
ON CONFLICT (gebruiker_id, product_id) DO NOTHING;

-- ── 2a) Gratis videos → 7-daagse-product ────────────────────────────────────
-- (Alle gratis videos; het actief-filter blijft een render-concern. Wil je enkel
--  actieve content koppelen, voeg dan "AND v.actief" toe.)
INSERT INTO public.lms_product_videos (product_id, video_id)
SELECT p.id, v.id
FROM public.lms_videos v
CROSS JOIN public.lms_producten p
WHERE p.slug = '7-daagse' AND v.gratis = true
ON CONFLICT (product_id, video_id) DO NOTHING;

-- ── 2b) Gratis documenten → 7-daagse-product ────────────────────────────────
INSERT INTO public.lms_product_documenten (product_id, document_id)
SELECT p.id, d.id
FROM public.lms_documenten d
CROSS JOIN public.lms_producten p
WHERE p.slug = '7-daagse' AND d.gratis = true
ON CONFLICT (product_id, document_id) DO NOTHING;

-- ── 3) Verificatie ───────────────────────────────────────────────────────────
--   -- grants gelijk aan aantal gebruikers?
--   SELECT (SELECT count(*) FROM public.lms_gebruikers)                                  AS gebruikers,
--          (SELECT count(*) FROM public.lms_toegang t JOIN public.lms_producten p
--             ON p.id = t.product_id WHERE p.slug = '7-daagse')                          AS grants_7daagse;
--   -- junction gelijk aan gratis-content?
--   SELECT (SELECT count(*) FROM public.lms_videos WHERE gratis)                         AS gratis_videos,
--          (SELECT count(*) FROM public.lms_product_videos pv JOIN public.lms_producten p
--             ON p.id = pv.product_id WHERE p.slug = '7-daagse')                         AS videos_gekoppeld,
--          (SELECT count(*) FROM public.lms_documenten WHERE gratis)                     AS gratis_docs,
--          (SELECT count(*) FROM public.lms_product_documenten pd JOIN public.lms_producten p
--             ON p.id = pd.product_id WHERE p.slug = '7-daagse')                         AS docs_gekoppeld;

-- ── ROLLBACK (indien nodig) — verwijdert alleen wat deze backfill maakte ─────
--   DELETE FROM public.lms_product_videos pv USING public.lms_producten p
--     WHERE pv.product_id = p.id AND p.slug = '7-daagse';
--   DELETE FROM public.lms_product_documenten pd USING public.lms_producten p
--     WHERE pd.product_id = p.id AND p.slug = '7-daagse';
--   DELETE FROM public.lms_toegang t USING public.lms_producten p
--     WHERE t.product_id = p.id AND p.slug = '7-daagse' AND t.bron = 'backfill';
