-- ============================================================================
-- 2026-08-01-ai-readonly-foundation.sql
-- ============================================================================
--
-- AI Manager PR-A: fundament voor een read-only AI-toegang tot de database.
--
-- Wat dit script doet (in deze volgorde):
--   1. Maakt schema `ai_readonly`.
--   2. Maakt Postgres-rol `ai_readonly` met LOGIN (aparte connectiestring).
--      Wachtwoord moet je HANDMATIG in Supabase zetten via de UI of via
--      ALTER ROLE ai_readonly WITH PASSWORD '...'  (zie deploy-stappen onder).
--   3. Herroept alle bestaande privileges van de rol op public/auth/storage/etc.
--   4. Geeft de rol ALLEEN USAGE op `ai_readonly` + SELECT op alle views daarin.
--   5. Bouwt 6 veilige views (allow-list — alleen kolommen die door recon 2026-08-01
--      als niet-gevoelig zijn geclassificeerd; expliciet WEGGELATEN: wachtwoord-
--      hashes, tokens, IBAN, mandaten, betaal-IDs, message-bodies, notes).
--   6. Documenteert elke view via COMMENT ON VIEW zodat een latere AI-Manager
--      de metadata kan uitlezen zonder de rauwe DDL te hoeven kennen.
--
-- Wat dit script NIET doet:
--   * NIET de ai_readonly_query() RPC (dat is voor PR-B — het AI-endpoint).
--   * NIET raakt aan `service_role`, `authenticated`, `anon`, of andere
--     bestaande rollen. Alle bestaande app-flows blijven ongewijzigd.
--   * NIET wijzigt bestaande tabellen (`public.*`) — alleen bovenop bestaande
--     tabellen leest via VIEW-abstractie in nieuw schema.
--
-- Veiligheidsprincipes:
--   * Rol heeft NOLOGIN kan alleen via GRANT — hier LOGIN, want user vroeg om
--     "eigen connectiestring, los van service-role" (route A in het bouwplan).
--   * REVOKE komt VOOR GRANT: eerst alles wegnemen, dan alleen ai_readonly
--     opnieuw toevoegen. Idempotent.
--   * ALTER DEFAULT PRIVILEGES zorgt dat NIEUWE views in ai_readonly automatisch
--     SELECT-recht krijgen zonder aparte GRANT.
--   * Views filteren `is_test`-data waar de tabel die kolom heeft
--     (event_attendees, follow_up_leads).
--   * Namen (first_name, last_name) worden BEWUST wél getoond — expliciet
--     goedgekeurd door Jeffrey 2026-08-01. E-mail, telefoon, adres, IBAN,
--     tokens en alle vrije-tekst-velden (notes/omschrijving/notitie/subject)
--     zijn eruit.
--
-- ============================================================================


-- ───────────────────────────────────────────────────────────────────────────
-- 1. SCHEMA
-- ───────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS ai_readonly;

COMMENT ON SCHEMA ai_readonly IS
  'Read-only whitelist-schema voor de AI Manager. Bevat uitsluitend views die
   veilige kolommen exposen; nooit rauwe tabellen. De rol `ai_readonly` heeft
   hier USAGE + SELECT, en niets anders in de database.';


-- ───────────────────────────────────────────────────────────────────────────
-- 2. ROL — met LOGIN (aparte connectiestring)
-- ───────────────────────────────────────────────────────────────────────────
-- Wachtwoord wordt in stap 6 (post-migratie) via aparte ALTER ROLE gezet,
-- zodat dit script geen secret in git plaatst.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai_readonly') THEN
    CREATE ROLE ai_readonly LOGIN NOINHERIT;
    RAISE NOTICE 'Rol ai_readonly aangemaakt (LOGIN, NOINHERIT). Zet wachtwoord met: ALTER ROLE ai_readonly WITH PASSWORD ''<strong-password>''';
  ELSE
    RAISE NOTICE 'Rol ai_readonly bestaat al — geen wijziging.';
  END IF;
END $$;

