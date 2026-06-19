-- Migration: whatsapp_conversations.attendee_id
--
-- Persistente, handmatige koppeling van een conversation aan een event_attendee.
-- Spiegelt het bestaande customer_id-veld; idempotent (IF NOT EXISTS).
-- ON DELETE SET NULL zodat het verwijderen van een attendee de conversation
-- niet kapotmaakt (en operator op de inbox-UI direct ziet dat de koppeling
-- weg is gevallen).

BEGIN;

ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS attendee_id uuid
    REFERENCES public.event_attendees(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_wa_conversations_attendee_id
  ON public.whatsapp_conversations (attendee_id)
  WHERE attendee_id IS NOT NULL;

COMMENT ON COLUMN public.whatsapp_conversations.attendee_id IS
  'Optionele persistente koppeling aan een event_attendee. Gezet via '
  'inbox-link-conversation-to-attendee endpoint. ON DELETE SET NULL zodat '
  'verwijderen van attendee de conversation niet kapotmaakt.';

COMMIT;
