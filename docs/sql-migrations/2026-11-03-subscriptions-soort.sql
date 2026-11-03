-- =============================================================================
-- 2026-11-03 — Soort abonnement (PR 2 mentorcommissie)
--
-- WAAROM (beslissing Maxim)
--   Elk abonnement krijgt een verplichte soort:
--     origineel        het abonnement van de sale zelf
--     aanpassing       uitstel / lager bedrag / regeling van dezelfde sale
--     incasso_regeling termijnen van een regeling na incasso, dezelfde sale
--     nieuwe_offerte   een nieuwe sale; telt NOOIT mee voor een oude
--                      event-bonus (tenzij toegewezen)
--   sale_deal_id = de sale waarbij het abonnement voor de commissie hoort.
--   Dit vervangt het klantbreed optellen en de 92-dagenregel.
--
-- ⚠ BLOKKEREND? Nee. De code leest en schrijft de kolommen fail-soft:
--   zonder migratie geldt de overgangsregel en wordt een nieuw abonnement
--   zonder soort opgeslagen (luid gelogd); "Soort wijzigen" geeft 503.
--
-- BACKFILL: stap 3 vult ENKEL de zekere gevallen (zelfde regels als
--   stelSoortVoor in api/_lib/subscription-soort.js). De onduidelijke gevallen
--   blijven leeg en staan in stap 4 (en als "soort ontbreekt" in het
--   controlescherm en bij de klant onder Abonnementen). Niet gokken.
--   Gemeten 3 nov (1303 abonnementen): zeker ± 591, onduidelijk ± 712,
--   waarvan 15 bij een commissieklant (geen enkele met een betaalde factuur).
--
-- Supabase SQL-editor: losse statements, geen DO-blocks. Volgorde aanhouden.
-- =============================================================================

-- 1) Kolommen ────────────────────────────────────────────────────────────────
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS soort text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS aanpassing_type text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS sale_deal_id uuid REFERENCES public.deals(id) ON DELETE SET NULL;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS soort_bron text;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS soort_gezet_door uuid REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS soort_gezet_op timestamptz;

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_soort_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_soort_check
  CHECK (soort IS NULL OR soort IN ('origineel','aanpassing','incasso_regeling','nieuwe_offerte'));
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_aanpassing_type_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_aanpassing_type_check
  CHECK ((soort = 'aanpassing' AND aanpassing_type IN ('uitstel','lager_bedrag','regeling'))
      OR (soort IS DISTINCT FROM 'aanpassing' AND aanpassing_type IS NULL));
ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_soort_bron_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_soort_bron_check
  CHECK (soort_bron IS NULL OR soort_bron IN ('aanmaak','handmatig','import','backfill'));

CREATE INDEX IF NOT EXISTS idx_subs_sale_deal ON public.subscriptions (sale_deal_id) WHERE sale_deal_id IS NOT NULL;

COMMENT ON COLUMN public.subscriptions.soort IS
  'Mentorcommissie: origineel / aanpassing / incasso_regeling (bij sale_deal_id) of nieuwe_offerte (eigen sale). Verplicht in aanmaak/wijzigflow; NULL = nog niet geclassificeerd (overgangsregel).';
COMMENT ON COLUMN public.subscriptions.sale_deal_id IS
  'De sale (deal) waarbij de betalingen van dit abonnement voor de mentorcommissie tellen.';