COMMENT ON ROLE ai_readonly IS
  'Read-only rol voor AI Manager. Krijgt LOGIN + eigen connectiestring, maar
   heeft alleen USAGE op schema ai_readonly + SELECT op zijn views. Kan geen
   INSERT/UPDATE/DELETE/DDL en geen andere schemas benaderen. NOINHERIT
   voorkomt dat de rol per ongeluk rechten erft van andere group-rollen.';


-- ───────────────────────────────────────────────────────────────────────────
-- 3. REVOKE ALL — verwijder alle default-privileges op alle andere schemas
-- ───────────────────────────────────────────────────────────────────────────
-- Deze rol mag NERGENS anders bij dan ai_readonly. We herroepen expliciet
-- alle rechten op de belangrijke schemas voor het geval Supabase default
-- iets gunt (bv. PUBLIC-inherit).
REVOKE ALL ON SCHEMA public   FROM ai_readonly;
REVOKE ALL ON SCHEMA auth     FROM ai_readonly;
REVOKE ALL ON SCHEMA storage  FROM ai_readonly;
REVOKE ALL ON SCHEMA extensions FROM ai_readonly;
REVOKE ALL ON SCHEMA graphql  FROM ai_readonly;
REVOKE ALL ON SCHEMA graphql_public FROM ai_readonly;
REVOKE ALL ON SCHEMA realtime FROM ai_readonly;

-- Ook: geen enkele tabel/functie/sequence in andere schemas
REVOKE ALL ON ALL TABLES    IN SCHEMA public  FROM ai_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public  FROM ai_readonly;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public  FROM ai_readonly;
REVOKE ALL ON ALL TABLES    IN SCHEMA auth    FROM ai_readonly;
REVOKE ALL ON ALL TABLES    IN SCHEMA storage FROM ai_readonly;

-- Blokkeer ook toekomstige defaults (bv. tabellen die door postgres-user
-- worden aangemaakt — die krijgen anders soms USAGE via PUBLIC)
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM ai_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM ai_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ai_readonly;


-- ───────────────────────────────────────────────────────────────────────────
-- 4. GRANT USAGE + SELECT op ALLEEN ai_readonly-schema
-- ───────────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA ai_readonly TO ai_readonly;
-- Bestaande views krijgen SELECT
GRANT SELECT ON ALL TABLES IN SCHEMA ai_readonly TO ai_readonly;
-- Toekomstige views (die we later toevoegen) krijgen automatisch SELECT
ALTER DEFAULT PRIVILEGES IN SCHEMA ai_readonly GRANT SELECT ON TABLES TO ai_readonly;


-- ───────────────────────────────────────────────────────────────────────────
-- 5. VIEWS — allow-list kolommen per view
-- ───────────────────────────────────────────────────────────────────────────

-- 5a. WANBETALERS — actieve dunning-cases per klant (met naam + open bedrag)
-- Kolommen: customer_id, klant_naam (samengesteld), stage_slug, stage_label,
-- stage_changed_at, aantal_open_facturen, totaal_open_bedrag.
-- EXPLICIET WEGGELATEN: email, telefoon, adres, IBAN, notes, invoice_number.
--
-- Open bedrag = amount_total - amount_paid - credited_amount (MAX 0). Dezelfde
-- formule als api/customer-dossier.js:248 en api/dunning-pipeline-detail.js.
-- Open statuses = ('open', 'partially_paid', 'overdue') — conform de app-conventie
-- (zie api/dunning-pipeline-detail.js:11 OPEN_STATUSES).
CREATE OR REPLACE VIEW ai_readonly.v_wanbetalers_actief AS
SELECT
  dpc.customer_id,
  TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))  AS klant_naam,
  dpc.stage_slug,
  dps.label                                                            AS stage_label,
  dpc.stage_changed_at,
  COUNT(i.id) FILTER (WHERE i.status IN ('open','partially_paid','overdue')) AS aantal_open_facturen,
  COALESCE(SUM(
    GREATEST(0::numeric,
             COALESCE(i.amount_total, 0) - COALESCE(i.amount_paid, 0) - COALESCE(i.credited_amount, 0))
  ) FILTER (WHERE i.status IN ('open','partially_paid','overdue')), 0)  AS totaal_open_bedrag
