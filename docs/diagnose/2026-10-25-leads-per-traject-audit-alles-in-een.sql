-- 2026-10-25 · AUDIT "Leads per traject" — ALLES IN ÉÉN QUERY (alleen lezen).
-- Zelfde inhoud als 2026-10-25-leads-per-traject-audit.sql (Q0–Q9), maar als
-- één resultaat: per sectie eerst een kopregel (r = 0) met de kolomnamen,
-- daaronder de cijfers. Venster: laatste 14 NL-kalenderdagen, test-adressen eruit.
WITH venster AS (
  SELECT (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - interval '13 days') AT TIME ZONE 'Europe/Amsterdam' AS van
),
lb AS (   -- leads aangemaakt in het venster (= wat het dashboard telt)
  SELECT l.*, lower(coalesce(l.traject, '')) AS t, (l.aangemaakt AT TIME ZONE 'Europe/Amsterdam')::date AS dag
  FROM public.leads l, venster
  WHERE l.verwijderd_op IS NULL AND l.aangemaakt >= venster.van
    AND coalesce(l.email, '') NOT ILIKE '%test%' AND coalesce(l.email, '') NOT ILIKE '%deforexopleiding%'
),
lt AS (   -- + de tegel waarin het dashboard ze zet
  SELECT lb.*,
    CASE
      WHEN t = '' THEN '⚠ ONGECATEGORISEERD — geen traject'
      WHEN t LIKE '%7-daagse%' OR t LIKE '%7 daagse%' OR t LIKE '%7daagse%' THEN '7-daagse'
      WHEN t LIKE '%event%'   THEN 'Event-aanmeldingen'
      WHEN t LIKE '%webinar%' THEN 'Webinar'
      WHEN t LIKE '%mini%'    THEN 'Mini cursus'
      ELSE '⚠ ONGECATEGORISEERD — traject zonder tegel'
    END AS tegel
  FROM lb
),
ea AS (
  SELECT a.source, lower(btrim(a.email)) AS mail
  FROM public.event_attendees a, venster
  WHERE a.created_at >= venster.van AND a.is_test IS NOT TRUE
    AND a.status::text <> 'switched_to_other_event'
    AND coalesce(a.email, '') NOT ILIKE '%test%' AND coalesce(a.email, '') NOT ILIKE '%deforexopleiding%'
),
wa AS (
  SELECT w.bron, w.lead_id, lower(btrim(w.email)) AS mail
  FROM public.webinar_aanmeldingen w, venster
  WHERE w.created_at >= venster.van AND w.is_test IS NOT TRUE
    AND coalesce(w.email, '') NOT ILIKE '%test%' AND coalesce(w.email, '') NOT ILIKE '%deforexopleiding%'
),
uit AS (
  -- ── 0 · Per dag: dashboard nagebootst ──
  SELECT 0 AS s, 0 AS r, '' AS k, 0::numeric AS o, '0 · per dag (dashboard nagebootst)' AS sectie,
         'dag' AS c1, 'totaal_dashboard' AS c2, 'tegel_7daagse' AS c3, 'tegel_event' AS c4, 'tegel_webinar' AS c5,
         'tegel_mini' AS c6, 'ongecat_geen_traject' AS c7, 'ongecat_traject_zonder_tegel' AS c8, NULL::text AS tekst
  UNION ALL
  SELECT 0, 1, '', -extract(epoch FROM dag)::numeric, '0 · per dag (dashboard nagebootst)',
         dag::text, count(*)::text,
         count(*) FILTER (WHERE tegel = '7-daagse')::text,
         count(*) FILTER (WHERE t LIKE '%event%')::text,
         count(*) FILTER (WHERE t LIKE '%webinar%')::text,
         count(*) FILTER (WHERE t LIKE '%mini%')::text,
         count(*) FILTER (WHERE tegel = '⚠ ONGECATEGORISEERD — geen traject')::text,
         count(*) FILTER (WHERE tegel = '⚠ ONGECATEGORISEERD — traject zonder tegel')::text, NULL
  FROM lt GROUP BY dag

  -- ── 1 · Per bron × traject + dashboard-tegel ──
  UNION ALL
  SELECT 1, 0, '', 0, '1 · per bron × traject', 'bron', 'traject', 'dashboard_tegel', 'leads', 'waarvan_afwijzer', 'eerste', 'laatste', NULL, NULL
  UNION ALL
  SELECT 1, 1, tegel, -count(*), '1 · per bron × traject',
         coalesce(bron, '(null)'), coalesce(traject, '(null)'), tegel, count(*)::text,
         count(*) FILTER (WHERE afwijzer IS TRUE)::text, min(aangemaakt)::text, max(aangemaakt)::text, NULL, NULL
  FROM lt GROUP BY bron, traject, tegel

  -- ── 2 · Alleen de ongecategoriseerde bak ──
  UNION ALL
  SELECT 2, 0, '', 0, '2 · ongecategoriseerd', 'bron', 'traject', 'soort', 'pagina', 'leads', NULL, NULL, NULL, NULL
  UNION ALL
  SELECT 2, 1, '', -count(*), '2 · ongecategoriseerd',
         coalesce(bron, '(null)'), coalesce(traject, '(null)'), coalesce(soort, '(null)'), coalesce(pagina, '(null)'),
         count(*)::text, NULL, NULL, NULL, NULL
  FROM lt WHERE tegel LIKE '⚠%' GROUP BY bron, traject, soort, pagina

  -- ── 3 · Heraanmeldingen (wel aangemeld, niet als nieuwe lead geteld) ──
  UNION ALL
  SELECT 3, 0, '', 0, '3 · heraanmeldingen (niet geteld)', 'huidig_traject', 'bron', 'heraanmeldingen', NULL, NULL, NULL, NULL, NULL, NULL
  UNION ALL
  SELECT 3, 1, '', -count(*), '3 · heraanmeldingen (niet geteld)',
         coalesce(l.traject, '(null)'), coalesce(l.bron, '(null)'), count(*)::text, NULL, NULL, NULL, NULL, NULL, NULL
  FROM public.leads l, venster
  WHERE l.verwijderd_op IS NULL AND l.laatste_aanmelding >= venster.van AND l.aangemaakt < venster.van
    AND coalesce(l.email, '') NOT ILIKE '%test%' AND coalesce(l.email, '') NOT ILIKE '%deforexopleiding%'
  GROUP BY l.traject, l.bron

  -- ── 4 · Events: aanmeldingen vs leads ──
  UNION ALL
  SELECT 4, 0, '', 0, '4 · events vs leads', 'source', 'aanmeldingen', 'zonder_lead', 'lead_nieuw_in_venster', 'lead_ouder', 'traject_van_die_leads', NULL, NULL, NULL
  UNION ALL
  SELECT 4, 1, '', -count(*), '4 · events vs leads',
         coalesce(ea.source, '(null)'), count(*)::text,
         count(*) FILTER (WHERE x.id IS NULL)::text,
         count(*) FILTER (WHERE x.aangemaakt >= v.van)::text,
         count(*) FILTER (WHERE x.aangemaakt <  v.van)::text,
         string_agg(DISTINCT coalesce(x.traject, '(null)'), ', '), NULL, NULL, NULL
  FROM ea CROSS JOIN venster v
  LEFT JOIN LATERAL (
    SELECT id, aangemaakt, traject FROM public.leads
    WHERE lower(email) = ea.mail AND verwijderd_op IS NULL ORDER BY aangemaakt LIMIT 1
  ) x ON true
  GROUP BY ea.source, v.van

  -- ── 5 · Webinar: aanmeldingen vs leads ──
  UNION ALL
  SELECT 5, 0, '', 0, '5 · webinar vs leads', 'bron', 'aanmeldingen', 'zonder_lead_id', 'geen_lead_op_email', 'lead_nieuw_in_venster', 'lead_ouder', 'lead_met_ander_traject', 'traject_van_die_leads', NULL
  UNION ALL
  SELECT 5, 1, '', -count(*), '5 · webinar vs leads',
         coalesce(wa.bron, '(null)'), count(*)::text,
         count(*) FILTER (WHERE wa.lead_id IS NULL)::text,
         count(*) FILTER (WHERE x.id IS NULL)::text,
         count(*) FILTER (WHERE x.aangemaakt >= v.van)::text,
         count(*) FILTER (WHERE x.aangemaakt <  v.van)::text,
         count(*) FILTER (WHERE x.id IS NOT NULL AND lower(coalesce(x.traject, '')) NOT LIKE '%webinar%')::text,
         string_agg(DISTINCT coalesce(x.traject, '(null)'), ', '), NULL
  FROM wa CROSS JOIN venster v
  LEFT JOIN LATERAL (
    SELECT id, aangemaakt, traject FROM public.leads
    WHERE lower(email) = wa.mail AND verwijderd_op IS NULL ORDER BY aangemaakt LIMIT 1
  ) x ON true
  GROUP BY wa.bron, v.van

  -- ── 6 · The Lab: aanmeldingen vs leads ──
  UNION ALL
  SELECT 6, 0, '', 0, '6 · the lab', 'resultaat', 'aanmeldingen', 'zonder_lead_id', NULL, NULL, NULL, NULL, NULL, NULL
  UNION ALL
  SELECT 6, 1, '', -count(*), '6 · the lab',
         coalesce(la.resultaat, '(null)'), count(*)::text, count(*) FILTER (WHERE la.lead_id IS NULL)::text,
         NULL, NULL, NULL, NULL, NULL, NULL
  FROM public.lab_aanmeldingen la, venster
  WHERE la.aangemaakt >= venster.van
    AND coalesce(la.email, '') NOT ILIKE '%test%' AND coalesce(la.email, '') NOT ILIKE '%deforexopleiding%'
  GROUP BY la.resultaat

  -- ── 7 · Event-vragenlijst (afgewezen / niet doorgeboekt = geen lead) ──
  UNION ALL
  SELECT 7, 0, '', 0, '7 · event-vragenlijst', 'bron', 'resultaat', 'inzendingen', 'niet_aangemeld', 'geen_lead_op_email', NULL, NULL, NULL, NULL
  UNION ALL
  SELECT 7, 1, coalesce(s.bron, '') || coalesce(s.resultaat, ''), -count(*), '7 · event-vragenlijst',
         coalesce(s.bron, '(null)'), coalesce(s.resultaat, '(null)'), count(*)::text,
         count(*) FILTER (WHERE s.attendee_id IS NULL)::text,
         count(*) FILTER (WHERE x.id IS NULL)::text, NULL, NULL, NULL, NULL
  FROM public.event_kwalificatie_submissions s
  CROSS JOIN venster
  LEFT JOIN LATERAL (
    SELECT id FROM public.leads WHERE lower(email) = lower(btrim(s.email)) AND verwijderd_op IS NULL LIMIT 1
  ) x ON true
  WHERE s.created_at >= venster.van
    AND coalesce(s.email, '') NOT ILIKE '%test%' AND coalesce(s.email, '') NOT ILIKE '%deforexopleiding%'
  GROUP BY s.bron, s.resultaat

  -- ── 8 · Funnelmeting: lead ingediend met/zonder gekoppelde lead ──
  UNION ALL
  SELECT 8, 0, '', 0, '8 · funnelmeting lead_ingediend', 'variant', 'sessies_lead_ingediend', 'met_lead_id', 'zonder_lead_id', NULL, NULL, NULL, NULL, NULL
  UNION ALL
  SELECT 8, 1, '', -count(DISTINCT fe.session_id), '8 · funnelmeting lead_ingediend',
         fe.variant, count(DISTINCT fe.session_id)::text,
         count(DISTINCT fe.session_id) FILTER (WHERE fe.lead_id IS NOT NULL)::text,
         count(DISTINCT fe.session_id) FILTER (WHERE fe.lead_id IS NULL)::text, NULL, NULL, NULL, NULL, NULL
  FROM public.funnel_events fe, venster
  WHERE fe.event_type = 'lead_ingediend' AND fe.ts >= venster.van
  GROUP BY fe.variant

  -- ── 9 · Databasefuncties die niet in de code staan (definitie in kolom tekst) ──
  UNION ALL
  SELECT 9, 0, '', 0, '9 · functiedefinities', 'functie', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'definitie'
  UNION ALL
  SELECT 9, 1, p.proname::text, 0, '9 · functiedefinities', p.proname::text, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         pg_get_functiondef(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname IN ('spiegel_attendee_naar_lead', 'upsert_lead')
)
SELECT sectie, r, c1, c2, c3, c4, c5, c6, c7, c8, tekst
FROM uit
ORDER BY s, r, k, o, c1;
