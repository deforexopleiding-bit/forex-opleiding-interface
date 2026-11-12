-- 2026-11-12-incasso-factuur-koppeling.sql
--
-- BACKFILL: facturen zonder abonnement-id koppelen aan hun incasso-
-- regelingsabonnement (opdracht Maxim, 12 nov 2026).
--
-- Waarom: Teamleader geeft sinds augustus 2026 geen abonnement-id meer mee op
-- een factuur (invoices.tl_subscription_id is NULL voor elke factuur sinds
-- 1 aug). Bij Noorulhaq stond november daardoor op "nog geen factuur" terwijl
-- factuur 2026 / 2317 (€ 400, vervalt 20 nov) er is, en kon "Betaling
-- ontvangen" niet.
--
-- Regel (dezelfde als de code: koppelRegelingFacturen in
-- api/_lib/incasso-maandlijst.js en de sync in api/_lib/invoice-upsert.js):
--   * enkel abonnementen van soort 'incasso_regeling' (niet geannuleerd, met
--     een Teamleader-id), van DEZELFDE klant;
--   * periode: de maand van de factuurdatum (anders de vervaldag) is een
--     termijnmaand van het abonnement;
--   * bedrag: factuurtotaal = termijnbedrag incl. btw, ± max(€ 1, 1 %);
--   * enkel EENDUIDIG: precies één abonnement past, precies één factuur voor
--     die termijn, en geen factuur die al aan die termijn hangt;
--   * concept en volledig gecrediteerd koppelen nooit.
--
-- NIET-DESTRUCTIEF: enkel invoices.tl_subscription_id van NULL naar een
-- waarde, en invoices.deal_id enkel als die NULL is (naar de deal van het
-- abonnement — precies wat de sync doet voor elke gekoppelde factuur). Wat er
-- stond wordt eerst bewaard in public.invoices_koppeling_backup_20261112.
--
-- Commissie: Noorulhaq heeft één commissie-sale (9c8a03c6…); het abonnement
-- hangt aan diezelfde sale (sale_deal_id), dus de factuur blijft bij dezelfde
-- sale. Er wordt niets vrijgegeven of uitbetaald door deze backfill.
--
-- Plakken in de Supabase SQL-editor, STAP VOOR STAP (elk statement staat op
-- zichzelf; geen temp-tabellen).
--
-- Verwacht resultaat op 12 nov 2026: precies 1 factuur — 2026 / 2317 van
-- Noorulhaq → abonnement dc8f544a-ca97-08d9-b86d-d342ee15b6ec (november).
-- Er bestaat op dit moment maar één abonnement van soort incasso_regeling,
-- dus geen andere klant heeft hetzelfde probleem.


