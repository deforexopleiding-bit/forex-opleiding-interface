-- 2026-09-20 — OPKUIS: bestaande telefoonnummers naar E.164
--
-- ══════════════════════════════════════════════════════════════════════════
--  WAAROM
-- ══════════════════════════════════════════════════════════════════════════
--  Gemeten over alle event_automation_run_log-stappen van het type
--  send_whatsapp:
--
--    Vragenlijst-herinnering     10 gelukt /  64 mislukt
--    Welkom + vragenlijst       131        /  38
--    Reminder laatste uren       70        /  38
--    Bevestiging aanmelding     109        /  16
--    Reminder 24u               131        /  16
--    Warmup vroeg                63        /  14
--    Geen gehoor                  1        /   0
--                                          ─────
--                                            186 nooit aangekomen
--
--  PR #1624 heeft de voordeur dicht: nieuwe nummers worden bij de invoer
--  genormaliseerd of geweigerd. De BESTAANDE rijen staan er nog, en dat is
--  wat dit bestand rechtzet.
--
-- ══════════════════════════════════════════════════════════════════════════
--  ⚠ WAT DIT BESTAND WEL EN NIET DOET — LEES DIT VOOR JE DRUKT
-- ══════════════════════════════════════════════════════════════════════════
--  STAP 2 zet automatisch de 140 rijen recht die PURE OPMAAK zijn: spaties,
--  streepjes, punten en haakjes eruit, en dan is het nummer al geldig E.164.
--  Daar wordt NIETS geraden — de landcode stond er al.
--
--  STAP 4 en 5 zetten NIETS. Die lijsten 18 rijen op die een menselijke blik
--  nodig hebben, met per rij de reden. Voor 15 daarvan staat er een
--  kant-en-klare UPDATE klaar die je per rij kunt uitvoeren nadat je gekeken
--  hebt.
--
--  DAT IS EEN AFWIJKING VAN DE OPDRACHT (155 automatisch), EN DIT IS WAAROM.
--
-- ══════════════════════════════════════════════════════════════════════════
--  DE 11 BELGISCHE GSM-NUMMERS ZIJN NIET EENDUIDIG
-- ══════════════════════════════════════════════════════════════════════════
--  De opdracht zegt: gebruik dezelfde regels als normaliseerStrict in
--  api/_lib/phone-e164.js, en wijkt de SQL daarvan af dan is dat een bug in
--  wording. Dat is precies de reden dat deze 15 rijen hier NIET automatisch
--  omgezet worden: normaliseerStrict WEIGERT een kale 0-prefix, omdat er geen
--  landcode uit af te leiden is.
--
--  Concreet, en dit is hetzelfde argument als dat van 040/Eindhoven:
--  Nederlandse nummers zijn 10 cijfers inclusief de 0, en Nederland heeft
--  netnummers die beginnen met 04:
--
--    0475xxxxxx   Roermond (NL, vast)      ⟷  0475xxxxxx  België (gsm)
--    0478xxxxxx   Venray   (NL, vast)      ⟷  0478xxxxxx  België (gsm)
--    045xxxxxxx   Heerlen  (NL, vast)      ⟷  0455-0459   België (gsm)
--    046xxxxxxx   Sittard  (NL, vast)      ⟷  046x        België (gsm)
--
--  Dezelfde tien cijfers, twee landen. Een blanco regel `04[5-9] → +32` zet
--  dus een vast nummer in Roermond om in een Belgisch gsm-nummer, en dan gaat
--  er een WhatsApp met iemands eventgegevens naar een wildvreemde. Dat is de
--  fout die we bij de invoer met opzet niet maken; hier met terugwerkende
--  kracht wél maken zou vreemd zijn.
--
--  Niet elk van de 11 botst: 0472 bijvoorbeeld bestaat niet als Nederlands
--  netnummer, dus die is wél eenduidig Belgisch. Maar welke van de 11 dat
--  zijn kan ik niet zien zonder de nummers, en STAP 4 zet ze daarom naast
--  elkaar met de botsing erbij. Eén blik per rij en je bent klaar.
--
--  DE 4 NEDERLANDSE GSM-NUMMERS (06…) zijn wél eenduidig binnen NL/BE —
--  België heeft geen 06-prefix. Ze staan tóch in de handmatige lijst, want
--  automatisch omzetten zou betekenen dat de SQL een regel kent die
--  normaliseerStrict niet heeft, en dat is exact de divergentie die de
--  opdracht verbiedt. Wil je die regel structureel, dan hoort hij in
--  api/_lib/phone-e164.js met zijn eigen tests (en met een uitzonderingslijst
--  voor de botsende NL-netnummers) — een aparte PR, geen stille SQL-regel.
--
-- ══════════════════════════════════════════════════════════════════════════
--  VEILIGHEID
-- ══════════════════════════════════════════════════════════════════════════
--   · Raakt ALLEEN rijen die nu NIET aan ^\+[1-9][0-9]{7,14}$ voldoen en er
--     ná de omzetting WEL aan voldoen. Een bestaand geldig nummer wordt nooit
--     aangeraakt — dat staat letterlijk in de WHERE.
--   · Geen DELETE, geen schema-wijziging, geen kolom erbij.
--   · Idempotent: een tweede keer draaien raakt 0 rijen, want na stap 2
--     voldoet de rij al aan de regex en valt hij uit de WHERE.
--   · STAP 1 en 3 zijn de telling vóór en ná. Draai ze in die volgorde en
--     bewaar de uitkomst.
--
--  TERUGDRAAIEN: stap 2 bewaart de oude waarde niet. Wil je een vangnet, run
--  dan eerst STAP 0 — die maakt een kopietabel. Aanrader, kost niets.
--
-- ══════════════════════════════════════════════════════════════════════════
--  HOE JE DIT DRAAIT
-- ══════════════════════════════════════════════════════════════════════════
--    STAP 0  (optioneel, aangeraden)  back-up van de te wijzigen rijen
--    STAP 1  telling VOOR             → bewaren
--    STAP 2  de omzetting             → meldt hoeveel rijen
--    STAP 3  telling NA               → vergelijken met stap 1
--    STAP 4  de 15 twijfelgevallen    → per rij nakijken
--    STAP 5  de 3 handwerk-gevallen   → met de hand
--
--  Elk statement staat los. De Supabase-editor knipt input op
--  statement-grenzen (elk statement een eigen transactie), dus er is met
--  opzet geen enkele DO-block die state van een andere verwacht.


