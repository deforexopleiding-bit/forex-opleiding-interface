-- 025_follow_up_appointments_afgeschreven.sql
--
-- Afschrijf-marker voor follow_up_appointments zodat de Opvolglijst-tab
-- (in follow-up.html) een cancelled/no_show/wacht_op_reschedule-afspraak
-- kan afsluiten met een verplichte reden. De afspraak blijft in de DB
-- staan (voor audit), maar verdwijnt uit de Opvolglijst-query.
--
-- Kolommen:
--   follow_up_afgeschreven_at     timestamptz — wanneer afgeschreven
--   follow_up_afgeschreven_reason text        — verplichte reden (min 1 char, app-level)
--   follow_up_afgeschreven_by     uuid        — wie het deed (auth.users.id)
--
-- De Opvolglijst-list-query filtert op follow_up_afgeschreven_at IS NULL
-- zodat afgeschreven items er niet meer in verschijnen.
-- Fail-soft: als de kolommen ontbreken (migratie niet gedraaid) toont de
-- lijst alles én geeft het afschrijf-endpoint een 501 MIGRATION_REQUIRED.

alter table follow_up_appointments add column if not exists follow_up_afgeschreven_at     timestamptz;
alter table follow_up_appointments add column if not exists follow_up_afgeschreven_reason text;
alter table follow_up_appointments add column if not exists follow_up_afgeschreven_by     uuid references auth.users(id);

-- Partial index voor snelle filtering van open opvolglijst-items.
create index if not exists follow_up_appointments_opvolglijst_open_idx
  on follow_up_appointments (status, updated_at)
  where follow_up_afgeschreven_at is null
    and status in ('no_show', 'cancelled', 'wacht_op_reschedule');

notify pgrst, 'reload schema';
