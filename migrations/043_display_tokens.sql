-- ============================================================================
-- Migratie 043: display_tokens — intrekbare tokens voor tv-dashboard
-- Datum: 2026-08-25
--
-- Doel: read-only /api/display-metrics gate't op een SHA-256-hash van een
-- 32-byte random plaintext. Token nooit plaintext in DB. Rotatie via
-- POST /api/display-token-admin (super_admin-only): create → returnt
-- plaintext 1x, revoke → zet revoked_at.
--
-- Rollback: DROP TABLE public.display_tokens; (aan het einde als comment).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.display_tokens (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash    text        NOT NULL UNIQUE,       -- lowercase-hex SHA-256 van plaintext
  label         text        NOT NULL,               -- 'tv-kantoor', 'tv-tijdelijk-jeffrey', etc
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  hit_count     integer     NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_display_tokens_active
  ON public.display_tokens(token_hash) WHERE revoked_at IS NULL;

ALTER TABLE public.display_tokens ENABLE ROW LEVEL SECURITY;

-- Alleen super_admin mag zien/wijzigen. Endpoints (display-metrics +
-- display-token-admin) gebruiken supabaseAdmin (service-role bypass) →
-- deze policy is defense-in-depth voor directe SQL-access.
DROP POLICY IF EXISTS display_tokens_super_admin ON public.display_tokens;
CREATE POLICY display_tokens_super_admin ON public.display_tokens
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON TABLE public.display_tokens IS
  'Intrekbare tokens voor read-only tv-dashboard /api/display-metrics. '
  'Plaintext = 32-byte random hex; DB slaat alleen SHA-256-hash op. '
  'Rotatie via /api/display-token-admin (super_admin-only).';

COMMIT;

-- ROLLBACK (aparte transactie):
-- BEGIN;
--   DROP TABLE IF EXISTS public.display_tokens;
-- COMMIT;
