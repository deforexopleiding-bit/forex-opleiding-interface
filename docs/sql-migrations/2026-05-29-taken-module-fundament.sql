-- LET OP: policies gebruiken SECURITY DEFINER helper-functies om
-- RLS-recursie te voorkomen. Zie 2026-05-29-taken-rls-recursion-fix.sql
-- voor de hotfix-context.
--
-- ============================================================================
-- Taken-module Fase 1 — Fundament
-- Datum: 2026-05-29
-- Branch: feature/taken-fase-1-migratie
--
-- Doel:
--  1. Schoon datamodel (uuid PK, strikte FKs op profiles).
--  2. Hybride assignee-model (toegewezen_aan text + assigned_to_type) weg.
--  3. created_by (mens) XOR created_by_agent (simon/leon/aron).
--  4. RLS aan met owner/assignee/admin patroon.
--  5. Status CHECK ('todo','progress','done') + trigger voor afgerond_op.
--
-- LET OP: TRUNCATE wist 11 bestaande rommel-rijen. Niet meer recoverable.
-- ============================================================================

BEGIN;

-- ── 1. CLEANUP ──────────────────────────────────────────────────────────────
TRUNCATE TABLE public.taken_assignees CASCADE;
TRUNCATE TABLE public.taken_items     CASCADE;

-- ── 2. SCHEMA taken_items ───────────────────────────────────────────────────

-- 2a. Drop legacy hybride assignee-velden.
ALTER TABLE public.taken_items DROP COLUMN IF EXISTS toegewezen_aan;
ALTER TABLE public.taken_items DROP COLUMN IF EXISTS assigned_to_type;

