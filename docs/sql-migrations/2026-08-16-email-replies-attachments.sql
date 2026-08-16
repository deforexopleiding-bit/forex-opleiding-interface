-- ============================================================================
-- E-mail uitgaand — attachments-kolom op email_replies (v2 email-round).
--
-- Uitgaande bijlagen (compose-picker → nodemailer) worden verzonden via
-- base64-payload; deze kolom bewaart de metadata (filename, MIME, size)
-- zodat de Sent-map in v2 kan tonen dat een reply een bijlage had.
--
-- Shape (jsonb array): [{filename, mime_type, size_bytes}]
--   NULL = geen attachments-info bewaard (backwards-compat met bestaande rows)
--   []   = expliciet geen bijlagen
--
-- Kolom is optioneel op INSERT (api/send-email.js:132 heeft al fail-soft
-- guard: "Omit attachments field when null — PostgREST rejects unknown
-- columns if the attachments JSONB column hasn't been added"). Zonder deze
-- migratie werkt sturen mét bijlage nog steeds — alleen metadata wordt niet
-- opgeslagen.
--
-- Idempotent. Geen impact op bestaande data.
-- ============================================================================

BEGIN;

ALTER TABLE public.email_replies
  ADD COLUMN IF NOT EXISTS attachments jsonb;

COMMENT ON COLUMN public.email_replies.attachments IS
  'Uitgaande attachments-metadata: [{filename, mime_type, size_bytes}]. NULL = niet ingevuld, [] = geen bijlagen.';

COMMIT;
