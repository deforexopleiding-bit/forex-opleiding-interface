-- ============================================================================
-- 2026-08-02 — dunning_gesprek_analyse: cache van AI-oordeel per klant
--
-- WAAROM
--   De AI-gespreksanalyse (Anthropic call via
--   /api/wanbetalers-diagnose-analyse-gesprek) leverde tot nu toe alleen
--   een client-side result (Map in browser-state). Result: page-reload
--   wist alle analyses; de "Afspraak-niet-vastgelegd"-filter kon niks
--   tonen tenzij je in dezelfde sessie "Analyseer alle" had gedraaid.
--
--   Deze tabel bewaart per klant het LAATSTE AI-oordeel (verdict +
--   samenvatting + termijnen + actie), zodat het diagnose-dashboard 't
--   direct bij openen kan laden en de filter een echte werklijst wordt.
--
-- PRIVACY
--   We slaan ALLEEN het oordeel + samenvatting op — NIET het volledige
--   WhatsApp-gesprek. Dat is proportioneel:
--     * Bedrijfsdata (betaalafspraak-oordeel), geen gespreksopslag
--     * Samenvatting max 200 chars (contract van de AI-tool)
--     * ON DELETE CASCADE — bij klant-anonymisering / -verwijdering weg
--
-- IDEMPOTENT
--   CREATE TABLE IF NOT EXISTS + partial index IF NOT EXISTS. Veilig
--   herhaaldelijk te draaien. UPSERT-pattern in endpoint via
--   ON CONFLICT (customer_id) DO UPDATE — één rij per klant, laatste
--   analyse wint.
--
-- ROLLBACK
--   DROP TABLE IF EXISTS public.dunning_gesprek_analyse;
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.dunning_gesprek_analyse (
  customer_id         UUID PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  afspraak_gemaakt    TEXT NOT NULL CHECK (afspraak_gemaakt IN ('JA','NEE','ONDUIDELIJK')),
  samenvatting        TEXT,
  termijnen           JSONB NOT NULL DEFAULT '[]'::jsonb,
  vertrouwen          TEXT CHECK (vertrouwen IS NULL OR vertrouwen IN ('hoog','laag')),
  actie_nodig         TEXT,
  heeft_arrangement   BOOLEAN NOT NULL DEFAULT false,
  messages_count      INT NOT NULL DEFAULT 0,
  customer_msg_count  INT NOT NULL DEFAULT 0,
  outbound_msg_count  INT NOT NULL DEFAULT 0,
  sufficient_data     BOOLEAN NOT NULL DEFAULT true,
  geanalyseerd_op     TIMESTAMPTZ NOT NULL DEFAULT now(),
  geanalyseerd_door   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.dunning_gesprek_analyse IS
  'Cache van AI-oordeel per klant over of er een BETAALAFSPRAAK is gemaakt in de WhatsApp-conversatie. 1 rij per klant, laatste analyse wint (UPSERT). Slaat GEEN gesprekken op, alleen het oordeel.';

COMMENT ON COLUMN public.dunning_gesprek_analyse.afspraak_gemaakt IS
  'Verdict: JA / NEE / ONDUIDELIJK (uit Anthropic structured output).';

COMMENT ON COLUMN public.dunning_gesprek_analyse.samenvatting IS
  'Max 200 chars NL samenvatting van wat er wel/niet is afgesproken (AI-output).';

COMMENT ON COLUMN public.dunning_gesprek_analyse.termijnen IS
  'JSONB array van {bedrag_eur, datum}-objecten bij afspraak_gemaakt=JA. Max 12 items.';

COMMENT ON COLUMN public.dunning_gesprek_analyse.actie_nodig IS
  'Vertaling van AI-verdict + arrangement-status naar aanbevolen actie ("Leg vast als TOEZEGGING", "Geen actie" etc).';

COMMENT ON COLUMN public.dunning_gesprek_analyse.geanalyseerd_door IS
  'user_id (super_admin) die de analyse triggerde. NULL bij (toekomstige) cron-analyses.';

-- Partial index voor de "Afspraak-niet-vastgelegd"-filter (JA + geen arrangement).
-- Alleen op JA-rijen zodat de scan lichtgewicht blijft.
CREATE INDEX IF NOT EXISTS idx_dunning_gesprek_analyse_ja_no_arr
  ON public.dunning_gesprek_analyse (customer_id)
  WHERE afspraak_gemaakt = 'JA' AND heeft_arrangement = false;

-- Sanity-check
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'dunning_gesprek_analyse'
ORDER BY ordinal_position;

COMMIT;
