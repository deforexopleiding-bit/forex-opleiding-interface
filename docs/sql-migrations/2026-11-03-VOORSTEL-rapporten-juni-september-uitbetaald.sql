-- =============================================================================
-- 2026-11-03 — VOORSTEL (niet gedraaid, beslissing Maxim)
--              Mentorrapporten juni t/m september 2026 → status 'uitbetaald'
--
-- WAAROM
--   Volgens Maxim zijn de rapporten juni–september effectief uitbetaald, maar
--   ze staan in mentor_payouts op 'goedgekeurd' en hun grootboekregels op
--   'vrijgegeven'. Gemeten 3 nov: de knop "Markeer uitbetaald" (RPC
--   mark_payout_paid) KAN ze niet afsluiten — hij faalt op elk rapport met
--   bonus_drift, omdat hij de regels van de RAPPORTMAAND met payout_id NULL
--   optelt, terwijl payout-generate-core de regels van de maand ervoor aan het
--   rapport koppelt (payout_id gezet). Voorbeeld Seppe, rapport juni:
--   bonus_total 28,35 · RPC-som 0,00 · gekoppeld 23,45.
--   Tot dit gedraaid is, rekenen dry-run en controlescherm deze rapporten als
--   werkelijk uitbetaald en tonen ze het verschil met de status apart
--   (api/_lib/commissie-uitbetaald.js; grens app_settings
--   'mentor_rapporten_werkelijk_uitbetaald_tot', standaard 2026-09-01).
--
-- BETREFT (gemeten 3 nov): 23 rapporten in status 'goedgekeurd' met
--   period_month 2026-06-01 … 2026-09-01 (Chesney 4, Danny 4, Karl 4,
--   Kjento 4, Ricardo 3, Seppe 4) en de grootboekregels die eraan gekoppeld
--   zijn. NIET inbegrepen: Seppe april 2026 (goedgekeurd, bonus 0,00) — niet
--   genoemd door Maxim; apart beslissen.
--
-- GEEN meldingen naar mentoren: de knop zou per rapport een melding
-- "Uitbetaling gedaan" sturen; dit SQL doet dat niet.
-- Supabase SQL-editor: losse statements, geen DO-blocks.
-- =============================================================================

-- 0) PRE-CHECK: verwacht 23 rapporten, 0 regels al op 'uitbetaald'
-- SELECT p.id, tm.name, p.period_month, p.status, p.bonus_total, p.approved_at,
--        (SELECT count(*) FROM mentor_ledger_entries e WHERE e.payout_id = p.id) AS regels,
--        (SELECT count(*) FROM mentor_ledger_entries e WHERE e.payout_id = p.id AND e.status = 'uitbetaald') AS al_uitbetaald
--   FROM mentor_payouts p LEFT JOIN team_members tm ON tm.user_id = p.mentor_user_id
--  WHERE p.status = 'goedgekeurd' AND p.period_month BETWEEN '2026-06-01' AND '2026-09-01'
--  ORDER BY tm.name, p.period_month;

-- A) RAPPORTEN EN HUN REGELS OP UITBETAALD ───────────────────────────────────
-- paid_at: de echte betaaldatum is niet bekend in het CRM. Voorstel: de datum
-- van goedkeuren (approved_at). Vervang door de echte datum als Maxim die heeft.
-- Eerst de regels (ze worden geselecteerd via de rapporten in 'goedgekeurd').
UPDATE public.mentor_ledger_entries e
   SET status = 'uitbetaald', paid_at = coalesce(p.approved_at, now())
  FROM public.mentor_payouts p
 WHERE e.payout_id = p.id
   AND e.status = 'vrijgegeven'
   AND p.status = 'goedgekeurd'
   AND p.period_month BETWEEN '2026-06-01' AND '2026-09-01';

UPDATE public.mentor_payouts
   SET status = 'uitbetaald', paid_at = coalesce(approved_at, now())
 WHERE status = 'goedgekeurd'
   AND period_month BETWEEN '2026-06-01' AND '2026-09-01';