-- 2b. id: text → uuid (tabel leeg, veilige cast).
ALTER TABLE public.taken_items
  ALTER COLUMN id DROP DEFAULT,
  ALTER COLUMN id TYPE uuid USING gen_random_uuid(),
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- 2c. email_id: text → uuid + FK email_messages (defensief: alleen als tabel bestaat).
DO $$
DECLARE v_type text;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='taken_items' AND column_name='email_id';
  IF v_type = 'text' THEN
    EXECUTE 'ALTER TABLE public.taken_items
              ALTER COLUMN email_id TYPE uuid USING NULLIF(email_id,'''')::uuid';
  END IF;
END$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='email_messages') THEN
    EXECUTE 'ALTER TABLE public.taken_items DROP CONSTRAINT IF EXISTS taken_items_email_id_fkey';
    EXECUTE 'ALTER TABLE public.taken_items
              ADD CONSTRAINT taken_items_email_id_fkey
              FOREIGN KEY (email_id) REFERENCES public.email_messages(id) ON DELETE SET NULL';
  END IF;
END$$;

-- 2d. source_meeting_id: FK agent_meetings (defensief).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='agent_meetings') THEN
    EXECUTE 'ALTER TABLE public.taken_items DROP CONSTRAINT IF EXISTS taken_items_source_meeting_id_fkey';
    EXECUTE 'ALTER TABLE public.taken_items
              ADD CONSTRAINT taken_items_source_meeting_id_fkey
              FOREIGN KEY (source_meeting_id) REFERENCES public.agent_meetings(id) ON DELETE SET NULL';
  END IF;
END$$;

-- 2e. assigned_to_id: FK profiles.
ALTER TABLE public.taken_items
  DROP CONSTRAINT IF EXISTS taken_items_assigned_to_id_fkey;
ALTER TABLE public.taken_items
  ADD CONSTRAINT taken_items_assigned_to_id_fkey
  FOREIGN KEY (assigned_to_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- 2f. created_by (mens) + created_by_agent (agent).
ALTER TABLE public.taken_items
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_agent text;

ALTER TABLE public.taken_items
  DROP CONSTRAINT IF EXISTS taken_items_created_by_agent_check;
ALTER TABLE public.taken_items
  ADD CONSTRAINT taken_items_created_by_agent_check
  CHECK (created_by_agent IS NULL OR created_by_agent IN ('simon','leon','aron'));

ALTER TABLE public.taken_items
  DROP CONSTRAINT IF EXISTS taken_items_exactly_one_creator;
ALTER TABLE public.taken_items
  ADD CONSTRAINT taken_items_exactly_one_creator
  CHECK ((created_by IS NOT NULL) <> (created_by_agent IS NOT NULL));

-- 2g. status CHECK constraint ('todo','progress','done').
ALTER TABLE public.taken_items
  DROP CONSTRAINT IF EXISTS taken_items_status_check;
ALTER TABLE public.taken_items
  ADD CONSTRAINT taken_items_status_check
  CHECK (status IN ('todo','progress','done'));

-- 2h. updated_at defensief.
ALTER TABLE public.taken_items
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ── 3. SCHEMA taken_assignees ───────────────────────────────────────────────

-- 3a. Drop legacy assignee_type / assignee_name (model gaat naar profiles-FK only).
ALTER TABLE public.taken_assignees DROP COLUMN IF EXISTS assignee_type;
ALTER TABLE public.taken_assignees DROP COLUMN IF EXISTS assignee_name;

-- 3b. task_id: text → uuid + strikte FK CASCADE.
DO $$
DECLARE v_type text;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='taken_assignees' AND column_name='task_id';
  IF v_type = 'text' THEN
    EXECUTE 'ALTER TABLE public.taken_assignees
              ALTER COLUMN task_id TYPE uuid USING NULLIF(task_id,'''')::uuid';
  END IF;
END$$;

ALTER TABLE public.taken_assignees
  DROP CONSTRAINT IF EXISTS taken_assignees_task_id_fkey;
ALTER TABLE public.taken_assignees
  ADD CONSTRAINT taken_assignees_task_id_fkey
  FOREIGN KEY (task_id) REFERENCES public.taken_items(id) ON DELETE CASCADE;

-- 3c. assignee_id: text → uuid + FK profiles + NOT NULL.
DO $$
DECLARE v_type text;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='taken_assignees' AND column_name='assignee_id';
  IF v_type = 'text' THEN
    EXECUTE 'ALTER TABLE public.taken_assignees
              ALTER COLUMN assignee_id TYPE uuid USING NULLIF(assignee_id,'''')::uuid';
  END IF;
END$$;

ALTER TABLE public.taken_assignees
  ALTER COLUMN assignee_id SET NOT NULL;

ALTER TABLE public.taken_assignees
  DROP CONSTRAINT IF EXISTS taken_assignees_assignee_id_fkey;
ALTER TABLE public.taken_assignees
  ADD CONSTRAINT taken_assignees_assignee_id_fkey
  FOREIGN KEY (assignee_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- 3d. Vervang oude composite unique door (task_id, assignee_id).
ALTER TABLE public.taken_assignees DROP CONSTRAINT IF EXISTS unique_task_assignee;
ALTER TABLE public.taken_assignees
  DROP CONSTRAINT IF EXISTS taken_assignees_task_assignee_unique;
ALTER TABLE public.taken_assignees
  ADD CONSTRAINT taken_assignees_task_assignee_unique
  UNIQUE (task_id, assignee_id);

-- ── 4. INDEXES ──────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_taken_items_status
  ON public.taken_items (status);
CREATE INDEX IF NOT EXISTS idx_taken_items_assigned_to_id
  ON public.taken_items (assigned_to_id)
  WHERE assigned_to_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_taken_items_created_by
  ON public.taken_items (created_by);
CREATE INDEX IF NOT EXISTS idx_taken_assignees_task_id
  ON public.taken_assignees (task_id);

-- ── 5. TRIGGER updated_at + afgerond_op semantiek ───────────────────────────
-- Status 'done' bewaart afgerond_op; terug uit 'done' reset 'm.
CREATE OR REPLACE FUNCTION public.taken_handle_status_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.status = 'done' AND (OLD.status IS DISTINCT FROM 'done') THEN
    NEW.afgerond_op := COALESCE(NEW.afgerond_op, now());
  END IF;
  IF NEW.status <> 'done' AND OLD.status = 'done' THEN
    NEW.afgerond_op := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_taken_items_status_change ON public.taken_items;
CREATE TRIGGER trg_taken_items_status_change
  BEFORE UPDATE ON public.taken_items
  FOR EACH ROW
  EXECUTE FUNCTION public.taken_handle_status_change();

-- ── 6. RLS helpers (SECURITY DEFINER, breken mutual recursion) ──────────────
-- taken_items_select en taken_assignees_select kunnen elkaar niet rechtstreeks
-- bevragen via EXISTS — Postgres detecteert dat als infinite recursion.
-- Oplossing: SECURITY DEFINER helpers die buiten RLS-context query'en.

CREATE OR REPLACE FUNCTION public.is_task_assignee(p_task_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.taken_assignees
    WHERE task_id = p_task_id AND assignee_id = p_user_id
  );
$$;

CREATE OR REPLACE FUNCTION public.can_access_task(p_task_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.taken_items
    WHERE id = p_task_id
      AND (created_by = p_user_id OR assigned_to_id = p_user_id)
  );
$$;

-- ── 6b. RLS taken_items ─────────────────────────────────────────────────────
ALTER TABLE public.taken_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS taken_items_select ON public.taken_items;
DROP POLICY IF EXISTS taken_items_insert ON public.taken_items;
DROP POLICY IF EXISTS taken_items_update ON public.taken_items;
DROP POLICY IF EXISTS taken_items_delete ON public.taken_items;

CREATE POLICY taken_items_select ON public.taken_items
  FOR SELECT
  USING (
    created_by = auth.uid()
    OR assigned_to_id = auth.uid()
    OR public.is_task_assignee(taken_items.id, auth.uid())
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY taken_items_insert ON public.taken_items
  FOR INSERT
  WITH CHECK (
    created_by = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY taken_items_update ON public.taken_items
  FOR UPDATE
  USING (
    created_by = auth.uid()
    OR assigned_to_id = auth.uid()
    OR public.is_task_assignee(taken_items.id, auth.uid())
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  )
  WITH CHECK (
    created_by = auth.uid()
    OR assigned_to_id = auth.uid()
    OR public.is_task_assignee(taken_items.id, auth.uid())
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY taken_items_delete ON public.taken_items
  FOR DELETE
  USING (
    created_by = auth.uid()
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

-- ── 7. RLS taken_assignees ──────────────────────────────────────────────────
ALTER TABLE public.taken_assignees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS taken_assignees_select ON public.taken_assignees;
DROP POLICY IF EXISTS taken_assignees_insert ON public.taken_assignees;
DROP POLICY IF EXISTS taken_assignees_delete ON public.taken_assignees;

CREATE POLICY taken_assignees_select ON public.taken_assignees
  FOR SELECT
  USING (
    assignee_id = auth.uid()
    OR public.can_access_task(taken_assignees.task_id, auth.uid())
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY taken_assignees_insert ON public.taken_assignees
  FOR INSERT
  WITH CHECK (
    public.can_access_task(taken_assignees.task_id, auth.uid())
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

CREATE POLICY taken_assignees_delete ON public.taken_assignees
  FOR DELETE
  USING (
    assignee_id = auth.uid()
    OR public.can_access_task(taken_assignees.task_id, auth.uid())
    OR public.has_any_role(ARRAY['super_admin','admin','manager'])
  );

COMMIT;

-- ============================================================================
-- ROLLBACK (handmatig)
-- ============================================================================
-- BEGIN;
--   DROP POLICY IF EXISTS taken_items_select  ON public.taken_items;
--   DROP POLICY IF EXISTS taken_items_insert  ON public.taken_items;
--   DROP POLICY IF EXISTS taken_items_update  ON public.taken_items;
--   DROP POLICY IF EXISTS taken_items_delete  ON public.taken_items;
--   DROP POLICY IF EXISTS taken_assignees_select ON public.taken_assignees;
--   DROP POLICY IF EXISTS taken_assignees_insert ON public.taken_assignees;
--   DROP POLICY IF EXISTS taken_assignees_delete ON public.taken_assignees;
--   ALTER TABLE public.taken_items     DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.taken_assignees DISABLE ROW LEVEL SECURITY;
--
--   DROP TRIGGER  IF EXISTS trg_taken_items_status_change ON public.taken_items;
--   DROP FUNCTION IF EXISTS public.taken_handle_status_change();
--
--   DROP INDEX IF EXISTS public.idx_taken_assignees_task_id;
--   DROP INDEX IF EXISTS public.idx_taken_items_created_by;
--   DROP INDEX IF EXISTS public.idx_taken_items_assigned_to_id;
--   DROP INDEX IF EXISTS public.idx_taken_items_status;
--
--   ALTER TABLE public.taken_items DROP CONSTRAINT IF EXISTS taken_items_exactly_one_creator;
--   ALTER TABLE public.taken_items DROP CONSTRAINT IF EXISTS taken_items_created_by_agent_check;
--   ALTER TABLE public.taken_items DROP CONSTRAINT IF EXISTS taken_items_status_check;
--   ALTER TABLE public.taken_items DROP COLUMN IF EXISTS created_by_agent;
--   ALTER TABLE public.taken_items DROP COLUMN IF EXISTS created_by;
--   -- toegewezen_aan / assignee_type / assignee_name: alleen restore uit backup mogelijk
-- COMMIT;