-- ══════════════════════════════════════════════════════════════════════════
--  DE OMZETTING, LETTERLIJK DIE VAN normaliseerStrict
-- ══════════════════════════════════════════════════════════════════════════
--  api/_lib/phone-e164.js doet precies dit, in deze volgorde:
--
--    1. _schoon()  → spaties, streepjes, haakjes en punten eruit
--    2. begint met '+'   → gebruik zoals het is
--    3. begint met '00'  → '+' plus alles vanaf het derde teken
--    4. anders           → WEIGEREN (geen landcode af te leiden)
--    5. en altijd: alleen goedkeuren als het resultaat aan
--                  ^\+[1-9][0-9]{7,14}$ voldoet
--
--  In SQL is dat:
--
--    schoon    := regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g')
--    kandidaat := CASE WHEN schoon LIKE '+%'  THEN schoon
--                      WHEN schoon LIKE '00%' THEN '+' || substring(schoon from 3)
--                      ELSE NULL END
--
--  Stap 4 van de code (weigeren) is hier `ELSE NULL`, en NULL valt overal uit
--  de WHERE. Zo kan deze migratie per constructie geen kale 0-prefix omzetten,
--  ook niet per ongeluk.
--
--  Die twee regels staan hieronder in elk statement opnieuw uitgeschreven in
--  plaats van in een view of functie. Dat is bewust: een view is een
--  schemawijziging, en de Supabase-editor knipt input op statement-grenzen,
--  dus niets mag afhangen van iets wat een vorig statement heeft aangemaakt.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 0 — BACK-UP (optioneel, aangeraden)
-- ══════════════════════════════════════════════════════════════════════════
-- Bewaart id + het oude nummer van elke rij die stap 2 gaat aanraken.
-- Terugzetten: UPDATE event_attendees a SET phone = b.phone_oud
--              FROM _backup_phone_20260920 b WHERE b.id = a.id;

