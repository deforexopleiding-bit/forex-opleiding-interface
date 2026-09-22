-- ============================================================================
-- Iris — fase 1: het datamodel
-- Datum: 21 september 2026
-- Hoort bij: docs/iris/01-ontwerp.md
--
-- ── WAT DIT DOET ────────────────────────────────────────────────────────────
-- Zet elf nieuwe tabellen neer met het voorvoegsel iris_, plus RLS met een
-- rolcheck en een handvol instellingen die allemaal UIT staan. Verder niets:
-- geen kolom die verdwijnt, geen kolom die van naam verandert, geen policy die
-- iets intrekt. Puur toevoegen.
--
-- ── WAAROM EEN LAAG ERBOVEN EN GEEN KOLOMMEN OP BESTAANDE TABELLEN ──────────
-- whatsapp_messages wordt gedeeld door de webhook, de aanmaanmotor, Joost,
-- Simone en de onboarding-agent. Daar een iris_categorie aan hangen betekent
-- dat elke schrijver naar die tabel ineens met Iris te maken krijgt. Een eigen
-- tabel met een unieke bron-sleutel houdt die scheiding hard, en maakt van
-- "wat heeft Iris nog niet gezien?" een indexeerbare vraag
-- (verwerkt_op IS NULL) in plaats van een scan over andermans tabel.
--
-- ── VEILIGHEID ──────────────────────────────────────────────────────────────
-- Elke tabel krijgt RLS aan en een policy op public.is_crm_staff(), conform
-- docs/rls-regels-nieuwe-tabellen.md. Nooit USING (true): handle_new_user()
-- maakt bij elke signup een profiles-rij met rol 'viewer', dus "iedere
-- ingelogde gebruiker" is ook elke student.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────
-- Alles staat achter IF NOT EXISTS / DROP POLICY IF EXISTS / ON CONFLICT DO
-- NOTHING. Opnieuw draaien verandert niets, ook geen instelling die iemand
-- intussen met de hand heeft aangezet.
--
-- ── SUPABASE SQL-EDITOR ─────────────────────────────────────────────────────
-- Die knipt de invoer op statement-grenzen en draait elk statement in een
-- eigen transactie. Daarom staat hier GEEN enkele BEGIN/COMMIT en geen DO-blok
-- dat toestand van een ander blok verwacht. Losse statements, in volgorde.
-- (Zie de waarschuwing in CLAUDE.md over
--  2026-07-17-joost-intent-namen-consolideren.sql.)
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- 1. iris_contacten — wie is dit, en weten we dat zeker?
-- ─────────────────────────────────────────────────────────────────────────────
-- Eén rij per persoon waar Iris contact mee heeft. De koppeling naar customers
-- / onboardings / hlms_student mag ontbreken: dan staat koppelstatus op
-- 'te_bevestigen' of 'onbekend' en wacht er een mens. Iris gokt nooit.
--
-- hlms_student_id heeft met opzet GEEN foreign key: die tabel staat in een
-- ander Supabase-project (dfo-lms). Een FK over projectgrenzen bestaat niet.

