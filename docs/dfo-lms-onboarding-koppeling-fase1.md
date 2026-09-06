# dfo-lms ← onboarding, fase 1

**Datum:** 5 september 2026 · **Status:** gebouwd, migraties gedraaid, nog niet in productie beproefd

Bij het starten van een onboarding wordt nu een studentrij aangemaakt in het
nieuwe LMS (`hlms_student` in het dfo-lms-project). Daarvoor liep de
onboarding alleen naar Bubble, waardoor er in het LMS geen enkele nieuwe klant
verscheen en studenten met de hand geïmporteerd moesten worden.

## Drie systemen die allemaal "LMS" heten

Dit is de belangrijkste val in dit onderdeel. Houd ze uit elkaar:

| | Wat | Waar | Code |
|---|---|---|---|
| **Bubble** | het oude LMS | Bubble | `api/_lib/bubble.js`, `onboarding-provision.js` |
| **trial-site** | 7-daagse / mini-cursus voor leads | `lms_gebruikers` / `lms_toegang` / `lms_producten` **in het CRM-project**, aangestuurd vanaf dfo-website | `api/_lib/lms-provisioning.js`, `toegang-provisioning-caller.js` |
| **dfo-lms** | het nieuwe LMS | eigen Supabase-project (`absicpdidnoblirngiia`), `hlms_*`-tabellen | `api/_lib/dfo-lms-db.js`, `dfo-lms-student.js` |

`onboardings.lms_provision` hoort bij de **trial-site**, niet bij dfo-lms. Dat
systeem is van een collega en wordt hier niet aangeraakt. Alles wat bij het
nieuwe LMS hoort heeft daarom de prefix `dfo_lms` / `dfoLms`; het generieke
`lms` is al bezet.

## Omgevingsvariabelen

`DFO_LMS_SUPABASE_URL` en `DFO_LMS_SUPABASE_SERVICE_ROLE_KEY` (Vercel, alle
omgevingen, Sensitive). Ontbreekt er één, dan slaat de koppeling zichzelf over
met een waarschuwing in de log — geen crash, en er wordt geen fout op de
onboarding geschreven, want dat is een omgevingsprobleem en geen probleem van
die klant. Er worden alleen variabele*namen* gelogd, nooit waarden.

## Idempotentie — het hart van fase 1

Dubbele studentrijen in een live LMS zijn erger dan een mislukte aanmaak.
Drie lagen, van goedkoop naar hard:

1. **CRM-vlag** — `dfo_lms_provisioned` + `dfo_lms_student_id` staan gevuld →
   direct klaar, geen enkele call naar het LMS.
2. **Zoeken vóór schrijven** — eerst op `crm_onboarding_id`, dan op e-mail
   (hoofdletterongevoelig). Gevonden = overnemen, niet aanmaken.
3. **Databank-vangnet** — dfo-lms heeft twee unieke indexen
   (`hlms_student_email_uidx` op `lower(email)` en
   `hlms_student_crm_onboarding_uidx`). Twee gelijktijdige pogingen kunnen dus
   nooit twee rijen opleveren; de verliezer krijgt `23505` en dat wordt
   behandeld als "bestond al", niet als mislukking.

Een rij die al aan een **andere** onboarding hangt wordt nooit gekaapt: dat
levert een zichtbare fout op met beide id's erin.

Bij het zoeken op e-mail wordt bewust géén kale `.ilike()` vertrouwd: `_` en
`%` zijn jokertekens in een LIKE-patroon en `_` is een geldig teken in een
e-mailadres. Er wordt daarom achteraf op exacte `lower()`-gelijkheid
gefilterd.

### Bekende beperking: de klant met twee e-mailadressen

**Alle drie de lagen matchen op gegevens, niet op een persoon.** Ze vangen de
klant die in het CRM en in het LMS onder *verschillende* e-mailadressen staat
dus niet — privé versus zakelijk, een oud adres, een typefout. Voor zo iemand
vindt de zoekslag niets, slaat de unieke index op `lower(email)` niet aan
(twee verschillende adressen zijn nu eenmaal niet gelijk), en wordt er een
**tweede studentrij aangemaakt voor iemand die er al staat**.

Dit is geen theorie. Bij de controle vóór de allereerste handmatige klik
(5 september 2026) kwam precies zo'n geval boven: één klant met een
`.2@icloud.com`-adres in het CRM en een `@gmail.com`-adres in het LMS. Was er
zonder die controle geklikt, dan was hij netjes gedupliceerd — met alle drie
de vangnetten actief.

Wat dit betekent voor de praktijk:

- **Vóór een handmatige klik op een bestaande klant: controleer op persoon,
  niet alleen op e-mailadres.** Zoek in `hlms_student` ook op achternaam of
  telefoonnummer, niet uitsluitend op `lower(email)`.
- De automatische weg voor **nieuwe** onboardings loopt dit risico veel minder:
  een net aangemelde klant staat doorgaans nog niet in het LMS. Uitgesloten is
  het niet — iemand die eerder een ander traject deed kan er al staan onder een
  ander adres.
- De koppeling **verandert nooit het e-mailadres** van een bestaande studentrij.
  Wordt een dubbele rij ontdekt, dan is opruimen aan LMS-kant handwerk.

Structureel oplossen vraagt een tweede matchas (telefoonnummer genormaliseerd,
of naam plus geboortedatum) met een expliciete keuze over wat er moet gebeuren
bij twijfel. Dat is bewust **niet** in fase 1 gebouwd: een tweede as die te
soepel matcht koppelt twee verschillende mensen aan elkaar, en dat is erger dan
een dubbele rij. Zolang die keuze niet gemaakt is, is de controle vooraf de
enige afdekking.

