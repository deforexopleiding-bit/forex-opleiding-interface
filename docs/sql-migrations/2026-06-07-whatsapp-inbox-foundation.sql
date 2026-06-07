-- 2026-06-07-whatsapp-inbox-foundation.sql
-- WhatsApp Inbox v1 fundament — DB-schema voor Meta WhatsApp Cloud API
-- directe integratie (geen BSP). Bouwt twee tabellen + RLS-stub. Geen
-- seed-data; Meta credentials worden later via env vars geconfigureerd
-- (PR A2).
--
-- Architectuur:
-- - whatsapp_conversations  : 1 rij per gesprek (1 per phone_number);
--                              uniek op phone_number i.p.v. Meta-side id
--                              omdat Cloud API geen stabiel conversation-id
--                              biedt voor klant-initiated chats — Meta's
--                              billing-side conversation-id is een ander
--                              concept (24h-windows).
-- - whatsapp_messages       : alle in- en uitgaande berichten met status-
--                              tracking en meta_wamid (Meta's WhatsApp
--                              Message ID, formaat 'wamid.XXX').
-- - last_inbound_at         : voor 24h customer-service window berekening
--                              (Meta laat alleen free-form text toe binnen
--                              24h sinds laatste inbound; daarna verplicht
--                              een approved template).
--
-- RBAC: aangemaakt in modules/admin.html feature_keys registry als
-- 'finance.inbox.view' + 'finance.inbox.send'. Bestaande
-- 'finance.whatsapp.*' keys blijven voor toekomstige granulaire
-- toepassingen (numbers_manage, etc).

BEGIN;

-- ---- whatsapp_conversations -----------------------------------------------
CREATE TABLE IF NOT EXISTS public.whatsapp_conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id          uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  phone_number         text NOT NULL,                       -- E.164 format, +316...
  display_name         text,                                -- Meta profile.name
  status               text NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','closed','archived')),
  last_message_at      timestamptz,
  last_message_preview text,                                -- eerste ~120 chars laatste msg
  unread_count         integer NOT NULL DEFAULT 0,
  last_inbound_at      timestamptz,                         -- voor 24h-window cap
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Uniek per phone_number (1 conversation per nummer; multi-channel later).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wa_conv_phone ON public.whatsapp_conversations (phone_number);
CREATE INDEX IF NOT EXISTS idx_wa_conv_customer  ON public.whatsapp_conversations (customer_id);
CREATE INDEX IF NOT EXISTS idx_wa_conv_last_msg  ON public.whatsapp_conversations (last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_wa_conv_status    ON public.whatsapp_conversations (status, last_message_at DESC NULLS LAST);

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
  meta_wamid          text UNIQUE,                          -- 'wamid.XXX' (Meta's msg id)
  body                text,
  media_url           text,                                 -- later: foto's, docs
  media_type          text,                                 -- image / document / audio / video
  template_name       text,                                 -- voor outbound template-sends
  template_variables  jsonb,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','sent','delivered','read','failed')),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  read_at             timestamptz,
  failed_reason       text,
  sent_by_user_id     uuid REFERENCES auth.users(id),       -- outbound: wie verzond? NULL bij workflow/auto
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wa_msg_conv      ON public.whatsapp_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_msg_status    ON public.whatsapp_messages (status)
  WHERE status IN ('queued','failed');
CREATE INDEX IF NOT EXISTS idx_wa_msg_wamid     ON public.whatsapp_messages (meta_wamid)
  WHERE meta_wamid IS NOT NULL;

-- ---- RLS stub -------------------------------------------------------------
-- Phase 1: authenticated SELECT; write USING(false) zodat alleen service-role
-- (webhook + endpoints) kan inserten. Granulaire policies komen in PR A2
-- zodra we finance.inbox.* permission-mapping doen.
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
