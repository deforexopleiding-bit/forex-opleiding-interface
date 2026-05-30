-- ============================================================================
-- Kennisbank Redesign — schema + data-migratie + RLS + versies
-- Datum: 2026-05-30
-- Branch: feature/kennisbank-redesign
--
-- Doel:
--  1. Nieuwe kb_items tabel (vervangt kennisbank_items qua structuur)
--  2. agents text[] voor per-agent scoping
--  3. kb_item_versions met auto-snapshot trigger (max 10 per item)
--  4. RLS aan met permission-checks
--  5. Data-migratie van kennisbank_items naar kb_items
--  6. Oude tabel hernoemd naar kennisbank_items_archive (rollback-window 1 week)
--
-- Verifie-queries vooraf (handmatig op productie):
--   SELECT type, count(*) FROM kennisbank_items GROUP BY type;
--   SELECT * FROM kennisbank_items WHERE label = '_profile' LIMIT 1;
--   SELECT relrowsecurity FROM pg_class WHERE relname IN
--     ('kennisbank_items', 'kb_tags', 'kb_item_tags');
-- ============================================================================

BEGIN;

-- ── 1. NIEUWE TABEL kb_items ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kb_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title               text NOT NULL,
  content             text,                  -- markdown
  question            text,                  -- optioneel, FAQ-stijl
  answer              text,                  -- optioneel, FAQ-stijl
  is_profile          boolean NOT NULL DEFAULT false,
  agents              text[] NOT NULL DEFAULT ARRAY['shared'],  -- 'simon','lisa','leon','aron','shared'
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  times_used          integer DEFAULT 0,
  times_helpful       integer DEFAULT 0,
  helpfulness_score   integer DEFAULT 0,
  auto_generated      boolean DEFAULT false,
  source_email_id     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Full-text search (Dutch). Wordt automatisch bijgewerkt via trigger.
  search_text         tsvector
);

-- Title-lengte als check (geen schema-constraint maar guard).
ALTER TABLE public.kb_items
  DROP CONSTRAINT IF EXISTS kb_items_title_length;
ALTER TABLE public.kb_items
  ADD CONSTRAINT kb_items_title_length CHECK (length(title) > 0 AND length(title) <= 200);

-- Agents-validatie (alleen toegestane waarden).
ALTER TABLE public.kb_items
  DROP CONSTRAINT IF EXISTS kb_items_agents_check;
ALTER TABLE public.kb_items
  ADD CONSTRAINT kb_items_agents_check CHECK (
    agents <@ ARRAY['simon','lisa','leon','aron','shared']
  );