FROM public.dunning_pipeline_customers dpc
JOIN      public.customers c                    ON c.id = dpc.customer_id
LEFT JOIN public.dunning_pipeline_stages dps    ON dps.slug = dpc.stage_slug
LEFT JOIN public.invoices i                     ON i.customer_id = dpc.customer_id
WHERE dpc.stage_slug NOT IN ('opgelost', 'afschrijven')
  AND (c.anonymization_status IS NULL OR c.anonymization_status <> 'anonymized')
GROUP BY dpc.customer_id, c.first_name, c.last_name, dpc.stage_slug, dps.label, dpc.stage_changed_at;

COMMENT ON VIEW ai_readonly.v_wanbetalers_actief IS
  'Actieve wanbetalers per klant. Kolommen: customer_id (uuid), klant_naam
   (voornaam + achternaam), stage_slug (nieuw/aangemaand/in_gesprek/regeling/
   brief_verstuurd/incasso), stage_label, stage_changed_at, aantal_open_facturen,
   totaal_open_bedrag (EUR). Sluit opgeloste/afgeschreven cases uit + geanonimi-
   seerde klanten. Geen contactdata (email/telefoon/adres/IBAN) — die zitten in
   de klant-detail-pagina van de app, niet hier.';


-- 5b. OMZET — getekende deals per week (EXCL BTW, laatste 24 maanden)
-- Kolommen: week_start, aantal_deals, omzet_excl_btw_totaal, gem_deal_waarde.
CREATE OR REPLACE VIEW ai_readonly.v_omzet_per_week AS
SELECT
  date_trunc('week', d.tl_quotation_accepted_at)::date          AS week_start,
  COUNT(*)                                                      AS aantal_deals,
  COALESCE(SUM(d.total_amount), 0)                              AS omzet_excl_btw_totaal,
  COALESCE(AVG(d.total_amount), 0)                              AS gem_deal_waarde_excl_btw
FROM public.deals d
WHERE d.tl_quotation_accepted_at IS NOT NULL
  AND d.tl_quotation_accepted_at >= now() - interval '24 months'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW ai_readonly.v_omzet_per_week IS
  'Weekly omzet-samenvatting op basis van getekende (TL-accepted) deals,
   laatste 24 maanden. Kolommen: week_start (maandag), aantal_deals,
   omzet_excl_btw_totaal (EUR), gem_deal_waarde_excl_btw. LET OP: EXCL BTW
   omdat deals.total_amount excl BTW is opgeslagen. Voor INCL BTW zie
   super-admin-omzet.js — dat gebruikt per-line calc, past niet in een
   simpele view.';


-- 5c. OMZET — getekende deals per maand (voor jaar-view)
CREATE OR REPLACE VIEW ai_readonly.v_omzet_per_maand AS
SELECT
  date_trunc('month', d.tl_quotation_accepted_at)::date         AS maand_start,
  COUNT(*)                                                     AS aantal_deals,
  COALESCE(SUM(d.total_amount), 0)                             AS omzet_excl_btw_totaal
FROM public.deals d
WHERE d.tl_quotation_accepted_at IS NOT NULL
  AND d.tl_quotation_accepted_at >= now() - interval '36 months'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW ai_readonly.v_omzet_per_maand IS
  'Maandelijkse omzet-samenvatting, laatste 36 maanden. Kolommen: maand_start,
   aantal_deals, omzet_excl_btw_totaal. Zie v_omzet_per_week voor kortere
   granulariteit. EXCL BTW — zelfde reden.';


-- 5d. LEADS PER SOORT — aggregatie per dag, laatste 180 dagen
-- BEWUST GEEN individuele leads exposen (die staan in aparte lead-modules).
CREATE OR REPLACE VIEW ai_readonly.v_leads_per_soort AS
SELECT
  COALESCE(l.soort, '(geen)')                                  AS soort,
  date_trunc('day', l.aangemaakt)::date                        AS dag,
  COUNT(*)                                                     AS aantal
FROM public.leads l
WHERE l.aangemaakt >= now() - interval '180 days'
GROUP BY 1, 2
ORDER BY 2 DESC, 1;

