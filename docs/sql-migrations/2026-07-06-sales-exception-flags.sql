-- ---------------------------------------------------------------------------
-- 2026-07-06 — Offerte-beveiliging bouwstap 1/2.
--
-- Voegt instelbare grenzen toe (app_settings) + audit-velden op deals voor
-- offertes die buiten die grenzen vallen (te laag termijnbedrag / te late
-- startdatum). Bouwstap 2 (€100-verrekening/factuur) volgt later — deze
-- migratie is puur observability + goedkeur-audit.
--
-- Idempotent (IF NOT EXISTS + ON CONFLICT DO NOTHING) zodat 'ie veilig
-- her-uitgevoerd kan worden.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1. Grenzen: instelbaar via /modules/admin.html (Integraties → Offerte-
--    beveiliging). Default 400 €/mnd en 40 dagen. Jsonb-shape consistent
--    met bestaande keys (bv. events_signups_auto_close_hours_before).
INSERT INTO public.app_settings (key, value)
VALUES ('sales_min_term_amount', '{"amount": 400}'::jsonb)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.app_settings (key, value)
VALUES ('sales_max_start_days', '{"days": 40}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 2. Audit-kolommen op deals. Allemaal nullable + defaults → non-breaking
--    voor bestaande rijen en RLS-policies.
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS exception_flagged      boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS exception_reasons      text,                            -- comma-separated: 'low_term_amount', 'late_start'
  ADD COLUMN IF NOT EXISTS exception_reason_note  text,                            -- vrije-tekst uitleg door sales
  ADD COLUMN IF NOT EXISTS exception_approved_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS exception_approved_at  timestamptz,
  ADD COLUMN IF NOT EXISTS exception_fee_agreed   boolean     NOT NULL DEFAULT false; -- €100 reserveringsfee bij lateStart (bouwstap 2 factureert)

COMMENT ON COLUMN public.deals.exception_flagged     IS 'True als offerte manager-goedkeuring nodig had (te laag termijnbedrag / te late start).';
COMMENT ON COLUMN public.deals.exception_reasons     IS 'CSV van triggers: low_term_amount, late_start.';
COMMENT ON COLUMN public.deals.exception_reason_note IS 'Vrije-tekst reden ingevuld door sales bij de goedkeur-popup.';
COMMENT ON COLUMN public.deals.exception_approved_by IS 'Sales-user die de manager-goedkeuring heeft geregistreerd (klant-attest, geen 2FA).';
COMMENT ON COLUMN public.deals.exception_approved_at IS 'Timestamp van registratie.';
COMMENT ON COLUMN public.deals.exception_fee_agreed  IS 'Bij late_start: klant akkoord met €100 reserveringsfee. Bouwstap 2 verrekent deze.';

-- 3. PostgREST schema-cache herladen zodat de nieuwe kolommen meteen
--    beschikbaar zijn zonder Vercel-deploy of DB-restart.
NOTIFY pgrst, 'reload schema';

COMMIT;
