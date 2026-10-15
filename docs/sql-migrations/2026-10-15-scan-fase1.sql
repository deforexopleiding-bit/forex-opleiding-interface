-- ============================================================================
-- Strategie-scan — fase 1: tabel `scans` + recht `scan.use`
-- Datum: 2026-10-15
-- Branch: feat/scan-fase1
--
-- ⚠ BLOKKEREND voor de scan-module: api/scan.js leest en schrijft public.scans.
--   Zonder deze migratie geeft elke scan-actie een databasefout (de rest van
--   het CRM merkt niets). Draaien VÓÓR of DIRECT NA de merge.
--
-- ── WAT ─────────────────────────────────────────────────────────────────────
-- 1. public.scans — één rij per strategie-scan (concept → afgerond →
--    verstuurd). De antwoorden staan als { '<onderdeel>_<index>': waarde }
--    (likert 1..5 of de index van de gekozen optie); de server rekent de
--    uitkomst zelf uit (modules/scan/scan-model.js) en bewaart die volledig in
--    `uitkomst` + de filterbare kolommen (score, categorie, aanpak, traject).
-- 2. Recht `scan.use`: alleen Dave + admins (gevoelige/financiële info).
--
-- ── TOEGANG ─────────────────────────────────────────────────────────────────
-- RLS AAN en REVOKE ALL van anon/authenticated, zonder policies: alleen de
-- service-role (api/scan.js, na requirePermission('scan.use')) komt erbij.
-- Zelfde patroon als de webinar-tabellen (2026-10-09-webinar-fase1.sql).
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- IF NOT EXISTS / NOT EXISTS overal; losse statements (de Supabase SQL-editor
-- knipt op statement-grenzen). Opnieuw draaien verandert niets.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.scans (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               uuid NULL REFERENCES public.leads(id) ON DELETE SET NULL,
  afspraak_id           uuid NULL REFERENCES public.follow_up_appointments(id) ON DELETE SET NULL,
  assessor_id           uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  status                text NOT NULL DEFAULT 'concept'
                          CHECK (status IN ('concept', 'afgerond', 'verstuurd')),
  deelnemer_naam        text NOT NULL,
  deelnemer_email       text NULL,
  deelnemer_telefoon    text NULL,
  antwoorden            jsonb NOT NULL DEFAULT '{}'::jsonb,
  uitkomst              jsonb NULL,
  override              jsonb NOT NULL DEFAULT '{}'::jsonb,
  readiness_score       integer NULL CHECK (readiness_score BETWEEN 0 AND 100),
  categorie             text NULL
                          CHECK (categorie IN ('Zeer geschikt', 'Geschikt met de juiste begeleiding', 'Nu nog niet')),
  aanbevolen_aanpak     text NULL CHECK (aanbevolen_aanpak IN ('Daytrading', 'Swingtrading')),
  aanbevolen_traject    text NULL,
  doel                  text NULL,
  dave_notitie          text NULL,
  rapport_pdf_ref       text NULL,
  certificaat_pdf_ref   text NULL,
  afgerond_op           timestamptz NULL,
  verstuurd_op          timestamptz NULL,
  aangemaakt_door       uuid NULL REFERENCES public.profiles(id) ON DELETE SET NULL,
  aangemaakt            timestamptz NOT NULL DEFAULT now(),
  gewijzigd             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scans_aangemaakt_idx ON public.scans (aangemaakt DESC);
CREATE INDEX IF NOT EXISTS scans_lead_idx       ON public.scans (lead_id) WHERE lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scans_afspraak_idx   ON public.scans (afspraak_id) WHERE afspraak_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS scans_status_idx     ON public.scans (status);

ALTER TABLE public.scans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scans FROM anon, authenticated;

-- ── Recht scan.use ──────────────────────────────────────────────────────────
-- Admins: per rol. super_admin heeft geen rij nodig (eigen OR-tak in
-- user_has_permission). Sales als ROL bewust NIET: alleen Dave persoonlijk
-- (user_permissions), zodat een nieuwe sales-collega niet vanzelf de
-- financiële scan-gegevens ziet.

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'admin', 'scan.use', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='admin' AND feature_key='scan.use');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'scan.use', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='scan.use');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'scan.use', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='scan.use');

-- Dave persoonlijk: het actieve sales-profiel met voornaam Dave.
INSERT INTO public.user_permissions (user_id, feature_key, allowed)
SELECT p.id, 'scan.use', true
FROM public.profiles p
WHERE p.role = 'sales' AND p.is_active AND p.full_name ILIKE 'dave%'
  AND NOT EXISTS (SELECT 1 FROM public.user_permissions u WHERE u.user_id = p.id AND u.feature_key = 'scan.use');

-- ── CONTROLE (los te draaien) ───────────────────────────────────────────────
-- Tabel + RLS:
-- SELECT relname, relrowsecurity FROM pg_class WHERE relname = 'scans';
--
-- Wie mag de scan gebruiken (verwacht: Dave + super_admin/admin/manager):
-- SELECT p.full_name, p.role, public.user_has_permission(p.id, 'scan.use') AS scan
-- FROM public.profiles p WHERE p.is_active ORDER BY 3 DESC, 1;
--
-- Staat Dave er NIET bij (bv. andere naam in profiles)? Dan los:
-- INSERT INTO public.user_permissions (user_id, feature_key, allowed)
-- SELECT id, 'scan.use', true FROM public.profiles WHERE email = '<daves e-mail>';

-- ── ROLLBACK (indien nodig; verwijdert ALLE scans) ──────────────────────────
-- DELETE FROM public.user_permissions WHERE feature_key = 'scan.use';
-- DELETE FROM public.role_permissions WHERE feature_key = 'scan.use';
-- DROP TABLE IF EXISTS public.scans;