COMMENT ON VIEW ai_readonly.v_leads_per_soort IS
  'Aantal leads per soort per dag, laatste 180 dagen. Kolommen: soort
   (7-daagse/webinar/minicursus/student/etc), dag, aantal. Individuele
   lead-data (naam/email/telefoon/antwoorden) is bewust NIET beschikbaar in
   ai_readonly — die staat in leads-module met eigen RBAC.';


-- 5e. EVENTS UPCOMING — eerstkomende events + aantallen (excl. is_test)
CREATE OR REPLACE VIEW ai_readonly.v_events_upcoming AS
SELECT
  e.id                                              AS event_id,
  e.title,
  e.starts_at,
  e.ends_at,
  e.capacity,
  e.niveau,
  e.location,
  COUNT(a.id) FILTER (WHERE a.status IN ('aangemeld','aanwezig')
                        AND a.assessment_response_id IS NOT NULL
                        AND a.is_test = false)      AS aantal_vragenlijst_ingevuld,
  COUNT(a.id) FILTER (WHERE a.status IN ('aangemeld','aanwezig')
                        AND a.is_test = false)      AS aantal_ingeschreven,
  COUNT(a.id) FILTER (WHERE a.call_status IS NOT NULL
                        AND a.is_test = false)      AS aantal_gebeld,
  GREATEST(0, e.capacity - COUNT(a.id) FILTER (WHERE a.status IN ('aangemeld','aanwezig')
                                                 AND a.assessment_response_id IS NOT NULL
                                                 AND a.is_test = false)) AS plaatsen_over
FROM public.events e
LEFT JOIN public.event_attendees a ON a.event_id = e.id
WHERE e.status = 'published'
  AND e.starts_at >= now()
GROUP BY e.id, e.title, e.starts_at, e.ends_at, e.capacity, e.niveau, e.location
ORDER BY e.starts_at ASC;

COMMENT ON VIEW ai_readonly.v_events_upcoming IS
  'Aankomende gepubliceerde events + counts. Kolommen: event_id, title,
   starts_at, ends_at, capacity, niveau, location, aantal_vragenlijst_ingevuld
   (Fase 1 regel: aangemeld/aanwezig + assessment_response_id), aantal_inge-
   schreven, aantal_gebeld (call_status IS NOT NULL — canoniek), plaatsen_over.
   ALLE tellingen exclusief is_test-attendees. LET OP: attendee-namen/emails
   zijn NIET beschikbaar in deze view — die staan in events-detail-pagina
   met eigen RBAC.';


-- 5f. KLANTEN ZONDER MENTOR (indicatie op basis van grootboek)
-- WAARSCHUWING: dit is een INDICATOR, geen bron-van-waarheid. "Mentor" wordt
-- hier afgeleid uit mentor_ledger_entries.customer_id — als er ooit een
-- grootboek-entry voor deze klant is aangemaakt, geldt deze view die als
-- "heeft mentor". Voor exacte mentor-toewijzing raadpleeg later een expliciete
-- mentor_students-tabel (die kan er nog niet zijn in dit repo — legacy).
CREATE OR REPLACE VIEW ai_readonly.v_klanten_zonder_mentor AS
SELECT
  c.id                                                       AS customer_id,
  TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS klant_naam,
  c.created_at                                               AS klant_sinds,
  EXISTS (
    SELECT 1 FROM public.subscriptions s
    WHERE s.customer_id = c.id AND s.status = 'active'
  )                                                          AS heeft_actief_abonnement
FROM public.customers c
WHERE (c.anonymization_status IS NULL OR c.anonymization_status <> 'anonymized')
  AND NOT EXISTS (
    SELECT 1 FROM public.mentor_ledger_entries m
    WHERE m.customer_id = c.id
  );

