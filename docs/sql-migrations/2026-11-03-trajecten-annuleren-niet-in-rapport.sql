-- =============================================================================
-- 2026-11-03 — DEFINITIEF (beslissing Maxim 3 nov, optie B): de 117,80 uit de
--              trajecten die zonder factuurcheck vrijgegeven werd en in GEEN
--              rapport zit → 'geannuleerd'
--
-- VOORWAARDE: 2026-11-03-cashtraject-naar-factuurmotor.sql is gedraaid (de
--   termijnregels hangen als children aan de traject-parents). De pre-check
--   hieronder controleert dat.
--
-- WAAROM: enkel een betaalde factuur geeft commissie vrij. Deze 16 termijn-
--   regels werden op datum vrijgegeven, zonder betaling, en zijn nooit
--   uitbetaald (payout_id NULL). Annuleren maakt het grootboek gelijk aan wat
--   werkelijk uitbetaald werd: de factuurmotor telt een geannuleerde child niet
--   als reeds vrijgegeven, dus de verrekening gebeurt op 141,80 (werkelijk
--   uitbetaald) in plaats van 259,60.
--   Gemeten: Paul 4 × 11,45 = 45,80 (apr, sep, okt, nov) · Shaliwal en
--   Noorulhaq elk 2 mentoren × 3 × 6,00 = 36,00 (sep, okt, nov).
--   GEVOLG na de volgende run van de factuurmotor: Paul (doel 48,00, uitbetaald
--   45,80) krijgt 2,20 vrij; Shaliwal en Noorulhaq blijven op 0 (te veel
--   uitbetaald 17,40 / 18,00 per mentor → verrekening loopt).
--   Bedragen, released_at en payout_id blijven staan; enkel de status wijzigt.
--
-- Supabase SQL-editor: losse statements, geen DO-blocks.
-- =============================================================================

-- 0) PRE-CHECK — verwacht: 16 regels, som 117.80, allemaal met parent, 0 zonder parent
SELECT count(*) AS regels, sum(amount) AS som,
       count(*) FILTER (WHERE parent_entry_id IS NOT NULL) AS met_parent,
       count(*) FILTER (WHERE parent_entry_id IS NULL) AS zonder_parent
  FROM public.mentor_ledger_entries
 WHERE idempotency_key LIKE 'cashtraject:%:term:%'
   AND status = 'vrijgegeven' AND payout_id IS NULL;
-- Staat zonder_parent > 0: STOP — eerst 2026-11-03-cashtraject-naar-factuurmotor.sql draaien.

-- 1) Annuleren (enkel regels mét parent: de omzetting moet gebeurd zijn)
UPDATE public.mentor_ledger_entries
   SET status = 'geannuleerd',
       note = coalesce(note, '') || ' | [2026-11-03] geannuleerd: vrijgegeven op datum zonder betaalde factuur, nooit uitbetaald (beslissing Maxim, optie B)'
 WHERE idempotency_key LIKE 'cashtraject:%:term:%'
   AND status = 'vrijgegeven'
   AND payout_id IS NULL
   AND parent_entry_id IS NOT NULL;

-- =============================================================================
-- POST-CHECK
-- =============================================================================
-- a) 16 · 117.80 geannuleerd
-- SELECT count(*), sum(amount) FROM public.mentor_ledger_entries WHERE idempotency_key LIKE 'cashtraject:%:term:%' AND status = 'geannuleerd';
-- b) 20 · 141.80 blijven vrijgegeven/uitbetaald (alle met payout_id)
-- SELECT status, count(*), sum(amount), count(payout_id) FROM public.mentor_ledger_entries
--  WHERE idempotency_key LIKE 'cashtraject:%:term:%' AND status <> 'geannuleerd' GROUP BY 1;
-- c) Factuurmotor dry-run: POST /api/mentor-cash-traject-release { "dry_run": true }
--    → Paul: 2,20 (would_release), Shaliwal en Noorulhaq: no_delta.
--
-- =============================================================================
-- ROLLBACK (exact deze regels; de notitie maakt ze herkenbaar)
-- =============================================================================
-- UPDATE public.mentor_ledger_entries
--    SET status = 'vrijgegeven',
--        note = replace(note, ' | [2026-11-03] geannuleerd: vrijgegeven op datum zonder betaalde factuur, nooit uitbetaald (beslissing Maxim, optie B)', '')
--  WHERE idempotency_key LIKE 'cashtraject:%:term:%' AND status = 'geannuleerd'
--    AND note LIKE '%[2026-11-03] geannuleerd: vrijgegeven op datum zonder betaalde factuur%';
--  (draai de rollback NIET meer als de factuurmotor intussen voor Paul een child schreef; meld het eerst)
