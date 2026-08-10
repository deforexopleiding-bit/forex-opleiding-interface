-- ============================================================================
-- Migratie 015: Sales-rol toegang tot de Wanbetalers-module
-- Datum: 2026-08-10
-- Branch: feat/sales-wanbetalers-access
--
-- DOEL: de rol `sales` toegang geven tot de Wanbetalers-module binnen Finance,
-- inclusief het actief bewerken van dossiers (TL-resultaat invoeren, dossier
-- sluiten, dunning-engine draaien). Geldt voor alle sales-medewerkers, nu en
-- toekomstig (rol-gebaseerd, union via role_permissions → user_has_permission).
--
-- Context: sales heeft al `finance.module.access` (migratie 014) en kan dus de
-- Finance-module openen, maar mist de `finance.dunning.*`-keys — daardoor is de
-- Wanbetalers-view nu afgeschermd ("Je mist de rechten finance.dunning.view").
-- Deze migratie voegt exact twee keys toe:
--   finance.dunning.view    → Wanbetalers-view + dossiers bekijken
--   finance.dunning.execute → dossiers bewerken (mark-as-executed, dossier
--                             sluiten, engine run-now)
-- BEWUST NIET toegevoegd: finance.dunning.config (wanbetalers-flow/instellingen
-- wijzigen) blijft manager/super_admin-only.
--
-- Zoals migratie 014: dit bestand is het versiebeheer-record. Draai de INSERT
-- op PROD om de grant live te zetten (of zet dezelfde twee vinkjes aan in de
-- admin-rechtenmatrix voor de rol sales).
--
-- IDEMPOTENT (ON CONFLICT DO NOTHING): herhaald draaien is veilig; bestaande
-- grants blijven ongemoeid.
-- ============================================================================

BEGIN;

INSERT INTO public.role_permissions (role, feature_key, allowed) VALUES
  ('sales','finance.dunning.view',true),
  ('sales','finance.dunning.execute',true)
ON CONFLICT (role, feature_key) DO NOTHING;

COMMIT;

-- ── ROLLBACK ────────────────────────────────────────────────────────────────
-- Verwijdert exact de twee rijen die deze migratie toevoegt. Tuple-based
-- WHERE-clause zodat er geen andere sales-keys sneuvelen.
--
-- DELETE FROM public.role_permissions
-- WHERE (role, feature_key) IN (
--   ('sales','finance.dunning.view'),
--   ('sales','finance.dunning.execute')
-- );
