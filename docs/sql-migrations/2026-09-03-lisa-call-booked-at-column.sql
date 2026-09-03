-- 2026-09-03: BP3 v17 — "Call ingepland"-markering op Lisa-gesprekken.
--
-- Voegt `call_booked_at` toe aan lisa_conversations zodat we per Instagram-
-- gesprek een expliciete "call is gepland"-timestamp kunnen zetten los van de
-- bestaande boolean `call_booked`.
--
-- Waarom nullable + geen backfill:
--   - Legacy call_booked (boolean) blijft z'n rol houden voor stats/telemetry.
--   - NULL op call_booked_at = geen call-markering; timestamp = ingeplande call.
--   - Bestaande PATCH-flow (body.call_booked → updates.call_booked_at) blijft
--     werken. Nieuwe expliciete toggle voegt alleen extra pad toe.
--
-- Ter review: NIET automatisch draaien. Draai handmatig via Supabase-editor
-- (single statement, klein, veilig — IF NOT EXISTS).

ALTER TABLE public.lisa_conversations
  ADD COLUMN IF NOT EXISTS call_booked_at timestamptz NULL;

COMMENT ON COLUMN public.lisa_conversations.call_booked_at IS
  'Timestamp wanneer de call bij deze gespreks-lead is ingepland; NULL = niet gepland. Gezet via de "Call ingepland"-toggle in de Gesprekken-tab (Lisa/Instagram).';
