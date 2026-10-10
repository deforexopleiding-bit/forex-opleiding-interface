-- 2026-10-11 · Massabericht fase 2b — WhatsApp + "beide" op de massa-motor van 2a.
--
--   massa_campagnes.kanaal  → 'email' | 'whatsapp' | 'beide'
--   massa_items.kanaal      → 'email' | 'whatsapp'  (bij 'beide' per lead één item
--                              per kanaal → uniek op (campagne, lead, kanaal))
--   WhatsApp-velden op de campagne: template, taal, {{2}}-tekst, template-tekst.
--   onderwerp / html / soort zijn alleen verplicht als er e-mail bij zit — dat
--   bewaakt de code (api/_lib/massa-mail.js → valideerCampagne); de kolommen
--   worden daarom nullable.
--
-- BLOKKEREND voor WhatsApp/"beide": zonder deze migratie weigert de database het
-- kanaal 'whatsapp' en de wa_*-kolommen, en kan een lead geen twee items (mail +
-- WhatsApp) in één campagne krijgen. NIET blokkerend voor e-mail-campagnes van 2a:
-- de code noemt de wa_*-kolommen alleen bij een WhatsApp-campagne. De popup meldt
-- "draai de migratie" als WhatsApp/beide wordt gekozen en dit nog niet gedraaid is.
-- Supabase SQL-editor: losse statements, geen DO-blokken.

-- ── 1. Kanaal verbreden ──────────────────────────────────────────────────────
ALTER TABLE public.massa_campagnes DROP CONSTRAINT IF EXISTS massa_campagnes_kanaal_check;
ALTER TABLE public.massa_campagnes ADD CONSTRAINT massa_campagnes_kanaal_check CHECK (kanaal IN ('email', 'whatsapp', 'beide'));

ALTER TABLE public.massa_items DROP CONSTRAINT IF EXISTS massa_items_kanaal_check;
ALTER TABLE public.massa_items ADD CONSTRAINT massa_items_kanaal_check CHECK (kanaal IN ('email', 'whatsapp'));

-- ── 2. Eén item per lead PER KANAAL ──────────────────────────────────────────
ALTER TABLE public.massa_items DROP CONSTRAINT IF EXISTS massa_items_campagne_id_lead_id_key;
ALTER TABLE public.massa_items ADD CONSTRAINT massa_items_campagne_lead_kanaal_key UNIQUE (campagne_id, lead_id, kanaal);

-- ── 3. E-mailvelden alleen verplicht bij e-mail (bewaakt in de code) ─────────
ALTER TABLE public.massa_campagnes ALTER COLUMN onderwerp DROP NOT NULL;
ALTER TABLE public.massa_campagnes ALTER COLUMN html DROP NOT NULL;
ALTER TABLE public.massa_campagnes ALTER COLUMN soort DROP NOT NULL;

-- ── 4. WhatsApp-velden ───────────────────────────────────────────────────────
ALTER TABLE public.massa_campagnes ADD COLUMN IF NOT EXISTS wa_template text;
ALTER TABLE public.massa_campagnes ADD COLUMN IF NOT EXISTS wa_taal text;
ALTER TABLE public.massa_campagnes ADD COLUMN IF NOT EXISTS wa_param2 text;
ALTER TABLE public.massa_campagnes ADD COLUMN IF NOT EXISTS wa_body text;

CREATE INDEX IF NOT EXISTS idx_massa_items_kanaal_verzonden ON public.massa_items (kanaal, verzonden_op) WHERE status = 'sent';

-- ── 5. Controle (alleen lezen) ───────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid IN ('public.massa_campagnes'::regclass, 'public.massa_items'::regclass) AND contype IN ('c', 'u');
-- SELECT column_name, is_nullable FROM information_schema.columns
--   WHERE table_name = 'massa_campagnes' AND column_name IN ('onderwerp', 'html', 'soort', 'wa_template', 'wa_param2');

-- ── ROLLBACK (alleen als er nog geen WhatsApp-items zijn) ────────────────────
-- ALTER TABLE public.massa_items DROP CONSTRAINT massa_items_campagne_lead_kanaal_key;
-- ALTER TABLE public.massa_items ADD CONSTRAINT massa_items_campagne_id_lead_id_key UNIQUE (campagne_id, lead_id);
-- ALTER TABLE public.massa_items DROP CONSTRAINT massa_items_kanaal_check;
-- ALTER TABLE public.massa_items ADD CONSTRAINT massa_items_kanaal_check CHECK (kanaal IN ('email'));
-- ALTER TABLE public.massa_campagnes DROP CONSTRAINT massa_campagnes_kanaal_check;
-- ALTER TABLE public.massa_campagnes ADD CONSTRAINT massa_campagnes_kanaal_check CHECK (kanaal IN ('email'));