-- 2) Voorstel (view, alleen lezen) — spiegel van stelSoortVoor ──────────────
CREATE OR REPLACE VIEW public.commissie_soort_voorstel AS
WITH sg AS (
  SELECT d.id, d.customer_id, coalesce(d.tl_quotation_accepted_at, d.created_at)::date AS getekend
    FROM public.deals d
   WHERE d.archived_at IS NULL
     AND (lower(coalesce(d.tl_quotation_status, '')) IN ('accepted','signed') OR d.tl_quotation_accepted_at IS NOT NULL)
), b AS (
  SELECT s.id, s.deal_id, d.customer_id, s.status, s.start_date,
         coalesce(s.postponed_months, 0) AS pm, s.original_start_date,
         lower(coalesce(d.tl_quotation_status, '')) AS qs,
         (SELECT g.getekend FROM sg g WHERE g.id = d.id) AS eigen_getekend,
         (SELECT count(*) FROM sg g WHERE g.customer_id = d.customer_id AND g.id <> d.id
             AND g.getekend < (SELECT g2.getekend FROM sg g2 WHERE g2.id = d.id)) AS eerder,
         (SELECT count(*) FROM sg g WHERE g.customer_id = d.customer_id AND s.start_date IS NOT NULL AND g.getekend <= s.start_date + 31) AS n_kand,
         (SELECT g.id FROM sg g WHERE g.customer_id = d.customer_id AND s.start_date IS NOT NULL AND g.getekend <= s.start_date + 31
           ORDER BY g.getekend DESC LIMIT 1) AS kand,
         (SELECT max(g.getekend) FROM sg g WHERE g.customer_id = d.customer_id AND s.start_date IS NOT NULL AND g.getekend <= s.start_date + 31) AS kand_getekend
    FROM public.subscriptions s JOIN public.deals d ON d.id = s.deal_id
), v AS (
  SELECT b.*,
    CASE
      WHEN eigen_getekend IS NOT NULL THEN CASE WHEN eerder > 0 THEN 'nieuwe_offerte' ELSE 'origineel' END
      WHEN qs <> 'no_quotation' THEN NULL
      WHEN start_date IS NULL OR n_kand = 0 OR n_kand > 1 THEN NULL
      WHEN pm > 0 OR original_start_date IS NOT NULL THEN 'aanpassing'
      WHEN start_date <= kand_getekend + 92 THEN 'origineel'
      ELSE NULL END AS v_soort,
    CASE
      WHEN eigen_getekend IS NOT NULL THEN CASE WHEN eerder > 0 THEN 'eigen getekende offerte; de klant had al een eerdere sale' ELSE 'eigen getekende offerte' END
      WHEN qs <> 'no_quotation' THEN 'offerte niet getekend of gearchiveerd'
      WHEN start_date IS NULL THEN 'geen startdatum'
      WHEN n_kand = 0 THEN 'geen getekende sale vóór de start'
      WHEN n_kand > 1 THEN 'meerdere getekende sales — kies er één'
      WHEN pm > 0 OR original_start_date IS NOT NULL THEN 'uitgesteld abonnement van de enige sale'
      WHEN start_date <= kand_getekend + 92 THEN 'geïmporteerd abonnement van de enige sale (start ≤ 92 d na tekenen)'
      ELSE 'start meer dan 92 dagen na tekenen: uitstel, regeling of nieuwe offerte?' END AS reden
    FROM b
)
SELECT id, deal_id, customer_id, status, start_date,
       v_soort AS soort,
       CASE WHEN v_soort = 'aanpassing' THEN 'uitstel' END AS aanpassing_type,
       CASE WHEN v_soort IS NULL THEN NULL WHEN eigen_getekend IS NOT NULL THEN deal_id ELSE kand END AS sale_deal_id,
       (v_soort IS NOT NULL) AS zeker,
       reden,
       CASE WHEN v_soort IS NULL AND kand IS NOT NULL AND n_kand = 1 THEN kand END AS kandidaat_sale
  FROM v;

REVOKE ALL ON public.commissie_soort_voorstel FROM anon, authenticated;
COMMENT ON VIEW public.commissie_soort_voorstel IS
  'Backfillvoorstel soort abonnement (spiegel van stelSoortVoor). Alleen service_role. Mag na de backfill blijven bestaan (controlescherm).';

-- 2b) PRE-CHECK (verwacht ± 591 zeker / ± 712 onduidelijk)
-- SELECT zeker, soort, count(*) FROM public.commissie_soort_voorstel GROUP BY 1, 2 ORDER BY 1, 2;

-- 3) BACKFILL — enkel zekere gevallen, enkel waar nog niets staat ───────────
UPDATE public.subscriptions s
   SET soort = v.soort, aanpassing_type = v.aanpassing_type, sale_deal_id = v.sale_deal_id,
       soort_bron = 'backfill', soort_gezet_op = now()
  FROM public.commissie_soort_voorstel v
 WHERE v.id = s.id AND v.zeker AND s.soort IS NULL;

-- 4) ONDUIDELIJK — door Maxim te beslissen (bij de klant: Abonnementen → ◇ Soort)
--    Eerst de commissieklanten (die raken de mentorcommissie):
-- SELECT c.first_name || ' ' || c.last_name AS klant, v.id AS abonnement, s.description, v.status, v.start_date,
--        v.reden, v.kandidaat_sale,
--        EXISTS (SELECT 1 FROM mentor_ledger_entries e WHERE e.customer_id = v.customer_id AND e.parent_entry_id IS NULL
--                 AND e.entry_type = 'bonus' AND e.status <> 'geannuleerd') AS commissieklant
--   FROM public.commissie_soort_voorstel v
--   JOIN public.subscriptions s ON s.id = v.id
--   JOIN public.customers c ON c.id = v.customer_id
--  WHERE NOT v.zeker AND s.soort IS NULL
--  ORDER BY commissieklant DESC, klant, v.start_date;

-- =============================================================================
-- POST-CHECK
-- =============================================================================
-- SELECT soort, soort_bron, count(*) FROM public.subscriptions GROUP BY 1, 2 ORDER BY 1, 2;
-- SELECT count(*) FROM public.subscriptions WHERE soort IS NOT NULL AND soort <> 'nieuwe_offerte' AND sale_deal_id IS NULL;  -- 0
-- SELECT count(*) FROM public.subscriptions WHERE soort = 'aanpassing' AND aanpassing_type IS NULL;                          -- 0
--
-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- UPDATE public.subscriptions SET soort = NULL, aanpassing_type = NULL, sale_deal_id = NULL, soort_bron = NULL, soort_gezet_op = NULL
--  WHERE soort_bron = 'backfill';                       -- alleen de backfill terugdraaien
-- DROP VIEW IF EXISTS public.commissie_soort_voorstel;
-- ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_soort_bron_check;
-- ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_aanpassing_type_check;
-- ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_soort_check;
-- DROP INDEX IF EXISTS public.idx_subs_sale_deal;
-- ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS soort_gezet_op, DROP COLUMN IF EXISTS soort_gezet_door,
--   DROP COLUMN IF EXISTS soort_bron, DROP COLUMN IF EXISTS sale_deal_id, DROP COLUMN IF EXISTS aanpassing_type, DROP COLUMN IF EXISTS soort;
