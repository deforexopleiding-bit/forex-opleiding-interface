-- 2026-10-27 — noshow_akkoord_at op opstartsessie_submissions
--
-- Legt vast WANNEER de lead het €50-no-show-akkoord bevestigde. Op de full-page
-- booking (flow-c-7daagse: 7-daagse-v5/v6 + de nieuwe Flow E) typt de lead nu
-- letterlijk "akkoord" voordat de boeking definitief is; api/public-opstartsessie-book.js
-- zet deze kolom (server-tijd) op de submission-rij bij een geslaagde boeking.
--
-- Nullable → bestaande rijen en de boek-endpoint blijven werken zonder deze
-- kolom (de endpoint negeert een ontbrekende kolom fail-soft). Idempotent.
--
-- Draai dit in de Supabase SQL-editor (service-role, RLS telt daar niet).

ALTER TABLE public.opstartsessie_submissions
  ADD COLUMN IF NOT EXISTS noshow_akkoord_at timestamptz;

COMMENT ON COLUMN public.opstartsessie_submissions.noshow_akkoord_at IS
  'Tijdstip waarop de lead "akkoord" typte en de boeking bevestigde (full-page flow). Server-tijd ~= bevestigingsmoment. NULL = (nog) niet via de getypte akkoord-stap geboekt.';

-- Verificatie:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'opstartsessie_submissions' AND column_name = 'noshow_akkoord_at';