## product_soort — de scherpe rand

`hlms_student.product_soort` is `text` **zonder CHECK**: de databank houdt een
verkeerde waarde niet tegen. De studentkant (`trajectstand.ts`) kent maar drie
uitkomsten: `mentorship`, `membership` en `onbekend`. Alles wat niet letterlijk
een van de eerste twee is, valt daar in `onbekend` — en dan ziet een betalende
klant een scherm dat zegt dat zijn traject niet bekend is.

Daarom is `PRODUCT_SOORT_MAP` in `api/_lib/dfo-lms-student.js` een **strikte**
tabel zonder terugval op `traject.key`. Staat een traject-type er niet in, dan
faalt de aanmaak luidruchtig met een melding in `dfo_lms_provision_error` in
plaats van stil een derde waarde weg te schrijven. Nieuw traject-type? Vul die
ene tabel aan; dat is de enige plek.

## Mentor

`hlms_student.mentor_id` wijst naar `hlms_personeel(id)`. De brug tussen CRM en
LMS is het **e-mailadres**: `team_members.email` → `hlms_personeel.email`, op
`lower(email)`. `hlms_personeel` is klein (11 rijen), dus die wordt opgehaald
en in JS vergeleken — geen `.ilike()`, om dezelfde reden als hierboven.

Geen match → `mentor_id` blijft leeg, er komt een waarschuwing in de log en de
rest van de studentrij wordt gewoon aangemaakt. Nooit gokken, en nooit de hele
aanmaak laten mislukken op een ontbrekende mentor.

Een mentorwissel in het CRM (`api/onboarding-assign-mentor.js`) schrijft door
naar het LMS via `syncDfoLmsMentor()`, faalzacht en niet-blokkerend. Een mentor
die in het LMS al gevuld is wordt bij het overnemen van een bestaande rij niet
overschreven — die kan daar met opzet gezet zijn.

## Wat er NIET geschreven wordt

`calls_gedaan`, `calls_startsaldo`, `no_show_count`, `auth_id`,
`bubble_user_id`, `membership_type`, `overrides`, `onboarding_status`,
`uitnodiging_*` en `aangemaakt_door` blijven ongemoeid. Fase 1 legt alleen het
studentfeit vast; inloggen en uitnodigen is een latere fase.

`herkomst` wordt bewust ook niet gezet: onbekend of daar een vaste
woordenlijst op staat, en `crm_onboarding_id` identificeert onze rijen al.

## Uitrol — geen inhaalslag

Nieuwe onboardings lopen automatisch mee via `api/onboarding-create.js`.
Bestaande onboardings gaan **één voor één** via de knop in het
onboarding-detailscherm (tab *Account & LMS*) → `POST
/api/onboarding-dfo-lms-provision`.

Er is met opzet **geen** batch-, cron- of "doe alles"-variant, en die hoort er
ook niet te komen zonder expliciete opdracht. De eerste echte aanmaak wordt met
z'n tweeën bekeken.

## De drie callvelden

"Eerste call gepland", "Laatste call voltooid" en "Laatste no-show" stonden bij
iedereen op een streepje. Dat was **geen** dode tabel maar een half afgemaakte
refactor: `api/onboarding-detail.js` geeft die drie sinds de perf-refactor
hardgecodeerd als `null` terug, omdat de trage Bubble-call naar een lazy
sidecar (`/api/onboarding-intake-status`) is verhuisd. Het lijstscherm roept die
sidecar aan, de detail-modal deed dat niet.

De modal haalt ze nu zelf op, ná het eerste render. En het scherm liegt niet
meer: zolang de sidecar loopt staat er *laden…*, faalt hij dan staat er *niet
opgehaald* — een streepje betekent voortaan echt "er is niets gepland".

De bron van die velden is overigens Bubble, niet het LMS. Zodra dfo-lms de
sessies overneemt, is `api/onboarding-intake-status.js` de plek om dat om te
zetten.

## Bestanden

| Bestand | |
|---|---|
| `api/_lib/dfo-lms-db.js` | aparte service-role client + `isUniqueViolation` |
| `api/_lib/dfo-lms-student.js` | `provisionDfoLmsStudent()`, `syncDfoLmsMentor()` |
| `api/_lib/onboarding-window.js` | gedeelde `addMonths` + vensterberekening |
| `api/onboarding-dfo-lms-provision.js` | handmatige knop, per klant |
| `api/onboarding-create.js` | haakt de koppeling in na de Bubble-provisioning |
| `api/onboarding-assign-mentor.js` | schrijft de mentor door |
| `api/onboarding-detail.js` | geeft de `dfo_lms_*`-velden terug |
| `modules/klanten-v2/views/modals/onboarding-detail.js` | status + knop + sidecar |
| `tests/dfo-lms-student.test.js` | 17 tests |
| `docs/sql-migrations/2026-09-05-dfo-lms-onboarding-koppeling-*.sql` | de twee migraties |

## Volgende stappen

- Eerste echte aanmaak samen bekijken.
- Auth/uitnodiging voor de student in dfo-lms (`auth_id`,
  `uitnodiging_verstuurd_op`) — buiten fase 1 gehouden.
- `calls_gedaan` / `no_show_count` terug laten stromen naar het CRM, zodat de
  drie callvelden uit dfo-lms komen in plaats van uit Bubble.
