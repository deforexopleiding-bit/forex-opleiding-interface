-- Migration: WhatsApp Meta-template folders (UI-grouping only — geen Meta-impact).
-- - whatsapp_template_folders: 1 rij per map per WABA.
-- - whatsapp_meta_templates.folder_id: optionele FK; ON DELETE SET NULL.
--
-- Strategie: idempotent (CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).

BEGIN;

CREATE TABLE IF NOT EXISTS public.whatsapp_template_folders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_account_id  text NOT NULL,
  name                 text NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  sort_order           integer NOT NULL DEFAULT 0,
  created_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_account_id, lower(name))
);

CREATE INDEX IF NOT EXISTS idx_wa_template_folders_waba
  ON public.whatsapp_template_folders (business_account_id, sort_order);

ALTER TABLE public.whatsapp_meta_templates
  ADD COLUMN IF NOT EXISTS folder_id uuid
    REFERENCES public.whatsapp_template_folders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wa_meta_templates_folder
  ON public.whatsapp_meta_templates (folder_id) WHERE folder_id IS NOT NULL;

COMMENT ON TABLE public.whatsapp_template_folders IS
  'Mappen voor WhatsApp Meta-templates per WABA. UI-only groepering — geen Meta-impact.';
COMMENT ON COLUMN public.whatsapp_meta_templates.folder_id IS
  'Optionele map voor UI-groepering. NULL = ongegroepeerd. ON DELETE SET NULL.';

COMMIT;
