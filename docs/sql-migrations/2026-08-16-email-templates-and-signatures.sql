-- ============================================================================
-- E-mail templates + handtekeningen — v2 email-round DEEL 2 + 3.
--
-- Twee nieuwe tabellen (geen wijzigingen op bestaande):
--   1. email_templates       — generieke reusable sjablonen (compose/reply)
--   2. email_signatures      — 1 globale default + optioneel per-mailbox
--
-- RLS-conventie: SELECT open voor authenticated (zoals dunning_templates);
-- writes gaan via server-side endpoints met super_admin gate + service-role
-- key. Client-writes zijn niet toegestaan (deny-all voor INSERT/UPDATE/DELETE).
--
-- Idempotent: gebruikt CREATE TABLE IF NOT EXISTS + safe policy re-creates.
-- Bij lokaal reruns geen error.
-- ============================================================================

BEGIN;

-- ── 1. email_templates ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.email_templates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL UNIQUE,
  subject         text,
  body_html       text NOT NULL DEFAULT '',
  body_text       text NOT NULL DEFAULT '',
  -- Categorie voor filtering in de picker. Vrij tekst; conventie:
  -- 'algemeen' | 'sales' | 'onboarding' | 'events' | 'wanbetalers' |
  -- 'partners' | 'welkom'.
  category        text NOT NULL DEFAULT 'algemeen',
  -- Variabelen die in body_html/body_text als {{key}} placeholders staan.
  -- Zelfde conventie als onderhoud_sjablonen.variabele_volgorde. Compose-
  -- picker toont ze als kleine chips zodat de user weet wat 'ie moet
  -- invullen. Empty array = geen variabelen.
  variables       jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active       boolean NOT NULL DEFAULT true,
  created_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_templates_active ON public.email_templates (is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_email_templates_category ON public.email_templates (category);

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_templates_select_authenticated ON public.email_templates;
CREATE POLICY email_templates_select_authenticated
  ON public.email_templates FOR SELECT
  TO authenticated USING (true);

-- Writes gaan via server-side endpoints (super_admin gate). Geen client writes.
DROP POLICY IF EXISTS email_templates_write_deny ON public.email_templates;
CREATE POLICY email_templates_write_deny
  ON public.email_templates FOR ALL
  TO authenticated USING (false) WITH CHECK (false);

-- ── 2. email_signatures ────────────────────────────────────────────────────
-- Één globale default (mailbox IS NULL) + optionele per-mailbox override.
-- Query bij send: SELECT * WHERE mailbox=$1 OR mailbox IS NULL
--                 ORDER BY mailbox NULLS LAST LIMIT 1
-- (per-mailbox rij wint van global).
CREATE TABLE IF NOT EXISTS public.email_signatures (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short-label van de mailbox ('info', 'leads', 'partners', 'administratie',
  -- 'onboarding', 'events', 'welkom'). NULL = globale default.
  mailbox            text UNIQUE,
  name               text NOT NULL DEFAULT 'Standaard',
  body_html          text NOT NULL DEFAULT '',
  body_text          text NOT NULL DEFAULT '',
  -- Logo-referentie. Zowel URL (hosted image) als data-URI/base64 mogelijk.
  -- Server-side kan hij als attachment met cid: worden ingesloten voor
  -- betrouwbaarder rendering in Outlook desktop / iOS Mail.
  -- Leeg = geen logo. Server wraps de body met logo als deze gezet is.
  logo_url           text,
  is_active          boolean NOT NULL DEFAULT true,
  updated_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Enforce: alleen 1 rij per mailbox (UNIQUE) + NULL is uniek (1 global default).
-- Postgres UNIQUE treats NULLs als distinct, dus we need een partial:
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_signatures_global
  ON public.email_signatures ((true)) WHERE mailbox IS NULL;

CREATE INDEX IF NOT EXISTS idx_email_signatures_active ON public.email_signatures (is_active) WHERE is_active = true;

ALTER TABLE public.email_signatures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_signatures_select_authenticated ON public.email_signatures;
CREATE POLICY email_signatures_select_authenticated
  ON public.email_signatures FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS email_signatures_write_deny ON public.email_signatures;
CREATE POLICY email_signatures_write_deny
  ON public.email_signatures FOR ALL
  TO authenticated USING (false) WITH CHECK (false);

-- ── 3. Seed default handtekening (backward-compat) ─────────────────────────
-- api/_lib/email-handtekening.js heeft nu een hardcoded default. Deze
-- migratie zet exact dezelfde tekst in de DB als globale default zodat de
-- gemigreerde codepath (per-mailbox uit DB) hetzelfde gedrag toont zonder
-- config-actie van Jeffrey.
INSERT INTO public.email_signatures (mailbox, name, body_html, body_text, logo_url)
VALUES (
  NULL,
  'Standaard',
  '<br><br>--<br>Team – De Forex Opleiding<br><a href="https://deforexopleiding.nl">deforexopleiding.nl</a>',
  E'\n\n--\nTeam – De Forex Opleiding\nhttps://deforexopleiding.nl',
  NULL
)
ON CONFLICT DO NOTHING;

COMMIT;
