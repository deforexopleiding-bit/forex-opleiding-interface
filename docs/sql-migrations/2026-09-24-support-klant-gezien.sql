-- ============================================================================
-- Supportmodule — "zit de bezoeker nu in de chat?"
-- Datum: 24 september 2026
--
-- Eén nullable kolom op support_gesprekken. De widget pollt met het venster
-- open elke vijf seconden; support-poll zet dan (hooguit één keer per 15 s)
-- klant_gezien_op op nu. Daarmee:
--   * toont het CRM per gesprek "In de chat" of "Niet in de chat · x geleden";
--   * beslist support-antwoord of een antwoord ook per mail moet: niet meer
--     op basis van "laatste klantbericht < 2 min", maar op basis van of de
--     chat écht open staat (< 40 s gezien).
--
-- ── NIET BLOKKEREND ─────────────────────────────────────────────────────────
-- Geen enkele query noemt deze kolom bij naam vóór hij bestaat:
--   * support-poll schrijft 'm alleen als de rij 'm al heeft ('klant_gezien_op'
--     in gesprek — select('*') levert 'm pas na deze migratie);
--   * support-antwoord valt zonder de kolom terug op de oude 2-minutenregel;
--   * support-gesprekken-list leest select('*').
-- Zonder deze migratie werkt alles zoals vóór de PR; alleen de
-- aanwezigheidsweergave in het CRM blijft leeg.
--
-- ── SQL-EDITOR ──────────────────────────────────────────────────────────────
-- Losse statements, geen DO-blocks, idempotent.
-- ============================================================================

ALTER TABLE public.support_gesprekken
  ADD COLUMN IF NOT EXISTS klant_gezien_op timestamptz;

COMMENT ON COLUMN public.support_gesprekken.klant_gezien_op IS
  'Laatste hartslag van de widget met het chatvenster open (support-poll, max 1x per 15 s). < 40 s geleden = bezoeker zit in de chat.';

-- Controle
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'support_gesprekken' AND column_name = 'klant_gezien_op';

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- ALTER TABLE public.support_gesprekken DROP COLUMN IF EXISTS klant_gezien_op;
