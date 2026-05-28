-- =============================================================================
-- Tickets-module Fase 1 — Fundament
-- Datum: 2026-05-28
-- Context: Bug/feature/vraag-tracker. 3 tabellen + RLS + trigger + bucket.
--
-- Afhankelijkheden:
-- - profiles tabel (met id uuid + role text)
-- - public.has_any_role(text[]) helper (bestaat sinds 2026-05-14)
--
-- Roll-out volgorde: deze migratie → sidebar/admin/placeholder PR → Fase 2 UI.
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. tickets — hoofdtabel
-- =============================================================================

CREATE TABLE public.tickets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title         text NOT NULL,
  description   text,

  type          text NOT NULL DEFAULT 'bug'
                CHECK (type IN ('bug','feature','question')),
  status        text NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','in_progress','resolved','closed')),
  priority      text NOT NULL DEFAULT 'middel'
                CHECK (priority IN ('laag','middel','hoog')),

  -- Welke module/onderwerp het ticket betreft. Vrije text — UI levert dropdown
  -- met huidige modules + 'Anders'. Geen CHECK zodat nieuwe modules geen
  -- schema-migratie vereisen.
  module        text,

  created_by    uuid NOT NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  assigned_to   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz
);

-- Indexes voor performance bij filter-queries
CREATE INDEX idx_tickets_status      ON public.tickets(status);
CREATE INDEX idx_tickets_assigned_to ON public.tickets(assigned_to)
  WHERE assigned_to IS NOT NULL;
CREATE INDEX idx_tickets_created_by  ON public.tickets(created_by);
CREATE INDEX idx_tickets_type        ON public.tickets(type);

-- =============================================================================
-- 2. ticket_comments — chronologische comments per ticket
-- =============================================================================

CREATE TABLE public.ticket_comments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES public.tickets(id) ON DELETE CASCADE,
  author_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_comments_ticket ON public.ticket_comments(ticket_id);

-- =============================================================================
-- 3. ticket_attachments — screenshots (storage) + video-links (external_url)
-- =============================================================================
-- Eén bijlage hangt aan OF een ticket OF een comment, en heeft OF een storage-
-- path OF een external_url. CHECK constraints garanderen exact één parent +
-- exact één bron.

CREATE TABLE public.ticket_attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  ticket_id     uuid REFERENCES public.tickets(id) ON DELETE CASCADE,
  comment_id    uuid REFERENCES public.ticket_comments(id) ON DELETE CASCADE,

  storage_path  text,  -- pad in 'tickets-attachments' bucket (screenshots/images)
  external_url  text,  -- volledige URL (Loom, YouTube, Drive, etc.)
  filename      text,
  mime_type     text,

  created_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ticket_attachments_parent_check
    CHECK ((ticket_id IS NOT NULL) <> (comment_id IS NOT NULL)),
  CONSTRAINT ticket_attachments_source_check
    CHECK ((storage_path IS NOT NULL) <> (external_url IS NOT NULL))
);

CREATE INDEX idx_ticket_attachments_ticket  ON public.ticket_attachments(ticket_id)
  WHERE ticket_id IS NOT NULL;
CREATE INDEX idx_ticket_attachments_comment ON public.ticket_attachments(comment_id)
  WHERE comment_id IS NOT NULL;

-- =============================================================================
-- 4. RLS policies — "owner or admin" patroon
-- =============================================================================

-- ── tickets ──────────────────────────────────────────────────────────────────
ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owner or ADMIN_ROLES (SELECT)"
  ON public.tickets
  FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR assigned_to = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY "Owner or ADMIN_ROLES (INSERT)"
  ON public.tickets
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
  );

CREATE POLICY "Owner or ADMIN_ROLES (UPDATE)"
  ON public.tickets
  FOR UPDATE TO authenticated
  USING (
    created_by = auth.uid()
    OR assigned_to = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  )
  WITH CHECK (
    created_by = auth.uid()
    OR assigned_to = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY "ADMIN_ROLES only (DELETE)"
  ON public.tickets
  FOR DELETE TO authenticated
  USING (
    public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- ── ticket_comments — inherit from parent ticket ────────────────────────────
ALTER TABLE public.ticket_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Inherit ticket access (SELECT)"
  ON public.ticket_comments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_comments.ticket_id
        AND (t.created_by = auth.uid()
             OR t.assigned_to = auth.uid()
             OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    )
  );

CREATE POLICY "Authenticated can comment (INSERT)"
  ON public.ticket_comments
  FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_comments.ticket_id
        AND (t.created_by = auth.uid()
             OR t.assigned_to = auth.uid()
             OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    )
  );