-- Indexes
CREATE INDEX IF NOT EXISTS idx_kb_items_helpfulness ON public.kb_items (helpfulness_score DESC);
CREATE INDEX IF NOT EXISTS idx_kb_items_updated     ON public.kb_items (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_items_profile     ON public.kb_items (is_profile) WHERE is_profile = true;
CREATE INDEX IF NOT EXISTS idx_kb_items_agents      ON public.kb_items USING GIN (agents);
CREATE INDEX IF NOT EXISTS idx_kb_items_search      ON public.kb_items USING GIN (search_text);

COMMENT ON TABLE public.kb_items IS
  'Centrale kennisbank — items met agent-scoping en versie-historie. Vervangt kennisbank_items.';

-- ── 2. VERSIE-TABEL ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.kb_item_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES public.kb_items(id) ON DELETE CASCADE,
  version_number  integer NOT NULL,
  title           text,
  content         text,
  question        text,
  answer          text,
  changed_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (item_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_kb_versions_item ON public.kb_item_versions (item_id, version_number DESC);

COMMENT ON TABLE public.kb_item_versions IS
  'Auto-snapshots bij elke UPDATE op kb_items. Max 10 versies per item; oudste worden gepruned door trigger.';

-- ── 3. TRIGGERS ─────────────────────────────────────────────────────────────

-- 3a. search_text auto-update bij INSERT/UPDATE.
CREATE OR REPLACE FUNCTION public.kb_items_update_search_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.search_text :=
    setweight(to_tsvector('dutch', coalesce(NEW.title, '')),    'A') ||
    setweight(to_tsvector('dutch', coalesce(NEW.question, '')), 'B') ||
    setweight(to_tsvector('dutch', coalesce(NEW.answer, '')),   'B') ||
    setweight(to_tsvector('dutch', coalesce(NEW.content, '')),  'C');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_items_search ON public.kb_items;
CREATE TRIGGER trg_kb_items_search
  BEFORE INSERT OR UPDATE OF title, content, question, answer ON public.kb_items
  FOR EACH ROW
  EXECUTE FUNCTION public.kb_items_update_search_text();

-- 3b. Auto-snapshot bij UPDATE → schrijf OLD naar kb_item_versions.
--     Daarna prune oudste versies > 10.
CREATE OR REPLACE FUNCTION public.kb_items_snapshot_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_version integer;
  cutoff_id uuid;
BEGIN
  -- Skip als er niets relevants is veranderd (alleen times_used/score updates).
  IF NEW.title IS NOT DISTINCT FROM OLD.title
     AND NEW.content IS NOT DISTINCT FROM OLD.content
     AND NEW.question IS NOT DISTINCT FROM OLD.question
     AND NEW.answer IS NOT DISTINCT FROM OLD.answer THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(version_number), 0) + 1
    INTO next_version
    FROM public.kb_item_versions
    WHERE item_id = OLD.id;

  INSERT INTO public.kb_item_versions (item_id, version_number, title, content, question, answer, changed_by)
  VALUES (OLD.id, next_version, OLD.title, OLD.content, OLD.question, OLD.answer, auth.uid());

  -- Prune: bewaar laatste 10 versies.
  DELETE FROM public.kb_item_versions
   WHERE item_id = OLD.id
     AND version_number <= (
       SELECT version_number FROM public.kb_item_versions
        WHERE item_id = OLD.id
        ORDER BY version_number DESC
        OFFSET 10 LIMIT 1
     );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kb_items_version_snapshot ON public.kb_items;
CREATE TRIGGER trg_kb_items_version_snapshot
  BEFORE UPDATE OF title, content, question, answer ON public.kb_items
  FOR EACH ROW
  EXECUTE FUNCTION public.kb_items_snapshot_version();

-- ── 4. RLS ──────────────────────────────────────────────────────────────────

ALTER TABLE public.kb_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_item_versions ENABLE ROW LEVEL SECURITY;

-- SELECT: alle authenticated users (gedeelde knowledge).
DROP POLICY IF EXISTS kb_items_select ON public.kb_items;
CREATE POLICY kb_items_select ON public.kb_items
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- INSERT: authenticated. Permission-check + created_by-injectie gebeurt op API-laag.
DROP POLICY IF EXISTS kb_items_insert ON public.kb_items;
CREATE POLICY kb_items_insert ON public.kb_items
  FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- UPDATE: own item, of admin-rol. Verfijning per-feature (kennisbank.item.edit) op API.
DROP POLICY IF EXISTS kb_items_update ON public.kb_items;
CREATE POLICY kb_items_update ON public.kb_items
  FOR UPDATE
  USING (
    created_by = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  )
  WITH CHECK (
    created_by = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- DELETE: admin-roles only.
DROP POLICY IF EXISTS kb_items_delete ON public.kb_items;
CREATE POLICY kb_items_delete ON public.kb_items
  FOR DELETE
  USING (public.has_any_role(ARRAY['super_admin','admin','manager']));

-- Versies: SELECT-only voor users, geen direct write.
DROP POLICY IF EXISTS kb_versions_select ON public.kb_item_versions;
CREATE POLICY kb_versions_select ON public.kb_item_versions
  FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Schrijven naar versies gebeurt ALLEEN via trigger (service-role bypassen).
DROP POLICY IF EXISTS kb_versions_no_write ON public.kb_item_versions;
CREATE POLICY kb_versions_no_write ON public.kb_item_versions
  FOR ALL
  USING (false)
  WITH CHECK (false);

-- ── 5. DATA-MIGRATIE ────────────────────────────────────────────────────────
-- Migreer kennisbank_items → kb_items. Defensief: alleen als bron-tabel bestaat
-- en doel-tabel leeg is (idempotent).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='kennisbank_items')
     AND NOT EXISTS (SELECT 1 FROM public.kb_items LIMIT 1) THEN

    INSERT INTO public.kb_items (
      id, title, content, question, answer, is_profile, agents,
      times_used, times_helpful, helpfulness_score, auto_generated,
      source_email_id, created_at, updated_at
    )
    SELECT
      COALESCE(id, gen_random_uuid()) AS id,
      -- NOT NULL guarantee: NULLIF strips empty strings, dan fallback-keten.
      COALESCE(NULLIF(title, ''), NULLIF(question, ''), 'Untitled') AS title,
      NULLIF(content, '') AS content,         -- nullable, leeg → NULL
      NULLIF(question, '') AS question,        -- nullable
      NULLIF(answer, '') AS answer,            -- nullable
      -- NOT NULL: wrap beide branches in COALESCE; NULL-input op een branch
      -- mag niet doorlekken naar OR-resultaat.
      (COALESCE(label = '_profile', false) OR COALESCE(type = 'bedrijfsprofiel', false)) AS is_profile,
      ARRAY['shared']::text[] AS agents,       -- NOT NULL, expliciete array
      COALESCE(times_used, 0),
      COALESCE(times_helpful, 0),
      COALESCE(helpfulness_score, 0),
      COALESCE(auto_generated, false),
      NULLIF(source_email_id, '') AS source_email_id,   -- nullable
      COALESCE(created_at, now()),             -- NOT NULL
      COALESCE(updated_at, created_at, now())  -- NOT NULL, met dubbele fallback
    FROM public.kennisbank_items;

    RAISE NOTICE 'Data-migratie kennisbank_items → kb_items voltooid.';
  ELSE
    RAISE NOTICE 'Migratie overgeslagen (geen bron of doel niet leeg).';
  END IF;
END$$;

-- ── 5b. TAG-FK FIX ──────────────────────────────────────────────────────────
-- kb_item_tags.item_id wees naar kennisbank_items.id. Na rename naar
-- kennisbank_items_archive (sectie 6) klopt die FK niet meer voor nieuwe items.
-- Re-point FK naar kb_items.id. Bestaande tag-links blijven geldig omdat
-- data-migratie de id-waardes behoudt.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='kb_item_tags') THEN
    -- Drop alle bestaande FKs op item_id (naam kan variëren).
    EXECUTE (
      SELECT string_agg(
        format('ALTER TABLE public.kb_item_tags DROP CONSTRAINT %I;', conname),
        ' '
      )
      FROM pg_constraint
      WHERE conrelid = 'public.kb_item_tags'::regclass
        AND contype = 'f'
    );
    -- Voeg nieuwe FK toe op kb_items.
    EXECUTE 'ALTER TABLE public.kb_item_tags
             ADD CONSTRAINT kb_item_tags_item_id_fkey
             FOREIGN KEY (item_id) REFERENCES public.kb_items(id) ON DELETE CASCADE';
    RAISE NOTICE 'kb_item_tags.item_id FK herpunt naar kb_items.';
  END IF;