CREATE TABLE IF NOT EXISTS public._backup_phone_20260920 AS
SELECT id, phone AS phone_oud, now() AS gemaakt_op
  FROM public.event_attendees
 WHERE phone IS NOT NULL
   AND phone !~ '^\+[1-9][0-9]{7,14}$'
   AND (CASE
          WHEN regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g') LIKE '+%'
            THEN regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g')
          WHEN regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g') LIKE '00%'
            THEN '+' || substring(regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g') from 3)
          ELSE NULL
        END) ~ '^\+[1-9][0-9]{7,14}$';

-- RLS OP DE BACK-UP. Dit is geen formaliteit: die tabel bevat telefoonnummers
-- van klanten, dus PII, en Postgres zet RLS standaard UIT — wat in Supabase
-- betekent dat de tabel met de anon-sleutel via PostgREST te lezen is. Precies
-- het lek van augustus 2026.
--
-- GEEN policies erbij, en dat is de bedoeling: alleen de service-role komt
-- erbij. De SQL-editor draait als service-role, dus jij kunt hem gewoon lezen
-- en gebruiken om terug te zetten; de browser kan er niet bij.
ALTER TABLE public._backup_phone_20260920 ENABLE ROW LEVEL SECURITY;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 1 — TELLING VOOR
-- ══════════════════════════════════════════════════════════════════════════
-- `opmaak_te_fixen` is het getal dat stap 2 gaat rechtzetten (verwacht: 140).
-- `blijft_staan` zijn de rijen die een mens nodig hebben (verwacht: 18).

SELECT
  count(*)                                                    AS met_nummer,
  count(*) FILTER (WHERE phone ~ '^\+[1-9][0-9]{7,14}$')      AS nu_al_geldig,
  count(*) FILTER (WHERE phone !~ '^\+[1-9][0-9]{7,14}$')     AS nu_fout,
  count(*) FILTER (WHERE phone !~ '^\+[1-9][0-9]{7,14}$'
                     AND kandidaat ~ '^\+[1-9][0-9]{7,14}$')  AS opmaak_te_fixen,
  count(*) FILTER (WHERE phone !~ '^\+[1-9][0-9]{7,14}$'
                     AND (kandidaat IS NULL
                          OR kandidaat !~ '^\+[1-9][0-9]{7,14}$'))
                                                              AS blijft_staan_voor_de_mens
FROM (
  SELECT phone,
         CASE WHEN schoon LIKE '+%'  THEN schoon
              WHEN schoon LIKE '00%' THEN '+' || substring(schoon from 3)
              ELSE NULL END AS kandidaat
    FROM (
      SELECT phone,
             regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g') AS schoon
        FROM public.event_attendees
       WHERE is_test = false AND phone IS NOT NULL AND btrim(phone) <> ''
    ) x
) y;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 2 — DE OMZETTING
-- ══════════════════════════════════════════════════════════════════════════
-- Verwacht: 140 rijen. Wijkt dat sterk af van `opmaak_te_fixen` uit stap 1,
-- dan is er tussen de twee statements data veranderd — stop en kijk.
--
-- DE TWEE VOORWAARDEN IN DE WHERE ZIJN DE HELE VEILIGHEID:
--   · phone !~ regex        → een nummer dat NU al geldig is wordt nooit
--                             aangeraakt, wat de omzetting er ook van maakt;
--   · kandidaat ~ regex     → er wordt alleen geschreven als het resultaat
--                             écht geldig is. Levert de omzetting niets
--                             bruikbaars op (of NULL, dus een kale 0-prefix),
--                             dan blijft de rij staan zoals hij was.
-- Samen: elke UPDATE maakt een fout nummer goed, en niets anders.
--
-- is_test = false blijft erbij zodat testrijen ongemoeid blijven; die worden
-- via de opruimknop weggegooid, niet opgeschoond.

UPDATE public.event_attendees a
   SET phone = k.kandidaat
  FROM (
    SELECT id,
           CASE WHEN schoon LIKE '+%'  THEN schoon
                WHEN schoon LIKE '00%' THEN '+' || substring(schoon from 3)
                ELSE NULL END AS kandidaat
      FROM (
        SELECT id, regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g') AS schoon
          FROM public.event_attendees
         WHERE is_test = false AND phone IS NOT NULL AND btrim(phone) <> ''
           AND phone !~ '^\+[1-9][0-9]{7,14}$'
      ) x
  ) k
 WHERE k.id = a.id
   AND k.kandidaat ~ '^\+[1-9][0-9]{7,14}$'
   AND a.phone    !~ '^\+[1-9][0-9]{7,14}$';


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 3 — TELLING NA
-- ══════════════════════════════════════════════════════════════════════════
-- Vergelijk met stap 1. VERWACHTING:
--   nu_al_geldig  : 25  →  165   (+140)
--   nu_fout       : 158 →   18   (−140)
--   opmaak_te_fixen: 140 →    0   ← dit hoort 0 te zijn, anders is stap 2
--                                   niet volledig gelopen
--   blijft_staan_voor_de_mens: 18 → 18  (ongewijzigd, dat is de bedoeling)

SELECT
  count(*)                                                    AS met_nummer,
  count(*) FILTER (WHERE phone ~ '^\+[1-9][0-9]{7,14}$')      AS nu_al_geldig,
  count(*) FILTER (WHERE phone !~ '^\+[1-9][0-9]{7,14}$')     AS nu_fout,
  count(*) FILTER (WHERE phone !~ '^\+[1-9][0-9]{7,14}$'
                     AND kandidaat ~ '^\+[1-9][0-9]{7,14}$')  AS opmaak_te_fixen,
  count(*) FILTER (WHERE phone !~ '^\+[1-9][0-9]{7,14}$'
                     AND (kandidaat IS NULL
                          OR kandidaat !~ '^\+[1-9][0-9]{7,14}$'))
                                                              AS blijft_staan_voor_de_mens
FROM (
  SELECT phone,
         CASE WHEN schoon LIKE '+%'  THEN schoon
              WHEN schoon LIKE '00%' THEN '+' || substring(schoon from 3)
              ELSE NULL END AS kandidaat
    FROM (
      SELECT phone,
             regexp_replace(phone, '[[:space:]\-\(\)\.]', '', 'g') AS schoon
        FROM public.event_attendees
       WHERE is_test = false AND phone IS NOT NULL AND btrim(phone) <> ''
    ) x
) y;


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 4 — DE 15 TWIJFELGEVALLEN, MET EEN VOORSTEL PER RIJ
-- ══════════════════════════════════════════════════════════════════════════
-- Deze query SCHRIJFT NIETS. Hij zet per rij neer wat het nummer is, wat het
-- voorstel zou zijn, en — dat is het punt — of dat voorstel BOTST met een
-- Nederlands netnummer.
--
-- Lees de kolom `botst_met_nl`:
--   'nee'  → eenduidig Belgisch gsm (het netnummer bestaat niet in NL).
--            Veilig om over te nemen.
--   'JA: …'→ dezelfde tien cijfers zijn óók een geldig Nederlands vast
--            nummer. Kijk naar de naam, het event en de rest van de rij
--            voor je kiest; bij twijfel niets doen en bellen.
--
-- De NL-netnummers die met 04 beginnen en tien cijfers lang zijn (en dus
-- botsen met Belgische gsm-reeksen) staan in de lijst hieronder. Die lijst is
-- met opzet ruim: liever één rij te veel nakijken dan één WhatsApp naar een
-- vreemde.

SELECT
  a.id,
  a.first_name || ' ' || a.last_name        AS deelnemer,
  a.phone                                   AS nu,
  e.starts_at::date                         AS event_datum,
  e.starts_at > now()                       AS komend_event,
  a.status,
  regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') AS cijfers,
  CASE
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^06[0-9]{8}$'
      THEN '+31' || substring(regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') from 2)
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^04[5-9][0-9]{7}$'
      THEN '+32' || substring(regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') from 2)
    ELSE NULL
  END                                       AS voorstel,
  CASE
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^06[0-9]{8}$'
      THEN 'nee — Belgie heeft geen 06-reeks, dus dit is eenduidig NL mobiel'
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^0475'
      THEN 'JA: 0475 is ook Roermond (NL, vast)'
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^0478'
      THEN 'JA: 0478 is ook Venray (NL, vast)'
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^0481|^0485|^0486|^0487|^0488'
      THEN 'JA: dit is ook een NL netnummer (Nijmegen/Land van Cuijk e.o.)'
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^0492|^0493|^0495|^0497|^0499'
      THEN 'JA: dit is ook een NL netnummer (Helmond/Weert e.o.)'
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^045'
      THEN 'JA: 045 is ook Heerlen (NL, vast)'
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^046'
      THEN 'JA: 046 is ook Sittard (NL, vast)'
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^04[7-9]'
      THEN 'nee — deze 04-reeks bestaat niet als NL netnummer'
    ELSE 'onbekend — niet automatisch te beoordelen'
  END                                       AS botst_met_nl
FROM public.event_attendees a
JOIN public.events e ON e.id = a.event_id
WHERE a.is_test = false
  AND a.phone IS NOT NULL AND btrim(a.phone) <> ''
  AND a.phone !~ '^\+[1-9][0-9]{7,14}$'
  AND regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') ~ '^0[1-9][0-9]{8}$'
ORDER BY komend_event DESC, botst_met_nl, deelnemer;


-- ── DE UPDATE VOOR STAP 4, PER RIJ, NA JE EIGEN BLIK ──────────────────────
-- Vul het id en het nummer uit de kolom `voorstel` in. Eén rij per keer, zodat
-- je niet per ongeluk een hele reeks meeneemt. De laatste voorwaarde is het
-- vangnet: hij weigert te schrijven als het nummer inmiddels toch geldig is.
--
-- UPDATE public.event_attendees
--    SET phone = '<voorstel, bv. +32472223752>'
--  WHERE id = '<id uit stap 4>'
--    AND phone !~ '^\+[1-9][0-9]{7,14}$';
--
-- Ben je klaar met alle 15, draai dan stap 3 nog een keer: `nu_fout` hoort dan
-- op 3 te staan — de drie uit stap 5.


-- ══════════════════════════════════════════════════════════════════════════
-- STAP 5 — DE 3 GEVALLEN DIE ALLEEN EEN MENS KAN OPLOSSEN
-- ══════════════════════════════════════════════════════════════════════════
-- Deze query SCHRIJFT NIETS. Gemeten waarden en waarom ze niet te repareren
-- zijn zonder de klant te spreken:
--
--   '047979884'             één cijfer te kort. Welk cijfer ontbreekt en waar,
--                           is niet te raden. Bellen of opnieuw uitvragen.
--   '639503861'             geen 0 en geen +, dus geen land. Kan NL mobiel
--                           zonder 0 zijn (+31639503861), kan iets anders zijn.
--   'nonclevalerie@gmailcom' er staat een mailadres in het telefoonveld — en
--                           let op, er mist ook een punt in 'gmail.com'. Zet
--                           het telefoonveld leeg en zet het adres (na
--                           correctie) in het e-mailveld, als dat daar nog
--                           niet staat.
--
-- Twee van de drie staan op een komend event; die hebben dus haast.

SELECT
  a.id,
  a.first_name || ' ' || a.last_name        AS deelnemer,
  a.phone                                   AS nu,
  a.email,
  e.starts_at::date                         AS event_datum,
  e.starts_at > now()                       AS komend_event,
  a.status,
  CASE
    WHEN a.phone ~ '@'                                                   THEN 'mailadres in het telefoonveld'
    WHEN regexp_replace(a.phone, '[^0-9]', '', 'g') = ''                 THEN 'geen cijfers'
    WHEN length(regexp_replace(a.phone, '[^0-9]', '', 'g')) < 9          THEN 'te kort — cijfer(s) ontbreken'
    WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') !~ '^0' THEN 'geen 0 en geen + — land onbekend'
    ELSE 'overig'
  END                                       AS waarom_handwerk
FROM public.event_attendees a
JOIN public.events e ON e.id = a.event_id
WHERE a.is_test = false
  AND a.phone IS NOT NULL AND btrim(a.phone) <> ''
  AND a.phone !~ '^\+[1-9][0-9]{7,14}$'
  AND regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') !~ '^0[1-9][0-9]{8}$'
  AND (CASE
         WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') LIKE '+%'
           THEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g')
         WHEN regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') LIKE '00%'
           THEN '+' || substring(regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g') from 3)
         ELSE NULL
       END) IS DISTINCT FROM regexp_replace(a.phone, '[[:space:]\-\(\)\.]', '', 'g')
ORDER BY komend_event DESC, deelnemer;


-- ══════════════════════════════════════════════════════════════════════════
-- OPRUIMEN NA AFLOOP
-- ══════════════════════════════════════════════════════════════════════════
-- Als stap 3 klopt en je de back-up niet meer nodig hebt:
--   DROP TABLE IF EXISTS public._backup_phone_20260920;
-- Laat hem desnoods een week staan, hij kost bijna niets.
