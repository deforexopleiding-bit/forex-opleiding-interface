-- 2026-10-09 · lead_mail_sjablonen — bibliotheek van e-mailsjablonen voor
-- "Stuur bericht" (Leads / Leadsonderhoud → Contacten), fase 1.
--
-- Gelezen en beschreven door api/lead-mail-sjablonen.js (service-role). RLS staat
-- aan; ingelogde CRM-gebruikers (authenticated) mogen lezen en beheren, anon niets.
-- Variabelen in onderwerp/inhoud: {{voornaam}} {{achternaam}} {{naam}} {{email}}
-- {{boekingslink}} — ingevuld bij het versturen.
--
-- Niet blokkerend voor de rest: zonder deze tabel werkt "Stuur bericht" gewoon
-- (WhatsApp en losse e-mail); alleen de sjablonen-tab meldt "draai de migratie".
-- Draaien in de Supabase SQL-editor, losse statements in deze volgorde.

-- ── 1. Tabel ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.lead_mail_sjablonen (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  naam             text NOT NULL CHECK (char_length(naam) BETWEEN 1 AND 120),
  onderwerp        text NOT NULL CHECK (char_length(onderwerp) BETWEEN 1 AND 200),
  html             text NOT NULL,
  aangemaakt       timestamptz NOT NULL DEFAULT now(),
  bijgewerkt       timestamptz NOT NULL DEFAULT now(),
  aangemaakt_door  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  bijgewerkt_door  uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_lead_mail_sjablonen_naam ON public.lead_mail_sjablonen (lower(naam));

-- ── 2. RLS: alleen ingelogde CRM-gebruikers ──────────────────────────────────
ALTER TABLE public.lead_mail_sjablonen ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.lead_mail_sjablonen FROM anon;

DROP POLICY IF EXISTS lead_mail_sjablonen_authenticated_all ON public.lead_mail_sjablonen;

CREATE POLICY lead_mail_sjablonen_authenticated_all ON public.lead_mail_sjablonen
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 3. Controle (alleen lezen) ───────────────────────────────────────────────
-- SELECT count(*) FROM public.lead_mail_sjablonen;                                  -- 0
-- SELECT has_table_privilege('anon', 'public.lead_mail_sjablonen', 'SELECT');        -- false
-- SELECT polname FROM pg_policy WHERE polrelid = 'public.lead_mail_sjablonen'::regclass;

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.lead_mail_sjablonen;
