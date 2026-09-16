-- 2026-09-16 · toegang_aanvragen.telefoon_last9 (generated) + partial index
--
-- ⚠ MOET DRAAIEN VÓÓR / DIRECT NA de code-merge in de begeleidende PR.
-- Zonder deze migratie geeft PostgREST 400 "column telefoon_last9 does not
-- exist" op elke inbound WhatsApp → de toegang-gate valt volledig uit.
--
-- CONTEXT
-- ─────────────────────────────────────────────────────────────────────────
-- De inbox-webhook (meta) + follow-up-ghl-conversation-webhook laadden tot
-- nu 50 wachtende rijen sorteer created_at ASC + id ASC, en filterden
-- daarna IN-MEMORY op de last-9 digits van het inbound-nummer. Bij >50
-- wachtenden viel de juiste rij buiten de LIMIT → geen match → reply werd
-- niet opgepikt → geen provisioning. Bewijs in follow_up_events_log
-- (event_type='toegang-gate-trace'): stelselmatig wachtend_rijen:50 +
-- kandidaten:0.
--
-- Deze migratie maakt de last-9 index-friendly aan de DB-kant, zodat de
-- handlers rechtstreeks WHERE telefoon_last9 = <inbound_last9> kunnen doen
-- tegen ALLE wachtenden — geen LIMIT-cap meer nodig, geen 50-blindspot.
--
-- KOLOM
-- ─────────────────────────────────────────────────────────────────────────
-- telefoon_last9: GENERATED ALWAYS AS ... STORED
--   right(regexp_replace(coalesce(telefoon,''), '\D', '', 'g'), 9)
--
-- Voordelen boven een handmatig-onderhouden kolom + trigger:
--   * ADD COLUMN vult automatisch bestaande rijen (backfill gratis).
--   * Onmogelijk uit sync met telefoon — DB regenereert bij elke UPDATE.
--   * Prefix-agnostisch: +31 6 12345678 / 06-12345678 / 0032... / 316...
--     leveren allemaal dezelfde last9-string, precies zoals de bestaande
--     in-memory logica (String(x).replace(/\D/g,'').slice(-9)).
--
-- INDEX
-- ─────────────────────────────────────────────────────────────────────────
-- Partial index op telefoon_last9 WHERE status='wachtend'. Alleen de hot
-- path staat in de index (typisch tientallen tot enkele honderden rijen).
-- Gereageerde/vervallen/provisioned rijen zijn buiten de index → geen bloat.
--
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS public.idx_toegang_aanvragen_last9_wachtend;
-- ALTER TABLE public.toegang_aanvragen DROP COLUMN IF EXISTS telefoon_last9;
--
-- 0 incasso-writes. Read-additive schema-wijziging.

ALTER TABLE public.toegang_aanvragen
  ADD COLUMN IF NOT EXISTS telefoon_last9 text
  GENERATED ALWAYS AS (
    right(regexp_replace(coalesce(telefoon, ''), '\D', '', 'g'), 9)
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_toegang_aanvragen_last9_wachtend
  ON public.toegang_aanvragen (telefoon_last9)
  WHERE status = 'wachtend';

NOTIFY pgrst, 'reload schema';
