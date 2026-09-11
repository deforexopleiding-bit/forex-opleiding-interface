-- =============================================================================
-- Takenbeheer Fase 1 — T1: watchers + attachments (SQL-migratie)
-- Datum: 2026-08-08
-- Branch: feat/takenbeheer-t1-migratie
--
-- Doel:
--   1. Nieuwe tabel taken_watchers (M:N task ↔ profile)
--   2. Nieuwe tabel taken_attachments (kopie van ticket_attachments-shape)
--   3. Nieuwe Storage-bucket taken-attachments (identiek aan tickets-attachments)
--   4. RLS-policies op beide tabellen + bucket (kopie van tickets-patroon)
--
-- SCOPE: puur additief. Geen wijziging aan bestaande data of tabellen.
--
-- HERGEBRUIK: alle structuur + policies gekopieerd van tickets-module
-- (docs/sql-migrations/2026-05-28-tickets-module.sql regels 73–91, 189–226,
-- 269–304). Zelfde bucket-config: private, 10 MB per file, alleen images
-- (image/png,image/jpeg,image/gif,image/webp). Videos gaan via external_url
-- (Loom/YouTube/Drive/Vimeo-embed) — bucket blokkeert video-mimes bewust.
--
-- LET OP: taken_items heeft GEEN comments-model (anders dan tickets). De XOR
-- op parent-check gebruikt daarom alleen task_id — comment_id kolom
-- gereserveerd (nullable, geen FK) voor toekomstige comments-uitbreiding.
--
-- ROLLBACK: onderaan expliciet.
-- =============================================================================

BEGIN;

-- ── 1. TABEL taken_watchers ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.taken_watchers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id      uuid NOT NULL REFERENCES public.taken_items(id) ON DELETE CASCADE,
  profile_id   uuid NOT NULL REFERENCES public.profiles(id)   ON DELETE CASCADE,
  added_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  added_at     timestamptz NOT NULL DEFAULT now(),
  notify_mode  text NOT NULL DEFAULT 'default'
    CHECK (notify_mode IN ('default','none')),
  CONSTRAINT taken_watchers_unique UNIQUE (task_id, profile_id)
);

CREATE INDEX IF NOT EXISTS taken_watchers_task_idx
  ON public.taken_watchers (task_id);
CREATE INDEX IF NOT EXISTS taken_watchers_profile_idx
  ON public.taken_watchers (profile_id);

-- ── 2. TABEL taken_attachments ─────────────────────────────────────────────
-- Shape gekopieerd van public.ticket_attachments. Videos zijn external_url
-- only; images via storage_path in 'taken-attachments'-bucket.
CREATE TABLE IF NOT EXISTS public.taken_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  task_id       uuid REFERENCES public.taken_items(id) ON DELETE CASCADE,
  comment_id    uuid,   -- gereserveerd voor toekomstige taken_comments; nu ongebruikt

  storage_path  text,   -- pad in 'taken-attachments'-bucket (images)
  external_url  text,   -- volledige URL (Loom/YouTube/Drive/Vimeo)
  filename      text,
  mime_type     text,

  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT taken_attachments_parent_check
    CHECK ((task_id IS NOT NULL) <> (comment_id IS NOT NULL)),
  CONSTRAINT taken_attachments_source_check
    CHECK ((storage_path IS NOT NULL) <> (external_url IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS taken_attachments_task_idx
  ON public.taken_attachments (task_id)
  WHERE task_id IS NOT NULL;

-- ── 3. RLS op taken_watchers ──────────────────────────────────────────────
ALTER TABLE public.taken_watchers ENABLE ROW LEVEL SECURITY;

-- DROP-vóór-CREATE zodat re-run van dit script niet crasht op bestaande policies.
DROP POLICY IF EXISTS "Watcher, owner, assignee or ADMIN (SELECT)" ON public.taken_watchers;
DROP POLICY IF EXISTS "Task owner, assignee or ADMIN (INSERT)"     ON public.taken_watchers;
DROP POLICY IF EXISTS "Watcher, owner or ADMIN (DELETE)"           ON public.taken_watchers;

-- SELECT: watcher zelf, task-owner (created_by), assignee, admin-rollen
CREATE POLICY "Watcher, owner, assignee or ADMIN (SELECT)"
  ON public.taken_watchers
  FOR SELECT TO authenticated
  USING (
    profile_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.taken_items ti
      WHERE ti.id = taken_watchers.task_id
        AND ti.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.taken_assignees ta
      WHERE ta.task_id = taken_watchers.task_id
        AND ta.profile_id = auth.uid()
    )
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- INSERT: task-owner + assignees + admin. Voegt watcher toe aan een taak
-- waar je zelf toegang toe hebt.
CREATE POLICY "Task owner, assignee or ADMIN (INSERT)"
  ON public.taken_watchers
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.taken_items ti
      WHERE ti.id = taken_watchers.task_id
        AND ti.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.taken_assignees ta
      WHERE ta.task_id = taken_watchers.task_id
        AND ta.profile_id = auth.uid()
    )
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- DELETE: watcher zelf (unsubscribe), task-owner of admin
CREATE POLICY "Watcher, owner or ADMIN (DELETE)"
  ON public.taken_watchers
  FOR DELETE TO authenticated
  USING (
    profile_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.taken_items ti
      WHERE ti.id = taken_watchers.task_id
        AND ti.created_by = auth.uid()
    )
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- ── 4. RLS op taken_attachments (parent-access-inheritance) ───────────────
ALTER TABLE public.taken_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Inherit parent access (SELECT)"   ON public.taken_attachments;
DROP POLICY IF EXISTS "Creator only (INSERT)"            ON public.taken_attachments;
DROP POLICY IF EXISTS "Creator or ADMIN_ROLES (DELETE)"  ON public.taken_attachments;

CREATE POLICY "Inherit parent access (SELECT)"
  ON public.taken_attachments
  FOR SELECT TO authenticated
  USING (
    task_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.taken_items ti
      WHERE ti.id = taken_attachments.task_id
        AND (
          ti.created_by = auth.uid()
          OR EXISTS (
            SELECT 1 FROM public.taken_assignees ta
            WHERE ta.task_id = ti.id AND ta.profile_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.taken_watchers tw
            WHERE tw.task_id = ti.id AND tw.profile_id = auth.uid()
          )
          OR public.has_any_role(ARRAY['super_admin','admin','manager'])
        )
    )
  );