CREATE TABLE IF NOT EXISTS public.iris_contacten (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      uuid REFERENCES public.customers(id)   ON DELETE SET NULL,
  onboarding_id    uuid REFERENCES public.onboardings(id) ON DELETE SET NULL,
  hlms_student_id  uuid,
  emails           text[] NOT NULL DEFAULT '{}',
  telefoons        text[] NOT NULL DEFAULT '{}',
  koppelstatus     text NOT NULL DEFAULT 'onbekend'
                     CHECK (koppelstatus IN ('gekoppeld','te_bevestigen','onbekend')),
  koppel_reden     text,
  weergavenaam     text,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_contacten IS
  'Iris: een persoon achter een gesprek. Koppeling naar customers/onboardings/hlms_student mag ontbreken; dan wacht er een mens. Iris gokt nooit.';
COMMENT ON COLUMN public.iris_contacten.hlms_student_id IS
  'Losse verwijzing naar hlms_student in het dfo-lms-project. Geen FK: die tabel staat in een ander Supabase-project.';
COMMENT ON COLUMN public.iris_contacten.emails IS
  'Genormaliseerd: kleine letters, getrimd. Meerdere adressen per persoon komen voor.';
COMMENT ON COLUMN public.iris_contacten.telefoons IS
  'E.164 met een plus ervoor, gelijk aan de conventie in whatsapp_conversations.phone_number.';
COMMENT ON COLUMN public.iris_contacten.koppel_reden IS
  'Waarom deze koppelstatus. Bijvoorbeeld "uniek e-mailadres" of "3 kandidaten op laatste 9 cijfers".';

CREATE INDEX IF NOT EXISTS idx_iris_contacten_customer   ON public.iris_contacten (customer_id)   WHERE customer_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iris_contacten_onboarding ON public.iris_contacten (onboarding_id) WHERE onboarding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iris_contacten_status     ON public.iris_contacten (koppelstatus);
CREATE INDEX IF NOT EXISTS idx_iris_contacten_emails     ON public.iris_contacten USING gin (emails);
CREATE INDEX IF NOT EXISTS idx_iris_contacten_telefoons  ON public.iris_contacten USING gin (telefoons);


-- ─────────────────────────────────────────────────────────────────────────────
-- 2. iris_gesprekken — één draad per persoon per kanaal
-- ─────────────────────────────────────────────────────────────────────────────
-- Waarom naast whatsapp_conversations en niet erin: die status
-- (open/closed/archived) gaat over de postbus. Deze status gaat over het werk —
-- wacht dit op ons of op de klant. Die twee in één kolom persen zou betekenen
-- dat een afgehandeld gesprek niet meer "wacht op klant" kan zijn, en dat kan
-- het wel degelijk.
--
-- extern_uniek is voor WhatsApp 'whatsapp:<conversation_id>' en voor mail
-- 'email:<adres>'. Voor mail is er geen betrouwbaar thread-id in
-- email_messages; adres-per-persoon sluit aan bij hoe inbox-thread-unified.js
-- het nu ook doet.

CREATE TABLE IF NOT EXISTS public.iris_gesprekken (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid REFERENCES public.iris_contacten(id) ON DELETE SET NULL,
  kanaal            text NOT NULL CHECK (kanaal IN ('whatsapp','email')),
  extern_id         text NOT NULL,
  extern_uniek      text NOT NULL UNIQUE,
  categorie         text,
  status            text NOT NULL DEFAULT 'nieuw'
                      CHECK (status IN ('nieuw','wacht_op_ons','wacht_op_klant','belofte_loopt','geregeld')),
  toegewezen_aan    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  laatste_inbound   timestamptz,
  laatste_outbound  timestamptz,
  ongelezen         integer NOT NULL DEFAULT 0,
  aangemaakt_op     timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_gesprekken IS
  'Iris: één draad per persoon per kanaal. Status gaat over het werk (wacht op ons / op de klant), niet over de postbus — dat is whatsapp_conversations.status.';
COMMENT ON COLUMN public.iris_gesprekken.extern_uniek IS
  'whatsapp:<whatsapp_conversations.id> of email:<adres>. UNIQUE, zodat de werk-cron zo vaak mag draaien als hij wil.';
COMMENT ON COLUMN public.iris_gesprekken.laatste_inbound IS
  'Spiegelt whatsapp_conversations.last_inbound_at. De bron voor het servicevenster van 24 uur.';
COMMENT ON COLUMN public.iris_gesprekken.toegewezen_aan IS
  'Maxim of Dave. NULL betekent: Iris houdt het vast, er is nog geen mens aan toegewezen.';

CREATE INDEX IF NOT EXISTS idx_iris_gesprekken_contact  ON public.iris_gesprekken (contact_id);
CREATE INDEX IF NOT EXISTS idx_iris_gesprekken_status   ON public.iris_gesprekken (status, laatste_inbound DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_iris_gesprekken_toegew   ON public.iris_gesprekken (toegewezen_aan) WHERE toegewezen_aan IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iris_gesprekken_venster  ON public.iris_gesprekken (laatste_inbound DESC NULLS LAST);


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. iris_berichten — wat Iris van een bericht weet
-- ─────────────────────────────────────────────────────────────────────────────
-- Het bericht zelf blijft staan waar het staat (whatsapp_messages /
-- email_messages). Dit is de laag erboven: gekoppeld, geclassificeerd,
-- samengevat.
--
-- bron_uniek is de idempotentie-sleutel. De cron mag zo vaak draaien als hij
-- wil; een tweede poging op hetzelfde bericht botst op deze constraint en
-- wordt stil overgeslagen.
--
-- opzeg_klacht_juridisch staat hier als categorie, maar daar kán geen
-- autonomie op — ook niet als iemand de instelling per ongeluk aanzet. Dat
-- wordt in code afgedwongen (_lib/iris/autonomie.js), niet in een instelling.

CREATE TABLE IF NOT EXISTS public.iris_berichten (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bron             text NOT NULL CHECK (bron IN ('whatsapp','email')),
  bron_id          text NOT NULL,
  bron_uniek       text NOT NULL UNIQUE,
  gesprek_id       uuid REFERENCES public.iris_gesprekken(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES public.iris_contacten(id)  ON DELETE SET NULL,
  richting         text NOT NULL CHECK (richting IN ('in','uit')),
  ontvangen_op     timestamptz NOT NULL,
  tekst_kort       text,
  categorie        text CHECK (categorie IS NULL OR categorie IN (
                     'facturatie','betaalafspraak','wanbetaling_reactie',
                     'lms_toegang','lms_support','planning_mentor',
                     'opzeg_klacht_juridisch','bounce_systeem','overig','spam')),
  categorie_reden  text,
  zekerheid        numeric(3,2) CHECK (zekerheid IS NULL OR (zekerheid >= 0 AND zekerheid <= 1)),
  samenvatting     text,
  verwerkt_op      timestamptz,
  verwerk_fout     text,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_berichten IS
  'Iris: wat zij van een bericht weet. Het bericht zelf blijft in whatsapp_messages / email_messages; dit is de laag erboven.';
COMMENT ON COLUMN public.iris_berichten.bron_uniek IS
  'wa:<whatsapp_messages.id> of mail:<email_messages.id>. UNIQUE — dit is de idempotentie-sleutel van de werk-cron.';
COMMENT ON COLUMN public.iris_berichten.verwerkt_op IS
  'NULL betekent: nog niet door Iris bekeken. Dit is de werkvoorraad van cron-iris-werk.';
COMMENT ON COLUMN public.iris_berichten.tekst_kort IS
  'Eerste 500 tekens. Genoeg voor de lijst en voor de prompt; de volledige tekst staat in de brontabel.';

CREATE INDEX IF NOT EXISTS idx_iris_berichten_gesprek  ON public.iris_berichten (gesprek_id, ontvangen_op DESC);
CREATE INDEX IF NOT EXISTS idx_iris_berichten_contact  ON public.iris_berichten (contact_id, ontvangen_op DESC);
CREATE INDEX IF NOT EXISTS idx_iris_berichten_werk     ON public.iris_berichten (ontvangen_op) WHERE verwerkt_op IS NULL;
CREATE INDEX IF NOT EXISTS idx_iris_berichten_cat      ON public.iris_berichten (categorie, ontvangen_op DESC) WHERE categorie IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 4. iris_concepten — het antwoord dat klaarstaat
-- ─────────────────────────────────────────────────────────────────────────────
-- verstuur_na is het ongedaan-venster. Goedkeuren zet status='goedgekeurd' en
-- verstuur_na = now() + 30 seconden. Annuleren vóór dat moment zet
-- 'geannuleerd'. De verzending zelf gebeurt in het goedkeur-verzoek met
-- waitUntil() — niet bij een volgende cron-ronde, want dat zou gemiddeld
-- tweeënhalve minuut vertraging geven en de masterprompt vraagt uitdrukkelijk
-- om "meteen". De cron staat er alleen als vangnet achter voor het geval de
-- functie sneuvelt.

CREATE TABLE IF NOT EXISTS public.iris_concepten (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gesprek_id       uuid NOT NULL REFERENCES public.iris_gesprekken(id) ON DELETE CASCADE,
  bericht_id       uuid REFERENCES public.iris_berichten(id) ON DELETE SET NULL,
  instructie       text,
  instructie_bron  text CHECK (instructie_bron IS NULL OR instructie_bron IN ('spraak','tekst','auto')),
  kanaal           text NOT NULL CHECK (kanaal IN ('whatsapp','email')),
  onderwerp        text,
  tekst            text,
  template_naam    text,
  template_vars    jsonb,
  status           text NOT NULL DEFAULT 'klaar'
                     CHECK (status IN ('klaar','goedgekeurd','verzonden','geannuleerd','mislukt')),
  verstuur_na      timestamptz,
  verzonden_op     timestamptz,
  verzonden_door   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  extern_id        text,
  fout             text,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_concepten IS
  'Iris: een antwoord in voorbereiding. Gaat pas de deur uit als een mens het goedkeurt, of als de autonomie voor die categorie aan staat.';
COMMENT ON COLUMN public.iris_concepten.verstuur_na IS
  'Het ongedaan-venster. Goedkeuren zet dit op now() + 30 seconden; annuleren vóór dat moment kan nog.';
COMMENT ON COLUMN public.iris_concepten.template_naam IS
  'Gevuld wanneer het venster van 24 uur dicht is en er dus een goedgekeurde template moet.';
COMMENT ON COLUMN public.iris_concepten.extern_id IS
  'meta_wamid na een WhatsApp-verzending, of het mail-id na een mail. Zo is een concept terug te vinden in de brontabel.';

CREATE INDEX IF NOT EXISTS idx_iris_concepten_gesprek ON public.iris_concepten (gesprek_id, aangemaakt_op DESC);
CREATE INDEX IF NOT EXISTS idx_iris_concepten_wacht   ON public.iris_concepten (verstuur_na) WHERE status = 'goedgekeurd';
CREATE INDEX IF NOT EXISTS idx_iris_concepten_klaar   ON public.iris_concepten (aangemaakt_op DESC) WHERE status = 'klaar';


-- ─────────────────────────────────────────────────────────────────────────────
-- 5. iris_opdrachten — "Iris, regel dit"
-- ─────────────────────────────────────────────────────────────────────────────
-- na_uitvoeren legt de afsluitkeuze vast: 'wacht' betekent dat er nog iets
-- onverstuurd klaarstaat, 'geregeld' dat het afgerond is. Op "Geregeld" drukken
-- terwijl er nog iets klaarstaat moet expliciet vragen wat ermee moet. Er
-- verdwijnt nooit iets stil.

CREATE TABLE IF NOT EXISTS public.iris_opdrachten (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vraag            text NOT NULL,
  titel            text,
  plan             jsonb NOT NULL DEFAULT '[]'::jsonb,
  status           text NOT NULL DEFAULT 'gevraagd'
                     CHECK (status IN ('gevraagd','uitzoeken','wacht_op_ok','uitgevoerd',
                                       'wacht_op_antwoord','geregeld','afgebroken')),
  vraag_aan_maxim  text,
  opties           jsonb,
  antwoord_maxim   text,
  na_uitvoeren     text CHECK (na_uitvoeren IS NULL OR na_uitvoeren IN ('wacht','geregeld')),
  verloop          jsonb NOT NULL DEFAULT '[]'::jsonb,
  aangemaakt_door  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_opdrachten IS
  'Iris: een opdracht die Maxim insprak of typte, met een zichtbaar plan en een verloop van wie wat deed.';
COMMENT ON COLUMN public.iris_opdrachten.vraag_aan_maxim IS
  'Eén duidelijke vraag als er iets ontbreekt. Eén, niet drie — anders wordt het een formulier.';
COMMENT ON COLUMN public.iris_opdrachten.verloop IS
  'Array van {op, wie, wat}. Het spoor dat maakt dat er nooit iets stil verdwijnt.';

CREATE INDEX IF NOT EXISTS idx_iris_opdrachten_status ON public.iris_opdrachten (status, aangemaakt_op DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- 6. iris_acties — de uitvoerbare stap
-- ─────────────────────────────────────────────────────────────────────────────
-- idempotentie is UNIQUE. Een dubbele klik botst op de constraint; het endpoint
-- vangt dat op als "al gedaan" en geeft de bestaande rij terug. Dat is het
-- enige waterdichte antwoord op dubbelklikken — een uitgeschakelde knop niet,
-- want het eerste verzoek kan al onderweg zijn.
--
-- Let op wat er NIET in de lijst staat: blokkeren en toegang intrekken. Die
-- actietypes bestaan met opzet niet. Iris kan het dus niet, ook niet per
-- ongeluk. Zij stelt het voor en een mens drukt.

CREATE TABLE IF NOT EXISTS public.iris_acties (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opdracht_id      uuid REFERENCES public.iris_opdrachten(id) ON DELETE CASCADE,
  concept_id       uuid REFERENCES public.iris_concepten(id)  ON DELETE SET NULL,
  contact_id       uuid REFERENCES public.iris_contacten(id)  ON DELETE SET NULL,
  type             text NOT NULL CHECK (type IN (
                     'wa_versturen','mail_versturen',
                     'lms_toegang_verlengen','lms_uitnodiging','lms_on_hold',
                     'belofte_vastleggen','afbetalingsplan',
                     'taak_aanmaken','belrij_toevoegen','factuur_nakijken')),
  parameters       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'klaar'
                     CHECK (status IN ('klaar','goedgekeurd','uitgevoerd','mislukt','geannuleerd')),
  idempotentie     text NOT NULL UNIQUE,
  uitgevoerd_door  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  uitgevoerd_op    timestamptz,
  resultaat        jsonb,
  fout             text,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_acties IS
  'Iris: één uitvoerbare stap. Blokkeren en toegang intrekken staan met opzet NIET in de typelijst — die kan Iris dus niet, ook niet per ongeluk.';
COMMENT ON COLUMN public.iris_acties.idempotentie IS
  'UNIQUE. Een dubbele klik botst hierop; het endpoint geeft dan de bestaande rij terug als "al gedaan".';

CREATE INDEX IF NOT EXISTS idx_iris_acties_opdracht ON public.iris_acties (opdracht_id);
CREATE INDEX IF NOT EXISTS idx_iris_acties_open     ON public.iris_acties (aangemaakt_op) WHERE status IN ('klaar','goedgekeurd');


-- ─────────────────────────────────────────────────────────────────────────────
-- 7. iris_beloftes — "ik betaal vrijdag"
-- ─────────────────────────────────────────────────────────────────────────────
-- Tot de datum stuurt Iris niets over die facturen. De aanmaanmotor gaat pas
-- zwijgen zodra IRIS_PAUZEERT_JOOST aan staat (fase 6, aparte PR). Zolang dat
-- niet zo is, toont de UI bij elke belofte met zoveel woorden: "let op, de
-- automatische aanmaningen lopen nog door".

CREATE TABLE IF NOT EXISTS public.iris_beloftes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id       uuid NOT NULL REFERENCES public.iris_contacten(id) ON DELETE CASCADE,
  customer_id      uuid REFERENCES public.customers(id) ON DELETE SET NULL,
  factuur_ids      uuid[] NOT NULL DEFAULT '{}',
  bedrag           numeric(12,2),
  datum            date NOT NULL,
  status           text NOT NULL DEFAULT 'actief'
                     CHECK (status IN ('actief','nagekomen','gebroken','geannuleerd')),
  bron             text NOT NULL DEFAULT 'iris'
                     CHECK (bron IN ('klant','maxim','dave','iris')),
  notitie          text,
  aangemaakt_door  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now(),
  afgehandeld_op   timestamptz
);

COMMENT ON TABLE public.iris_beloftes IS
  'Iris: een betaaltoezegging met datum. Tot die datum zwijgt Iris over die facturen. Naast (niet in plaats van) de bestaande MANUAL_CONFIRM_PROMISE-taken van de aanmaanmotor.';
COMMENT ON COLUMN public.iris_beloftes.customer_id IS
  'Losgetrokken uit het contact zodat de Joost-pauzepoort (fase 6) kan opzoeken op klant zonder een join over iris_contacten.';

CREATE INDEX IF NOT EXISTS idx_iris_beloftes_actief   ON public.iris_beloftes (datum) WHERE status = 'actief';
CREATE INDEX IF NOT EXISTS idx_iris_beloftes_customer ON public.iris_beloftes (customer_id) WHERE status = 'actief';


-- ─────────────────────────────────────────────────────────────────────────────
-- 8. iris_belrij + iris_belpogingen — wie moet er gebeld worden
-- ─────────────────────────────────────────────────────────────────────────────
-- Eigen telling, naast opvolging_pogingen. Die blijft van Dave; hier raken we
-- hem niet aan.
--
-- dagen_met_poging staat er los van pogingen_totaal omdat de escalatieregel
-- luidt: N niet-opgenomen pogingen op M VERSCHILLENDE dagen. Twee pogingen op
-- één dag zijn niet twee dagen.

CREATE TABLE IF NOT EXISTS public.iris_belrij (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid NOT NULL REFERENCES public.iris_contacten(id) ON DELETE CASCADE,
  reden             text NOT NULL,
  reden_detail      text,
  eigenaar          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  prioriteit        integer NOT NULL DEFAULT 50,
  status            text NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','bezig','gedaan','vervallen')),
  bron              text NOT NULL DEFAULT 'hand'
                      CHECK (bron IN ('wanbetaler','onboarding','mentorsignaal','geen_reactie','hand')),
  laatste_poging_op timestamptz,
  pogingen_totaal   integer NOT NULL DEFAULT 0,
  dagen_met_poging  integer NOT NULL DEFAULT 0,
  aangemaakt_op     timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_op     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_belrij IS
  'Iris: wie er gebeld moet worden, door wie en waarom. Eigen telling naast opvolging_taken — die blijft van Dave en wordt hier niet aangeraakt.';
COMMENT ON COLUMN public.iris_belrij.dagen_met_poging IS
  'Aantal VERSCHILLENDE dagen waarop geprobeerd is. Staat los van pogingen_totaal, want twee pogingen op één dag zijn niet twee dagen.';

CREATE INDEX IF NOT EXISTS idx_iris_belrij_open ON public.iris_belrij (eigenaar, prioriteit DESC, aangemaakt_op) WHERE status IN ('open','bezig');

CREATE TABLE IF NOT EXISTS public.iris_belpogingen (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  belrij_id               uuid REFERENCES public.iris_belrij(id)    ON DELETE CASCADE,
  contact_id              uuid NOT NULL REFERENCES public.iris_contacten(id) ON DELETE CASCADE,
  call_log_id             uuid REFERENCES public.call_log(id)       ON DELETE SET NULL,
  uitkomst                text NOT NULL
                            CHECK (uitkomst IN ('gesproken','niet_opgenomen','voicemail','bezet','mislukt')),
  afgebroken_voor_opname  boolean NOT NULL DEFAULT false,
  duur_sec                integer,
  notitie                 text,
  notitie_bron            text CHECK (notitie_bron IS NULL OR notitie_bron IN ('spraak','tekst')),
  gebeld_door             uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  gebeld_op               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_belpogingen IS
  'Iris: één belpoging. Gekoppeld aan call_log zodat de softphone de bron blijft.';
COMMENT ON COLUMN public.iris_belpogingen.afgebroken_voor_opname IS
  'Een call die werd afgebroken vóór er opgenomen was. Telt NOOIT als poging. Komt uit call_log.outcome_hint = local_cancel.';
COMMENT ON COLUMN public.iris_belpogingen.duur_sec IS
  'Onbetrouwbaar. Nooit leidend voor de vraag of er contact was — daarvoor telt uitkomst.';

CREATE INDEX IF NOT EXISTS idx_iris_belpogingen_belrij  ON public.iris_belpogingen (belrij_id, gebeld_op DESC);
CREATE INDEX IF NOT EXISTS idx_iris_belpogingen_contact ON public.iris_belpogingen (contact_id, gebeld_op DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- 9. iris_signalen — wat de mentoren melden
-- ─────────────────────────────────────────────────────────────────────────────
-- Kopie van hlms_signaal uit het dfo-lms-project, plus de mentorupdates uit het
-- CRM. bron_id is UNIQUE zodat de synchronisatie zo vaak mag draaien als ze wil.

CREATE TABLE IF NOT EXISTS public.iris_signalen (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bron_id          text NOT NULL UNIQUE,
  bron_systeem     text NOT NULL DEFAULT 'dfo_lms'
                     CHECK (bron_systeem IN ('dfo_lms','crm')),
  contact_id       uuid REFERENCES public.iris_contacten(id) ON DELETE SET NULL,
  type             text NOT NULL,
  mentor_naam      text,
  toelichting      text,
  gevraagde_actie  text,
  signaal_op       timestamptz NOT NULL,
  verwerkt_op      timestamptz,
  aangemaakt_op    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.iris_signalen IS
  'Iris: kopie van de mentorsignalen uit het LMS. Lezen alleen — het LMS wordt vanuit deze module nooit beschreven.';
COMMENT ON COLUMN public.iris_signalen.bron_id IS
  'UNIQUE. hlms_signaal.id of onboarding_mentor_updates.id, met een prefix per bronsysteem.';
COMMENT ON COLUMN public.iris_signalen.type IS
  'Vrije tekst met opzet: het LMS kent vandaag nog niet alle types die we willen (uitstel / reageert_niet / halt). Een CHECK zou de synchronisatie laten breken op een type dat het LMS morgen toevoegt. Zie docs/iris/lms-signaalcontract.md.';

CREATE INDEX IF NOT EXISTS idx_iris_signalen_open    ON public.iris_signalen (signaal_op DESC) WHERE verwerkt_op IS NULL;
CREATE INDEX IF NOT EXISTS idx_iris_signalen_contact ON public.iris_signalen (contact_id, signaal_op DESC);


-- ─────────────────────────────────────────────────────────────────────────────
-- 10. iris_instellingen — alles staat uit
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.iris_instellingen (
  sleutel          text PRIMARY KEY,
  waarde           jsonb NOT NULL,
  omschrijving     text,
  bijgewerkt_op    timestamptz NOT NULL DEFAULT now(),
  bijgewerkt_door  uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.iris_instellingen IS
  'Iris: schakelaars. Alles staat bij aanvang uit; Maxim zet per categorie aan zodra hij het vertrouwt.';


-- ─────────────────────────────────────────────────────────────────────────────
-- 11. iris_log
-- ─────────────────────────────────────────────────────────────────────────────
-- PRIVACY: hier komen GEEN volledige telefoonnummers en GEEN berichtteksten in.
-- Alleen id's, tellingen en korte omschrijvingen. Dezelfde regel die de
-- opvolgbrug al hanteert.

CREATE TABLE IF NOT EXISTS public.iris_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wanneer      timestamptz NOT NULL DEFAULT now(),
  wie          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  wat          text NOT NULL,
  contact_id   uuid REFERENCES public.iris_contacten(id) ON DELETE SET NULL,
  gesprek_id   uuid REFERENCES public.iris_gesprekken(id) ON DELETE SET NULL,
  kanaal       text,
  resultaat    text,
  fout         text,
  details      jsonb
);

COMMENT ON TABLE public.iris_log IS
  'Iris: elke actie. GEEN volledige telefoonnummers en GEEN berichtteksten — alleen id''s, tellingen en korte omschrijvingen.';
COMMENT ON COLUMN public.iris_log.wie IS
  'NULL betekent: Iris zelf deed dit, er was geen mens bij.';

CREATE INDEX IF NOT EXISTS idx_iris_log_wanneer ON public.iris_log (wanneer DESC);
CREATE INDEX IF NOT EXISTS idx_iris_log_contact ON public.iris_log (contact_id, wanneer DESC);
CREATE INDEX IF NOT EXISTS idx_iris_log_fout    ON public.iris_log (wanneer DESC) WHERE fout IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- 12. RLS — elke tabel dicht, met een rolcheck
-- ─────────────────────────────────────────────────────────────────────────────
-- Conform docs/rls-regels-nieuwe-tabellen.md. Schrijven gaat in de praktijk via
-- supabaseAdmin in de endpoints (die RLS omzeilt); deze policies zijn de
-- ondergrens voor wie rechtstreeks via PostgREST leest.

ALTER TABLE public.iris_contacten    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_gesprekken   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_berichten    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_concepten    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_opdrachten   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_acties       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_beloftes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_belrij       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_belpogingen  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_signalen     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_instellingen ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iris_log          ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS iris_contacten_staff    ON public.iris_contacten;
CREATE POLICY iris_contacten_staff    ON public.iris_contacten    FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_gesprekken_staff   ON public.iris_gesprekken;
CREATE POLICY iris_gesprekken_staff   ON public.iris_gesprekken   FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_berichten_staff    ON public.iris_berichten;
CREATE POLICY iris_berichten_staff    ON public.iris_berichten    FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_concepten_staff    ON public.iris_concepten;
CREATE POLICY iris_concepten_staff    ON public.iris_concepten    FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_opdrachten_staff   ON public.iris_opdrachten;
CREATE POLICY iris_opdrachten_staff   ON public.iris_opdrachten   FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_acties_staff       ON public.iris_acties;
CREATE POLICY iris_acties_staff       ON public.iris_acties       FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_beloftes_staff     ON public.iris_beloftes;
CREATE POLICY iris_beloftes_staff     ON public.iris_beloftes     FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_belrij_staff       ON public.iris_belrij;
CREATE POLICY iris_belrij_staff       ON public.iris_belrij       FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_belpogingen_staff  ON public.iris_belpogingen;
CREATE POLICY iris_belpogingen_staff  ON public.iris_belpogingen  FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_signalen_staff     ON public.iris_signalen;
CREATE POLICY iris_signalen_staff     ON public.iris_signalen     FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_instellingen_staff ON public.iris_instellingen;
CREATE POLICY iris_instellingen_staff ON public.iris_instellingen FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

DROP POLICY IF EXISTS iris_log_staff          ON public.iris_log;
CREATE POLICY iris_log_staff          ON public.iris_log          FOR ALL TO authenticated USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());


-- ─────────────────────────────────────────────────────────────────────────────
-- 13. De instellingen, allemaal uit
-- ─────────────────────────────────────────────────────────────────────────────
-- ON CONFLICT DO NOTHING: opnieuw draaien overschrijft nooit iets wat Maxim
-- intussen heeft aangezet. Dat is precies de fout die
-- 2026-07-17-joost-intent-namen-consolideren.sql wél maakte.

INSERT INTO public.iris_instellingen (sleutel, waarde, omschrijving) VALUES
  ('autonomie', '{
      "facturatie":             "uit",
      "betaalafspraak":         "uit",
      "wanbetaling_reactie":    "uit",
      "lms_toegang":            "uit",
      "lms_support":            "uit",
      "planning_mentor":        "uit",
      "opzeg_klacht_juridisch": "uit",
      "bounce_systeem":         "uit",
      "overig":                 "uit",
      "spam":                   "uit"
   }'::jsonb,
   'Per categorie: uit / concept / zelf. Alles staat uit. opzeg_klacht_juridisch kan nooit op "zelf" — dat wordt in code geweigerd, ongeacht wat hier staat.')
ON CONFLICT (sleutel) DO NOTHING;

INSERT INTO public.iris_instellingen (sleutel, waarde, omschrijving) VALUES
  ('escalatie', '{"pogingen": 3, "dagen": 3}'::jsonb,
   'Na hoeveel niet-opgenomen pogingen, op hoeveel verschillende dagen, Iris zelf een WhatsApp en een mail stuurt.')
ON CONFLICT (sleutel) DO NOTHING;

INSERT INTO public.iris_instellingen (sleutel, waarde, omschrijving) VALUES
  ('stille_uren', '{"van": "21:00", "tot": "08:00", "zondag_stil": true, "tijdzone": "Europe/Brussels"}'::jsonb,
   'Geen automatische berichten tussen deze uren, en niet op zondag.')
ON CONFLICT (sleutel) DO NOTHING;

INSERT INTO public.iris_instellingen (sleutel, waarde, omschrijving) VALUES
  ('dosering', '{"max_per_minuut": 6, "max_per_uur": 60, "max_per_dag_per_persoon": 2}'::jsonb,
   'Doseerlimieten. Strato knijpt af bij bulk (421/450) en Meta straft herhaalde templates naar mensen die niet reageren.')
ON CONFLICT (sleutel) DO NOTHING;

INSERT INTO public.iris_instellingen (sleutel, waarde, omschrijving) VALUES
  ('mailboxen', '{
      "lezen": ["administratie", "info", "onboarding"],
      "afzender_per_categorie": {
        "facturatie":          "administratie@deforexopleiding.nl",
        "betaalafspraak":      "administratie@deforexopleiding.nl",
        "wanbetaling_reactie": "administratie@deforexopleiding.nl",
        "lms_toegang":         "onboarding@deforexopleiding.nl",
        "lms_support":         "onboarding@deforexopleiding.nl",
        "planning_mentor":     "onboarding@deforexopleiding.nl"
      },
      "standaard": "administratie@deforexopleiding.nl"
   }'::jsonb,
   'Welke mailboxen Iris leest en van welk adres ze antwoordt. Standaard is het adres waar de klant eerder mee mailde; dit is de terugval.')
ON CONFLICT (sleutel) DO NOTHING;

INSERT INTO public.iris_instellingen (sleutel, waarde, omschrijving) VALUES
  ('model', '{"redeneren": "claude-sonnet-4-5", "transcriptie": "gpt-4o-transcribe", "temperatuur": 0.3}'::jsonb,
   'Welk model waarvoor. Instelbaar zodat een modelwissel geen code-wijziging is.')
ON CONFLICT (sleutel) DO NOTHING;

INSERT INTO public.iris_instellingen (sleutel, waarde, omschrijving) VALUES
  ('ongedaan_seconden', '30'::jsonb,
   'Hoeveel seconden een verstuurd bericht nog tegengehouden kan worden.')
ON CONFLICT (sleutel) DO NOTHING;


-- ─────────────────────────────────────────────────────────────────────────────
-- 14. Nakijken
-- ─────────────────────────────────────────────────────────────────────────────
-- Draai dit na afloop; het hoort 12 tabellen, 12 policies en 7 instellingen te
-- geven.
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema='public' AND table_name LIKE 'iris\_%' ORDER BY 1;
--
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname='public' AND tablename LIKE 'iris\_%' ORDER BY 1;
--
--   SELECT c.relname, c.relrowsecurity FROM pg_class c
--     JOIN pg_namespace n ON n.oid=c.relnamespace
--    WHERE n.nspname='public' AND c.relname LIKE 'iris\_%' ORDER BY 1;
--     -- relrowsecurity moet overal t zijn
--
--   SELECT sleutel, waarde FROM public.iris_instellingen ORDER BY sleutel;
