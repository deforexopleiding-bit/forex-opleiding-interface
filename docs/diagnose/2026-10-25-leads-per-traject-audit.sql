-- 2026-10-25 · AUDIT "Leads per traject" (dashboard) — ALLEEN LEZEN.
--
-- Alleen SELECT. Geen writes. Elke query staat los; draai ze één voor één in de
-- Supabase SQL-editor. Venster: de laatste 14 NL-kalenderdagen (vandaag + 13).
--
-- HOE HET DASHBOARD TELT (api/_lib/leads-per-traject-compute.js +
-- modules/klanten-v2/views/dashboard-v2.js):
--   * totaal  = leads met aangemaakt in de periode, verwijderd_op IS NULL,
--               e-mail zonder 'test'/'deforexopleiding' (afwijzers tellen MEE);
--   * tegels  = dezelfde rijen, gegroepeerd op leads.traject (NIET op bron),
--               met substring-matching op lower(traject):
--                 7-daagse           ← '7-daagse' | '7 daagse' | '7daagse'
--                 Event-aanmeldingen ← 'event'
--                 Webinar            ← 'webinar'
--                 Mini cursus        ← 'mini'
--   * alles met een ander traject of traject NULL telt in het totaal, niet in
--     een tegel = de "verdwenen" aanmeldingen.
--   * heraanmeldingen (bestaande lead die zich opnieuw aanmeldt) tellen NIET:
--     upsert_lead ontdubbelt op e-mail, aangemaakt blijft de oude datum.

-- ═══ Q0 · Reproductie dashboard per dag: totaal vs tegels vs ongecategoriseerd ═══
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
), l AS (
  SELECT (aangemaakt AT TIME ZONE 'Europe/Amsterdam')::date AS dag, lower(coalesce(traject, '')) AS t, afwijzer
  FROM public.leads, venster
  WHERE verwijderd_op IS NULL AND aangemaakt >= venster.van
    AND coalesce(email, '') NOT ILIKE '%test%' AND coalesce(email, '') NOT ILIKE '%deforexopleiding%'
)
SELECT dag,
       count(*)                                                                          AS totaal_dashboard,
       count(*) FILTER (WHERE t LIKE '%7-daagse%' OR t LIKE '%7 daagse%' OR t LIKE '%7daagse%') AS tegel_7daagse,
       count(*) FILTER (WHERE t LIKE '%event%')                                          AS tegel_event,
       count(*) FILTER (WHERE t LIKE '%webinar%')                                        AS tegel_webinar,
       count(*) FILTER (WHERE t LIKE '%mini%')                                           AS tegel_mini,
       count(*) FILTER (WHERE t = '')                                                    AS ongecat_geen_traject,
       count(*) FILTER (WHERE t <> '' AND NOT (t LIKE '%7-daagse%' OR t LIKE '%7 daagse%' OR t LIKE '%7daagse%'
                                               OR t LIKE '%event%' OR t LIKE '%webinar%' OR t LIKE '%mini%')) AS ongecat_traject_zonder_tegel
FROM l GROUP BY dag ORDER BY dag DESC;

-- ═══ Q1 · Per bron × traject: aantal leads + de tegel waar het dashboard ze zet ═══
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
)
SELECT coalesce(bron, '(null)')    AS bron,
       coalesce(traject, '(null)') AS traject,
       CASE
         WHEN traject IS NULL OR btrim(traject) = '' THEN '⚠ ONGECATEGORISEERD — geen traject'
         WHEN lower(traject) LIKE '%7-daagse%' OR lower(traject) LIKE '%7 daagse%' OR lower(traject) LIKE '%7daagse%' THEN '7-daagse'
         WHEN lower(traject) LIKE '%event%'   THEN 'Event-aanmeldingen'
         WHEN lower(traject) LIKE '%webinar%' THEN 'Webinar'
         WHEN lower(traject) LIKE '%mini%'    THEN 'Mini cursus'
         ELSE '⚠ ONGECATEGORISEERD — traject zonder tegel'
       END                          AS dashboard_tegel,
       count(*)                     AS leads,
       count(*) FILTER (WHERE afwijzer IS TRUE) AS waarvan_afwijzer,
       min(aangemaakt)              AS eerste,
       max(aangemaakt)              AS laatste
