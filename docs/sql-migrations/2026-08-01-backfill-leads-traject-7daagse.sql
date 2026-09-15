-- ============================================================================
-- Backfill: 7-daagse-leads zonder traject krijgen de funnel-slug '7-daagse'
-- Datum: 2026-08-01
--
-- REDEN
-- De onderhoud_wachtrij-view start met een CTE die filtert op
--   FROM leads l ... WHERE l.traject IS NOT NULL
-- en joint daarna op onderhoud_trajecten.slug = traject. 7-daagse-trial-leads
-- komen echter binnen met traject = NULL (de website vult alleen bij student-
-- aanmeldingen een sub-traject in). Daardoor vallen ze meteen uit de wachtrij
-- en krijgen ze nooit de welkom-WhatsApp (stap 'welkom' / aanleiding na_start).
--
-- Deze backfill zet de bestaande 7-daagse-leads op traject = '7-daagse', zodat
-- ze door filter #1 én de join (onderhoud_trajecten.slug='7-daagse', actief)
-- heen komen. De website is los gefixt (dfo-website: traject = body.traject ||
-- body.soort || null) zodat NIEUWE leads dit meteen goed hebben.
--
-- SCOPE / VEILIGHEID
--   * Alleen soort='7-daagse' EN traject IS NULL.
--   * Raakt GEEN student-leads (die hebben traject='1-op-1 begeleiding' of
--     'Membership').
--   * Raakt de gedeelde view NIET — dit is puur een data-update.
--
-- Draai de stappen in volgorde; review stap 1 vóór stap 2.
-- ============================================================================

-- Stap 1 — REVIEW: hoeveel rijen worden geraakt, en welke?
SELECT id, email, soort, traject, aangemaakt
FROM public.leads
WHERE soort = '7-daagse' AND traject IS NULL
ORDER BY aangemaakt DESC;

-- Stap 2 — De backfill.
UPDATE public.leads
SET traject = '7-daagse'
WHERE soort = '7-daagse' AND traject IS NULL;

-- Stap 3 — VERIFIEER: alle 7-daagse-leads horen nu traject='7-daagse' te hebben.
SELECT traject, count(*)
FROM public.leads
WHERE soort = '7-daagse'
GROUP BY traject
ORDER BY traject;

-- Stap 4 (optioneel) — controleer dat de wachtrij nu welkom-rijen oplevert
-- (na een cron-ronde of direct op de view):
--   SELECT lead_id, soort, kanaal, voornaam, telefoon_e164
--   FROM public.onderhoud_wachtrij
--   WHERE soort = 'welkom';

-- ----------------------------------------------------------------------------
-- ROLLBACK (indien nodig)
-- LET OP: onderstaande zet ALLE 7-daagse-leads met traject='7-daagse' terug op
-- NULL — inclusief leads die vóór deze backfill al legitiem '7-daagse' hadden
-- (bv. handmatig gezet). Wil je uitsluitend déze migratie terugdraaien, noteer
-- dan in stap 1 de geraakte id's en gebruik:
--   UPDATE public.leads SET traject = NULL WHERE id IN ( ...geraakte id's... );
--
-- Grove rollback (alles):
--   UPDATE public.leads SET traject = NULL
--   WHERE soort = '7-daagse' AND traject = '7-daagse';
-- ----------------------------------------------------------------------------