-- POST-CHECK A
-- SELECT status, count(*) FROM mentor_payouts WHERE period_month BETWEEN '2026-06-01' AND '2026-09-01' GROUP BY 1;   -- uitbetaald 23
-- SELECT e.status, count(*), sum(e.amount) FROM mentor_ledger_entries e JOIN mentor_payouts p ON p.id = e.payout_id
--  WHERE p.period_month BETWEEN '2026-06-01' AND '2026-09-01' GROUP BY 1;                                              -- enkel uitbetaald
-- Daarna mag de grens terug (geen verschil status/werkelijkheid meer):
-- DELETE FROM app_settings WHERE key = 'mentor_rapporten_werkelijk_uitbetaald_tot';   -- (alleen als ze gezet werd)
--
-- ROLLBACK A (enkel de 23 rapporten; paid_at-tijdstip van deze run invullen)
-- UPDATE mentor_ledger_entries e SET status = 'vrijgegeven', paid_at = NULL
--   FROM mentor_payouts p WHERE e.payout_id = p.id AND p.period_month BETWEEN '2026-06-01' AND '2026-09-01'
--    AND p.status = 'uitbetaald' AND e.status = 'uitbetaald';
-- UPDATE mentor_payouts SET status = 'goedgekeurd', paid_at = NULL
--  WHERE period_month BETWEEN '2026-06-01' AND '2026-09-01' AND status = 'uitbetaald'
--    AND id <> '0fdf18ae-c787-4747-9498-962c66dc5567';   -- Seppe mei stond al op uitbetaald (valt sowieso buiten de periode)

-- B) OPTIONEEL — de 117,80 die zonder factuurcheck vrijgegeven werd en in GEEN
--    rapport zit (trajecttermijnen, payout_id NULL). Pas NA de omzetting
--    (2026-11-03-cashtraject-naar-factuurmotor.sql). Met de code van PR 1
--    worden deze regels al niet meer aan een rapport gekoppeld en tellen ze
--    niet in de bonus. Annuleren maakt het grootboek gelijk aan het rapport:
--    de factuurmotor telt een geannuleerde regel niet als reeds vrijgegeven,
--    dus de verrekening gebeurt dan op wat werkelijk uitbetaald is (141,80).
--    Niet annuleren = ze blijven als "vrijgegeven, niet in rapport" zichtbaar
--    in het controlescherm en de factuurmotor verrekent op 259,60.
--    Gemeten: Paul 4 × 11,45 = 45,80 (apr, sep, okt, nov) · Shaliwal en
--    Noorulhaq elk 2 × 3 × 6,00 = 36,00 (sep, okt, nov).
-- UPDATE public.mentor_ledger_entries
--    SET status = 'geannuleerd',
--        note = coalesce(note, '') || ' | [2026-11-03] geannuleerd: vrijgegeven op datum zonder betaalde factuur, nooit uitbetaald'
--  WHERE idempotency_key LIKE 'cashtraject:%:term:%'
--    AND status = 'vrijgegeven' AND payout_id IS NULL;
-- POST-CHECK B: SELECT count(*), sum(amount) FROM mentor_ledger_entries WHERE idempotency_key LIKE 'cashtraject:%:term:%' AND status = 'geannuleerd';  -- 16 · 117.80
-- ROLLBACK B:  UPDATE mentor_ledger_entries SET status = 'vrijgegeven' WHERE idempotency_key LIKE 'cashtraject:%:term:%' AND status = 'geannuleerd' AND payout_id IS NULL;

-- C) TER BESPREKING — waarom de knop niet werkt (geen SQL in dit voorstel)
--    mark_payout_paid telt `released_at` binnen period_month met payout_id NULL;
--    het rapport koppelt released_at in de maand ERVOOR en zet payout_id. De
--    bonus van het rapport komt bovendien uit het overzicht (betaalde
--    termijnen), niet uit de grootboeksom, dus een gelijkheidscontrole op het
--    grootboek kan niet kloppen. Voorstel voor een aparte PR: de RPC markeert
--    `WHERE payout_id = p_payout_id AND status = 'vrijgegeven'` en vergelijkt
--    niet meer met bonus_total.