FROM public.leads, venster
WHERE verwijderd_op IS NULL AND aangemaakt >= venster.van
  AND coalesce(email, '') NOT ILIKE '%test%' AND coalesce(email, '') NOT ILIKE '%deforexopleiding%'
GROUP BY 1, 2, 3
ORDER BY dashboard_tegel, leads DESC;

-- ═══ Q2 · Alleen de ongecategoriseerde bak, met soort en pagina ═══
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
)
SELECT coalesce(bron, '(null)') AS bron, coalesce(traject, '(null)') AS traject,
       coalesce(soort, '(null)') AS soort, coalesce(pagina, '(null)') AS pagina, count(*) AS leads
FROM public.leads, venster
WHERE verwijderd_op IS NULL AND aangemaakt >= venster.van
  AND coalesce(email, '') NOT ILIKE '%test%' AND coalesce(email, '') NOT ILIKE '%deforexopleiding%'
  AND NOT (lower(coalesce(traject, '')) LIKE '%7-daagse%' OR lower(coalesce(traject, '')) LIKE '%7 daagse%'
        OR lower(coalesce(traject, '')) LIKE '%7daagse%'  OR lower(coalesce(traject, '')) LIKE '%event%'
        OR lower(coalesce(traject, '')) LIKE '%webinar%'  OR lower(coalesce(traject, '')) LIKE '%mini%')
GROUP BY 1, 2, 3, 4 ORDER BY leads DESC;

-- ═══ Q3 · Heraanmeldingen: wél aangemeld in het venster, maar NIET als nieuwe lead geteld ═══
-- (bestaande lead, laatste_aanmelding in het venster, aangemaakt ervoor)
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
)
SELECT coalesce(traject, '(null)') AS huidig_traject, coalesce(bron, '(null)') AS bron, count(*) AS heraanmeldingen
FROM public.leads, venster
WHERE verwijderd_op IS NULL AND laatste_aanmelding >= venster.van AND aangemaakt < venster.van
  AND coalesce(email, '') NOT ILIKE '%test%' AND coalesce(email, '') NOT ILIKE '%deforexopleiding%'
GROUP BY 1, 2 ORDER BY heraanmeldingen DESC;

-- ═══ Q4 · EVENTS: aanmeldingen (event_attendees) vs leads ═══
-- Een event-aanmelding maakt zelf geen lead; dat doet de DB-trigger
-- spiegel_attendee_naar_lead (definitie: Q9). Kolommen hier:
--   zonder_lead          = geen lead met dit e-mailadres → telt NERGENS;
--   lead_nieuw_in_venster = telt als nieuwe lead (in het dashboard);
--   lead_ouder            = bestaande lead → telt NIET (heraanmelding).
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
), a AS (
  SELECT ea.source, lower(btrim(ea.email)) AS mail
  FROM public.event_attendees ea, venster
  WHERE ea.created_at >= venster.van AND ea.is_test IS NOT TRUE
    AND ea.status::text <> 'switched_to_other_event'
    AND coalesce(ea.email, '') NOT ILIKE '%test%' AND coalesce(ea.email, '') NOT ILIKE '%deforexopleiding%'
)
SELECT coalesce(a.source, '(null)') AS source,
       count(*)                                                    AS aanmeldingen,
       count(*) FILTER (WHERE l.id IS NULL)                        AS zonder_lead,
       count(*) FILTER (WHERE l.aangemaakt >= v.van) AS lead_nieuw_in_venster,
       count(*) FILTER (WHERE l.aangemaakt <  v.van) AS lead_ouder,
       string_agg(DISTINCT coalesce(l.traject, '(null)'), ', ')    AS traject_van_die_leads
FROM a CROSS JOIN venster v
LEFT JOIN LATERAL (
  SELECT id, aangemaakt, traject FROM public.leads
  WHERE lower(email) = a.mail AND verwijderd_op IS NULL ORDER BY aangemaakt LIMIT 1
) l ON true
GROUP BY 1, v.van ORDER BY aanmeldingen DESC;

