-- ============================================================================
-- Opvolging · 'Leads bellen' — leadkaarten in opvolging_taken
-- 2 oktober 2026
--
-- ⚠ AL GEDRAAID DOOR COWORK 2026-10-02 op productie (forex-command-center).
-- Dit bestand is DOCUMENTATIE van wat er gedraaid is. Het is idempotent
-- geschreven: nogmaals draaien verandert niets.
--
-- Geen nieuwe tabel → geen RLS-wijziging; opvolging_taken houdt zijn policy
-- opvolging_taken_staff (is_crm_staff()).
--
-- ── WAT HET DOET ────────────────────────────────────────────────────────────
-- 1. opvolging_taken.lijst ('dag' | 'leads'), default 'dag' — alle 319
--    bestaande rijen werden 'dag'. De code filtert Daves schermen op
--    lijst='dag' via api/_lib/opvolging-lijst.js.
-- 2. opvolging_taken.lead_id (→ leads.id, bewust GEEN FK: een lead mag
--    verwijderd worden zonder dat de historiek van de kaart verdwijnt),
--    archief_categorie (reden van afronden in Leads bellen) en
--    terugbel_notitie (wat de lead zei bij 'moet later terugkomen').
-- 3. CHECK-constraints uitgebreid:
--      reden  + 'lead_bellen'
--      bron   + 'lead', 'import'
--      opvolging_pogingen.soort + 'agenda_herinnering'
-- 4. Indexen, waaronder een UNIEKE partiële index die per lead maximaal één
--    lopende leadkaart toelaat (idempotentie van /api/opvolging-leads-kaart).
-- 5. Recht 'opvolging.leads.view' (manager + sales true; administratie,
--    marketing, mentor false).
-- 6. app_settings 'opvolging_agenda_doorsturen' met agenda_link NULL —
--    fail-closed: zonder link verstuurt 'Agenda doorsturen' niets.
--
-- ── TERUGDRAAIEN (de vorige CHECK-definities) ──────────────────────────────
--   Eerst de leadkaarten weg (anders faalt de oude CHECK):
--     DELETE FROM public.opvolging_taken WHERE lijst = 'leads';
--     DELETE FROM public.opvolging_pogingen WHERE soort = 'agenda_herinnering';
--   ALTER TABLE public.opvolging_taken DROP CONSTRAINT IF EXISTS opvolging_taken_reden_chk;
--   ALTER TABLE public.opvolging_taken ADD CONSTRAINT opvolging_taken_reden_chk
--     CHECK (reden = ANY (ARRAY['wil_nog_beslissen','no_show_event','no_show_call',
--       'afgemeld','niet_ingepland','aanmelding','zoom_nabellen','zoom_geannuleerd',
--       'zoom_bevestigen']::text[]));
--   ALTER TABLE public.opvolging_taken DROP CONSTRAINT IF EXISTS opvolging_taken_bron_chk;
--   ALTER TABLE public.opvolging_taken ADD CONSTRAINT opvolging_taken_bron_chk
--     CHECK (bron IN ('event','call','handmatig'));
--   ALTER TABLE public.opvolging_pogingen DROP CONSTRAINT IF EXISTS opvolging_pogingen_soort_chk;
--   ALTER TABLE public.opvolging_pogingen ADD CONSTRAINT opvolging_pogingen_soort_chk
--     CHECK (soort IN ('call','whatsapp','spraakbericht','agenda_doorgestuurd','ingepland'));
--   DROP INDEX IF EXISTS public.opvolging_taken_leadkaart_uniek;
--   DROP INDEX IF EXISTS public.opvolging_taken_lead_id_idx;
--   DROP INDEX IF EXISTS public.opvolging_taken_lijst_status_due_idx;
--   ALTER TABLE public.opvolging_taken
--     DROP COLUMN IF EXISTS terugbel_notitie, DROP COLUMN IF EXISTS archief_categorie,
--     DROP COLUMN IF EXISTS lead_id, DROP COLUMN IF EXISTS lijst;
--   DELETE FROM public.role_permissions WHERE feature_key = 'opvolging.leads.view';
--   DELETE FROM public.app_settings WHERE key = 'opvolging_agenda_doorsturen';
-- ============================================================================

-- ── 1 + 2 · Kolommen ────────────────────────────────────────────────────────
ALTER TABLE public.opvolging_taken
  ADD COLUMN IF NOT EXISTS lijst text NOT NULL DEFAULT 'dag' CHECK (lijst IN ('dag', 'leads'));
