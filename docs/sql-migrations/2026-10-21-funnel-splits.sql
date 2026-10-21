-- 2026-10-21 · Funnel-split-test + verkeersrouter (/go/<slug> op de website).
--
-- STATUS: handmatig draaien in de Supabase SQL-editor (Jeffrey). Muterend.
-- Losse statements (elk een eigen transactie). Opnieuw draaien kan (IF NOT EXISTS).
--
-- NIET BLOKKEREND voor bestaande flows: niets bestaands verandert. Zonder deze
-- tabellen stuurt /go/<slug> door naar '/' en toont de CRM-tab "Funnels koppelen"
-- een migratie-melding.
--
-- funnel_splits            één rij per vaste instaplink (/go/<slug>) — die link staat in Meta.
-- funnel_split_varianten   welke funnel-varianten eraan hangen + gewicht (0–100, relatief).
-- funnel_split_toewijzingen log: welke bezoeker welke variant kreeg (180 dagen bewaren,
--                          net als funnel_events). Geen persoonsgegevens: een anonieme
--                          bezoeker-id (cookie), utm's en of er een fbclid was.
-- Alleen de service role leest/schrijft (website-router + CRM-endpoint): RLS aan,
-- REVOKE van anon/authenticated, geen policies — zoals public.scans.

CREATE TABLE IF NOT EXISTS public.funnel_splits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,40}$'),
  naam          text NOT NULL,
  actief        boolean NOT NULL DEFAULT true,
  fallback_pad  text CHECK (fallback_pad IS NULL OR (fallback_pad LIKE '/%' AND fallback_pad NOT LIKE '//%')),
  notitie       text,
  aangemaakt    timestamptz NOT NULL DEFAULT now(),
  bijgewerkt    timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_door uuid
);

CREATE TABLE IF NOT EXISTS public.funnel_split_varianten (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  split_id   uuid NOT NULL REFERENCES public.funnel_splits(id) ON DELETE CASCADE,
  bron       text NOT NULL CHECK (bron ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  pad        text NOT NULL CHECK (pad LIKE '/%' AND pad NOT LIKE '//%'),
  gewicht    integer NOT NULL DEFAULT 50 CHECK (gewicht BETWEEN 0 AND 100),
  actief     boolean NOT NULL DEFAULT true,
  volgorde   integer NOT NULL DEFAULT 0,
  aangemaakt timestamptz NOT NULL DEFAULT now(),
  UNIQUE (split_id, bron)
);

CREATE TABLE IF NOT EXISTS public.funnel_split_toewijzingen (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  split_id     uuid NOT NULL REFERENCES public.funnel_splits(id) ON DELETE CASCADE,
  bron         text NOT NULL,
  bezoeker_id  uuid,
  nieuw        boolean NOT NULL DEFAULT true,
  utm_source   text,
  utm_campaign text,
  utm_content  text,
  fbclid       boolean NOT NULL DEFAULT false,
  ts           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_funnel_split_varianten_split ON public.funnel_split_varianten (split_id, volgorde);
CREATE INDEX IF NOT EXISTS idx_funnel_split_toewijzingen_split_ts ON public.funnel_split_toewijzingen (split_id, ts DESC);

-- Stats per test: funnel_events van het testverkeer (meta->>'split' = slug).
CREATE INDEX IF NOT EXISTS idx_funnel_events_split ON public.funnel_events ((meta->>'split'), ts) WHERE meta ? 'split';

ALTER TABLE public.funnel_splits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funnel_split_varianten ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funnel_split_toewijzingen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.funnel_splits FROM anon, authenticated;
REVOKE ALL ON public.funnel_split_varianten FROM anon, authenticated;
REVOKE ALL ON public.funnel_split_toewijzingen FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';

-- Controle (alleen lezen):
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'funnel_split%';
--   → funnel_splits, funnel_split_toewijzingen, funnel_split_varianten.
-- Opruimen van het log (optioneel, net als funnel_events, bv. maandelijks):
-- DELETE FROM public.funnel_split_toewijzingen WHERE ts < now() - interval '180 days';
