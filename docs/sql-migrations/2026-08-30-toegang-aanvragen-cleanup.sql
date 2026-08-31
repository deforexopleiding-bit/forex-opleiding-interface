-- 2026-08-30-toegang-aanvragen-cleanup.sql
--
-- STATUS: TER REVIEW — NIET AUTOMATISCH DRAAIEN.
-- Draai eerst SECTIE A (dry-run SELECT's) om te zien wat er zou worden
-- opgeruimd. Draai SECTIE B (DELETE) alleen na akkoord van Jeffrey en
-- na Optie 1 + 2 een paar dagen live-verificatie.
--
-- Doel: bestaande dubbele openstaande rijen in public.toegang_aanvragen
-- opruimen zodat de partial UNIQUE index van
-- 2026-08-30-toegang-aanvragen-uniq-index.sql aangemaakt kan worden
-- zonder duplicate-fout.
--
-- Scope (bevestigd read-only): de enige `wachtend`-duplicaten zitten op
-- telefoon +31655270212 (test-accounts administratie@ + biemoldjeffrey@).
-- Query 3 uit de diagnose leverde geen andere `wachtend`-duplicaten op.
-- Als je later toch nog een echte user tegenkomt via de post-review-query
-- onderaan, breid dan SECTIE B uit.
--
-- Regels voor dedup:
--   - Alleen 'wachtend'-rijen worden opgeruimd. 'gereageerd' / 'vervallen'
--     blijven staan (audit-trail).
--   - Per (lower(email)) blijft de OUDSTE 'wachtend'-rij staan (created_at
--     ASC); alle nieuwere 'wachtend'-rijen voor dezelfde email worden
--     verwijderd.
--   - Bij een DELETE worden geen FK's geraakt: `toegang_aanvragen` heeft
--     geen inbound FK's (bevestigd via read-only kijk op migrations/051).
--
-- 0 incasso-writes. Raakt geen finance-/incasso-tabellen.

-- ═══════════════════════════════════════════════════════════════════════
-- SECTIE A — DRY-RUN: kijk wat er zou worden verwijderd.
-- ═══════════════════════════════════════════════════════════════════════

-- A1) Alle groepen met >1 'wachtend'-rij per email.
SELECT
  lower(email)                                 AS email_lc,
  count(*)                                     AS n_rijen,
  array_agg(id ORDER BY created_at ASC)        AS ids_oud_naar_nieuw,
  array_agg(soort ORDER BY created_at ASC)     AS soorten,
  array_agg(created_at ORDER BY created_at ASC) AS created_at_lijst
FROM public.toegang_aanvragen
WHERE status = 'wachtend'
GROUP BY 1
HAVING count(*) > 1
ORDER BY n_rijen DESC;

-- A2) Concrete rijen die zouden worden verwijderd (alles behalve de oudste
--     per email).
SELECT
  ta.id,
  ta.email,
  ta.telefoon,
  ta.soort,
  ta.bron,
  ta.created_at,
  ta.status
FROM public.toegang_aanvragen ta
WHERE ta.status = 'wachtend'
  AND ta.id NOT IN (
    SELECT DISTINCT ON (lower(email)) id
    FROM public.toegang_aanvragen
    WHERE status = 'wachtend'
    ORDER BY lower(email), created_at ASC
  )
ORDER BY ta.email, ta.created_at;

-- A3) Sanity: alle 'wachtend'-rijen op +31655270212 (test-telefoon).
--     Verwacht: administratie@deforexopleiding.nl + biemoldjeffrey@gmail.com,
--     mogelijk beide met 2 rijen (verschillende soort). Geen echte user.
SELECT id, email, telefoon, soort, bron, status, created_at
FROM public.toegang_aanvragen
WHERE right(regexp_replace(telefoon, '\D', '', 'g'), 9) = '655270212'
  AND status = 'wachtend'
ORDER BY email, created_at;

-- ═══════════════════════════════════════════════════════════════════════
-- SECTIE B — DELETE (uitcommentarieerd; alleen draaien na akkoord).
-- ═══════════════════════════════════════════════════════════════════════
--
-- Verwijdert per email de niet-oudste 'wachtend'-rijen. Draai binnen een
-- transactie zodat je 'em kunt terugdraaien als het aantal afwijkt van
-- wat SECTIE A2 verwachtte.
--
-- BEGIN;
--
-- DELETE FROM public.toegang_aanvragen ta
-- WHERE ta.status = 'wachtend'
--   AND ta.id NOT IN (
--     SELECT DISTINCT ON (lower(email)) id
--     FROM public.toegang_aanvragen
--     WHERE status = 'wachtend'
--     ORDER BY lower(email), created_at ASC
--   );
--
-- -- Controleer aantal — moet matchen met SECTIE A2's count(*).
-- SELECT count(*) AS resterend_wachtend_per_email FROM (
--   SELECT lower(email) FROM public.toegang_aanvragen
--   WHERE status = 'wachtend'
--   GROUP BY 1 HAVING count(*) > 1
-- ) s;
-- -- Verwacht: 0
--
-- COMMIT;
-- -- of ROLLBACK; als iets niet klopt.

-- ═══════════════════════════════════════════════════════════════════════
-- POST-REVIEW VERIFICATIE
-- ═══════════════════════════════════════════════════════════════════════
--
-- Draai deze query na SECTIE B om te bevestigen dat er geen 'wachtend'-
-- duplicaten meer bestaan (per email). Verwacht: 0 rijen.
--
-- SELECT lower(email) AS email_lc, count(*)
-- FROM public.toegang_aanvragen
-- WHERE status = 'wachtend'
-- GROUP BY 1
-- HAVING count(*) > 1;
--
-- Pas ná deze verificatie is 2026-08-30-toegang-aanvragen-uniq-index.sql
-- veilig om te draaien.
