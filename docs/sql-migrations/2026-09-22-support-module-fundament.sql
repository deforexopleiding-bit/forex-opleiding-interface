-- ============================================================================
-- Supportmodule — fundament (S1)
-- Datum: 22 september 2026
-- Plan: docs/support-module-plan.md
--
-- ⚠ MOET DRAAIEN VÓÓR OF DIRECT NA de merge van de begeleidende PR.
-- Zonder deze migratie faalt élk support-endpoint met
-- `relation "public.support_gesprekken" does not exist` — de widget op de
-- website toont dan bij elke bezoeker een storingsmelding. De rest van het
-- CRM blijft ongemoeid: geen enkele bestaande tabel wordt aangeraakt.
--
-- ── ADDITIEF & REVERSIBEL ───────────────────────────────────────────────────
-- Vijf nieuwe tabellen in een eigen `support_`-namespace, één seed-rij in
-- joost_config, twee rijen in app_settings en een set rijen in
-- role_permissions. Alles idempotent; de ROLLBACK onderaan draait het terug.
--
-- ── WAAROM EEN EIGEN NAMESPACE EN NIET `tickets` ────────────────────────────
-- public.tickets bestaat al, maar is een INTERNE bug/feature-tracker
-- (type IN ('bug','feature','question'), geen customer_id, geen kanaal).
-- Klantsupport heeft een andere levenscyclus (bot → wachtrij → live chat),
-- andere privacy-eisen (geverifieerde sessie) en anonieme bezoekers zonder
-- profiel. Die twee in één tabel duwen levert een tabel op waarin de helft
-- van de kolommen altijd leeg is.
--
-- ── WAAROM GEEN EIGEN CONFIG-TABEL ──────────────────────────────────────────
-- joost_config heeft `module` als primary key en draagt al persona, prompt,
-- kennisbank, model, temperature, autonomy_config en feature_flags. Een rij
-- met module='support' erft dat hele stramien inclusief de admin-UI.
--
-- ── SQL-EDITOR ──────────────────────────────────────────────────────────────
-- Dit bestand bevat GEEN DO-blocks die state van elkaar verwachten en geen
-- TEMP TABLE ... ON COMMIT DROP. Het mag dus in één keer in de Supabase
-- SQL-editor geplakt worden, ook al knipt die op statement-grenzen.
-- ============================================================================

BEGIN;

