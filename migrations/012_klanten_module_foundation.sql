-- Migration 012: Klanten module foundation
-- Date: 2026-05-25
-- Purpose: Foundation tables for Klanten-module (DB-fundament; geen UI/API in deze fase).
-- Spec: docs/specs/01-klanten-module-spec.md (inline-spec Fase 1)
-- Idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING / DROP+CREATE policies). Vereist:
--   migratie 001 (profiles) + 002 (public.is_super_admin()).
-- LET OP: authenticated-read-all op customers (PII) volgt het migratie-003-pattern;
--   fijnmazige toegang (eigen vs alle klanten, AVG-acties) komt op de API-laag in Fase 2.

BEGIN;

-- ============================================================================
-- 1) audit_log — generieke, module-brede audit-trail (los van agent_audit_log)
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES profiles(id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity_type   text,
  entity_id     uuid,
  before_json   jsonb,
  after_json    jsonb,
  reason_text   text,
  ip_address    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user   ON audit_log(user_id, created_at DESC);

-- ============================================================================
-- 2) customers — NAW + AVG-velden (email/phone GEEN unique: klant kan reactiveren)
-- ============================================================================
CREATE TABLE IF NOT EXISTS customers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name                  text NOT NULL,
  last_name                   text NOT NULL,
  email                       text,
  phone                       text,
  address_street              text,
  address_number              text,
  address_postal              text,
  address_city                text,
  date_of_birth               date,
  tl_contact_id               text,
  ghl_contact_id              text,
  risk_tag_auto               boolean NOT NULL DEFAULT false,
  notes                       text,
  privacy_accepted_at         timestamptz,
  privacy_accepted_by_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by_user_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  archived_at                 timestamptz,
  anonymized_at               timestamptz,
  anonymization_reason        text
);
CREATE INDEX IF NOT EXISTS idx_customers_email_active ON customers(email)
  WHERE archived_at IS NULL AND anonymized_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_phone_active ON customers(phone)
  WHERE archived_at IS NULL AND anonymized_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_tl_contact   ON customers(tl_contact_id);
CREATE INDEX IF NOT EXISTS idx_customers_active       ON customers(archived_at, anonymized_at)
  WHERE archived_at IS NULL AND anonymized_at IS NULL;

-- ============================================================================
-- 3) customer_tag_definitions (+ 5 system-seeds) + customer_tags (junction)
-- ============================================================================
CREATE TABLE IF NOT EXISTS customer_tag_definitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  label         text NOT NULL,
  color         text NOT NULL DEFAULT '#6B7280',
  description   text,
  is_system     boolean NOT NULL DEFAULT false,
  display_order int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO customer_tag_definitions (slug, label, color, is_system, display_order) VALUES
  ('vip',         'VIP',         '#F59E0B', true, 1),
  ('risico',      'Risico',      '#EF4444', true, 2),
  ('ambassadeur', 'Ambassadeur', '#10B981', true, 3),
  ('pilot',       'Pilot',       '#3B82F6', true, 4),
  ('oud-lead',    'Oud-lead',    '#9CA3AF', true, 5)