CREATE POLICY "Creator only (INSERT)"
  ON public.taken_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
  );

CREATE POLICY "Creator or ADMIN_ROLES (DELETE)"
  ON public.taken_attachments
  FOR DELETE TO authenticated
  USING (
    created_by = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- ── 5. Storage-bucket + storage.objects-policies ──────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'taken-attachments',
  'taken-attachments',
  false,                                                  -- private, signed URLs
  10485760,                                               -- 10 MB per file
  ARRAY['image/png','image/jpeg','image/gif','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: user mag alleen uploaden onder eigen user.id-prefix
DROP POLICY IF EXISTS "Taken attachments INSERT (own prefix)"    ON storage.objects;
DROP POLICY IF EXISTS "Taken attachments SELECT (authenticated)" ON storage.objects;
DROP POLICY IF EXISTS "Taken attachments DELETE (own or admin)"  ON storage.objects;

CREATE POLICY "Taken attachments INSERT (own prefix)"
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'taken-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Taken attachments SELECT (authenticated)"
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'taken-attachments'
  );

CREATE POLICY "Taken attachments DELETE (own or admin)"
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'taken-attachments'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.has_any_role(ARRAY['super_admin','admin','manager'])
    )
  );

COMMIT;

-- =============================================================================
-- ROLLBACK (manueel uitvoerbaar — draai deze in aparte transactie bij terugdraai):
-- =============================================================================
--
-- BEGIN;
--
-- DROP POLICY IF EXISTS "Taken attachments INSERT (own prefix)"    ON storage.objects;
-- DROP POLICY IF EXISTS "Taken attachments SELECT (authenticated)" ON storage.objects;
-- DROP POLICY IF EXISTS "Taken attachments DELETE (own or admin)"  ON storage.objects;
--
-- -- Bucket-delete alleen als geen objects meer in de bucket zitten:
-- DELETE FROM storage.objects WHERE bucket_id = 'taken-attachments';
-- DELETE FROM storage.buckets WHERE id = 'taken-attachments';
--
-- DROP TABLE IF EXISTS public.taken_attachments;
-- DROP TABLE IF EXISTS public.taken_watchers;
--
-- COMMIT;
--
-- =============================================================================
-- PREREQ-CHECK (draai eerst — moet 't' returnen):
-- =============================================================================
--
-- SELECT EXISTS (
--   SELECT 1 FROM pg_proc
--   WHERE proname = 'has_any_role' AND pronargs = 1
-- ) AS "has_any_role_exists";
--
-- SELECT EXISTS (
--   SELECT 1 FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='taken_items'
-- ) AS "taken_items_exists";
--
-- SELECT EXISTS (
--   SELECT 1 FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='taken_assignees'
-- ) AS "taken_assignees_exists";
--
-- SELECT EXISTS (
--   SELECT 1 FROM information_schema.tables
--   WHERE table_schema='public' AND table_name='profiles'
-- ) AS "profiles_exists";
