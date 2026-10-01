-- ============================================================================
-- calls.closer — wie de closer-topbar ziet ("Maak je dagrapportage in orde")
-- Datum: 2026-10-01
-- Branch: feat/call-closer-topbar
--
-- ── WAAROM EEN RECHT EN GEEN ROL ────────────────────────────────────────────
-- 'Closer' zegt niet wat iemand IS in het CRM (menu, landing, modules), maar
-- dat hij calls bezit die een uitkomst nodig hebben. Een rol 'closer' zou
-- betekenen: de CHECK op profiles.role, user_roles.role en
-- role_permissions.role verruimen, plus de ~6 rollijsten in de code
-- (api/_lib/roles.js, design-system/roles.js, CRM_STAFF_ROLES, de labels in
-- klanten-v2.js, de matrix in admin) — en een keuze voor landing en menu die
-- nu niemand hoeft te maken. Dave is gewoon sales.
--
-- Een recht dekt dat zonder nevenwerking, en het is hetzelfde precedent als de
-- hoofdmentor (api/_lib/notify.js resolveOntvangersVoorRecht): toekennen per
-- rol (deze migratie: sales) of per persoon (user_permissions), bv. een
-- manager die ook closet. Komt er later toch een rol, dan is één rij in
-- role_permissions genoeg en verandert er aan de code niets.
--
-- De topbar kijkt daarnaast of de gebruiker afspraken BEZIT (owner_id). Een
-- sales-medewerker zonder calls ziet dus niets.
--
-- ── NIET BLOKKEREND ─────────────────────────────────────────────────────────
-- Er wordt geen kolom of tabel toegevoegd; de code noemt niets dat zonder deze
-- migratie ontbreekt. Draait hij (nog) niet, dan:
--   - geeft user_has_permission() voor calls.closer alleen true voor
--     super_admin (de eigen OR-tak) — en die bezit geen afspraken, dus ziet
--     ook niets;
--   - krijgt Dave (sales) een 403 op /api/mijn-calls-vandaag, en vraagt de
--     shell het niet eens op (RBAC.can is false). Geen topbar, geen melding.
--   - werkt de rest van het CRM precies als voorheen.
--
-- ── ROL-TOEWIJZING ──────────────────────────────────────────────────────────
--   sales          → true   (de closers; op dit moment alleen Dave)
--   manager        → false  (stuurt aan, bezit geen calls; per persoon aan te
--                            zetten via user_permissions als dat verandert)
--   super_admin    → geen rij nodig; eigen OR-tak in user_has_permission
--   overige rollen → geen rij (= niet toegekend)
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Elke INSERT staat achter een NOT EXISTS op (role, feature_key). Opnieuw
-- draaien voegt niets toe en overschrijft geen allowed-waarde die later met de
-- hand is aangepast. Losse statements, dus veilig in de Supabase SQL-editor
-- die op statement-grenzen knipt.
-- ============================================================================

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'sales', 'calls.closer', true
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='sales' AND feature_key='calls.closer');

INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT 'manager', 'calls.closer', false
WHERE NOT EXISTS (SELECT 1 FROM public.role_permissions WHERE role='manager' AND feature_key='calls.closer');

-- ── CONTROLE (los te draaien) ───────────────────────────────────────────────
-- Verwacht: sales = true, manager = false.
--
-- SELECT role, allowed FROM public.role_permissions
-- WHERE feature_key = 'calls.closer' ORDER BY role;
--
-- Wie heeft het recht effectief (Dave hoort erbij):
-- SELECT p.full_name, public.user_has_permission(p.id, 'calls.closer') AS closer
-- FROM public.profiles p WHERE p.is_active ORDER BY 1;

-- ── ROLLBACK (indien nodig) ─────────────────────────────────────────────────
-- Hiermee verdwijnt de topbar voor iedereen; de rest van het CRM merkt niets.
--
-- DELETE FROM public.role_permissions WHERE feature_key = 'calls.closer';
