-- 2026-10-19 · Strategie-scan als eigen funnel (deforexopleiding.nl/strategiescan-v1)
--
-- NIET destructief: alleen INSERT ... ON CONFLICT DO NOTHING. Opnieuw draaien kan.
-- Niet blokkerend voor de code: zonder deze rijen werkt de boeking ook (de bron is
-- een vrije slug op follow_up_appointments), maar dan
--   · toont Kennismakingsgesprekken de slug i.p.v. het label 'Strategie-scan',
--   · staat 'strategiescan' niet in het bronfilter,
--   · is er geen leadonderhoud-traject 'strategiescan'.
--
-- LOS van The Lab: een strategiesessie uit The Lab blijft bron 'the-lab'.

-- 1) Agendabron. Geen vragenlijst (de funnel boekt meteen), GEEN owner_user_id:
--    dat veld is de setter (commissie). Dave is de eigenaar van de afspraak
--    (owner_id), gezet door api/_lib/strategiescan-boeking.js.
INSERT INTO public.booking_sources (slug, label, actief, vragenlijst)
VALUES ('strategiescan', 'Strategie-scan', true, false)
ON CONFLICT (slug) DO NOTHING;

-- 2) Leadonderhoud-traject. Zonder stappen/sjablonen verstuurt de motor niets;
--    die komen er pas als ze gemaakt worden in Leadsonderhoud > Trajecten.
INSERT INTO public.onderhoud_trajecten (slug, naam, omschrijving, agent, agenda_link, volgorde, actief)
VALUES ('strategiescan', 'Strategie-scan',
        'Leads uit de Strategie-scan-funnel (gratis scan met Dave, t.w.v. €99, rapport + certificaat).',
        '', 'https://www.deforexopleiding.nl/strategiescan-v1', 5, true)
ON CONFLICT (slug) DO NOTHING;

-- Controle (alleen lezen):
-- SELECT slug, label, actief, vragenlijst, owner_user_id FROM public.booking_sources WHERE slug = 'strategiescan';
-- SELECT slug, naam, actief FROM public.onderhoud_trajecten WHERE slug = 'strategiescan';
