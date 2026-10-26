-- PROJECT: forex-command-center (nsjnsvlmdhunzqkdvagm)
--
-- 2026-10-26-trial-opvolging-wa-sjablonen.sql — WhatsApp-templates van de
-- trial-opvolging koppelen (docs/trial-opvolging-whatsapp.md).
--
-- Zet per WhatsApp-stap een onderhoud_sjablonen-rij (traject 'the-lab') met de
-- naam van het Meta-template. Zolang Meta het template niet goedkeurde, slaat
-- de motor WhatsApp over (status niet_goedgekeurd, gelogd) — er gaat dus niets
-- weg door deze migratie. Alleen INSERT van rijen die nog niet bestaan; een
-- bestaande rij (zelfde traject + soort + kanaal) blijft onaangeroerd.
-- Niet blokkerend: zonder deze rijen meldt de motor 'geen_template'.
--
-- Rollback:
--   delete from public.onderhoud_sjablonen
--    where traject_slug = 'the-lab' and kanaal = 'whatsapp'
--      and meta_template in ('trial_welkom','trial_niet_ingelogd_48u','trial_uitnodiging_sessie','trial_laatste_dag','trial_verlopen');

-- Controle VÓÓR — verwacht: 0
select count(*) as wa_rijen from public.onderhoud_sjablonen where traject_slug = 'the-lab' and kanaal = 'whatsapp';

insert into public.onderhoud_sjablonen (traject_slug, soort, kanaal, meta_template, variabele_volgorde, tekst, actief)
select v.traject_slug, v.soort, 'whatsapp', v.meta_template, array['voornaam', 'loginlink'], v.tekst, true
  from (values
    ('the-lab', 'welkom', 'trial_welkom',
     'Hey {{1}}! 👋 Je toegang staat klaar: 7 dagen in de leeromgeving van De Forex Opleiding. Begin met de eerste video en plaats daarna je eerste (simulatie)trade in The Lab. Log in met één klik: {{2}}'),
    ('the-lab', 'niet-ingelogd-48u', 'trial_niet_ingelogd_48u',
     'Hey {{1}}, je toegang loopt maar 7 dagen en je bent nog niet ingelogd. Zet er vanavond tien minuten voor opzij — één klik en je zit erin: {{2}}'),
    ('the-lab', 'uitnodiging-sessie', 'trial_uitnodiging_sessie',
     'Hey {{1}}, sterk bezig! Tijd om het concreet te maken: plan je strategiesessie van 30 minuten met ons team (t.w.v. €100, voor jou gratis). Kies je moment: {{2}}'),
    ('the-lab', 'laatste-dag', 'trial_laatste_dag',
     'Hey {{1}}, vandaag is je laatste dag toegang. Twijfel je nog? Plan je gratis strategiesessie — 30 minuten, zonder verplichtingen. Je gaat buiten met een plan: {{2}}'),
    ('the-lab', 'verlopen', 'trial_verlopen',
     'Hey {{1}}, je 7 dagen zitten erop. Wil je verder? Plan een sessie met ons team, dan bekijken we samen wat er voor jou mogelijk is: {{2}}')
  ) as v (traject_slug, soort, meta_template, tekst)
 where not exists (
   select 1 from public.onderhoud_sjablonen s
    where s.traject_slug = v.traject_slug and s.soort = v.soort and s.kanaal = 'whatsapp'
 );

-- Controle NA — verwacht: 5
select soort, meta_template, actief from public.onderhoud_sjablonen
 where traject_slug = 'the-lab' and kanaal = 'whatsapp' order by soort;
