-- ============================================================================
-- LEAD-DEDUP — DOC 1 / CLEANUP (draai dit EERST, apart, vóór DOC 2)
-- ============================================================================
-- Doel: één lead per persoon op lower(email). Deze migratie merget bestaande
-- duplicaten tot één survivor-rij (nieuwste interactie wint) en herpoint de
-- verwijzende rijen, ZODAT de UNIEKE index in DOC 2 daarna kan worden gezet.
--
-- Survivor per lower(email): ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC.
-- Behouden bij merge (gezette waarde wint): eigenaar_id, notitie, toestemming.
-- Herpoint vóór delete (beide FK's zijn ON DELETE SET NULL → herpointen behoudt
-- de koppeling): public.lms_gebruikers.lead_id en public.berichten_log.lead_id.
--
-- Jeffrey draait dit. Alles in één transactie; niets wordt automatisch gedraaid.
-- ============================================================================

-- STAP 0 — VOORAF: hoeveel duplicaten zijn er? (informatief, niets wijzigen)
SELECT lower(email) AS email_key, count(*) AS n, array_agg(id) AS ids
FROM public.leads
WHERE email IS NOT NULL AND btrim(email) <> ''
GROUP BY lower(email)
HAVING count(*) > 1
ORDER BY n DESC;


BEGIN;

-- 1) Survivor per lower(email) = nieuwste interactie.
CREATE TEMP TABLE lead_survivor ON COMMIT DROP AS
SELECT k, keep_id
FROM (
  SELECT lower(email) AS k, id AS keep_id,
         row_number() OVER (
           PARTITION BY lower(email)
           ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC NULLS LAST, id DESC
         ) AS rn
  FROM public.leads
  WHERE email IS NOT NULL AND btrim(email) <> ''
) s
WHERE rn = 1;

-- 2) Merge behouden velden van de dups naar de survivor (gezette waarde wint).
--    eigenaar_id/notitie: eerste NIET-lege waarde uit de groep.
--    toestemming: sticky OR over de hele groep.
WITH agg AS (
  SELECT lower(email) AS k,
         (array_agg(eigenaar_id) FILTER (WHERE eigenaar_id IS NOT NULL))[1]                       AS eigenaar_id,
         (array_agg(notitie)     FILTER (WHERE notitie IS NOT NULL AND btrim(notitie) <> ''))[1]  AS notitie,
         bool_or(COALESCE(toestemming, false))                                                    AS toestemming
  FROM public.leads
  WHERE email IS NOT NULL AND btrim(email) <> ''
  GROUP BY lower(email)
)
UPDATE public.leads keep SET
  eigenaar_id = COALESCE(keep.eigenaar_id, agg.eigenaar_id),
  notitie     = COALESCE(NULLIF(btrim(keep.notitie), ''), agg.notitie),
  toestemming = COALESCE(keep.toestemming, false) OR agg.toestemming
FROM agg
JOIN lead_survivor sv ON sv.k = agg.k
WHERE keep.id = sv.keep_id;

-- 3) HERPOINT de verwijzende rijen van de dups → survivor (vóór delete).
UPDATE public.lms_gebruikers g SET lead_id = sv.keep_id
FROM public.leads dup
JOIN lead_survivor sv ON sv.k = lower(dup.email)
WHERE g.lead_id = dup.id AND dup.id <> sv.keep_id;

UPDATE public.berichten_log b SET lead_id = sv.keep_id
FROM public.leads dup
JOIN lead_survivor sv ON sv.k = lower(dup.email)
WHERE b.lead_id = dup.id AND dup.id <> sv.keep_id;

-- 4) Verwijder de non-survivors.
DELETE FROM public.leads dup
USING lead_survivor sv
WHERE lower(dup.email) = sv.k AND dup.id <> sv.keep_id;

COMMIT;


-- STAP 5 — CONTROLE (na COMMIT): moet 0 rijen geven.
SELECT lower(email) AS email_key, count(*)
FROM public.leads
WHERE email IS NOT NULL AND btrim(email) <> ''
GROUP BY lower(email)
HAVING count(*) > 1;
