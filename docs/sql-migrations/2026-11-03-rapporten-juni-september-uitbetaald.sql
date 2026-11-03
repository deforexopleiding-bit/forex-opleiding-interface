-- =============================================================================
-- 2026-11-03 — DEFINITIEF (beslissing Maxim 3 nov): mentorrapporten juni t/m
--              september 2026 → status 'uitbetaald'
--
-- WAAROM
--   Deze rapporten zijn effectief uitbetaald, maar staan in mentor_payouts op
--   'goedgekeurd' en hun grootboekregels op 'vrijgegeven'. De knop "Markeer
--   uitbetaald" (RPC mark_payout_paid) faalt op elk van die rapporten met
--   bonus_drift: de RPC telt de regels van de RAPPORTMAAND met payout_id NULL,
--   terwijl payout-generate-core de regels van de maand ervoor koppelt.
--
-- WAT: de 23 rapporten in status 'goedgekeurd' met period_month 2026-06-01 …
--   2026-09-01 (gemeten 3 nov: Chesney 4, Danny 4, Karl 4, Kjento 4, Ricardo 3,
--   Seppe 4) + de grootboekregels die eraan gekoppeld zijn (payout_id) → status
--   'uitbetaald'. paid_at = approved_at (de echte betaaldatum staat niet in het
--   CRM; vervang die waarde als je de juiste datum hebt).
--   NIET inbegrepen: Seppe april 2026 (goedgekeurd, bonus 0,00).
--   GEEN meldingen naar mentoren (de knop zou "Uitbetaling gedaan" sturen).
--
-- ONAFHANKELIJK van de andere migraties; mag voor of na
-- 2026-11-03-cashtraject-naar-factuurmotor.sql.
-- Supabase SQL-editor: losse statements, geen DO-blocks. Volgorde aanhouden.
-- =============================================================================

-- 0) PRE-CHECK — verwacht: 23 rijen, status goedgekeurd, al_uitbetaald 0
SELECT p.id, tm.name, p.period_month, p.status, p.bonus_total, p.approved_at, p.paid_at,
       (SELECT count(*) FROM public.mentor_ledger_entries e WHERE e.payout_id = p.id) AS regels,
       (SELECT count(*) FROM public.mentor_ledger_entries e WHERE e.payout_id = p.id AND e.status = 'uitbetaald') AS al_uitbetaald
  FROM public.mentor_payouts p LEFT JOIN public.team_members tm ON tm.user_id = p.mentor_user_id
 WHERE p.status = 'goedgekeurd' AND p.period_month BETWEEN '2026-06-01' AND '2026-09-01'
 ORDER BY tm.name, p.period_month;

-- 0b) Telling ter controle — verwacht: rapporten 23
SELECT count(*) AS rapporten,
       (SELECT count(*) FROM public.mentor_ledger_entries e JOIN public.mentor_payouts p2 ON p2.id = e.payout_id
         WHERE p2.status = 'goedgekeurd' AND p2.period_month BETWEEN '2026-06-01' AND '2026-09-01' AND e.status = 'vrijgegeven') AS regels_te_zetten
  FROM public.mentor_payouts WHERE status = 'goedgekeurd' AND period_month BETWEEN '2026-06-01' AND '2026-09-01';

-- 1) Grootboekregels van die rapporten → uitbetaald (eerst, via de rapporten in 'goedgekeurd')
UPDATE public.mentor_ledger_entries e
   SET status = 'uitbetaald', paid_at = coalesce(p.approved_at, now())
  FROM public.mentor_payouts p
 WHERE e.payout_id = p.id
   AND e.status = 'vrijgegeven'
   AND p.status = 'goedgekeurd'
   AND p.period_month BETWEEN '2026-06-01' AND '2026-09-01';

-- 2) De rapporten zelf → uitbetaald
UPDATE public.mentor_payouts
   SET status = 'uitbetaald', paid_at = coalesce(approved_at, now())
 WHERE status = 'goedgekeurd'
   AND period_month BETWEEN '2026-06-01' AND '2026-09-01';

-- =============================================================================
-- POST-CHECK
-- =============================================================================
-- a) 23 × uitbetaald, 0 × goedgekeurd in de periode
-- SELECT status, count(*) FROM public.mentor_payouts WHERE period_month BETWEEN '2026-06-01' AND '2026-09-01' GROUP BY 1;
-- b) geen gekoppelde regel meer op vrijgegeven
-- SELECT e.status, count(*), sum(e.amount) FROM public.mentor_ledger_entries e JOIN public.mentor_payouts p ON p.id = e.payout_id
--  WHERE p.period_month BETWEEN '2026-06-01' AND '2026-09-01' GROUP BY 1;     -- enkel 'uitbetaald'
-- c) Controlescherm (Mentoren › Commissies › Controle): "status loopt achter" verdwijnt voor deze maanden.
--
-- =============================================================================
-- ROLLBACK (alleen de rijen van deze run: vervang <TIJDSTIP> door het moment van draaien, bv. '2026-11-03 18:00+01')
-- =============================================================================
-- UPDATE public.mentor_ledger_entries e SET status = 'vrijgegeven', paid_at = NULL
--   FROM public.mentor_payouts p
--  WHERE e.payout_id = p.id AND p.period_month BETWEEN '2026-06-01' AND '2026-09-01'
--    AND p.status = 'uitbetaald' AND e.status = 'uitbetaald';
-- UPDATE public.mentor_payouts SET status = 'goedgekeurd', paid_at = NULL
--  WHERE period_month BETWEEN '2026-06-01' AND '2026-09-01' AND status = 'uitbetaald';
--  (geen enkel rapport in deze periode stond vóór deze run op uitbetaald — gemeten 3 nov)
--
-- TER BESPREKING (aparte PR): mark_payout_paid laten markeren op
-- `payout_id = p_payout_id AND status = 'vrijgegeven'` zonder gelijkheidscontrole
-- met bonus_total (die komt uit het overzicht, niet uit het grootboek).
