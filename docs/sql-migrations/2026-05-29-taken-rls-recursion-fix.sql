-- ============================================================================
-- Hotfix: RLS-recursie tussen taken_items en taken_assignees
-- Datum: 2026-05-29
-- Branch: fix/taken-rls-recursion
--
-- Probleem (PR #20, commit 7605843):
--   taken_items_select policy doet EXISTS (SELECT FROM taken_assignees ...)
--   taken_assignees_select policy doet EXISTS (SELECT FROM taken_items ...)
--   → Postgres detecteert infinite recursion (mutual policy evaluation).
--   Werkt voor super_admin/admin/manager door has_any_role short-circuit;
--   faalt voor alle andere rollen (sales/mentor/administratie/viewer).
--
-- Fix:
--   SECURITY DEFINER helper-functies die buiten RLS-context query'en.
--   Policies gebruiken nu de helpers ipv directe EXISTS subqueries.
-- ============================================================================

BEGIN;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Helper 1: is user assignee van deze taak?
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

-- Helper 2: mag user de taak zien als creator of direct-assignee?
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

-- ── Drop recursieve policies ────────────────────────────────────────────────
DROP POLICY IF EXISTS taken_items_select     ON public.taken_items;
DROP POLICY IF EXISTS taken_items_update     ON public.taken_items;
DROP POLICY IF EXISTS taken_assignees_select ON public.taken_assignees;
DROP POLICY IF EXISTS taken_assignees_insert ON public.taken_assignees;
DROP POLICY IF EXISTS taken_assignees_delete ON public.taken_assignees;

-- ── Herbouw met SECURITY DEFINER helpers ────────────────────────────────────

CREATE POLICY taken_items_select ON public.taken_items
  FOR SELECT
  USING (
    created_by = auth.uid()
    OR assigned_to_id = auth.uid()
    OR public.is_task_assignee(taken_items.id, auth.uid())
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
--   DROP POLICY IF EXISTS taken_items_select     ON public.taken_items;
--   DROP POLICY IF EXISTS taken_items_update     ON public.taken_items;
--   DROP POLICY IF EXISTS taken_assignees_select ON public.taken_assignees;
--   DROP POLICY IF EXISTS taken_assignees_insert ON public.taken_assignees;
--   DROP POLICY IF EXISTS taken_assignees_delete ON public.taken_assignees;
--   DROP FUNCTION IF EXISTS public.is_task_assignee(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.can_access_task(uuid, uuid);
--   -- Daarna originele policies uit 2026-05-29-taken-module-fundament.sql sectie 6+7 opnieuw aanmaken.
-- COMMIT;
