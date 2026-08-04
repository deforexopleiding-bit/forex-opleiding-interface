-- ============================================================================
-- LEAD-DEDUP — DOC 1 / CLEANUP (draai dit EERST, apart, vóór DOC 2)
-- ============================================================================
-- Doel: één lead per persoon op lower(email). Deze migratie merget bestaande
-- duplicaten tot één survivor-rij (nieuwste interactie wint) en herpoint de
-- verwijzende rijen, ZODAT de UNIEKE index in DOC 2 daarna kan worden gezet.
--
-- Survivor per lower(email): ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC.
-- Merge (consistent met upsert_lead) — vult de survivor's velden uit de hele
-- e-mailgroep vóór de DELETE, zodat de data van de non-survivors niet verdwijnt:
--   - interactie-data (nieuwste non-null): voornaam, achternaam, telefoon,
--     telefoon_e164, score, kwalificatie, drempel, afwijzer, antwoorden,
--     campagne, pagina
--   - attributie/consent (eerste/oudste behouden): meta_event_id, ip_hash,
--     toestemming_op; toestemming = sticky OR
--   - CRM-eigendom: eigenaar_id/notitie = nieuwste gezette waarde;
--     opgevolgd_op = meest recente; status = non-'nieuw' als survivor='nieuw'
--   - interactie-DEFINITIE blijft de survivor's (traject, event_id, soort, bron)
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

-- 2) Merge de non-survivor-data naar de survivor. De survivor (nieuwste
--    interactie) is vaak een kale event-rij; zonder deze merge zou de DELETE de
--    7-daagse-data + attributie/consent + agent-status van de dups weggooien.
--    Omdat de survivor de hoogste bijgewerkt heeft, is de "nieuwste non-null"
--    over de groep gelijk aan de survivor's eigen waarde als die gezet is, en
--    anders de eerstvolgende non-null uit de groep (= vul survivor's NULLs).
WITH agg AS (
  SELECT lower(email) AS k,
    -- interactie-data: nieuwste non-null wint
    (array_agg(voornaam      ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE voornaam      IS NOT NULL))[1] AS voornaam,
    (array_agg(achternaam    ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE achternaam    IS NOT NULL))[1] AS achternaam,
    (array_agg(telefoon      ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE telefoon      IS NOT NULL))[1] AS telefoon,
    (array_agg(telefoon_e164 ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE telefoon_e164 IS NOT NULL))[1] AS telefoon_e164,
    (array_agg(score         ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE score         IS NOT NULL))[1] AS score,
    (array_agg(kwalificatie  ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE kwalificatie  IS NOT NULL))[1] AS kwalificatie,
    (array_agg(drempel       ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE drempel       IS NOT NULL))[1] AS drempel,
    (array_agg(afwijzer      ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE afwijzer      IS NOT NULL))[1] AS afwijzer,
    (array_agg(antwoorden    ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE antwoorden IS NOT NULL AND antwoorden <> '[]'::jsonb))[1] AS antwoorden,
    (array_agg(campagne      ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE campagne      IS NOT NULL))[1] AS campagne,
    (array_agg(pagina        ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE pagina        IS NOT NULL))[1] AS pagina,
    -- attributie: eerste (oudste) non-null behouden
    (array_agg(meta_event_id ORDER BY aangemaakt ASC NULLS LAST, bijgewerkt ASC) FILTER (WHERE meta_event_id IS NOT NULL))[1] AS meta_event_id,
    (array_agg(ip_hash       ORDER BY aangemaakt ASC NULLS LAST, bijgewerkt ASC) FILTER (WHERE ip_hash       IS NOT NULL))[1] AS ip_hash,
    -- consent: sticky OR + eerste toestemming_op
    bool_or(COALESCE(toestemming, false)) AS toestemming,
    min(toestemming_op)                   AS toestemming_op,
    -- CRM-eigendom: nieuwste gezette waarde; opgevolgd_op = meest recente
    (array_agg(eigenaar_id ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE eigenaar_id IS NOT NULL))[1] AS eigenaar_id,
    (array_agg(notitie     ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE notitie IS NOT NULL AND btrim(notitie) <> ''))[1] AS notitie,
    max(opgevolgd_op) AS opgevolgd_op,
    -- status: nieuwste non-'nieuw' uit de groep (agent-progressie behouden)
    (array_agg(status ORDER BY bijgewerkt DESC NULLS LAST, aangemaakt DESC) FILTER (WHERE status IS NOT NULL AND status <> 'nieuw'))[1] AS status_non_nieuw,
    -- eerste-gezien-datum van de hele groep
    min(aangemaakt) AS min_aangemaakt
  FROM public.leads
  WHERE email IS NOT NULL AND btrim(email) <> ''
  GROUP BY lower(email)
  HAVING count(*) > 1
)
UPDATE public.leads keep SET
  -- interactie-data (survivor's waarde blijft; NULLs worden gevuld)
  voornaam       = agg.voornaam,
  achternaam     = agg.achternaam,
  telefoon       = agg.telefoon,
  telefoon_e164  = agg.telefoon_e164,
  score          = agg.score,
  kwalificatie   = agg.kwalificatie,
  drempel        = agg.drempel,
  afwijzer       = COALESCE(agg.afwijzer,   keep.afwijzer),
  antwoorden     = COALESCE(agg.antwoorden, keep.antwoorden),
  campagne       = agg.campagne,
  pagina         = agg.pagina,
  -- attributie/consent (eerste waarde behouden; sticky)
  meta_event_id  = agg.meta_event_id,
  ip_hash        = agg.ip_hash,
  toestemming    = agg.toestemming,
  toestemming_op = agg.toestemming_op,
  -- CRM-eigendom
  eigenaar_id    = agg.eigenaar_id,
  notitie        = agg.notitie,
  opgevolgd_op   = agg.opgevolgd_op,
  status = CASE WHEN keep.status IS DISTINCT FROM 'nieuw'
                THEN keep.status                          -- survivor al voorbij 'nieuw'
                ELSE COALESCE(agg.status_non_nieuw, keep.status) END,
  -- eerste-gezien-datum behouden (oudste van de groep)
  aangemaakt = LEAST(keep.aangemaakt, agg.min_aangemaakt)
  -- interactie-DEFINITIE (traject, event_id, soort, bron) + bijgewerkt NIET in
  -- de SET: die blijven de survivor's (nieuwste interactie).
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