END$$;

-- ── 6. ARCHIVE-RENAME ───────────────────────────────────────────────────────
-- Rename oude tabel → kennisbank_items_archive (1 week rollback-window).
-- Defensief: alleen renamen als bron bestaat én archive-target nog niet bestaat.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='kennisbank_items')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='kennisbank_items_archive') THEN
    EXECUTE 'ALTER TABLE public.kennisbank_items RENAME TO kennisbank_items_archive';
    RAISE NOTICE 'kennisbank_items hernoemd naar kennisbank_items_archive.';
  END IF;
END$$;

COMMIT;

-- ============================================================================
-- ROLLBACK (handmatig — bij issues binnen 1 week)
-- ============================================================================
-- BEGIN;
--   -- Stap 1: archive terug naar origineel zodat oude code weer werkt.
--   DO $$ BEGIN
--     IF EXISTS (SELECT 1 FROM information_schema.tables
--                WHERE table_schema='public' AND table_name='kennisbank_items_archive')
--        AND NOT EXISTS (SELECT 1 FROM information_schema.tables
--                WHERE table_schema='public' AND table_name='kennisbank_items') THEN
--       EXECUTE 'ALTER TABLE public.kennisbank_items_archive RENAME TO kennisbank_items';
--     END IF;
--   END $$;
--   -- Stap 2: nieuwe tabellen weg.
--   DROP TRIGGER IF EXISTS trg_kb_items_version_snapshot ON public.kb_items;
--   DROP TRIGGER IF EXISTS trg_kb_items_search          ON public.kb_items;
--   DROP FUNCTION IF EXISTS public.kb_items_snapshot_version();
--   DROP FUNCTION IF EXISTS public.kb_items_update_search_text();
--   DROP TABLE IF EXISTS public.kb_item_versions;
--   DROP TABLE IF EXISTS public.kb_items;
-- COMMIT;
