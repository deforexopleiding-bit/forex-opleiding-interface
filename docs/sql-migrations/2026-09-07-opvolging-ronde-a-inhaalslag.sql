-- ═══════════════════════════════════════════════════════════════════════════
-- Opvolging · de slapende aanmeldkaarten alsnog naar ronde A halen
-- 7 september 2026
--
-- GEEN MIGRATIE — een eenmalige opruiming. Er verandert geen enkele kolom,
-- constraint of policy; alleen de `due` van kaarten die door de ontbrekende
-- ronde A te ver vooruit gezet zijn.
--
-- ── WAT ER MIS WAS ─────────────────────────────────────────────────────────
-- Elke aanmeldkaart kreeg bij het aanmaken meteen due = eventdatum min vier
-- (ronde B), ook als de aanmelding weken eerder binnenkwam. De kaart werd dus
-- geboren in slaaptoestand en Dave zag hem pas vlak voor het event. Ronde A —
-- bellen binnen 24 uur na de aanmelding — heeft nooit bestaan.
--
-- De code is gerepareerd, maar de kaarten die er al staan blijven slapen.
--
-- ── NIET BLIND NAAR VOREN HALEN ────────────────────────────────────────────
-- Alleen de kaarten die NOG NOOIT ZIJN AANGERAAKT. Wie al een poging heeft
-- gehad is wél gebeld; die kaart alsnog op vandaag zetten zou Dave werk laten
-- overdoen en het dagrapport vervuilen met leads die geen actie nodig hebben.
--
-- ⚠ DRAAI STAP 1 EN 2 EERST EN LEES ZE. Stap 3 is de enige die schrijft.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── STAP 1 · Wie slaapt er, en is die al aangeraakt? ───────────────────────
-- Verwacht: de kaarten met bron 'event' die verder dan morgen staan. De kolom
-- `pogingen` is de beslissende: 0 betekent nooit gebeld of geappt.
--
-- Lees deze lijst vóór stap 3. Staat er iemand tussen met pogingen > 0, dan
-- blijft die terecht buiten de opruiming.

SELECT
  t.id,
  t.naam,
  t.due,
  t.created_at::date                          AS aangemaakt_op,
  t.bron_ref->>'event_dag'                    AS event_dag,
  count(p.id)                                 AS pogingen,
  max(p.tijdstip)                             AS laatste_poging
FROM public.opvolging_taken t
LEFT JOIN public.opvolging_pogingen p ON p.taak_id = t.id
WHERE t.status = 'open'
  AND t.bron   = 'event'
  AND t.reden  = 'aanmelding'
  AND t.due    > (current_date + 1)
GROUP BY t.id, t.naam, t.due, t.created_at, t.bron_ref
ORDER BY t.due, t.naam;


-- ── STAP 2 · Hoeveel gaan er verschuiven? ──────────────────────────────────
-- Twee getallen: hoeveel er slapen en hoeveel daarvan onaangeraakt zijn.
-- Alleen het tweede getal wordt door stap 3 gewijzigd.

SELECT
  count(*)                                          AS slapend_totaal,
  count(*) FILTER (WHERE g.pogingen = 0)            AS wordt_verschoven,
  count(*) FILTER (WHERE g.pogingen > 0)            AS blijft_staan_want_al_gebeld
FROM (
  SELECT t.id, count(p.id) AS pogingen
  FROM public.opvolging_taken t
  LEFT JOIN public.opvolging_pogingen p ON p.taak_id = t.id
  WHERE t.status = 'open' AND t.bron = 'event' AND t.reden = 'aanmelding'
    AND t.due > (current_date + 1)
  GROUP BY t.id
) g;


-- ── STAP 3 · De onaangeraakte kaarten naar morgen ──────────────────────────
-- Morgen, niet vandaag: dat is dezelfde regel als ronde A in de code (de dag
-- na de aanmelding) en het voorkomt dat er vanochtend ineens zeven kaarten
-- bijkomen in een dag die al loopt. Wie morgen niet gebeld wordt, rolt daarna
-- vanzelf door via cron-opvolging-doorrol.
--
-- `later` gaat op false: die vlag hoort bij de tweede ronde van vandaag en
-- zegt over een dag in de toekomst niets.
--
-- Idempotent: opnieuw draaien raakt niets meer, want na de eerste keer staat
-- de due niet meer verder dan morgen.

UPDATE public.opvolging_taken t
SET    due        = current_date + 1,
       later      = false,
       updated_at = now()
WHERE  t.status = 'open'
  AND  t.bron   = 'event'
  AND  t.reden  = 'aanmelding'
  AND  t.due    > (current_date + 1)
  AND  NOT EXISTS (
         SELECT 1 FROM public.opvolging_pogingen p WHERE p.taak_id = t.id
       );


-- ── CONTROLE ACHTERAF ──────────────────────────────────────────────────────
-- Verwacht: 0 onaangeraakte slapende kaarten. Wat er nog staat, staat er
-- terecht — dat zijn de kaarten die al een poging hebben gehad.
--
-- SELECT count(*) AS nog_slapend_en_onaangeraakt
-- FROM public.opvolging_taken t
-- WHERE t.status = 'open' AND t.bron = 'event' AND t.reden = 'aanmelding'
--   AND t.due > (current_date + 1)
--   AND NOT EXISTS (SELECT 1 FROM public.opvolging_pogingen p WHERE p.taak_id = t.id);
--
-- ── GEEN ROLLBACK ──────────────────────────────────────────────────────────
-- De oude due's zijn niet bewaard, en terugzetten zou betekenen dat deze
-- mensen weer gaan slapen. Wil je het toch: de oude waarde was
-- (bron_ref->>'event_dag')::date - 4.