-- ═══ Q5 · WEBINAR: webinar_aanmeldingen vs leads ═══
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
), w AS (
  SELECT wa.bron, wa.lead_id, lower(btrim(wa.email)) AS mail
  FROM public.webinar_aanmeldingen wa, venster
  WHERE wa.created_at >= venster.van AND wa.is_test IS NOT TRUE
    AND coalesce(wa.email, '') NOT ILIKE '%test%' AND coalesce(wa.email, '') NOT ILIKE '%deforexopleiding%'
)
SELECT coalesce(w.bron, '(null)') AS bron,
       count(*)                                                    AS aanmeldingen,
       count(*) FILTER (WHERE w.lead_id IS NULL)                   AS zonder_lead_id,
       count(*) FILTER (WHERE l.id IS NULL)                        AS geen_lead_op_email,
       count(*) FILTER (WHERE l.aangemaakt >= v.van) AS lead_nieuw_in_venster,
       count(*) FILTER (WHERE l.aangemaakt <  v.van) AS lead_ouder,
       count(*) FILTER (WHERE l.id IS NOT NULL AND lower(coalesce(l.traject, '')) NOT LIKE '%webinar%') AS lead_met_ander_traject,
       string_agg(DISTINCT coalesce(l.traject, '(null)'), ', ')    AS traject_van_die_leads
FROM w CROSS JOIN venster v
LEFT JOIN LATERAL (
  SELECT id, aangemaakt, traject FROM public.leads
  WHERE lower(email) = w.mail AND verwijderd_op IS NULL ORDER BY aangemaakt LIMIT 1
) l ON true
GROUP BY 1, v.van ORDER BY aanmeldingen DESC;

-- ═══ Q6 · THE LAB: lab_aanmeldingen vs leads ═══
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
)
SELECT coalesce(la.resultaat, '(null)') AS resultaat,
       count(*)                                  AS aanmeldingen,
       count(*) FILTER (WHERE la.lead_id IS NULL) AS zonder_lead_id
FROM public.lab_aanmeldingen la, venster
WHERE la.aangemaakt >= venster.van
  AND coalesce(la.email, '') NOT ILIKE '%test%' AND coalesce(la.email, '') NOT ILIKE '%deforexopleiding%'
GROUP BY 1 ORDER BY aanmeldingen DESC;

-- ═══ Q7 · EVENT-VRAGENLIJST: afgewezen of niet doorgeboekt = GEEN lead (bewust) ═══
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
)
SELECT coalesce(s.bron, '(null)') AS bron, s.resultaat,
       count(*)                                    AS inzendingen,
       count(*) FILTER (WHERE s.attendee_id IS NULL) AS niet_aangemeld,
       count(*) FILTER (WHERE l.id IS NULL)          AS geen_lead_op_email
FROM public.event_kwalificatie_submissions s
CROSS JOIN venster
LEFT JOIN LATERAL (
  SELECT id FROM public.leads WHERE lower(email) = lower(btrim(s.email)) AND verwijderd_op IS NULL LIMIT 1
) l ON true
WHERE s.created_at >= venster.van
  AND coalesce(s.email, '') NOT ILIKE '%test%' AND coalesce(s.email, '') NOT ILIKE '%deforexopleiding%'
GROUP BY 1, 2 ORDER BY 1, 2;

-- ═══ Q8 · FUNNEL-METING: 'lead ingediend' per variant, met en zonder gekoppelde lead ═══
-- Website-funnels via /api/lead koppelen lead_id aan de sessie; events,
-- webinar en training niet (daar is lead_id NULL normaal). Een hoge
-- "zonder_lead_id" bij een /api/lead-funnel = mogelijke registratiefout.
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
)
SELECT variant,
       count(DISTINCT session_id)                                     AS sessies_lead_ingediend,
       count(DISTINCT session_id) FILTER (WHERE lead_id IS NOT NULL)  AS met_lead_id,
       count(DISTINCT session_id) FILTER (WHERE lead_id IS NULL)      AS zonder_lead_id
FROM public.funnel_events, venster
WHERE event_type = 'lead_ingediend' AND ts >= venster.van
GROUP BY 1 ORDER BY sessies_lead_ingediend DESC;

-- ═══ Q9 · Definities die NIET in de repo staan (welk traject zet de event-trigger?) ═══
SELECT p.proname, pg_get_functiondef(p.oid) AS definitie
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname IN ('spiegel_attendee_naar_lead', 'upsert_lead');
