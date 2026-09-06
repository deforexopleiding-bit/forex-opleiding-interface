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

## herkomst

`herkomst` wordt bij het **aanmaken** op `'crm'` gezet (`HERKOMST_CRM` in
`api/_lib/dfo-lms-student.js`). Dat is een bestaande waarde in de
HERKOMSTEN-lijst aan LMS-kant; er wordt bewust géén nieuwe variant
geïntroduceerd. De kolom heeft — net als `product_soort` — geen CHECK, dus
een onbekende waarde zou niet tegengehouden worden maar aan de leeskant stil
omvallen. Zonder deze waarde staan door het CRM aangemaakte studenten
gelabeld alsof ze uit Bubble geïmporteerd zijn.

Bij het **overnemen** van een bestaande rij wordt `herkomst` niet aangeraakt.
Die student is ergens anders ontstaan en dat hoort te blijven staan; anders
zou een uit Bubble geïmporteerde student na een koppeling ineens als
CRM-aanmaak te boek staan.

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

## De LMS-uitnodiging (spoor A, stap 1)

Sinds deze stap krijgt een nieuwe klant zijn inloggegevens van het **LMS** in
plaats van van Bubble. Het Bubble-account wordt nog wél aangemaakt — alleen de
Bubble-inloggegevensmail is gedoofd.

**Waarom het account blijft.** Dertig bestanden lezen `bubble_user_id`. Zonder
dat id verdwijnt de klant stil uit de studentenlijst van zijn mentor
(`api/_lib/mentorStudents.js:76`), uit de Studenten-module
(`api/students-overview.js:58`), en uit de kandidatenlijst van de
archiveercron (`api/cron/archive-completed-onboardings.js:93`). Vier
scope-checks zouden hem bovendien een **403** geven op zijn eigen student. Het
account weghalen is een aparte stap die pas kan als die lijsten uit het LMS
gevoed worden.

### De aanroep — twee stappen

| | |
|---|---|
| **Stap 1** | `POST <basis>/api/admin/studenten/` · headers `x-dfo-secret` + `content-type: application/json` · body `{ email, herkomst: 'crm' }` |
| **Stap 2** | `POST <basis>/api/admin/studenten/<student-id>/uitnodiging/` · alleen `x-dfo-secret`, géén body en géén content-type |

`<student-id>` komt uit `data.student.id` van stap 1. Env:
`DFO_LMS_PUSH_SECRET` (gedeelde variabele op teamniveau) en optioneel
`DFO_LMS_BASE_URL`.

### Drie dingen die hier fout kunnen gaan

**1. De afsluitende schuine streep is verplicht.** Op het LMS staat
`trailingSlash` aan. Een pad zonder streep krijgt een 308, en bij die
omleiding valt de `x-dfo-secret`-header weg — je krijgt dan een **403 die
niets met het geheim te maken heeft** en zoekt uren de verkeerde kant op.
`bouwUrl()` dwingt de streep af, en de client staat op `redirect: 'manual'`
zodat een omleiding als zodanig gemeld wordt in plaats van stil gevolgd.

**2. Programmeer op `code`, nooit op de HTTP-status of op `message`.** Een 200
met een foutcode is mogelijk. Stap 1 slaagt bij `aangemaakt`,
`gekoppeld_aan_bestaande_rij` (ons normale geval), `gekoppeld_aan_bestaand_account`
en `bestaat_al`. Bij `half_aangemaakt` staat het account er maar mislukte een
vervolgstap; `data.auth_id` zegt om welk account het gaat en opnieuw proberen
koppelt daaraan — er gaat dan géén uitnodiging uit.

**3. De grendel.** Staat er in `data.student.uitnodiging_verstuurd_op` een
tijdstip, dan is er al gemaild en wordt stap 2 **overgeslagen**. Zonder die
grendel krijgt de student een tweede mail én werkt zijn eerste wachtwoord
niet meer — schade die je pas hoort als hij belt.

### Twee foutcodes die je nooit als één ding mag tonen

- `mail_mislukt` — er is **niets** veranderd. Het bestaande wachtwoord werkt
  door. Veilig om opnieuw te proberen.
- `mail_verstuurd_wachtwoord_niet_gezet` — de mail is de deur uit **met een
  wachtwoord dat niet werkt**. De student kan er nu niet in. Opnieuw sturen is
  geen keuze maar een noodzaak.

Beide belanden in `dfo_lms_provision_error`, met een stabiel voorvoegsel
(`UITNODIGING_MAIL_MISLUKT:` / `UITNODIGING_WACHTWOORD_NIET_GEZET:`) zodat het
detailscherm ze exact kan onderscheiden zonder op Nederlandse tekst te matchen.
Het eerste geeft een gele melding, het tweede een rode met "actie vereist".