ALTER TABLE public.opvolging_taken
  ADD COLUMN IF NOT EXISTS lead_id uuid NULL;
ALTER TABLE public.opvolging_taken
  ADD COLUMN IF NOT EXISTS archief_categorie text NULL;
ALTER TABLE public.opvolging_taken
  ADD COLUMN IF NOT EXISTS terugbel_notitie text NULL;

COMMENT ON COLUMN public.opvolging_taken.lijst IS
  'dag = Daves daglijst; leads = leadkaart van de tab Leads bellen. Daglijst-schermen filteren op dag (api/_lib/opvolging-lijst.js).';
COMMENT ON COLUMN public.opvolging_taken.lead_id IS
  'leads.id van een leadkaart. Geen FK: de kaarthistoriek blijft als de lead verwijderd wordt.';

-- ── 3 · CHECK-constraints ───────────────────────────────────────────────────
ALTER TABLE public.opvolging_taken DROP CONSTRAINT IF EXISTS opvolging_taken_reden_chk;
ALTER TABLE public.opvolging_taken ADD CONSTRAINT opvolging_taken_reden_chk
  CHECK (reden = ANY (ARRAY['wil_nog_beslissen','no_show_event','no_show_call',
    'afgemeld','niet_ingepland','aanmelding','zoom_nabellen','zoom_geannuleerd',
    'zoom_bevestigen','lead_bellen']::text[]));

ALTER TABLE public.opvolging_taken DROP CONSTRAINT IF EXISTS opvolging_taken_bron_chk;
ALTER TABLE public.opvolging_taken ADD CONSTRAINT opvolging_taken_bron_chk
  CHECK (bron IN ('event','call','handmatig','lead','import'));

ALTER TABLE public.opvolging_pogingen DROP CONSTRAINT IF EXISTS opvolging_pogingen_soort_chk;
ALTER TABLE public.opvolging_pogingen ADD CONSTRAINT opvolging_pogingen_soort_chk
  CHECK (soort IN ('call','whatsapp','spraakbericht','agenda_doorgestuurd','ingepland','agenda_herinnering'));

-- ── 4 · Indexen ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS opvolging_taken_lijst_status_due_idx
  ON public.opvolging_taken (lijst, status, due);
CREATE INDEX IF NOT EXISTS opvolging_taken_lead_id_idx
  ON public.opvolging_taken (lead_id);
CREATE UNIQUE INDEX IF NOT EXISTS opvolging_taken_leadkaart_uniek
  ON public.opvolging_taken (lead_id)
  WHERE lijst = 'leads' AND lead_id IS NOT NULL AND status IN ('open', 'wacht_inplanning');

-- ── 5 · Recht ───────────────────────────────────────────────────────────────
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT v.role, 'opvolging.leads.view', v.allowed
  FROM (VALUES ('manager', true), ('sales', true),
               ('administratie', false), ('marketing', false), ('mentor', false)) AS v(role, allowed)
 WHERE NOT EXISTS (
   SELECT 1 FROM public.role_permissions rp
    WHERE rp.role = v.role AND rp.feature_key = 'opvolging.leads.view');

-- ── 6 · Instelling (fail-closed: agenda_link NULL) ─────────────────────────
INSERT INTO public.app_settings (key, value)
SELECT 'opvolging_agenda_doorsturen', jsonb_build_object(
  'agenda_link', NULL,
  'bericht',     E'Hey {voornaam}, zoals afgesproken: via deze link kies je zelf een moment voor ons gesprek dat jou past 👇\n\n{link}\n\nLukt het niet of vind je geen moment? Laat het me hier gewoon weten, dan zoeken we samen iets.\nGroetjes, Dave — De Forex Opleiding',
  'herinnering', E'Hey {voornaam}, kleine reminder: je had nog geen moment gekozen voor ons gesprek. Hier is de link nog eens 👇\n\n{link}\n\nGroetjes, Dave')
 WHERE NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'opvolging_agenda_doorsturen');

-- ── Nakijken ────────────────────────────────────────────────────────────────
-- SELECT lijst, count(*) FROM public.opvolging_taken GROUP BY lijst;
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid IN ('public.opvolging_taken'::regclass, 'public.opvolging_pogingen'::regclass);
-- SELECT * FROM public.role_permissions WHERE feature_key = 'opvolging.leads.view';