COMMENT ON VIEW ai_readonly.v_klanten_zonder_mentor IS
  'Klanten zonder mentor-koppeling (indicator: geen entry in
   mentor_ledger_entries). Kolommen: customer_id, klant_naam,
   klant_sinds, heeft_actief_abonnement. LET OP: dit is een indicator,
   geen bron van waarheid — een klant zonder ledger-entry kan wel al
   toegewezen zijn maar nog geen periode-declaratie hebben. Filter op
   heeft_actief_abonnement=true voor de meest urgente gaten.
   Geen contactdata — via klant-detail-pagina.';


-- 5g. SCHEMA-HELP — metadata voor de AI (later, in PR-B, gebruikt de AI-endpoint
-- dit om te weten welke views er zijn en waar ze voor dienen).
CREATE OR REPLACE VIEW ai_readonly.v_schema_help AS
SELECT
  v.table_name                                                                AS view_naam,
  obj_description(
    (quote_ident(v.table_schema)||'.'||quote_ident(v.table_name))::regclass,
    'pg_class'
  )                                                                           AS beschrijving,
  (SELECT string_agg(c.column_name, ', ' ORDER BY c.ordinal_position)
   FROM information_schema.columns c
   WHERE c.table_schema = v.table_schema AND c.table_name = v.table_name)     AS kolommen
FROM information_schema.views v
WHERE v.table_schema = 'ai_readonly'
ORDER BY v.table_name;

COMMENT ON VIEW ai_readonly.v_schema_help IS
  'Meta-view: geeft per view in ai_readonly de naam + beschrijving +
   kolomlijst. Wordt door PR-B (AI-endpoint) uitgelezen om de AI te vertellen
   welke views bestaan en hoe ze te gebruiken. Zo hoeft er niets over de
   schema in de system-prompt gehardcoded te worden.';


-- ───────────────────────────────────────────────────────────────────────────
-- 6. GRANT SELECT op alle nieuwe views expliciet
-- ───────────────────────────────────────────────────────────────────────────
-- (Al gedaan via ALL TABLES + ALTER DEFAULT PRIVILEGES, maar voor de zeker-
-- heid nogmaals expliciet — idempotent.)
GRANT SELECT ON ai_readonly.v_wanbetalers_actief    TO ai_readonly;
GRANT SELECT ON ai_readonly.v_omzet_per_week        TO ai_readonly;
GRANT SELECT ON ai_readonly.v_omzet_per_maand       TO ai_readonly;
GRANT SELECT ON ai_readonly.v_leads_per_soort       TO ai_readonly;
GRANT SELECT ON ai_readonly.v_events_upcoming       TO ai_readonly;
GRANT SELECT ON ai_readonly.v_klanten_zonder_mentor TO ai_readonly;
GRANT SELECT ON ai_readonly.v_schema_help           TO ai_readonly;


-- ───────────────────────────────────────────────────────────────────────────
-- POST-MIGRATIE STAPPEN (handmatig in Supabase — NIET in dit script)
-- ───────────────────────────────────────────────────────────────────────────
--
-- STAP A. Wachtwoord instellen voor de nieuwe rol:
--   ALTER ROLE ai_readonly WITH PASSWORD '<sterk-random-wachtwoord>';
--   (Genereer bv. via `openssl rand -base64 32`. Bewaar in 1Password.)
--
-- STAP B. Connectiestring samenstellen voor Vercel env-var
--   AI_READONLY_DATABASE_URL:
--
--   Formaat: postgres://ai_readonly:<PASSWORD>@<HOST>:6543/postgres
--
--   Host + poort haal je uit Supabase → Project Settings → Database → Connection
--   Pooling. Gebruik de POOLED connection (poort 6543 met pgbouncer), niet de
--   direct-connection (poort 5432) — dat is Vercel-safe.
--
-- STAP C. Deze env-var toevoegen in Vercel (Sensitive):
--   Project → Settings → Environment Variables → New:
--     Name  = AI_READONLY_DATABASE_URL
--     Value = postgres://ai_readonly:<PASSWORD>@<HOST>:6543/postgres
--     Envs  = Production + Preview + Development (allemaal aan)
--     Sensitive = true
--
-- STAP D. Verificatie draaien: zie docs/sql-migrations/_verify-ai-readonly.sql
--   Als alle 6 tests groen zijn, is het fundament dicht.
--
-- ============================================================================
