-- =============================================================================
-- 2026-11-03 — Handmatige trajecten → factuurmotor (PR 1 mentorcommissie)
--
-- WAAROM
--   De drie mentor_cash_trajects gaven elke maand een termijn vrij op DATUM,
--   zonder factuurcheck. Gemeten 3 nov: 259,60 vrijgegeven tegenover 72,00
--   (73,20 als je de te veel betaalde 40 euro op factuur 2026/835 meetelt) op
--   basis van betaalde CRM-facturen. Ze staan sinds 3 nov op 'paused'.
--   Beslissing Maxim: enkel een betaalde factuur geeft commissie vrij; te veel
--   vrijgegeven wordt verrekend (er komt niets meer vrij tot de betalingen het
--   ingehaald hebben); niemand betaalt terug.
--
-- WAT DIT DOET (spiegel van api/_lib/cash-traject-omzetten.js)
--   1. Traject krijgt customer_id + deal_id + status 'omgezet' (nieuwe waarde).
--   2. Per aanwezige event-mentor één gewone grootboek-parent
--      (key cashtraject:<traject>:sale:<mentor>) met de OORSPRONKELIJKE
--      commissie (bonus_total / aantal mentoren) als original_amount en
--      amount = max(0, commissie − al vrijgegeven).
--   3. De 36 bestaande termijnregels worden CHILDREN van die parent
--      (parent_entry_id + customer_id + source_quote_id). Bedrag, status,
--      released_at en payout_id blijven EXACT staan (forward-only).
--   De factuurmotor (releaseProportionalForPaidAmount) rekent daarna:
--      doel = commissie × betaald / basis; reeds vrijgegeven = som children
--      → zolang doel < reeds vrijgegeven: niets (verrekening).
--   Het overzicht/rapport zet de oude termijnregels in hun eigen maand en laat
--   betaalde termijnen pas weer tellen boven het vrijgegeven bedrag.
--
-- KEUZES OM TE CONTROLEREN DOOR MAXIM
--   * Paul Plantfeber: twee getekende deals (13 jan € 3167,79 en 21 mrt
--     € 3489,28, beide excl. btw). Gekozen: 21 mrt (e8a55d0f…) = de laatst
--     getekende vóór de start van zijn abonnement (6 apr 2026). Zijn betalingen
--     lopen deels via GoHighLevel en staan NIET in het CRM: te controleren.
--   * Mohammad Shoaib Shaliwal → deal ced18cac… (getekend 8 apr).
--   * Noorulhaq Alikozai → deal 9c8a03c6… (getekend 4 apr).
--
-- VOORWAARDE: geen. Los van 2026-10-22-commissie-incasso-en-koppeling.sql.
-- Supabase SQL-editor: losse statements, geen DO-blocks, geen temp tables.
-- Volgorde aanhouden. Elk statement is herhaalbaar (idempotent).
-- =============================================================================

-- 0) PRE-CHECK ────────────────────────────────────────────────────────────────
-- Verwacht: 3 rijen, status 'paused', customer_id NULL, vrijgegeven 91.60 / 84.00 / 84.00.
-- SELECT t.id, t.client_label, t.status, t.customer_id, t.bonus_total,
--        (SELECT count(*) FROM mentor_ledger_entries e WHERE e.idempotency_key LIKE 'cashtraject:'||t.id||':term:%') AS regels,
--        (SELECT sum(amount) FROM mentor_ledger_entries e WHERE e.idempotency_key LIKE 'cashtraject:'||t.id||':term:%' AND e.status IN ('vrijgegeven','uitbetaald')) AS vrijgegeven,
--        (SELECT count(*) FROM mentor_ledger_entries e WHERE e.idempotency_key LIKE 'cashtraject:'||t.id||':term:%' AND e.parent_entry_id IS NOT NULL) AS al_gekoppeld
--   FROM mentor_cash_trajects t ORDER BY t.client_label;

