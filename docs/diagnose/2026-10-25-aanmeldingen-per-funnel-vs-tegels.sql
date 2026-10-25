-- 2026-10-25 · DIAGNOSE: nieuwe tegel-telling (aanmeldingen per funnel) naast de
-- huidige tegelwaarde (nieuwe leads op leads.traject). ALLEEN LEZEN — één SELECT.
--
-- Zelfde definitie als api/_lib/aanmeldingen-per-funnel.js:
--   7-daagse / Mini  = funnelmeting ('lead ingediend') ∪ nieuwe leads met dat traject,
--                      één per persoon (lead, anders sessie); afgewezen = lead.afwijzer,
--                      anders 'geen_toegang' zonder 'toegang';
--   Event            = event_attendees (geen test, niet verplaatst) + apart de afgewezen
--                      aanmelders uit de vragenlijst (uniek op e-mail);
--   Webinar          = webinar_aanmeldingen (geen test);
--   Overig           = The Lab (lab_aanmeldingen + Lab-leads, uniek op e-mail),
--                      Strategie-scan, Training, Opstartsessie, Overige leads.
--   KOP              = som van de tegels.
-- "huidig" = wat de tegel nu toont: nieuwe leads (aangemaakt in het venster, afwijzers
-- incl., test eruit) op substring van leads.traject. Huidige kop = alle nieuwe leads.
-- Vensters: vandaag, laatste 7 dagen, laatste 30 dagen (NL-kalenderdagen t/m nu).
WITH vensters AS (
  SELECT v.naam, v.nr, (date_trunc('day', now() AT TIME ZONE 'Europe/Amsterdam') - make_interval(days => v.d)) AT TIME ZONE 'Europe/Amsterdam' AS van
  FROM (VALUES ('vandaag', 1, 0), ('7 dagen', 2, 6), ('30 dagen', 3, 29)) AS v(naam, nr, d)
),
leads_v AS (
  SELECT v.naam, l.id, lower(btrim(l.email)) AS mail, lower(coalesce(l.bron, '')) AS bron,
         lower(coalesce(l.traject, '')) AS t, (l.afwijzer IS TRUE) AS afwijzer
  FROM vensters v
  JOIN public.leads l ON l.aangemaakt >= v.van
  WHERE l.verwijderd_op IS NULL
    AND coalesce(l.email, '') NOT ILIKE '%test%' AND coalesce(l.email, '') NOT ILIKE '%deforexopleiding%'
),
-- Huidige tegels (oude telling).
oud AS (
  SELECT naam, tegel, count(*) AS n FROM (
    SELECT naam, CASE
      WHEN t LIKE '%7-daagse%' OR t LIKE '%7 daagse%' OR t LIKE '%7daagse%' THEN '7-daagse'
      WHEN t LIKE '%event%'   THEN 'event'
      WHEN t LIKE '%webinar%' THEN 'webinar'
      WHEN t LIKE '%mini%'    THEN 'mini'
      ELSE 'overig' END AS tegel
    FROM leads_v
  ) x GROUP BY naam, tegel
),
sess AS (
  SELECT v.naam, fe.session_id, min(fe.variant) AS variant, max(fe.lead_id::text) AS lead_id,
         bool_or(fe.event_type = 'lead_ingediend') AS ingediend,
         bool_or(fe.event_type = 'toegang') AS toe, bool_or(fe.event_type = 'geen_toegang') AS geen
  FROM vensters v
  JOIN public.funnel_events fe ON fe.ts >= v.van
  WHERE fe.event_type IN ('lead_ingediend', 'toegang', 'geen_toegang')
  GROUP BY v.naam, fe.session_id
),
sleutels AS (
  SELECT naam, tegel, sleutel, bron_soort, afg FROM (
    SELECT naam,
      CASE WHEN variant LIKE '7-daagse-%' THEN '7-daagse'
           WHEN variant LIKE 'kennismakingscursus-%' OR variant LIKE 'strategiesessie-%' THEN 'mini'
           WHEN variant LIKE 'strategiescan-%' THEN 'overig · Strategie-scan'
           WHEN variant ~ '^training-[0-9]{2}-[0-9]{2}-[0-9]{2}$' THEN 'overig · Training'
      END AS tegel,
      coalesce('lead:' || lead_id, 'sessie:' || session_id::text) AS sleutel, 'funnel' AS bron_soort, (geen AND NOT toe) AS afg
    FROM sess WHERE ingediend
    UNION ALL
    SELECT naam,
      CASE WHEN t LIKE '%7-daagse%' OR t LIKE '%7 daagse%' OR t LIKE '%7daagse%' THEN '7-daagse'
           WHEN t LIKE '%mini%' OR t LIKE '%kennismakingscursus%' OR t LIKE '%strategiesessie%' THEN 'mini'
           WHEN t LIKE '%event%' OR t LIKE '%webinar%' OR t = 'the-lab' THEN NULL
           WHEN t = 'strategiescan' OR bron LIKE 'strategiescan-%' THEN 'overig · Strategie-scan'
           WHEN bron ~ '^training-[0-9]{2}-[0-9]{2}-[0-9]{2}$' THEN 'overig · Training'
           WHEN t = 'opstartsessie' OR bron = 'opstartsessie' THEN 'overig · Opstartsessie'
           ELSE 'overig · Overige leads'
      END,
      'lead:' || id::text, 'lead', afwijzer
    FROM leads_v
  ) x WHERE tegel IS NOT NULL
),
uniek AS (   -- één per persoon per tegel; de lead (server) wint voor afgewezen
  SELECT naam, tegel, sleutel,
         coalesce(bool_or(afg) FILTER (WHERE bron_soort = 'lead'), bool_and(afg)) AS afg
  FROM sleutels GROUP BY naam, tegel, sleutel
),
lab AS (
  SELECT naam, count(DISTINCT k) AS n FROM (
    SELECT v.naam, 'mail:' || lower(btrim(la.email)) AS k
    FROM vensters v JOIN public.lab_aanmeldingen la ON la.aangemaakt >= v.van
    WHERE coalesce(la.email, '') NOT ILIKE '%test%' AND coalesce(la.email, '') NOT ILIKE '%deforexopleiding%'
    UNION
    SELECT naam, coalesce('mail:' || mail, 'lead:' || id::text) FROM leads_v WHERE t = 'the-lab'
  ) x GROUP BY naam
),
ev AS (
  SELECT v.naam, a.id, lower(btrim(a.email)) AS mail
  FROM vensters v JOIN public.event_attendees a ON a.created_at >= v.van
  WHERE a.is_test IS NOT TRUE AND a.status::text <> 'switched_to_other_event'
    AND coalesce(a.email, '') NOT ILIKE '%test%' AND coalesce(a.email, '') NOT ILIKE '%deforexopleiding%'
),
inz AS (
  SELECT v.naam, lower(btrim(s.email)) AS mail, lower(coalesce(s.resultaat, '')) AS res
  FROM vensters v JOIN public.event_kwalificatie_submissions s ON s.created_at >= v.van
  WHERE coalesce(s.email, '') <> '' AND s.email NOT ILIKE '%test%' AND s.email NOT ILIKE '%deforexopleiding%'
),
ev_afg AS (
  SELECT a.naam, count(DISTINCT a.mail) AS n FROM inz a
  WHERE a.res = 'afgewezen'
    AND NOT EXISTS (SELECT 1 FROM inz b WHERE b.naam = a.naam AND b.mail = a.mail AND b.res = 'toegelaten')
    AND NOT EXISTS (SELECT 1 FROM ev e WHERE e.naam = a.naam AND e.mail = a.mail)
  GROUP BY a.naam
),
web AS (
  SELECT v.naam, count(*) AS n
  FROM vensters v JOIN public.webinar_aanmeldingen w ON w.created_at >= v.van
  WHERE w.is_test IS NOT TRUE AND coalesce(w.email, '') NOT ILIKE '%test%' AND coalesce(w.email, '') NOT ILIKE '%deforexopleiding%'
  GROUP BY v.naam
),
nieuw AS (
  SELECT naam, tegel, count(*) AS totaal, count(*) FILTER (WHERE afg) AS afgewezen FROM uniek GROUP BY naam, tegel
  UNION ALL SELECT naam, 'overig · The Lab', n, 0 FROM lab
  UNION ALL SELECT v.naam, 'event', (SELECT count(*) FROM ev WHERE ev.naam = v.naam) + coalesce((SELECT n FROM ev_afg WHERE ev_afg.naam = v.naam), 0),
                   coalesce((SELECT n FROM ev_afg WHERE ev_afg.naam = v.naam), 0) FROM vensters v
  UNION ALL SELECT v.naam, 'webinar', coalesce((SELECT n FROM web WHERE web.naam = v.naam), 0), 0 FROM vensters v
),
tegels AS (   -- de vijf tegels (Overig = som van de delen) + de delen zelf
  SELECT naam, CASE WHEN tegel LIKE 'overig%' THEN 'overig' ELSE tegel END AS tegel,
         sum(totaal) AS totaal, sum(afgewezen) AS afgewezen
  FROM nieuw GROUP BY 1, 2
)
SELECT v.naam AS venster, x.tegel, x.huidig, x.nieuw_totaal, x.nieuw_totaal - x.nieuw_afgewezen AS nieuw_toegelaten,
       x.nieuw_afgewezen, x.nieuw_totaal - x.huidig AS verschil
