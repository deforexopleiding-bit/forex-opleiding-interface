-- 004-kb-tags-lisa-products.sql
-- Lisa F4 — Knowledge Base: tag-systeem voor kennisbank_items + structured Lisa-producten.
-- Idempotent. Uitvoeren in Supabase SQL Editor (één keer; herhaalbaar).
-- Vereist: public.is_super_admin() uit migratie 002.
--
-- NB: kennisbank_items bestaat BUITEN de migraties (handmatig aangemaakt). Daarom GEEN FK
--     op kb_item_tags.item_id → kennisbank_items (een FK zou breken / orphans ontstaan bij
--     verwijderen van een KB-item; frontend toont die als "ghost tags").

BEGIN;

-- ============================================
-- TABEL: kb_tags
-- ============================================
CREATE TABLE IF NOT EXISTS kb_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text UNIQUE NOT NULL,
  color text NOT NULL DEFAULT '#6B7280', -- hex kleur voor UI
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_kb_tags_name ON kb_tags(name);

COMMENT ON TABLE kb_tags IS
  'Tags voor kennisbank_items. Lisa filtert op tags voor relevante KB.';

-- ============================================
-- TABEL: kb_item_tags (junction, N:M)
-- ============================================
CREATE TABLE IF NOT EXISTS kb_item_tags (
  item_id uuid NOT NULL,  -- → kennisbank_items.id (bewust GEEN FK, zie kop)
  tag_id uuid NOT NULL REFERENCES kb_tags(id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by uuid REFERENCES profiles(id),
  PRIMARY KEY (item_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_item_tags_item ON kb_item_tags(item_id);
CREATE INDEX IF NOT EXISTS idx_kb_item_tags_tag ON kb_item_tags(tag_id);

COMMENT ON TABLE kb_item_tags IS
  'N:M koppeling tussen kennisbank_items en kb_tags. Geen FK op item_id omdat '
  'kennisbank_items niet in de migraties bestaat.';

-- ============================================
-- lisa_config: structured producten + FAQ + tag-filter
-- ============================================
-- kb_products WAS text in migratie 003 → converteer naar jsonb (array of objects).
-- Veilig: kb_products zit NIET in de config-editor (EDIT_FIELDS), dus altijd NULL/leeg.
-- Idempotent: alleen converteren zolang de kolom nog 'text' is.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'lisa_config' AND column_name = 'kb_products') = 'text' THEN
    ALTER TABLE lisa_config ALTER COLUMN kb_products DROP DEFAULT;
    ALTER TABLE lisa_config ALTER COLUMN kb_products TYPE jsonb
      USING CASE
        WHEN kb_products IS NULL OR btrim(kb_products) = '' THEN '[]'::jsonb
        ELSE to_jsonb(kb_products)
      END;
    ALTER TABLE lisa_config ALTER COLUMN kb_products SET DEFAULT '[]'::jsonb;
  END IF;
END $$;

COMMENT ON COLUMN lisa_config.kb_products IS
  'JSONB array: [{naam, beschrijving, prijs, doelgroep, duur}]';

-- kb_faq was al jsonb in 003 — alleen schema documenteren.
COMMENT ON COLUMN lisa_config.kb_faq IS
  'JSONB array: [{vraag, antwoord, tags?: [string]}]';

-- Nieuw: welke tags Lisa mag gebruiken voor KB-lookup.
ALTER TABLE lisa_config
  ADD COLUMN IF NOT EXISTS kb_tag_filter jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN lisa_config.kb_tag_filter IS
  'JSONB array van tag-namen. Lisa gebruikt alleen kennisbank_items met deze tags. '
  'Lege array = geen KB-items.';

-- ============================================
-- RLS Policies
-- ============================================
ALTER TABLE kb_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_item_tags ENABLE ROW LEVEL SECURITY;

-- READ: alle authenticated users
DROP POLICY IF EXISTS "auth read kb_tags" ON kb_tags;
CREATE POLICY "auth read kb_tags" ON kb_tags
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth read kb_item_tags" ON kb_item_tags;
CREATE POLICY "auth read kb_item_tags" ON kb_item_tags
  FOR SELECT TO authenticated USING (true);

-- WRITE: super_admin (service role bypasst RLS automatisch)
DROP POLICY IF EXISTS "super admin write kb_tags" ON kb_tags;
CREATE POLICY "super admin write kb_tags" ON kb_tags
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "super admin write kb_item_tags" ON kb_item_tags;
CREATE POLICY "super admin write kb_item_tags" ON kb_item_tags
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ============================================
-- Seed: Lisa-relevante starter tags (idempotent op UNIQUE name)
-- ============================================
INSERT INTO kb_tags (name, color, description)
SELECT t.name, t.color, t.description FROM (VALUES
  ('lisa-product',    '#3B82F6', 'Producten/diensten voor Lisa'),
  ('lisa-pricing',    '#10B981', 'Prijsinformatie voor Lisa'),
  ('lisa-faq',        '#8B5CF6', 'Veelgestelde vragen Lisa-context'),
  ('trading-basics',  '#F59E0B', 'Basis trading-kennis'),
  ('risk-management', '#EF4444', 'Risicobeheer'),
  ('forex-context',   '#06B6D4', 'Forex-specifieke kennis')
) AS t(name, color, description)
WHERE NOT EXISTS (SELECT 1 FROM kb_tags WHERE kb_tags.name = t.name);

COMMIT;

-- ============================================
-- VERIFICATIE (handmatig in SQL Editor)
-- ============================================
-- SELECT COUNT(*) FROM kb_tags;                          -- >= 6 starter tags
-- SELECT name, color FROM kb_tags ORDER BY name;
-- SELECT data_type FROM information_schema.columns
--   WHERE table_name='lisa_config' AND column_name='kb_products';  -- jsonb
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name='lisa_config' AND column_name='kb_tag_filter'; -- bestaat