-- 0b) DRY-RUN per klant (alleen lezen) ───────────────────────────────────────
-- Betaald = som amount_paid van niet-volledig-gecrediteerde, niet-concept
-- facturen van de klant (zelfde regel als de factuurmotor; elke klant heeft
-- precies één commissie-sale). Verwacht (3 nov):
--   Paul     betaald 1600 → doel 48.00 (1 mentor)        · vrijgegeven 91.60 → te veel 43.60
--   Shaliwal betaald  440 → doel 6.60 per mentor (2)     · vrijgegeven 42.00 p.m. → te veel 35.40 p.m.
--   Noorulhaq betaald 400 → doel 6.00 per mentor (2)     · vrijgegeven 42.00 p.m. → te veel 36.00 p.m.
-- WITH k(tid, cust) AS (VALUES
--   ('c636d9fa-94b2-48c3-9390-7d3b078655ef'::uuid, 'b86144ef-f657-4814-9203-b5cd775deab2'::uuid),
--   ('2c4f9308-59f8-48c3-b8a3-7157ad151d29'::uuid, '2404a8e2-9a9b-412c-ba59-ff3ec3c503fd'::uuid),
--   ('bade0c7f-a945-4c54-88f1-05f5b7c3835c'::uuid, '39f28f41-2700-4282-94db-b62f8c28b7c9'::uuid))
-- SELECT t.client_label, t.total_amount AS basis, t.bonus_total,
--        b.betaald,
--        round(t.bonus_total * least(1, b.betaald / t.total_amount), 2) AS doel_totaal,
--        v.vrijgegeven,
--        round(v.vrijgegeven - t.bonus_total * least(1, b.betaald / t.total_amount), 2) AS te_veel_vrijgegeven
--   FROM k JOIN mentor_cash_trajects t ON t.id = k.tid
--   CROSS JOIN LATERAL (SELECT coalesce(sum(i.amount_paid), 0) AS betaald FROM invoices i
--                        WHERE i.customer_id = k.cust AND i.status <> 'concept'
--                          AND NOT (i.amount_total > 0 AND coalesce(i.credited_amount,0) >= i.amount_total - 0.005)) b
--   CROSS JOIN LATERAL (SELECT sum(e.amount) AS vrijgegeven FROM mentor_ledger_entries e
--                        WHERE e.idempotency_key LIKE 'cashtraject:'||t.id||':term:%' AND e.status IN ('vrijgegeven','uitbetaald')) v;

-- 1) Schema ──────────────────────────────────────────────────────────────────
ALTER TABLE public.mentor_cash_trajects ADD COLUMN IF NOT EXISTS deal_id uuid REFERENCES public.deals(id) ON DELETE SET NULL;
ALTER TABLE public.mentor_cash_trajects ADD COLUMN IF NOT EXISTS omgezet_op timestamptz;
ALTER TABLE public.mentor_cash_trajects DROP CONSTRAINT IF EXISTS mentor_cash_trajects_status_check;
ALTER TABLE public.mentor_cash_trajects ADD CONSTRAINT mentor_cash_trajects_status_check
  CHECK (status IN ('active','paused','completed','omgezet'));
COMMENT ON COLUMN public.mentor_cash_trajects.deal_id IS
  'De sale (deal) waarop de facturen van dit traject staan. Vereist voor de factuurmotor.';
COMMENT ON COLUMN public.mentor_cash_trajects.omgezet_op IS
  'Moment van omzetting naar de factuurmotor. Vanaf dan geen datumvrijval meer; enkel betaalde facturen.';

-- 2) Klant + sale op de trajecten ────────────────────────────────────────────
UPDATE public.mentor_cash_trajects SET customer_id = 'b86144ef-f657-4814-9203-b5cd775deab2', deal_id = 'e8a55d0f-5417-4402-80f2-66b02375466f'
 WHERE id = 'c636d9fa-94b2-48c3-9390-7d3b078655ef' AND status <> 'omgezet';
UPDATE public.mentor_cash_trajects SET customer_id = '2404a8e2-9a9b-412c-ba59-ff3ec3c503fd', deal_id = 'ced18cac-6d96-4805-8bbe-55a3df9de30d'
 WHERE id = '2c4f9308-59f8-48c3-b8a3-7157ad151d29' AND status <> 'omgezet';