FROM vensters v
CROSS JOIN LATERAL (
  SELECT t.tegel, t.volgorde,
         coalesce((SELECT o.n FROM oud o WHERE o.naam = v.naam AND o.tegel = t.tegel), 0) AS huidig,
         coalesce((SELECT g.totaal FROM tegels g WHERE g.naam = v.naam AND g.tegel = t.tegel), 0) AS nieuw_totaal,
         coalesce((SELECT g.afgewezen FROM tegels g WHERE g.naam = v.naam AND g.tegel = t.tegel), 0) AS nieuw_afgewezen
  FROM (VALUES ('7-daagse', 1), ('mini', 2), ('event', 3), ('webinar', 4), ('overig', 5)) AS t(tegel, volgorde)
  UNION ALL
  SELECT n.tegel, 6, NULL, n.totaal, n.afgewezen FROM nieuw n WHERE n.naam = v.naam AND n.tegel LIKE 'overig ·%'
  UNION ALL
  SELECT '= KOP (totaal)', 9,
         (SELECT count(*) FROM leads_v l WHERE l.naam = v.naam),
         coalesce((SELECT sum(g.totaal) FROM tegels g WHERE g.naam = v.naam), 0),
         coalesce((SELECT sum(g.afgewezen) FROM tegels g WHERE g.naam = v.naam), 0)
) x
ORDER BY v.nr, x.volgorde, x.tegel;