### Wanneer hij afgaat

- **Nieuwe aanmelding** — automatisch, direct na de studentrij
  (`api/onboarding-create.js`).
- **Bestaande klant** — alleen op uitdrukkelijk verzoek, via de knop
  *LMS-uitnodiging versturen*. De server stuurt niets zonder
  `send_invite: true`. Reden: die knop wordt op bestaande klanten gebruikt en
  die horen geen mail te krijgen omdat iemand de koppeling wilde controleren.

Alles faalzacht: mislukt de uitnodiging, dan blijft de aanmelding staan en komt
de reden in `dfo_lms_provision_error`. `dfo_lms_provisioned` wordt daarbij
**niet** teruggezet — de studentrij is immers wél gekoppeld.

### De Bubble-resetknop

`api/onboarding-credentials-reset.js` weigert nu met een 409 zodra de
onboarding een `dfo_lms_student_id` heeft. Die klant hoort in het LMS, en een
Bubble-wachtwoord helpt hem niet. Bestaande, Bubble-only studenten houden de
knop gewoon.

## Bekende beperking: tellers die alleen tellen wat ze zagen

Dit is geen fout in één cron maar een patroon dat op meerdere plaatsen in het
CRM terugkomt, en het is de reden dat de Bubble-naar-LMS-verschuiving zo lang
onopgemerkt kon blijven. **Een proces filtert zijn kandidaten op een bron,
rapporteert daarna een keurig getal over precies díe verzameling, en wat er
buiten de filter viel bestaat in dat rapport niet.** Het getal klopt, en juist
daarom stelt het gerust.

### Het scherpste geval: de archiveercron

`api/cron/archive-completed-onboardings.js:93` selecteert zijn kandidaten met:

    .not('bubble_user_id', 'is', null)

Een onboarding zonder Bubble-koppeling komt dus niet in de kandidatenlijst.
Gevolg: die wordt **nooit automatisch gearchiveerd** en blijft eeuwig in het
actieve overzicht staan. De cron telt intussen netjes `checked` op over de
rijen die hij wél ophaalde (regel 129) en eindigt gezond.

Vandaag raakt dit vrijwel niemand, want bijna elke onboarding heeft een
Bubble-id. Het wordt scherp zodra nieuwe klanten geen Bubble-account meer
krijgen: dan valt honderd procent van de instroom buiten deze cron.

Er is bovendien geen vervanging klaar. De cron bepaalt "klaar" via
`readCallsCompleted(user)` op het Bubble-user-object (regel 149). Het LMS heeft
dat gegeven wel — `hlms_student.calls_gedaan` — maar niets in het CRM leest
dat.

### Dezelfde vorm, elders

- `api/cron/first-call-payment-reminder.js:112` zoekt zijn sessies in Bubble.
  Staan de geplande sessies alleen in het LMS, dan rapporteert de cron
  `{ ok: true, checked: 0 }` — niet te onderscheiden van "er stond niets
  gepland".
- `api/_lib/bubble-one-on-one-count.js:72` begint zijn teller op `0` en telt
  op; alleen bij een **fout** wordt het `null` (regel 89). Een leeg antwoord
  geeft dus een keurige `0` op het wandbord, als feit gepresenteerd.
- `api/student-detail.js:190` en `api/_lib/bubble-1on1.js` vangen fouten af
  naar een lege lijst. Een storing en "er is niets" zien er in de UI identiek
  uit.
- `api/_lib/mentorStudents.js:76` en `api/students-overview.js:58` bouwen hun
  studentenlijst uit Bubble. Wie daar niet in staat, ontbreekt zonder melding.

### De regel die hieruit volgt

Bij elk proces dat een getal rapporteert over een gefilterde verzameling:
**tel ook wat er buiten de filter viel, en toon dat.** Een cron die meldt
"47 gecontroleerd" naast "12 overgeslagen wegens ontbrekende koppeling" is
eerlijk; een cron die alleen het eerste getal meldt, is dat niet.

Dezelfde regel geldt voor schermen: onderscheid "niets gevonden" van "niet
opgehaald". Dat is precies wat de drie callvelden hierboven wél doen sinds
ze *laden…* en *niet opgehaald* uit elkaar houden — en wat de rest van het
CRM nog niet doet.

Dit is bewust **niet** opgelost in fase 1; het staat hier zodat het bij de
Bubble-uitfasering op tafel ligt in plaats van halverwege ontdekt te worden.

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
