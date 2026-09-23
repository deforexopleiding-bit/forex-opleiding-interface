-- ============================================================================
-- Supportmodule — mailkant ontdubbelen
-- Datum: 23 september 2026
-- Plan: docs/support-module-plan.md §7c
--
-- ⚠ MET DE HAND DRAAIEN in de Supabase SQL-editor, vóór of direct na de merge
-- van de begeleidende PR. De code heeft deze indexen niet nodig om te werken:
-- er komt geen kolom bij (alles staat in support_berichten.meta), dus zonder
-- migratie faalt er niets. Wat er dan wél ontbreekt is de laatste grendel:
-- twee runs van api/cron-support-mail.js die exact tegelijk dezelfde mail
-- verwerken (een trage run die de volgende overlapt, of een handmatige aanroep
-- naast de cron) kunnen allebei hun check "nog niet bekend" doorkomen en de
-- klanttekst twee keer in de thread zetten. Met deze indexen weigert de
-- database de tweede insert en herkent de cron dat als "al verwerkt".
--
-- ── WAT ─────────────────────────────────────────────────────────────────────
-- Twee partiële unieke indexen op support_berichten:
--   uniq_support_bericht_bron_email   — (meta->>'bron_email_id')
--       één bericht per email_messages-rij.
--   uniq_support_bericht_bron_message — (meta->>'bron_message_id')
--       één bericht per Message-ID. Dezelfde mail aan info@ én events@ is
--       twee email_messages-rijen met dezelfde Message-ID; die hoort maar één
--       keer in de thread.
-- De namen staan ook in UNIEKE_BRON_INDEXEN in api/_lib/support-mailbrug.js;
-- wie ze hier hernoemt, moet ze daar meenemen, anders telt een botsing weer
-- als storing.
--
-- Partieel (WHERE ... IS NOT NULL) omdat de overgrote meerderheid van de
-- berichten uit de widget komt en geen bron-mail heeft.
--
-- ── ALS DE INDEX NIET WIL ───────────────────────────────────────────────────
-- CREATE UNIQUE INDEX faalt met "could not create unique index" als er al
-- dubbele berichten staan — precies de fout die deze migratie dichtzet, en
-- de mailcron draait sinds #1670. Er wordt dan niets half aangemaakt. Kijk
-- eerst wat er dubbel staat:
--
--   SELECT meta->>'bron_email_id' AS bron, count(*), array_agg(id ORDER BY created_at)
--   FROM public.support_berichten
--   WHERE meta ? 'bron_email_id'
--   GROUP BY 1 HAVING count(*) > 1;
--
-- en ruim de jongste van elk paar bewust op (dit bestand doet dat NIET
-- zelf; berichten verwijderen is een beslissing, geen bijwerking):
--
--   DELETE FROM public.support_berichten b
--   USING public.support_berichten o
--   WHERE b.meta->>'bron_email_id' = o.meta->>'bron_email_id'
--     AND b.created_at > o.created_at;
--
-- Voor bron_message_id is dat niet nodig: die sleutel bestaat pas sinds deze
-- PR en staat op nog geen enkele rij.
--
-- ── SQL-EDITOR ──────────────────────────────────────────────────────────────
-- Geen DO-blocks en geen TEMP TABLE; mag in één keer geplakt worden. Elke
-- index is op zichzelf idempotent (IF NOT EXISTS). Geen CONCURRENTLY: dat mag
-- niet binnen een transactie, en de tabel is klein genoeg voor een korte lock.
-- ============================================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_bericht_bron_email
  ON public.support_berichten ((meta->>'bron_email_id'))
  WHERE meta->>'bron_email_id' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_bericht_bron_message
  ON public.support_berichten ((meta->>'bron_message_id'))
  WHERE meta->>'bron_message_id' IS NOT NULL;

COMMENT ON INDEX public.uniq_support_bericht_bron_email IS
  'Eén support-bericht per email_messages-rij. Idempotentie van api/cron-support-mail.js.';
COMMENT ON INDEX public.uniq_support_bericht_bron_message IS
  'Eén support-bericht per Message-ID: dezelfde mail in twee mailboxen komt één keer in de thread.';

COMMIT;

-- ── CONTROLE ────────────────────────────────────────────────────────────────
-- Moet twee rijen geven:
--
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE schemaname = 'public' AND tablename = 'support_berichten'
--     AND indexname LIKE 'uniq_support_bericht_bron_%';

-- ============================================================================
-- ROLLBACK
--
--   DROP INDEX IF EXISTS public.uniq_support_bericht_bron_email;
--   DROP INDEX IF EXISTS public.uniq_support_bericht_bron_message;
--
-- De cron blijft daarna gewoon werken; alleen de grendel tegen gelijktijdige
-- runs is dan weer weg.
-- ============================================================================
