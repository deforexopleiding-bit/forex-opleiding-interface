-- ============================================================================
-- Opvolging — het WhatsApp-gesprek in het CRM zelf
-- Datum: 2026-09-05
-- Branch: feat/opvolging-whatsapp-gesprek
--
-- ⚠ BLOKKEREND. api/opvolging-whatsapp-webhook.js en
-- api/opvolging-whatsapp-gesprek.js noemen deze tabel bij naam. Draait deze
-- migratie niet, dan faalt het gesprekspaneel met een tabel-die-niet-bestaat.
-- De webhook zelf blijft wél werken: het wegschrijven van een berichtrij is
-- daar fail-soft, zodat de poging-telling (de bestaande functie) niet omvalt
-- over een migratie die nog moet draaien. Zie de code voor de precieze grens.
--
-- ── WAAROM EEN EIGEN TABEL ──────────────────────────────────────────────────
-- `opvolging_pogingen` is de TELLING: één rij per gebeurtenis, en daarop rust
-- het oordeel in Afgerond over hoeveel moeite er gedaan is. Dat is iets anders
-- dan het GESPREK. Tot nu toe werd de tekst van een inkomend bericht in
-- `resultaat` geplakt ('antwoord ontvangen: hoi, ik kom morgen'), en dat is op
-- drie manieren de verkeerde plek:
--
--   1. `resultaat` is 500 tekens en wordt afgekapt; een gesprek niet.
--   2. Er is geen kolom voor richting — die zit verstopt in de woordkeuze
--      ('verstuurd' tegenover 'ontvangen'). Een gesprek uit twee kanten
--      opbouwen door tekst te parseren gaat een keer mis.
--   3. Eén verstuurd bericht kan meerdere pogingrijen raken (verzonden,
--      afgeleverd, gelezen). Als gespreksregel hoort het er één te zijn.
--
-- Vandaar deze tabel ernaast. `opvolging_pogingen` blijft ongemoeid: dat is de
-- telling, dit is het gesprek.
--
-- ── HET PRIVACYFILTER BLIJFT DE EERSTE REGEL ────────────────────────────────
-- Hier komt alleen in wat de brug doorlaat, en de brug laat alleen door wat op
-- de leadlijst staat. Daves privégesprekken bereiken deze tabel dus niet — niet
-- omdat we ze hier wegfilteren, maar omdat ze de VPS nooit verlaten. Groepen
-- ook niet. Die grens ligt in services/whatsapp-brug/lib/whatsapp.js, vóór er
-- ook maar een object gebouwd wordt, en dat is de enige plek waar hij hoort.
--
-- ── GEEN HISTORIEK VAN VOOR VANDAAG ─────────────────────────────────────────
-- Deze tabel begint leeg. Er is geen bron om uit terug te vullen: de tekst van
-- uitgaande berichten verliet de telefoon tot nu toe niet, en van inkomende
-- staat alleen een afgekapte kopie in `resultaat`. Het paneel zegt dat met
-- zoveel woorden in plaats van een leeg gesprek te tonen alsof er niets gezegd
-- is.
--
-- Idempotent: `if not exists` overal.
-- ============================================================================

create table if not exists public.opvolging_wa_berichten (
  id          uuid primary key default gen_random_uuid(),
  nummer      text not null,                 -- genormaliseerd, alleen cijfers
  taak_id     uuid references public.opvolging_taken(id) on delete set null,
  richting    text not null,
  tekst       text,
  media_type  text,                          -- 'chat', 'ptt', 'image', …
  bericht_id  text,                          -- WhatsApp-id; de idempotency-sleutel
  tijdstip    timestamptz not null default now(),
  created_at  timestamptz not null default now(),
  constraint opvolging_wa_berichten_richting_chk check (richting in ('in', 'uit'))
);

-- Uniek op bericht_id: de brug herkanst, en hetzelfde bericht twee keer in het
-- gesprek zetten leest als een dubbel verstuurd bericht. NULL mag meerdere
-- keren (Postgres telt NULLs niet als gelijk) — een bericht zonder id is
-- zeldzaam en dan is één regel te veel beter dan een regel te weinig.
create unique index if not exists opvolging_wa_berichten_bericht_idx
  on public.opvolging_wa_berichten (bericht_id)
  where bericht_id is not null;

-- Het gesprek wordt altijd per nummer of per taak opgehaald, oplopend op tijd.
create index if not exists opvolging_wa_berichten_nummer_idx
  on public.opvolging_wa_berichten (nummer, tijdstip);
create index if not exists opvolging_wa_berichten_taak_idx
  on public.opvolging_wa_berichten (taak_id, tijdstip)
  where taak_id is not null;

-- ── RLS volgens docs/rls-regels-nieuwe-tabellen.md ──────────────────────────
-- Het normale geval: CRM-data, dus is_crm_staff(). Nooit USING (true) — een
-- tabel met gespreksinhoud is wel de laatste waar een viewer-rol in hoort mee
-- te kunnen lezen.
alter table public.opvolging_wa_berichten enable row level security;

drop policy if exists opvolging_wa_berichten_staff on public.opvolging_wa_berichten;
create policy opvolging_wa_berichten_staff
  on public.opvolging_wa_berichten
  for all
  to authenticated
  using      (public.is_crm_staff())
  with check (public.is_crm_staff());

comment on table public.opvolging_wa_berichten is
  'Het WhatsApp-gesprek per lead, zodat het in het CRM te lezen en te beantwoorden is. Bevat alleen nummers van de leadlijst — het privacyfilter in de brug is de eerste regel. opvolging_pogingen blijft de telling; dit is het gesprek.';
comment on column public.opvolging_wa_berichten.richting is
  '''in'' = van de lead naar ons, ''uit'' = van ons naar de lead.';
comment on column public.opvolging_wa_berichten.bericht_id is
  'Het WhatsApp-id. Uniek waar gevuld, zodat een herkans van de brug geen tweede regel oplevert.';

-- ── Controle achteraf ───────────────────────────────────────────────────────
--   select relrowsecurity from pg_class where relname = 'opvolging_wa_berichten';
--   -- verwacht: t
--   select polname, polcmd from pg_policy
--    where polrelid = 'public.opvolging_wa_berichten'::regclass;
--   -- verwacht: opvolging_wa_berichten_staff | *
