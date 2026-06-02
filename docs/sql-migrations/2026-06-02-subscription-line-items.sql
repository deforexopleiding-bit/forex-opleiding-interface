-- ============================================================================
-- Wizard 2 upgrade: multi-line abonnementen
-- Datum: 2026-06-02
-- Branch: feature/wizard-2-multi-line-subs
--
-- Per subscription kunnen nu MEERDERE regels (line_items) met aparte BTW-tarieven
-- worden opgeslagen. Voorbeeld: aanbetaling €1500 = €1000 (21%) begeleiding +
-- €500 (9%) e-book. De jsonb-kolom houdt dit als array bij; de bestaande
-- amount/vat_percentage kolommen blijven gevuld (sum / dominant tarief) voor
-- backwards-compatibility met code die ze nog leest.
--
-- Structuur line_items:
--   [
--     { "description": "Begeleidingstraject", "amount": 1000, "vat_percentage": 21 },
--     { "description": "E-book",              "amount": 500,  "vat_percentage": 9 }
--   ]
-- amount = bedrag EXCL BTW per termijn (zoals naar TL gepusht met tax:'excluding').
-- ============================================================================

BEGIN;

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS line_items jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMIT;

-- ROLLBACK
-- BEGIN;
--   ALTER TABLE public.subscriptions DROP COLUMN IF EXISTS line_items;
-- COMMIT;
