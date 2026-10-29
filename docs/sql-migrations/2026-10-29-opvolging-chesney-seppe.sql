-- ============================================================================
-- Opvolging-module: persoonlijke toegang voor Chesney en Seppe
-- Datum: 2026-10-29
--
-- WAT HET DOET
-- Geeft twee personen (niet hun rol) toegang tot de Opvolging-module, via
-- public.user_permissions. Dat is dezelfde manier waarop Chesney eerder
-- softphone.use, onboarding.admin en signals.hoofdmentor.receive kreeg, en
-- Dave scan.use. De mentor-rol blijft voor opvolging.* op false staan
-- (migratie 2026-09-04-opvolging-role-permissions.sql), zodat een nieuwe
-- mentor de module NIET vanzelf krijgt.
--
-- user_has_permission() = super_admin OF (user_roles x role_permissions) OF
-- user_permissions. De frontend (modules/shared/permissions.js) leest dezelfde
-- user_permissions, en de zijbalk toont Opvolging zodra
-- opvolging.module.access waar is (permKey in app-shell.js, additief op de rollen).
--
-- DE TIEN RECHTEN (dezelfde set als de sales-rol):
--   opvolging.module.access   module + zijbalk, de meeste endpoints
--   opvolging.dag.view        tab Vandaag
--   opvolging.dashboard.view  tab Dashboard
--   opvolging.archief.view    tab Afgerond
--   opvolging.leads.view      tab Leads bellen
--   opvolging.rapport.view    tab Rapport
--   opvolging.taak.afronden   een taak afronden of een poging loggen
--   opvolging.taak.archiveren archiveren
--   opvolging.agenda.boeken   een call inplannen
--   opvolging.whatsapp.sturen WhatsApp vanuit de taak
-- Wil je een recht niet geven, haal die regel dan uit de VALUES-lijst in stap 2.
--
-- NIET in deze set: de tab Call-rapport. Die hangt aan calls.rapport.view
-- (een apart recht, api/call-rapport.js). Zonder dat recht krijgen ze bij die
-- tab een melding "geen rechten"; de rest werkt. Zie de optionele regel onderaan.
--
-- Seppe: heeft hij super_admin in user_roles (seed 2026-09-15), dan mag hij
-- alles al. De rij hieronder kan dan geen kwaad: ze geldt alleen als die
-- super_admin-rol ooit verdwijnt.
--
-- IDEMPOTENT: ON CONFLICT (user_id, feature_key) DO UPDATE SET allowed = true.
-- Opnieuw draaien verandert niets.
-- ============================================================================


-- ── STAP 1 · CONTROLE VOORAF (alleen lezen) ─────────────────────────────────
-- Verwacht: precies één actieve rij voor Chesney en één voor Seppe. Controleer
-- naam, e-mail en rol. Chesney zou id 9f4cd827-9529-4647-bdd3-2db4cd340bab
-- moeten hebben (dezelfde als in migratie 044 en 2026-09-07).
-- Zie je meer dan één actieve Chesney of Seppe, of geen enkele, stop dan:
-- stap 2 weigert in dat geval toch.

SELECT p.id, p.full_name, p.email, p.role, p.is_active,
       (SELECT string_agg(ur.role, ', ' ORDER BY ur.role)
          FROM public.user_roles ur WHERE ur.user_id = p.id) AS alle_rollen,
       public.user_has_permission(p.id, 'opvolging.module.access') AS heeft_opvolging_nu
  FROM public.profiles p
 WHERE p.full_name ILIKE 'chesney%'
    OR p.full_name ILIKE 'seppe%'
    OR p.email     ILIKE 'chesney%'
    OR p.email     ILIKE 'seppe%'
 ORDER BY p.full_name;


-- ── STAP 2 · TOEGANG GEVEN ──────────────────────────────────────────────────
-- Eén DO-block: zoekt per voornaam precies één ACTIEF profiel (op full_name)
-- en weigert met een foutmelding bij 0 of meer dan 1 treffer. Er wordt dan
-- niets weggeschreven.

DO $$
DECLARE
  v_naam   text;
  v_aantal int;
  v_id     uuid;
  v_ids    uuid[] := '{}';
BEGIN
  FOREACH v_naam IN ARRAY ARRAY['chesney', 'seppe'] LOOP
    SELECT count(*), min(p.id::text)::uuid
      INTO v_aantal, v_id
      FROM public.profiles p
     WHERE p.is_active
       AND p.full_name ILIKE v_naam || '%';
    IF v_aantal <> 1 THEN
      RAISE EXCEPTION 'Verwacht precies 1 actief profiel voor "%", gevonden: %. Niets gewijzigd.', v_naam, v_aantal;
    END IF;
    v_ids := v_ids || v_id;
  END LOOP;

  INSERT INTO public.user_permissions (user_id, feature_key, allowed)
  SELECT u.id, k.feature_key, true
    FROM unnest(v_ids) AS u(id)
   CROSS JOIN (VALUES
     ('opvolging.module.access'),
     ('opvolging.dag.view'),
     ('opvolging.dashboard.view'),
     ('opvolging.archief.view'),
     ('opvolging.leads.view'),
     ('opvolging.rapport.view'),
     ('opvolging.taak.afronden'),
     ('opvolging.taak.archiveren'),
     ('opvolging.agenda.boeken'),
     ('opvolging.whatsapp.sturen')
   ) AS k(feature_key)
  ON CONFLICT (user_id, feature_key) DO UPDATE SET allowed = true;

  RAISE NOTICE 'Opvolging-rechten gezet voor % profielen.', array_length(v_ids, 1);
END $$;


-- ── STAP 3 · CONTROLE ACHTERAF (alleen lezen) ───────────────────────────────
-- Verwacht: Chesney en Seppe allebei true in elke kolom.
-- Daarna moeten ze één keer opnieuw inloggen of de pagina verversen; de
-- rechten worden per paginalading opgehaald.

SELECT p.full_name, p.email,
       public.user_has_permission(p.id, 'opvolging.module.access')   AS module,
       public.user_has_permission(p.id, 'opvolging.dag.view')        AS vandaag,
       public.user_has_permission(p.id, 'opvolging.leads.view')      AS leads_bellen,
       public.user_has_permission(p.id, 'opvolging.taak.afronden')   AS afronden,
       public.user_has_permission(p.id, 'opvolging.agenda.boeken')   AS inplannen,
       public.user_has_permission(p.id, 'opvolging.whatsapp.sturen') AS whatsapp
  FROM public.profiles p
 WHERE p.is_active
   AND (p.full_name ILIKE 'chesney%' OR p.full_name ILIKE 'seppe%')
 ORDER BY p.full_name;


-- ── OPTIONEEL · ook de tab Call-rapport ─────────────────────────────────────
-- INSERT INTO public.user_permissions (user_id, feature_key, allowed)
-- SELECT p.id, 'calls.rapport.view', true
--   FROM public.profiles p
--  WHERE p.is_active AND (p.full_name ILIKE 'chesney%' OR p.full_name ILIKE 'seppe%')
-- ON CONFLICT (user_id, feature_key) DO UPDATE SET allowed = true;


-- ── ROLLBACK (indien nodig) ─────────────────────────────────────────────────
-- DELETE FROM public.user_permissions up
--  USING public.profiles p
--  WHERE up.user_id = p.id
--    AND up.feature_key LIKE 'opvolging.%'
--    AND (p.full_name ILIKE 'chesney%' OR p.full_name ILIKE 'seppe%');
