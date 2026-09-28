-- ============================================================================
-- Uitgesteld versturen — de wachtrij
-- Datum: 28 september 2026
-- Hoort bij: docs/iris/03-gesprekken-v2.md, sectie "G2 op de server"
--
-- ── WAT DIT DOET ────────────────────────────────────────────────────────────
-- Eén nieuwe tabel: inbox_uitgesteld. Verder niets. Geen kolom die verdwijnt,
-- geen kolom die van naam verandert, geen policy die iets intrekt. Puur
-- toevoegen, dus veilig om te draaien terwijl er mensen in het CRM werken.
--
-- ── WAT HET OPLOST ──────────────────────────────────────────────────────────
-- Het ongedaan-venster van dertig seconden wachtte tot nu toe IN HET SCHERM.
-- Sluit je het tabblad binnen die dertig seconden, dan vertrok het bericht
-- nooit — en niets zei dat. Je denkt dat je geantwoord hebt.
--
-- Met deze tabel parkeert de server het bericht meteen. Blijft het tabblad
-- open, dan geeft datzelfde scherm na dertig seconden het startsein (dan is het
-- exact dertig seconden). Is het tabblad dicht, dan pikt een cron het op. Het
-- bericht vertrekt dus hoe dan ook, of het wordt bewust geannuleerd — die twee,
-- en niets ertussenin.
--
-- ── WAAROM claimed_at ───────────────────────────────────────────────────────
-- Het scherm en de cron kunnen tegelijk besluiten dat dit bericht nú weg mag.
-- Zonder claim vertrekt het dan TWEE KEER, en dat is bij een klant met een
-- betalingsachterstand niet "een dubbel berichtje" maar een reden om te
-- twijfelen aan alles wat je stuurt.
--
-- De claim is een UPDATE die alleen slaagt als status nog 'gepland' is én
-- claimed_at nog leeg. Twee tegelijk: één krijgt een rij terug, de ander nul.
-- Zelfde patroon als cron-lisa-delayed, dat zich daar al bewezen heeft.
--
-- ── VEILIGHEID ──────────────────────────────────────────────────────────────
-- RLS aan met een policy op public.is_crm_staff(), conform
-- docs/rls-regels-nieuwe-tabellen.md. Nooit USING (true): handle_new_user()
-- maakt bij elke signup een profiles-rij met rol 'viewer', dus "iedere
-- ingelogde gebruiker" is ook elke student. De cron draait met de service-rol
-- en gaat langs RLS heen; die heeft deze policy niet nodig.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Alles achter IF NOT EXISTS / DROP POLICY IF EXISTS. Opnieuw draaien verandert
-- niets.
--
-- ── SUPABASE SQL-EDITOR ─────────────────────────────────────────────────────
-- Die knipt de invoer op statement-grenzen en draait elk statement in een eigen
-- transactie. Daarom geen BEGIN/COMMIT en geen DO-blok dat toestand van een
-- ander blok verwacht. Losse statements, in volgorde.
--
-- ── WANNEER DRAAIEN ─────────────────────────────────────────────────────────
-- Na de merge van PR 1 en VÓÓR die van PR 2. PR 1 raakt deze tabel niet aan —
-- daar verhuist alleen de verzendlogica — dus tussen die twee in is het rustig.
-- Draait de migratie niet en gaat PR 2 wél live, dan faalt het parkeren met een
-- tabel-die-niet-bestaat; het scherm valt dan terug op het oude gedrag
-- (wachten in het scherm), dus er gaat niets kapot, maar het gat blijft open.
-- ============================================================================


-- ── CONTROLE VOORAF ─────────────────────────────────────────────────────────
-- Verwacht: 0 rijen (de tabel bestaat nog niet).
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_name = 'inbox_uitgesteld';


