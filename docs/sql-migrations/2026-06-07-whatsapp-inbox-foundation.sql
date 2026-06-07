-- 2026-06-07-whatsapp-inbox-foundation.sql
-- WhatsApp Inbox v1 fundament — DB-schema voor finance-scoped Bird API
-- integratie. Bouwt twee tabellen + RLS-stub. Geen seed-data; Bird
-- credentials worden later via env vars geconfigureerd (PR A2).
--
-- Architectuur:
-- - whatsapp_conversations  : 1 rij per gesprek met klant (Bird conversation)
-- - whatsapp_messages       : alle in- en uitgaande berichten met status-tracking
-- - bird_conversation_id    : uniek per Bird-conversation, koppeling met Bird's data
-- - customer_id             : optionele koppeling met customers (NULL bij onbekende
--                              nummers; wordt gevuld als we de bel-terug-match doen)
-- - status (conv)           : open / closed / archived
-- - direction (msg)         : 'in' (klant → ons) of 'out' (wij → klant)
-- - status (msg)            : queued / sent / delivered / read / failed
--
-- RBAC: aangemaakt in admin.html als 'finance.inbox.view' + 'finance.inbox.send'
-- (via UI feature_keys registry). Bestaande 'finance.whatsapp.*' keys blijven
-- voor later granulaire toepassingen.

BEGIN;

-- ---- whatsapp_conversations -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  bird_conversation_id text UNIQUE,                         -- Bird's eigen ID
  phone_number         text NOT NULL,                       -- WhatsApp nummer klant (+31...)
  display_name         text,                                -- naam zoals Bird kent
  status               text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','closed','archived')),
  last_message_at      timestamptz,
  last_message_preview text,                                -- eerste ~120 chars laatste msg
  unread_count         integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_conv_customer  ON public.whatsapp_conversations (customer_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_phone     ON public.whatsapp_conversations (phone_number);
CREATE INDEX IF NOT EXISTS idx_wa_conv_last_msg  ON public.whatsapp_conversations (last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_wa_conv_status    ON public.whatsapp_conversations (status, last_message_at DESC NULLS LAST);

-- Auto-update updated_at bij UPDATE (zelfde patroon als payment_match_candidates).
CREATE OR REPLACE FUNCTION public.whatsapp_conversations_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wa_conv_touch ON public.whatsapp_conversations;
CREATE TRIGGER trg_wa_conv_touch
  BEFORE UPDATE ON public.whatsapp_conversations
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_conversations_touch_updated_at();

-- ---- whatsapp_messages ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  direction           text NOT NULL CHECK (direction IN ('in','out')),
  bird_message_id     text UNIQUE,                          -- Bird's eigen message ID
  body                text,
  media_url           text,                                 -- voor foto's/docs (later)
  media_type          text,                                 -- image / document / audio / etc
  template_name       text,                                 -- bij outbound templates
  template_variables  jsonb,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','delivered','read','failed')),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_reason       text,
  sent_by_user_id     uuid REFERENCES auth.users(id),       -- outbound: wie verzond? (NULL bij workflow/auto)
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_msg_conv      ON public.whatsapp_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msg_status    ON public.whatsapp_messages (status)
  WHERE status IN ('queued','failed');
CREATE INDEX IF NOT EXISTS idx_wa_msg_bird_id   ON public.whatsapp_messages (bird_message_id)
  WHERE bird_message_id IS NOT NULL;

-- ---- RLS stub -------------------------------------------------------------
-- Phase 1: alleen authenticated SELECT. Write enkel via service-role
-- (webhook/endpoints). Granulaire policies komen in PR A2 zodra we de
-- finance.inbox.* permissions in een policy mappen.
ALTER TABLE public.whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_messages      ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wa_conv_select ON public.whatsapp_conversations;
DROP POLICY IF EXISTS wa_conv_write  ON public.whatsapp_conversations;
CREATE POLICY wa_conv_select ON public.whatsapp_conversations
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY wa_conv_write  ON public.whatsapp_conversations
  FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS wa_msg_select ON public.whatsapp_messages;
DROP POLICY IF EXISTS wa_msg_write  ON public.whatsapp_messages;
CREATE POLICY wa_msg_select ON public.whatsapp_messages
  FOR SELECT USING (auth.uid() IS NOT NULL);
CREATE POLICY wa_msg_write  ON public.whatsapp_messages
  FOR ALL USING (false) WITH CHECK (false);

COMMIT;