ON CONFLICT (slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS customer_tags (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_slug           text NOT NULL REFERENCES customer_tag_definitions(slug),
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  UNIQUE (customer_id, tag_slug)
);
CREATE INDEX IF NOT EXISTS idx_customer_tags_customer ON customer_tags(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_tags_slug     ON customer_tags(tag_slug);

-- ============================================================================
-- 4) WhatsApp gedeelde infrastructuur (numbers / templates / messages)
-- ============================================================================
CREATE TABLE IF NOT EXISTS whatsapp_numbers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                  text,
  twilio_number_sid      text,
  phone_number           text UNIQUE NOT NULL,
  purpose                text NOT NULL CHECK (purpose IN ('finance','followup','lisa','general','sales')),
  is_active              boolean NOT NULL DEFAULT true,
  is_default_for_purpose boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_numbers_purpose ON whatsapp_numbers(purpose, is_active);

CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text UNIQUE NOT NULL,
  body_text            text,
  variables_json       jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta_template_id     text,
  meta_template_status text CHECK (meta_template_status IN ('draft','pending_approval','approved','rejected')) DEFAULT 'draft',
  category             text CHECK (category IN ('utility','marketing','authentication')) DEFAULT 'utility',
  language             text NOT NULL DEFAULT 'nl',
  version              int NOT NULL DEFAULT 1,
  is_active            boolean NOT NULL DEFAULT true,
  created_by_user_id   uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id             uuid REFERENCES customers(id) ON DELETE SET NULL,
  whatsapp_number_id      uuid REFERENCES whatsapp_numbers(id) ON DELETE SET NULL,
  direction               text NOT NULL CHECK (direction IN ('in','out')),
  message_body            text,
  template_id             uuid REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  template_variables_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_module           text,
  source_entity_type      text,
  source_entity_id        uuid,
  twilio_message_sid      text,
  status                  text NOT NULL CHECK (status IN ('queued','sent','delivered','read','failed')) DEFAULT 'queued',
  sent_at                 timestamptz,
  delivered_at            timestamptz,
  read_at                 timestamptz,
  sender_user_id          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_customer ON whatsapp_messages(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_source   ON whatsapp_messages(source_module, source_entity_type, source_entity_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status   ON whatsapp_messages(direction, status, created_at DESC);

-- ============================================================================
-- 5) letter_templates + letters
-- ============================================================================
CREATE TABLE IF NOT EXISTS letter_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text UNIQUE NOT NULL,
  body_markdown  text,
  variables_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  version        int NOT NULL DEFAULT 1,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS letters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: brieven = incasso-bewijslijn (aanmaningen) → hard delete blokkeren, anonimiseren is de route.
  customer_id         uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  template_id         uuid REFERENCES letter_templates(id) ON DELETE SET NULL,
  pdf_url             text,
  delivery_mode       text CHECK (delivery_mode IN ('manual','postnl_api')) DEFAULT 'manual',
  status              text CHECK (status IN ('generated','sent_manual','sent_postnl','delivered','failed')) DEFAULT 'generated',
  postnl_tracking_code text,
  generated_at        timestamptz DEFAULT now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  source_module       text,
  source_entity_type  text,
  source_entity_id    uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_letters_customer ON letters(customer_id);
CREATE INDEX IF NOT EXISTS idx_letters_status   ON letters(status);

-- ============================================================================
-- 6) avg_data_requests — AVG inzage/vergetelheid verzoeken
-- ============================================================================
CREATE TABLE IF NOT EXISTS avg_data_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: AVG-verzoeken = bewijs van correcte afhandeling (AP-klacht) → hard delete blokkeren.
  customer_id          uuid NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  request_type         text NOT NULL CHECK (request_type IN ('inzage','vergetelheid')),
  received_at          timestamptz NOT NULL DEFAULT now(),
  deadline_at          timestamptz NOT NULL,
  fulfilled_at         timestamptz,
  fulfilled_by_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  output_url           text,
  notes                text,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_avg_requests_open ON avg_data_requests(deadline_at) WHERE fulfilled_at IS NULL;

-- ============================================================================
-- 7) Herbruikbare updated_at-trigger (DRY — nieuw in de codebase)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customers_updated ON customers;
CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_whatsapp_templates_updated ON whatsapp_templates;
CREATE TRIGGER trg_whatsapp_templates_updated BEFORE UPDATE ON whatsapp_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_letter_templates_updated ON letter_templates;
CREATE TRIGGER trg_letter_templates_updated BEFORE UPDATE ON letter_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- 8) RLS — zelfde idioom als migratie 003 (authenticated read / super_admin write).
--    Service-role bypasst RLS automatisch; schrijven gebeurt in Fase 2 via service-role
--    ná permission-checks op de API-laag.
-- ============================================================================
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'audit_log','customers','customer_tag_definitions','customer_tags',
    'whatsapp_numbers','whatsapp_templates','whatsapp_messages',
    'letter_templates','letters','avg_data_requests'
  ]) LOOP
    EXECUTE format('ALTER TABLE %1$s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "auth read %1$s" ON %1$s', t);
    EXECUTE format('CREATE POLICY "auth read %1$s" ON %1$s FOR SELECT TO authenticated USING (true)', t);
    EXECUTE format('DROP POLICY IF EXISTS "super admin write %1$s" ON %1$s', t);
    EXECUTE format('CREATE POLICY "super admin write %1$s" ON %1$s FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())', t);
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- VALIDATIE (handmatig in SQL Editor) — verwacht 10 rijen
-- ============================================================================
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('audit_log','customers','customer_tag_definitions','customer_tags',
    'whatsapp_numbers','whatsapp_messages','whatsapp_templates',
    'letters','letter_templates','avg_data_requests')
ORDER BY table_name;
-- Extra checks:
-- SELECT slug,label FROM customer_tag_definitions ORDER BY display_order;   -- 5 seeds
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname IN (...);      -- alle true