-- ─────────────────────────────────────────────────────────────────────────────
-- inbox_uitgesteld — berichten die zo meteen vertrekken
-- ─────────────────────────────────────────────────────────────────────────────
-- De inhoud-kolommen spiegelen de opdracht die /api/inbox-send al aanneemt
-- (zie _lib/inbox-verzendopdracht.js). Bewust plat en niet als één jsonb-blob:
-- "welke berichten staan er klaar voor deze klant" moet een gewone WHERE zijn,
-- geen scan door json.
CREATE TABLE IF NOT EXISTS public.inbox_uitgesteld (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES public.whatsapp_conversations(id) ON DELETE CASCADE,
  module              text NOT NULL DEFAULT 'finance',

  -- Wat er verstuurd moet worden.
  mode                text NOT NULL CHECK (mode IN ('text','template','image','document','video')),
  body                text,
  template_name       text,
  template_language   text,
  template_variables  jsonb,
  template_components jsonb,
  media_link          text,
  media_caption       text,
  media_filename      text,

  -- Wie, wanneer, en hoe het afliep.
  aangemaakt_door     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  verstuur_na         timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'gepland'
                        CHECK (status IN ('gepland','verstuurd','geannuleerd','mislukt')),
  claimed_at          timestamptz,
  reden               text,
  meta_wamid          text,
  aangemaakt_op       timestamptz NOT NULL DEFAULT now(),
  afgehandeld_op      timestamptz
);

COMMENT ON TABLE public.inbox_uitgesteld IS
  'Berichten die geparkeerd staan tot verstuur_na. Het scherm geeft normaal het startsein (exact 30 s); staat het tabblad dicht, dan doet de cron het.';
COMMENT ON COLUMN public.inbox_uitgesteld.claimed_at IS
  'Gezet door wie dit bericht gaat versturen. De claim-UPDATE slaagt alleen als status=gepland EN claimed_at IS NULL, zodat scherm en cron het nooit allebei doen.';
COMMENT ON COLUMN public.inbox_uitgesteld.verstuur_na IS
  'Aanmaakmoment + 30 s. Het 24-uursvenster wordt NIET hier gecontroleerd maar op het moment van versturen: een venster dat nu open is, kan dan dicht zijn.';
COMMENT ON COLUMN public.inbox_uitgesteld.reden IS
  'Leesbare uitleg bij geannuleerd of mislukt. Wordt in het gesprek getoond — een bericht dat niet vertrok, mag nooit stil blijven.';

-- De vraag van de cron: wat staat er klaar en is nog van niemand?
CREATE INDEX IF NOT EXISTS idx_inbox_uitgesteld_klaar
  ON public.inbox_uitgesteld (verstuur_na)
  WHERE status = 'gepland' AND claimed_at IS NULL;

-- De vraag van het scherm: staat er voor dit gesprek nog iets in de wacht?
CREATE INDEX IF NOT EXISTS idx_inbox_uitgesteld_gesprek
  ON public.inbox_uitgesteld (conversation_id, aangemaakt_op DESC);

-- Het herstel van hangende claims: geclaimd, maar nooit afgerond.
CREATE INDEX IF NOT EXISTS idx_inbox_uitgesteld_hangend
  ON public.inbox_uitgesteld (claimed_at)
  WHERE status = 'gepland' AND claimed_at IS NOT NULL;


-- ── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE public.inbox_uitgesteld ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_uitgesteld_staff ON public.inbox_uitgesteld;
CREATE POLICY inbox_uitgesteld_staff ON public.inbox_uitgesteld
  FOR ALL TO authenticated
  USING (public.is_crm_staff())
  WITH CHECK (public.is_crm_staff());


-- ── CONTROLE ACHTERAF ───────────────────────────────────────────────────────
-- 1. De tabel bestaat, met 0 rijen.
SELECT count(*) AS rijen FROM public.inbox_uitgesteld;

-- 2. RLS staat aan.
SELECT relname, relrowsecurity
FROM pg_class
WHERE oid = 'public.inbox_uitgesteld'::regclass;

-- 3. Er is precies één policy, en die hangt aan is_crm_staff.
SELECT policyname, cmd, qual
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'inbox_uitgesteld';

-- 4. De drie indexen staan er.
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'inbox_uitgesteld'
ORDER BY indexname;