CREATE POLICY "Author or ADMIN_ROLES (UPDATE)"
  ON public.ticket_comments
  FOR UPDATE TO authenticated
  USING (
    author_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY "Author or ADMIN_ROLES (DELETE)"
  ON public.ticket_comments
  FOR DELETE TO authenticated
  USING (
    author_id = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- ── ticket_attachments — inherit from parent ticket OR comment ──────────────
ALTER TABLE public.ticket_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Inherit parent access (SELECT)"
  ON public.ticket_attachments
  FOR SELECT TO authenticated
  USING (
    (ticket_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tickets t
      WHERE t.id = ticket_attachments.ticket_id
        AND (t.created_by = auth.uid()
             OR t.assigned_to = auth.uid()
             OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    ))
    OR
    (comment_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.ticket_comments c
      JOIN public.tickets t ON t.id = c.ticket_id
      WHERE c.id = ticket_attachments.comment_id
        AND (t.created_by = auth.uid()
             OR t.assigned_to = auth.uid()
             OR public.has_any_role(ARRAY['super_admin','admin','manager']))
    ))
  );

CREATE POLICY "Creator only (INSERT)"
  ON public.ticket_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
  );

CREATE POLICY "Creator or ADMIN_ROLES (DELETE)"
  ON public.ticket_attachments
  FOR DELETE TO authenticated
  USING (
    created_by = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- =============================================================================
-- 5. Status-change trigger op tickets
-- =============================================================================
-- Muteert twee dingen op elke UPDATE:
--   • updated_at = now() (audit)
--   • resolved_at semantiek:
--       open|in_progress → resolved : zet resolved_at = now()
--       open|in_progress → closed   : zet resolved_at = now()
--       resolved         ↔ closed   : BLIJFT staan (= moment werk klaar was,
--                                     niet moment van sluiten/heropenen-naar-closed)
--       resolved|closed  → open|in_progress : clear resolved_at (heropend)

CREATE OR REPLACE FUNCTION public.tickets_handle_status_change()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();

  -- Vers afgesloten: vul resolved_at als die er nog niet stond.
  IF NEW.status IN ('resolved', 'closed') AND OLD.status NOT IN ('resolved', 'closed') THEN
    NEW.resolved_at = now();
  END IF;

  -- Heropend: clear resolved_at. Een resolved <-> closed transitie raakt
  -- dit blok NIET — resolved_at blijft staan als 'wanneer het werk klaar was'.
  IF NEW.status IN ('open', 'in_progress') AND OLD.status IN ('resolved', 'closed') THEN
    NEW.resolved_at = NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tickets_handle_status_change
  BEFORE UPDATE ON public.tickets
  FOR EACH ROW
  EXECUTE FUNCTION public.tickets_handle_status_change();

-- =============================================================================
-- 6. Supabase Storage bucket voor ticket-attachments
-- =============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tickets-attachments',
  'tickets-attachments',
  false,                                                  -- private; ondersteund via signed URLs of pad-prefix-check
  10485760,                                               -- 10 MB per file (screenshots/images)
  ARRAY['image/png','image/jpeg','image/gif','image/webp']
)
ON CONFLICT (id) DO NOTHING;

-- Storage RLS: user mag alleen uploaden onder eigen user.id-prefix
CREATE POLICY "Tickets attachments INSERT (own prefix)"
  ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tickets-attachments'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY "Tickets attachments SELECT (authenticated)"
  ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'tickets-attachments'
  );

CREATE POLICY "Tickets attachments DELETE (own or admin)"
  ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'tickets-attachments'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.has_any_role(ARRAY['super_admin','admin','manager'])
    )
  );

COMMIT;

-- =============================================================================
-- ROLLBACK (manueel uitvoerbaar):
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS "Tickets attachments INSERT (own prefix)" ON storage.objects;
-- DROP POLICY IF EXISTS "Tickets attachments SELECT (authenticated)" ON storage.objects;
-- DROP POLICY IF EXISTS "Tickets attachments DELETE (own or admin)" ON storage.objects;
-- DELETE FROM storage.buckets WHERE id = 'tickets-attachments';
-- DROP TRIGGER IF EXISTS tickets_handle_status_change ON public.tickets;
-- DROP FUNCTION IF EXISTS public.tickets_handle_status_change();
-- DROP TABLE IF EXISTS public.ticket_attachments CASCADE;
-- DROP TABLE IF EXISTS public.ticket_comments CASCADE;
-- DROP TABLE IF EXISTS public.tickets CASCADE;
-- COMMIT;
