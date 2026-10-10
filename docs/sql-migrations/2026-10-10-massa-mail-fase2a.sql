-- 2026-10-10 · Massa-e-mail fase 2a — campagnes, wachtrij en mailvoorkeuren.
--
--   massa_campagnes      1 rij per massabericht (naam, onderwerp, inhoud, tempo, tellers)
--   massa_items          1 rij per ontvanger (queued → sending → sent / failed / skipped)
--   lead_mail_voorkeuren 1 rij per e-mailadres: token voor de publieke
--                        voorkeurenpagina (dfo-website /voorkeuren) + afmelding
--
-- Schrijvers: api/massa-campagne.js (aanmaken), api/cron-massa-mail.js (versturen),
-- dfo-website app/api/voorkeuren (token-route, service role). RLS staat aan op alle
-- drie ZONDER policies: alleen de service role (de endpoints) leest en schrijft.
-- De voorkeurentabel is dus NIET publiek open — alleen via de token-route.
--
-- BLOKKEREND voor de massa-functie (zonder deze tabellen meldt de knop
-- "draai de migratie"); NIET blokkerend voor de rest van het CRM.
-- Draaien in de Supabase SQL-editor; losse statements, geen DO-blokken.

-- ── 1. Campagnes ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.massa_campagnes (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  naam                 text NOT NULL CHECK (char_length(btrim(naam)) BETWEEN 1 AND 120),
  kanaal               text NOT NULL DEFAULT 'email' CHECK (kanaal IN ('email')),
  soort                text NOT NULL CHECK (soort IN ('tips', 'events', 'aanbod')),
  onderwerp            text NOT NULL CHECK (char_length(btrim(onderwerp)) BETWEEN 1 AND 200),
  html                 text NOT NULL,
  sjabloon_id          uuid,
  filter               jsonb NOT NULL DEFAULT '{}'::jsonb,
  portie               integer NOT NULL DEFAULT 100 CHECK (portie BETWEEN 1 AND 500),
  status               text NOT NULL DEFAULT 'wachtrij'
                       CHECK (status IN ('wachtrij', 'bezig', 'klaar', 'gepauzeerd', 'geannuleerd')),
  aantal               integer NOT NULL DEFAULT 0,
  aantal_verstuurd     integer NOT NULL DEFAULT 0,
  aantal_mislukt       integer NOT NULL DEFAULT 0,
  aantal_overgeslagen  integer NOT NULL DEFAULT 0,
  aangemaakt_op        timestamptz NOT NULL DEFAULT now(),
  aangemaakt_door      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  gestart_op           timestamptz,
  klaar_op             timestamptz
);

CREATE INDEX IF NOT EXISTS idx_massa_campagnes_status ON public.massa_campagnes (status, aangemaakt_op);

-- ── 2. Wachtrij-items (1 per ontvanger) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.massa_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campagne_id    uuid NOT NULL REFERENCES public.massa_campagnes(id) ON DELETE CASCADE,
  lead_id        uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  kanaal         text NOT NULL DEFAULT 'email' CHECK (kanaal IN ('email')),
  email          text,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'skipped')),
  reden          text,
  fout           text,
  extern_id      text,
  geclaimd_op    timestamptz,
  verzonden_op   timestamptz,
  aangemaakt_op  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campagne_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_massa_items_wachtrij ON public.massa_items (campagne_id, status, aangemaakt_op);
CREATE INDEX IF NOT EXISTS idx_massa_items_lead ON public.massa_items (lead_id, verzonden_op DESC);
CREATE INDEX IF NOT EXISTS idx_massa_items_verzonden ON public.massa_items (verzonden_op) WHERE status = 'sent';

-- ── 3. Mailvoorkeuren (publieke voorkeurenpagina, token-based) ───────────────
CREATE TABLE IF NOT EXISTS public.lead_mail_voorkeuren (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email <> ''),
  lead_id        uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  token          text NOT NULL UNIQUE CHECK (char_length(token) >= 32),
  afgemeld       boolean NOT NULL DEFAULT false,
  afgemeld_op    timestamptz,
  voorkeuren     jsonb NOT NULL DEFAULT '{}'::jsonb,
  aangemaakt_op  timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op  timestamptz NOT NULL DEFAULT now()
);

-- ── 4. RLS: alleen de service role ───────────────────────────────────────────
ALTER TABLE public.massa_campagnes      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.massa_items          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_mail_voorkeuren ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.massa_campagnes      FROM anon, authenticated;
REVOKE ALL ON public.massa_items          FROM anon, authenticated;
REVOKE ALL ON public.lead_mail_voorkeuren FROM anon, authenticated;

-- ── 5. Controle (alleen lezen) ───────────────────────────────────────────────
-- SELECT relname, relrowsecurity FROM pg_class
--   WHERE relname IN ('massa_campagnes', 'massa_items', 'lead_mail_voorkeuren');   -- 3× true
-- SELECT has_table_privilege('anon', 'public.lead_mail_voorkeuren', 'SELECT');     -- false
-- SELECT count(*) FROM pg_policy WHERE polrelid IN
--   ('public.massa_campagnes'::regclass, 'public.massa_items'::regclass, 'public.lead_mail_voorkeuren'::regclass); -- 0

-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS public.massa_items;
-- DROP TABLE IF EXISTS public.massa_campagnes;
-- DROP TABLE IF EXISTS public.lead_mail_voorkeuren;