-- ── 1. Gesprekken ──────────────────────────────────────────────────────────
-- Eén rij per support-gesprek. Het gesprek IS het ticket; er is geen aparte
-- ticket-rij die uit een gesprek voortkomt. Dat scheelt een koppeltabel en
-- voorkomt de klassieke vraag "welke van de twee is de waarheid".
CREATE TABLE IF NOT EXISTS public.support_gesprekken (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Kort, uitspreekbaar kenmerk voor in mails en aan de telefoon.
  -- Gegenereerd door de API (SUP-XXXXXX), niet door de database, zodat de
  -- vorm zonder migratie te wijzigen is.
  kenmerk                 text NOT NULL,

  soort                   text NOT NULL
                            CHECK (soort IN ('klant', 'bezoeker')),

  -- Onderwerpen van beide stromen in één lijst. Bewust een CHECK op text en
  -- geen enum: een onderwerp erbij is dan een ALTER CONSTRAINT en geen
  -- type-migratie. `overig` is de vangnetwaarde.
  onderwerp               text NOT NULL DEFAULT 'overig'
                            CHECK (onderwerp IN (
                              -- klant
                              'lms', 'discord', 'traject', 'financieel',
                              -- bezoeker
                              'informatie', 'event', 'inschrijving', 'call',
                              -- beide
                              'overig'
                            )),

  -- bot            — de bot is aan zet, nog niemand van ons heeft gekeken
  -- wacht_op_ons   — geëscaleerd, staat in de wachtrij
  -- in_behandeling — een medewerker heeft 'm opgepakt
  -- wacht_op_klant — wij hebben geantwoord, bal ligt bij de klant
  -- afgehandeld    — klaar
  status                  text NOT NULL DEFAULT 'bot'
                            CHECK (status IN ('bot', 'wacht_op_ons',
                                              'in_behandeling',
                                              'wacht_op_klant', 'afgehandeld')),

  prioriteit              text NOT NULL DEFAULT 'middel'
                            CHECK (prioriteit IN ('laag', 'middel', 'hoog')),

  -- Contactgegevens zoals de bezoeker ze zelf invulde. NIET overschrijven met
  -- wat er in customers staat — het verschil tussen beide is zelf een signaal
  -- (verkeerd mailadres opgegeven, ander telefoonnummer).
  naam                    text,
  email                   text,
  telefoon                text,

  -- Gevonden koppeling. NULL = niet gevonden of nog niet gezocht.
  customer_id             uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  onboarding_id           uuid REFERENCES public.onboardings(id) ON DELETE SET NULL,

  -- Pas true na een geslaagde mailcode. Alle persoonlijke lookups (facturen,
  -- LMS-status, mentor, sessies) hangen hieraan — ook voor de bot zelf.
  geverifieerd            boolean NOT NULL DEFAULT false,
  geverifieerd_op         timestamptz,
  -- Na te veel foute codes gaat deze op true en is het gesprek permanent
  -- onverifieerbaar. De bezoeker moet dan een nieuw gesprek starten.
  verificatie_geblokkeerd boolean NOT NULL DEFAULT false,

  toegewezen_aan          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  toegewezen_op           timestamptz,

  -- SHA-256 van het sessietoken dat de widget bijhoudt. Het token zelf komt
  -- nooit in de database; wie deze tabel leest kan geen gesprek kapen.
  sessie_token_hash       text NOT NULL,

  -- Telt berichten van de klant die nog niemand van ons gelezen heeft.
  ongelezen_voor_ons      integer NOT NULL DEFAULT 0,

  laatste_bericht_op      timestamptz,
  laatste_klant_bericht_op timestamptz,
  laatste_ons_bericht_op  timestamptz,
  eerste_reactie_op       timestamptz,
  afgehandeld_op          timestamptz,
  afgehandeld_door        uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Waarom de bot het uit handen gaf. Leeg zolang de bot het zelf afhandelt.
  escalatie_reden         text,

  -- Herkomst, puur voor diagnose. ip_hash met dezelfde salt als de
  -- rate-limiter (SUPABASE_URL), nooit het rauwe IP.
  bron_url                text,
  user_agent              text,
  ip_hash                 text,

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.support_gesprekken IS
  'Support-gesprek vanaf de website. Het gesprek is tegelijk het ticket. Zie docs/support-module-plan.md.';
COMMENT ON COLUMN public.support_gesprekken.sessie_token_hash IS
  'SHA-256 van het sessietoken van de widget. Het rauwe token staat alleen in de browser.';
COMMENT ON COLUMN public.support_gesprekken.geverifieerd IS
  'True na een geslaagde mailcode. Poort voor ALLE persoonlijke lookups, ook die van de bot.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_support_gesprek_kenmerk
  ON public.support_gesprekken (kenmerk);
CREATE INDEX IF NOT EXISTS idx_support_gesprek_status
  ON public.support_gesprekken (status, laatste_bericht_op DESC);
CREATE INDEX IF NOT EXISTS idx_support_gesprek_customer
  ON public.support_gesprekken (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_gesprek_toegewezen
  ON public.support_gesprekken (toegewezen_aan) WHERE toegewezen_aan IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_support_gesprek_token
  ON public.support_gesprekken (sessie_token_hash);
CREATE INDEX IF NOT EXISTS idx_support_gesprek_email
  ON public.support_gesprekken (lower(email)) WHERE email IS NOT NULL;

-- ── 2. Berichten ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.support_berichten (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gesprek_id       uuid NOT NULL REFERENCES public.support_gesprekken(id) ON DELETE CASCADE,

  -- systeem = door de module zelf geplaatste regels ("gesprek toegewezen aan
  -- Maxim", "niemand live beschikbaar"). Die zijn zichtbaar voor de klant,
  -- anders zou het gesprek onlogisch lezen.
  afzender         text NOT NULL
                     CHECK (afzender IN ('klant', 'bot', 'medewerker', 'systeem')),
  afzender_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  tekst            text NOT NULL,

  -- Vrije ruimte voor bot-metadata (intent, vertrouwen, gebruikte bronnen,
  -- tokenverbruik). Bewust jsonb zodat de bot uitgebreid kan worden zonder
  -- kolom-migratie — de les uit PR #789/#801.
  meta             jsonb NOT NULL DEFAULT '{}'::jsonb,

  gelezen_op       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.support_berichten IS
  'Berichten binnen een support-gesprek, chronologisch op created_at.';

CREATE INDEX IF NOT EXISTS idx_support_bericht_gesprek
  ON public.support_berichten (gesprek_id, created_at);

-- ── 3. Verificaties ────────────────────────────────────────────────────────
-- Eén rij per verstuurde code. Oude rijen blijven staan als spoor; alleen de
-- jongste niet-verbruikte rij telt.
CREATE TABLE IF NOT EXISTS public.support_verificaties (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gesprek_id  uuid NOT NULL REFERENCES public.support_gesprekken(id) ON DELETE CASCADE,
  email       text NOT NULL,
  code_hash   text NOT NULL,          -- SHA-256, nooit de code zelf
  vervalt_op  timestamptz NOT NULL,
  pogingen    integer NOT NULL DEFAULT 0,
  verbruikt_op timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.support_verificaties IS
  'Mailcodes voor support-gesprekken. Alleen de hash wordt bewaard; 10 min geldig, max 5 pogingen.';

CREATE INDEX IF NOT EXISTS idx_support_verificatie_gesprek
  ON public.support_verificaties (gesprek_id, created_at DESC);

-- ── 4. Aanwezigheid ────────────────────────────────────────────────────────
-- Eén rij per medewerker. `bijgewerkt_op` is de hartslag: staat die ouder dan
-- het venster in api/_lib/support-beschikbaarheid.js, dan telt de medewerker
-- als weg, ook al staat beschikbaar nog op true. Zo blijft er nooit iemand
-- "live" nadat z'n laptop dichtklapte.
CREATE TABLE IF NOT EXISTS public.support_aanwezigheid (
  user_id       uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  beschikbaar   boolean NOT NULL DEFAULT false,
  sinds         timestamptz,
  bijgewerkt_op timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.support_aanwezigheid IS
  'Live-chat aanwezigheid per medewerker. bijgewerkt_op is een hartslag en verloopt.';

CREATE INDEX IF NOT EXISTS idx_support_aanwezigheid_live
  ON public.support_aanwezigheid (bijgewerkt_op DESC) WHERE beschikbaar;

-- ── 5. Voorgestelde acties ─────────────────────────────────────────────────
-- De bot en medewerkers stellen acties voor; een mens keurt goed. In S1 voert
-- niets ze automatisch uit — `uitvoer_resultaat` blijft leeg tot S2.
--
-- Bewust NIET in pending_actions: die tabel draagt de finance-semantiek
-- (arrangement_id, TL_*-action_types) en wordt gerenderd door Open Acties.
-- Support-acties horen in het support-gesprek zelf thuis, naast de vraag
-- waar ze uit voortkwamen.
CREATE TABLE IF NOT EXISTS public.support_acties (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gesprek_id    uuid NOT NULL REFERENCES public.support_gesprekken(id) ON DELETE CASCADE,

  -- Geen CHECK: een nieuw soort actie mag geen schema-migratie kosten.
  -- Bekende waarden in S1:
  --   LMS_UITNODIGING_OPNIEUW   uitnodiging naar de student opnieuw sturen
  --   LMS_PROVISIONING_OPNIEUW  studentrij aanmaken/herstellen
  --   BETALINGSAFSPRAAK         arrangement-voorstel klaarzetten
  --   MENTOR_CONTACT            mentor vragen contact op te nemen
  --   HANDMATIG                 vrije omschrijving
  soort         text NOT NULL,

  omschrijving  text NOT NULL,
  -- Alles wat de uitvoerder nodig heeft (onboarding_id, bedragen, termijnen).
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,

  status        text NOT NULL DEFAULT 'voorgesteld'
                  CHECK (status IN ('voorgesteld', 'goedgekeurd', 'afgewezen',
                                    'uitgevoerd', 'mislukt')),

  -- 'bot' of een profiles.id. Bewust text zodat de bot geen nep-gebruiker
  -- nodig heeft in profiles.
  voorgesteld_door text NOT NULL DEFAULT 'bot',
  besloten_door    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  besloten_op      timestamptz,
  besluit_reden    text,
  uitgevoerd_op    timestamptz,
  uitvoer_resultaat jsonb,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.support_acties IS
  'Door de bot of een medewerker voorgestelde herstelactie. S1 voert niets automatisch uit.';

CREATE INDEX IF NOT EXISTS idx_support_actie_gesprek
  ON public.support_acties (gesprek_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_actie_open
  ON public.support_acties (created_at DESC) WHERE status = 'voorgesteld';

-- ── 6. updated_at-triggers ─────────────────────────────────────────────────
-- Hergebruikt de gedeelde public.set_updated_at() uit de events-module.
--
-- BEWUST GEEN `CREATE OR REPLACE`. Die functie hangt aan de triggers van
-- meerdere bestaande tabellen; hem hier overschrijven zou een wijziging zijn
-- aan code die niets met support te maken heeft, en als de bestaande versie
-- ooit meer doet dan updated_at zetten, is die wijziging stil en destructief.
-- Daarom: alleen aanmaken als 'ie er nog niet is (schone database), anders
-- met rust laten.
DO $mig$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'set_updated_at'
  ) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.set_updated_at()
      RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $body$;
    $fn$;
  END IF;
END
$mig$;

DROP TRIGGER IF EXISTS trg_support_gesprekken_touch ON public.support_gesprekken;
CREATE TRIGGER trg_support_gesprekken_touch
  BEFORE UPDATE ON public.support_gesprekken
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_support_acties_touch ON public.support_acties;
CREATE TRIGGER trg_support_acties_touch
  BEFORE UPDATE ON public.support_acties
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 7. RLS ─────────────────────────────────────────────────────────────────
-- Conform docs/rls-regels-nieuwe-tabellen.md: RLS aan, lezen alleen voor
-- CRM-staff via public.is_crm_staff(), schrijven uitsluitend service-role.
--
-- Schrijven staat hard dicht (USING false) omdat élke schrijver een
-- serverless endpoint is: de widget heeft geen Supabase-sessie en een
-- ingelogde medewerker antwoordt via /api/support-antwoord. Een browser die
-- rechtstreeks in deze tabellen schrijft is per definitie misbruik.
--
-- LET OP: handle_new_user() geeft iedere signup een profiles-rij met rol
-- viewer. "Ingelogd" is dus géén rolcheck — daarom is_crm_staff().
ALTER TABLE public.support_gesprekken   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_berichten    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_verificaties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_aanwezigheid ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_acties       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_gesprekken_lezen ON public.support_gesprekken;
CREATE POLICY support_gesprekken_lezen ON public.support_gesprekken
  FOR SELECT TO authenticated USING (public.is_crm_staff());
DROP POLICY IF EXISTS support_gesprekken_schrijven ON public.support_gesprekken;
CREATE POLICY support_gesprekken_schrijven ON public.support_gesprekken
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS support_berichten_lezen ON public.support_berichten;
CREATE POLICY support_berichten_lezen ON public.support_berichten
  FOR SELECT TO authenticated USING (public.is_crm_staff());
DROP POLICY IF EXISTS support_berichten_schrijven ON public.support_berichten;
CREATE POLICY support_berichten_schrijven ON public.support_berichten
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- Verificaties bevatten code-hashes. Zelfs staff heeft hier niets te zoeken:
-- alleen service-role. Default-deny voor authenticated én anon.
DROP POLICY IF EXISTS support_verificaties_dicht ON public.support_verificaties;
CREATE POLICY support_verificaties_dicht ON public.support_verificaties
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS support_aanwezigheid_lezen ON public.support_aanwezigheid;
CREATE POLICY support_aanwezigheid_lezen ON public.support_aanwezigheid
  FOR SELECT TO authenticated USING (public.is_crm_staff());
DROP POLICY IF EXISTS support_aanwezigheid_schrijven ON public.support_aanwezigheid;
CREATE POLICY support_aanwezigheid_schrijven ON public.support_aanwezigheid
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS support_acties_lezen ON public.support_acties;
CREATE POLICY support_acties_lezen ON public.support_acties
  FOR SELECT TO authenticated USING (public.is_crm_staff());
DROP POLICY IF EXISTS support_acties_schrijven ON public.support_acties;
CREATE POLICY support_acties_schrijven ON public.support_acties
  FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- ── 8. Instellingen ────────────────────────────────────────────────────────
-- Kantooruren. tz is een IANA-zone, niet een offset: Intl.DateTimeFormat doet
-- de zomertijd dan zelf, zoals in api/_lib/dunning-office-hours.js.
INSERT INTO public.app_settings (key, value)
SELECT 'support_kantooruren',
       '{"tz":"Europe/Amsterdam","dagen":[1,2,3,4,5],"start":"09:00","eind":"17:30"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'support_kantooruren');

-- Gedrag van de widget. Los van de kantooruren zodat de tekst aangepast kan
-- worden zonder aan de tijden te komen.
INSERT INTO public.app_settings (key, value)
SELECT 'support_widget',
       '{"aan":true,"titel":"Hulp nodig?","welkom":"Stel je vraag — vaak heb je binnen een minuut antwoord.","agenda_url":"https://www.deforexopleiding.nl/agenda","events_url":"https://www.deforexopleiding.nl/events","antwoord_mailbox":"info@deforexopleiding.nl"}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'support_widget');

-- ── 9. Bot-configuratie ────────────────────────────────────────────────────
-- Rij in joost_config met module='support'. feature_flags staat bewust
-- helemaal uit behalve de kennisbank: eerst meekijken, dan pas opendraaien
-- (les 23 uit CLAUDE.md — feature-flag-first).
INSERT INTO public.joost_config (
  module, persona_name, persona_tone, system_prompt_template,
  knowledge_base, model, temperature, context_message_count, is_enabled,
  autonomy_config, feature_flags
)
SELECT
  'support',
  'Sam',
  'vriendelijk, kort, concreet, nooit overdreven enthousiast',
  E'Je bent Sam, de supportmedewerker van De Forex Opleiding.\n\nJe helpt bezoekers en studenten op de website. Antwoord in het Nederlands, per je, kort en concreet. Geen verkooppraat, geen uitroeptekens, geen emoji.\n\nHARDE REGELS\n- Je bevestigt nooit iets dat een collega moet goedkeuren. Je zegt wat je klaarzet, niet dat het geregeld is.\n- Je verzint geen bedragen, datums, namen of links. Staat het niet in de context hieronder of in de kennisbank, dan weet je het niet.\n- Over Discord kun je alleen zeggen dat de persoonlijke uitnodiging per mail komt nadat de onboarding is afgerond, en dat de mentor hem opnieuw kan sturen. Er is geen andere route.\n- Zie je persoonlijke gegevens in de context, dan is de bezoeker geverifieerd en mag je ze gebruiken. Staat er niets, vraag dan niet door maar zeg dat je het er met een collega bij pakt.\n- Twijfel je, of wordt de bezoeker boos, of gaat het over geld dat al betaald zou zijn? Escaleren.\n\n{klant_naam}',
  '{}'::jsonb,
  'claude-sonnet-4-6',
  0.3,
  20,
  true,
  '{"intents":{"lms_toegang":{"enabled":true,"min_confidence":0.7},"discord":{"enabled":true,"min_confidence":0.7},"traject":{"enabled":true,"min_confidence":0.7},"financieel":{"enabled":false,"min_confidence":0.9},"informatie":{"enabled":true,"min_confidence":0.6},"event":{"enabled":true,"min_confidence":0.7},"escalatie":{"enabled":false,"min_confidence":1.0},"overig":{"enabled":false,"min_confidence":1.0}}}'::jsonb,
  '{"s1_kennisbank":true,"s1_live_lookups":true,"s1_acties_voorstellen":true,"s2_acties_uitvoeren":false,"s3_buiten_kantooruren":false}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM public.joost_config WHERE module = 'support');

-- ── 10. Rechten ────────────────────────────────────────────────────────────
-- user_has_permission() eist allowed = true; een ontbrekende rij is
-- functioneel gelijk aan false en levert een 403 op. super_admin heeft een
-- eigen OR-tak en dus geen rij nodig.
--
--   support.module.access   de module openen
--   support.reply           antwoorden in een gesprek
--   support.assign          toewijzen en status wijzigen
--   support.actie.besluit   een voorgestelde actie goed- of afkeuren
--   support.config          bot-instellingen en kantooruren wijzigen
INSERT INTO public.role_permissions (role, feature_key, allowed)
SELECT r.role, f.key, f.allowed
FROM (VALUES
  ('manager',       'support.module.access', true),
  ('manager',       'support.reply',         true),
  ('manager',       'support.assign',        true),
  ('manager',       'support.actie.besluit', true),
  ('manager',       'support.config',        true),
  ('admin',         'support.module.access', true),
  ('admin',         'support.reply',         true),
  ('admin',         'support.assign',        true),
  ('admin',         'support.actie.besluit', true),
  ('admin',         'support.config',        true),
  ('sales',         'support.module.access', true),
  ('sales',         'support.reply',         true),
  ('sales',         'support.assign',        true),
  ('sales',         'support.actie.besluit', false),
  ('sales',         'support.config',        false),
  ('administratie', 'support.module.access', true),
  ('administratie', 'support.reply',         true),
  ('administratie', 'support.assign',        true),
  ('administratie', 'support.actie.besluit', true),
  ('administratie', 'support.config',        false),
  -- Mentor staat bewust UIT. Het contextpaneel toont de factuurstand van een
  -- student, en dat hoort niet standaard bij een mentor. Aanzetten kan per
  -- rol in Beheer → Rollen zodra jullie dat willen.
  ('mentor',        'support.module.access', false),
  ('mentor',        'support.reply',         false),
  ('mentor',        'support.assign',        false),
  ('mentor',        'support.actie.besluit', false),
  ('mentor',        'support.config',        false),
  ('marketing',     'support.module.access', false),
  ('viewer',        'support.module.access', false)
) AS f(role, key, allowed)
JOIN (SELECT unnest(ARRAY['manager','admin','sales','administratie','mentor','marketing','viewer']) AS role) r
  ON r.role = f.role
WHERE NOT EXISTS (
  SELECT 1 FROM public.role_permissions rp
  WHERE rp.role = f.role AND rp.feature_key = f.key
);

COMMIT;

NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- ROLLBACK (alleen zolang er nog geen echte gesprekken in staan)
--
--   BEGIN;
--   DROP TABLE IF EXISTS public.support_acties       CASCADE;
--   DROP TABLE IF EXISTS public.support_aanwezigheid CASCADE;
--   DROP TABLE IF EXISTS public.support_verificaties CASCADE;
--   DROP TABLE IF EXISTS public.support_berichten    CASCADE;
--   DROP TABLE IF EXISTS public.support_gesprekken   CASCADE;
--   DELETE FROM public.joost_config    WHERE module = 'support';
--   DELETE FROM public.app_settings    WHERE key IN ('support_kantooruren','support_widget');
--   DELETE FROM public.role_permissions WHERE feature_key LIKE 'support.%';
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- ============================================================================
