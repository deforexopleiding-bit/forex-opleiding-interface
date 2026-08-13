-- Migratie 2026-08-13: querybare tabel voor overgeslagen TL-facturen.
--
-- Aanleiding: de invoice-sync-cursor (cron-finance-sync.js) blokkeerde op een
-- factuur zonder gekoppelde klant (upsertInvoiceFromTl throwt → cursor-overshoot-
-- fix zet de cursor op de oudste fail → alles daarna synct niet meer).
--
-- Nieuw gedrag: een onmatchbare factuur wordt NIET meer als fout geteld (die
-- blokkeert de cursor), maar overgeslagen (cursor schuift door) én hier
-- weggeschreven, zodat je precies ziet welke facturen wachten op een klant-
-- koppeling. Zodra de klant bestaat kun je op deze tl_invoice_id's bulk-resyncen.
--
-- Toegang: alleen via de service-role (cron + admin-endpoints). RLS staat aan
-- zonder client-policy → geen directe browser-reads (consistent met de overige
-- finance-instroom die volledig server-side loopt).

CREATE TABLE IF NOT EXISTS public.finance_sync_skipped_invoices (
  tl_invoice_id    text PRIMARY KEY,          -- Teamleader invoice-id
  invoice_number   text,                       -- bv. "2026 / 1548" (leeg bij draft)
  reason           text NOT NULL DEFAULT 'no_customer',  -- 'no_customer' | 'no_invoicee'
  invoicee_id      text,                       -- TL contact/company-id van de invoicee
  invoicee_type    text,                       -- 'contact' | 'company'
  match_column     text,                       -- 'tl_contact_id' | 'tl_company_id'
  tl_department_id text,
  invoice_date     date,
  amount_total     numeric,
  tl_updated_at    timestamptz,                -- updated_at van de TL-factuur
  seen_count       integer NOT NULL DEFAULT 1, -- hoe vaak de sync 'm oversloeg
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz                 -- gezet zodra de factuur alsnog is geïmporteerd
);

CREATE INDEX IF NOT EXISTS idx_fssi_unresolved  ON public.finance_sync_skipped_invoices (resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_fssi_invoicee    ON public.finance_sync_skipped_invoices (invoicee_id);

ALTER TABLE public.finance_sync_skipped_invoices ENABLE ROW LEVEL SECURITY;
-- Geen policy → clients (browser-JWT) kunnen niets; de service-role bypasst RLS
-- en is de enige die schrijft/leest (cron + admin-endpoints).

COMMENT ON TABLE public.finance_sync_skipped_invoices IS
  'TL-facturen die de sync oversloeg wegens ontbrekende klant-koppeling (skip-and-advance i.p.v. cursor-block). resolved_at = alsnog geimporteerd.';

-- Markeer skips als resolved zodra de factuur alsnog in `invoices` staat
-- (na klant-koppeling + bulk-resync). Eén set-based UPDATE...WHERE EXISTS; de
-- cron roept deze na de invoices-fase aan. SECURITY DEFINER zodat de call ook
-- werkt onder de service-role zonder extra grants.
CREATE OR REPLACE FUNCTION public.mark_resolved_skipped_invoices()
RETURNS integer
LANGUAGE sql SECURITY DEFINER
AS $$
  WITH upd AS (
    UPDATE public.finance_sync_skipped_invoices s
    SET resolved_at = now()
    WHERE s.resolved_at IS NULL
      AND EXISTS (SELECT 1 FROM public.invoices i WHERE i.tl_invoice_id = s.tl_invoice_id)
    RETURNING 1
  )
  SELECT COALESCE(count(*), 0)::integer FROM upd;
$$;

-- Nog-openstaande skips (klant ontbreekt nog):
--   SELECT * FROM public.finance_sync_skipped_invoices
--   WHERE resolved_at IS NULL ORDER BY tl_updated_at;