UPDATE public.mentor_cash_trajects SET customer_id = '39f28f41-2700-4282-94db-b62f8c28b7c9', deal_id = '9c8a03c6-a578-4477-a2ea-48b2d4ea5b0d'
 WHERE id = 'bade0c7f-a945-4c54-88f1-05f5b7c3835c' AND status <> 'omgezet';

-- 3) Parents: één per aanwezige event-mentor met login ───────────────────────
-- Commissie per mentor = bonus_total / N (Paul: 126 / 1; Shaliwal + Noorulhaq:
-- 216 / 2 = 108). amount = max(0, commissie − al vrijgegeven van die mentor).
INSERT INTO public.mentor_ledger_entries
  (mentor_user_id, team_member_id, event_id, entry_type, customer_id, basis, basis_incl_btw, pct,
   amount, original_amount, status, source_quote_id, source_invoice_id, idempotency_key, note)
SELECT tm.user_id, em.team_member_id, t.event_id, 'bonus', t.customer_id, t.total_amount, true, t.pct,
       greatest(0, round(t.bonus_total / n.aantal, 2) - coalesce(v.vrij, 0)),
       round(t.bonus_total / n.aantal, 2),
       'pending', t.deal_id::text, NULL,
       'cashtraject:' || t.id || ':sale:' || tm.user_id,
       'Handmatig traject ' || t.client_label || ' omgezet naar factuurmotor (2026-11-03) — '
         || n.aantal || ' mentor(en); al vrijgegeven ' || to_char(coalesce(v.vrij, 0), 'FM999990.00') || ' telt als reeds vrijgegeven'
  FROM public.mentor_cash_trajects t
  JOIN public.event_mentors em ON em.event_id = t.event_id AND em.was_present = true
  JOIN public.team_members tm ON tm.id = em.team_member_id AND tm.user_id IS NOT NULL
  CROSS JOIN LATERAL (SELECT count(*)::numeric AS aantal FROM public.event_mentors em2
                        JOIN public.team_members tm2 ON tm2.id = em2.team_member_id AND tm2.user_id IS NOT NULL
                       WHERE em2.event_id = t.event_id AND em2.was_present = true) n
  LEFT JOIN LATERAL (SELECT sum(e.amount) AS vrij FROM public.mentor_ledger_entries e
                      WHERE e.idempotency_key LIKE 'cashtraject:' || t.id || ':term:%'
                        AND e.mentor_user_id = tm.user_id AND e.status IN ('vrijgegeven','uitbetaald')) v ON true
 WHERE t.id IN ('c636d9fa-94b2-48c3-9390-7d3b078655ef','2c4f9308-59f8-48c3-b8a3-7157ad151d29','bade0c7f-a945-4c54-88f1-05f5b7c3835c')
   AND t.customer_id IS NOT NULL AND t.deal_id IS NOT NULL
ON CONFLICT (idempotency_key) DO NOTHING;

-- 4) Bestaande termijnregels koppelen (alleen metadata) ──────────────────────
UPDATE public.mentor_ledger_entries e
   SET parent_entry_id = p.id,
       customer_id     = t.customer_id,
       source_quote_id = t.deal_id::text
  FROM public.mentor_cash_trajects t, public.mentor_ledger_entries p
 WHERE t.id IN ('c636d9fa-94b2-48c3-9390-7d3b078655ef','2c4f9308-59f8-48c3-b8a3-7157ad151d29','bade0c7f-a945-4c54-88f1-05f5b7c3835c')
   AND e.idempotency_key LIKE 'cashtraject:' || t.id || ':term:%'
   AND e.parent_entry_id IS NULL
   AND p.idempotency_key = 'cashtraject:' || t.id || ':sale:' || e.mentor_user_id;