-- ═══ STAP 0 · PRE-CHECK (alleen lezen) ═════════════════════════════════════
-- Toont elke factuur die gekoppeld zal worden. Verwacht: 1 rij (2026 / 2317).
WITH sub AS (
  SELECT s.id AS sub_id, s.teamleader_subscription_id AS tl, s.deal_id AS sub_deal_id, d.customer_id,
         round(CASE WHEN jsonb_typeof(s.line_items) = 'array' AND jsonb_array_length(s.line_items) > 0
                    THEN (SELECT sum(coalesce((l->>'amount')::numeric, 0) * (1 + coalesce((l->>'vat_percentage')::numeric, 0) / 100))
                            FROM jsonb_array_elements(s.line_items) l)
                    ELSE coalesce(s.amount, 0) * (1 + coalesce(s.vat_percentage, 21)::numeric / 100) END, 2) AS per,
         s.start_date, s.term_count,
         CASE WHEN lower(coalesce(s.billing_cycle, '')) LIKE '%quarter%' THEN 3
              WHEN lower(coalesce(s.billing_cycle, '')) LIKE '%year%' THEN 12 ELSE 1 END AS cyc
    FROM public.subscriptions s JOIN public.deals d ON d.id = s.deal_id
   WHERE s.soort = 'incasso_regeling' AND s.teamleader_subscription_id IS NOT NULL
     AND lower(coalesce(s.status, '')) <> 'cancelled' AND s.start_date IS NOT NULL AND coalesce(s.term_count, 0) > 0
),
term AS (
  SELECT sub.*, to_char(sub.start_date + make_interval(months => g.i * sub.cyc), 'YYYY-MM') AS ym
    FROM sub CROSS JOIN LATERAL generate_series(0, sub.term_count - 1) AS g(i)
   WHERE sub.per > 0
),
inv AS (
  SELECT i.id, i.customer_id, i.amount_total, to_char(i.issue_date, 'YYYY-MM') AS iym, to_char(i.due_date, 'YYYY-MM') AS dym
    FROM public.invoices i
   WHERE i.tl_subscription_id IS NULL AND lower(coalesce(i.status, '')) <> 'concept'
     AND coalesce(i.amount_total, 0) > 0
     AND NOT (coalesce(i.credited_amount, 0) >= i.amount_total - 0.005)
     AND i.customer_id IN (SELECT customer_id FROM sub)
),
hits AS (
  SELECT inv.id, p.prio, t.tl, t.ym, t.sub_deal_id
    FROM inv CROSS JOIN LATERAL (VALUES (inv.iym, 1), (inv.dym, 2)) AS p(periode, prio)
    JOIN term t ON t.customer_id = inv.customer_id AND t.ym = p.periode
               AND abs(inv.amount_total - t.per) <= greatest(1, abs(t.per) * 0.01) + 0.000000001
   WHERE p.periode IS NOT NULL
),
eerste AS (SELECT id, min(prio) AS prio FROM hits GROUP BY id),
keuze AS (
  SELECT h.id, min(h.tl) AS tl, min(h.ym) AS ym, (array_agg(h.sub_deal_id))[1] AS sub_deal_id, count(DISTINCT h.tl) AS n
    FROM hits h JOIN eerste e ON e.id = h.id AND e.prio = h.prio GROUP BY h.id
),
kand AS (SELECT * FROM keuze WHERE n = 1),
bezet AS (
  SELECT DISTINCT i.tl_subscription_id AS tl, x.ym
    FROM public.invoices i
    CROSS JOIN LATERAL (VALUES (to_char(i.issue_date, 'YYYY-MM')), (to_char(i.due_date, 'YYYY-MM'))) AS x(ym)
   WHERE i.tl_subscription_id IN (SELECT tl FROM sub) AND lower(coalesce(i.status, '')) <> 'concept'
     AND NOT (coalesce(i.amount_total, 0) > 0 AND coalesce(i.credited_amount, 0) >= i.amount_total - 0.005)
     AND x.ym IS NOT NULL
)
SELECT k.id AS invoice_id, i.invoice_number, i.customer_id, i.amount_total, i.issue_date, i.due_date, i.status,
       k.tl AS nieuw_tl_subscription_id, k.ym AS termijnmaand, i.deal_id AS huidige_deal_id, k.sub_deal_id
  FROM kand k JOIN public.invoices i ON i.id = k.id
 WHERE (SELECT count(*) FROM kand k2 WHERE k2.tl = k.tl AND k2.ym = k.ym) = 1
   AND NOT EXISTS (SELECT 1 FROM bezet b WHERE b.tl = k.tl AND b.ym = k.ym)
 ORDER BY i.customer_id, i.issue_date;


-- ═══ STAP 1 · BACKUPTABEL ══════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.invoices_koppeling_backup_20261112 (
  invoice_id                uuid PRIMARY KEY REFERENCES public.invoices(id) ON DELETE CASCADE,
  invoice_number            text,
  oud_tl_subscription_id    text,
  oud_deal_id               uuid,
  nieuw_tl_subscription_id  text NOT NULL,
  nieuw_deal_id             uuid,
  termijnmaand              text,
  bewaard_op                timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.invoices_koppeling_backup_20261112 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invoices_koppeling_backup_20261112 FROM anon, authenticated;


-- ═══ STAP 2 · KANDIDATEN BEWAREN (zelfde selectie als stap 0) ═════════════
WITH sub AS (
  SELECT s.id AS sub_id, s.teamleader_subscription_id AS tl, s.deal_id AS sub_deal_id, d.customer_id,
         round(CASE WHEN jsonb_typeof(s.line_items) = 'array' AND jsonb_array_length(s.line_items) > 0
                    THEN (SELECT sum(coalesce((l->>'amount')::numeric, 0) * (1 + coalesce((l->>'vat_percentage')::numeric, 0) / 100))
                            FROM jsonb_array_elements(s.line_items) l)
                    ELSE coalesce(s.amount, 0) * (1 + coalesce(s.vat_percentage, 21)::numeric / 100) END, 2) AS per,
         s.start_date, s.term_count,
         CASE WHEN lower(coalesce(s.billing_cycle, '')) LIKE '%quarter%' THEN 3
              WHEN lower(coalesce(s.billing_cycle, '')) LIKE '%year%' THEN 12 ELSE 1 END AS cyc
    FROM public.subscriptions s JOIN public.deals d ON d.id = s.deal_id
   WHERE s.soort = 'incasso_regeling' AND s.teamleader_subscription_id IS NOT NULL
     AND lower(coalesce(s.status, '')) <> 'cancelled' AND s.start_date IS NOT NULL AND coalesce(s.term_count, 0) > 0
),
term AS (
  SELECT sub.*, to_char(sub.start_date + make_interval(months => g.i * sub.cyc), 'YYYY-MM') AS ym
    FROM sub CROSS JOIN LATERAL generate_series(0, sub.term_count - 1) AS g(i)
   WHERE sub.per > 0
),
inv AS (
  SELECT i.id, i.customer_id, i.amount_total, to_char(i.issue_date, 'YYYY-MM') AS iym, to_char(i.due_date, 'YYYY-MM') AS dym
    FROM public.invoices i
   WHERE i.tl_subscription_id IS NULL AND lower(coalesce(i.status, '')) <> 'concept'
     AND coalesce(i.amount_total, 0) > 0
     AND NOT (coalesce(i.credited_amount, 0) >= i.amount_total - 0.005)
     AND i.customer_id IN (SELECT customer_id FROM sub)
),
hits AS (
  SELECT inv.id, p.prio, t.tl, t.ym, t.sub_deal_id
    FROM inv CROSS JOIN LATERAL (VALUES (inv.iym, 1), (inv.dym, 2)) AS p(periode, prio)
    JOIN term t ON t.customer_id = inv.customer_id AND t.ym = p.periode
               AND abs(inv.amount_total - t.per) <= greatest(1, abs(t.per) * 0.01) + 0.000000001
   WHERE p.periode IS NOT NULL
),
eerste AS (SELECT id, min(prio) AS prio FROM hits GROUP BY id),
keuze AS (
  SELECT h.id, min(h.tl) AS tl, min(h.ym) AS ym, (array_agg(h.sub_deal_id))[1] AS sub_deal_id, count(DISTINCT h.tl) AS n
    FROM hits h JOIN eerste e ON e.id = h.id AND e.prio = h.prio GROUP BY h.id
),
kand AS (SELECT * FROM keuze WHERE n = 1),
bezet AS (
  SELECT DISTINCT i.tl_subscription_id AS tl, x.ym
    FROM public.invoices i
    CROSS JOIN LATERAL (VALUES (to_char(i.issue_date, 'YYYY-MM')), (to_char(i.due_date, 'YYYY-MM'))) AS x(ym)
   WHERE i.tl_subscription_id IN (SELECT tl FROM sub) AND lower(coalesce(i.status, '')) <> 'concept'
     AND NOT (coalesce(i.amount_total, 0) > 0 AND coalesce(i.credited_amount, 0) >= i.amount_total - 0.005)
     AND x.ym IS NOT NULL
)
INSERT INTO public.invoices_koppeling_backup_20261112
       (invoice_id, invoice_number, oud_tl_subscription_id, oud_deal_id, nieuw_tl_subscription_id, nieuw_deal_id, termijnmaand)
SELECT k.id, i.invoice_number, i.tl_subscription_id, i.deal_id, k.tl, coalesce(i.deal_id, k.sub_deal_id), k.ym
  FROM kand k JOIN public.invoices i ON i.id = k.id
 WHERE (SELECT count(*) FROM kand k2 WHERE k2.tl = k.tl AND k2.ym = k.ym) = 1
   AND NOT EXISTS (SELECT 1 FROM bezet b WHERE b.tl = k.tl AND b.ym = k.ym)
ON CONFLICT (invoice_id) DO NOTHING;

-- Controle: zelfde rijen als stap 0?
SELECT * FROM public.invoices_koppeling_backup_20261112 ORDER BY bewaard_op;


-- ═══ STAP 3 · KOPPELEN (enkel NULL → waarde) ═══════════════════════════════
UPDATE public.invoices i
   SET tl_subscription_id = b.nieuw_tl_subscription_id,
       deal_id            = coalesce(i.deal_id, b.nieuw_deal_id),
       updated_at         = now()
  FROM public.invoices_koppeling_backup_20261112 b
 WHERE b.invoice_id = i.id
   AND i.tl_subscription_id IS NULL;


-- ═══ STAP 4 · POST-CHECK (alleen lezen) ════════════════════════════════════
-- Verwacht: elke rij ok = true.
SELECT b.invoice_number, i.tl_subscription_id, i.deal_id, b.termijnmaand,
       (i.tl_subscription_id = b.nieuw_tl_subscription_id
        AND i.deal_id IS NOT DISTINCT FROM b.nieuw_deal_id) AS ok
  FROM public.invoices_koppeling_backup_20261112 b
  JOIN public.invoices i ON i.id = b.invoice_id
 ORDER BY b.invoice_number;
-- Daarna in het CRM: Wanbetalers › Incasso-abonnementen › Noorulhaq → november
-- toont 2026 / 2317 met de knop "Betaling ontvangen"; december en later staan
-- op "gepland" (neutraal).


-- ═══ ROLLBACK (enkel indien nodig) ═════════════════════════════════════════
-- Zet exact terug wat er stond, enkel voor rijen die sindsdien niet meer
-- veranderd zijn. LET OP: zolang de nieuwe code live staat, koppelt de sync
-- dezelfde factuur bij de volgende passage opnieuw (zelfde regel); een
-- volledige terugdraai = ook de PR terugdraaien.
-- UPDATE public.invoices i
--    SET tl_subscription_id = b.oud_tl_subscription_id,
--        deal_id            = b.oud_deal_id,
--        updated_at         = now()
--   FROM public.invoices_koppeling_backup_20261112 b
--  WHERE b.invoice_id = i.id
--    AND i.tl_subscription_id = b.nieuw_tl_subscription_id
--    AND i.deal_id IS NOT DISTINCT FROM b.nieuw_deal_id;
-- DROP TABLE public.invoices_koppeling_backup_20261112;