-- 5) Traject markeren: nooit meer datumvrijval ───────────────────────────────
UPDATE public.mentor_cash_trajects
   SET status = 'omgezet', omgezet_op = now(),
       note = coalesce(note, '') || E'\n[2026-11-03] Omgezet naar de factuurmotor: enkel betaalde facturen geven commissie vrij; al vrijgegeven telt als reeds vrijgegeven (verrekening).'
 WHERE id IN ('c636d9fa-94b2-48c3-9390-7d3b078655ef','2c4f9308-59f8-48c3-b8a3-7157ad151d29','bade0c7f-a945-4c54-88f1-05f5b7c3835c')
   AND status <> 'omgezet'
   AND EXISTS (SELECT 1 FROM public.mentor_ledger_entries p WHERE p.idempotency_key LIKE 'cashtraject:' || mentor_cash_trajects.id || ':sale:%');

-- =============================================================================
-- POST-CHECK (verwacht)
-- =============================================================================
-- a) 5 parents: Paul 1 (orig 126.00, amount 34.40), Shaliwal 2 en Noorulhaq 2 (orig 108.00, amount 66.00)
-- SELECT t.client_label, p.mentor_user_id, p.original_amount, p.amount, p.status, p.customer_id, p.source_quote_id,
--        (SELECT count(*) FROM mentor_ledger_entries k WHERE k.parent_entry_id = p.id) AS children,
--        (SELECT sum(k.amount) FROM mentor_ledger_entries k WHERE k.parent_entry_id = p.id) AS reeds_vrijgegeven
--   FROM mentor_ledger_entries p JOIN mentor_cash_trajects t ON p.idempotency_key LIKE 'cashtraject:' || t.id || ':sale:%'
--  ORDER BY 1, 2;
--   → children 8 / 7 / 7 / 7 / 7, reeds 91.60 / 42.00 ×4, original − amount = reeds (behalve als reeds > original).
-- b) Geen ongekoppelde termijnregel meer: 0
-- SELECT count(*) FROM mentor_ledger_entries WHERE idempotency_key LIKE 'cashtraject:%:term:%' AND parent_entry_id IS NULL;
-- c) Bedragen/status/payout van de termijnregels ongewijzigd: 36 rijen, som 259.60, 20 met payout_id
-- SELECT count(*), sum(amount), count(payout_id) FROM mentor_ledger_entries WHERE idempotency_key LIKE 'cashtraject:%:term:%' AND status = 'vrijgegeven';
-- d) Trajecten: 3 × status 'omgezet' met customer_id + deal_id
-- SELECT id, client_label, status, customer_id, deal_id, omgezet_op FROM mentor_cash_trajects;
-- e) Factuurmotor-dryrun (na deploy van PR 1): POST /api/mentor-cash-traject-release { "dry_run": true }
--    → per klant total_released 0 en skip_reason 'no_delta' (te veel vrijgegeven, wordt verrekend).
--
-- =============================================================================
-- ROLLBACK (in deze volgorde)
-- =============================================================================
-- UPDATE mentor_ledger_entries SET parent_entry_id = NULL, customer_id = NULL, source_quote_id = NULL
--  WHERE idempotency_key LIKE 'cashtraject:%:term:%';
-- DELETE FROM mentor_ledger_entries
--  WHERE idempotency_key LIKE 'cashtraject:%:sale:%'
--    AND NOT EXISTS (SELECT 1 FROM mentor_ledger_entries k WHERE k.parent_entry_id = mentor_ledger_entries.id);
--    -- (heeft de factuurmotor intussen een child geschreven, dan blijft die parent staan: eerst melden)
-- UPDATE mentor_cash_trajects SET status = 'paused', customer_id = NULL, deal_id = NULL, omgezet_op = NULL
--  WHERE id IN ('c636d9fa-94b2-48c3-9390-7d3b078655ef','2c4f9308-59f8-48c3-b8a3-7157ad151d29','bade0c7f-a945-4c54-88f1-05f5b7c3835c');
-- ALTER TABLE mentor_cash_trajects DROP CONSTRAINT IF EXISTS mentor_cash_trajects_status_check;
-- ALTER TABLE mentor_cash_trajects ADD CONSTRAINT mentor_cash_trajects_status_check CHECK (status IN ('active','paused','completed'));
-- ALTER TABLE mentor_cash_trajects DROP COLUMN IF EXISTS omgezet_op;
-- ALTER TABLE mentor_cash_trajects DROP COLUMN IF EXISTS deal_id;
