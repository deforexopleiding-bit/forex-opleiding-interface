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

Stap 2 slaagt **alleen** bij `uitnodiging_verstuurd` (HTTP 200, met
`data.student` en `data.verstuurd_naar`). Elke andere code telt bewust **niet**
als succes: een contractwijziging aan LMS-kant mag niet stil als "gemaild"
passeren, want dan denken wij dat de student een mail heeft die hij misschien
nooit kreeg.

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

### Het vormcontract van provisionDfoLmsStudent

Elk geslaagd pad bouwt zijn resultaat via `succesResultaat({ studentId, email, … })`
en nooit met een eigen object-literal. Reden: de aanroeper heeft `email` nodig
om daarna de uitnodiging te versturen — hij kent het adres niet zelf.

Op 6 september 2026 gaf het 'al gekoppeld'-uitstappad wél `ok:true` maar géén
`email`. Daardoor heeft de uitnodigingsknop **nooit** gewerkt: de aanroeper
zag geen adres en sloeg de aanroep over, met de melding *"geen studentrij"* —
terwijl het bestáán van die rij juist de oorzaak was. De melding beschreef het
omgekeerde van de werkelijkheid.

Twee dingen zijn daarom veranderd:

- De klant wordt nu opgehaald **vóór** de al-gekoppeld-uitstap, zodat `email`
  op élk pad in bereik is. Het traject wordt bewust ná die uitstap opgehaald:
  een al gekoppelde student hoeft niet opnieuw door de `product_soort`-controle.
- `tests/dfo-lms-student.test.js` dwingt het contract af **op broncode-niveau**.
  Wie later een pad toevoegt met een eigen `return { ok: true, … }` laat drie
  tests falen. Dat is gecontroleerd door de fout opzettelijk opnieuw in te
  bouwen: de tests sloegen aan, en werden weer groen na herstel.

### Meldingen mogen niets beweren dat niet gemeten is

`verklaarNietGebeld()` in `api/onboarding-dfo-lms-provision.js` is een pure
functie die uitlegt waarom de uitnodiging niet geprobeerd is. Elke tak
beschrijft uitsluitend wat er daadwerkelijk in het resultaat stond.
"Geen studentrij" mag er alleen staan als er echt gezocht is en er geen
student-id uit kwam; is de rij er wél maar ontbreekt het adres, dan zegt de
melding dát, mét het student-id erbij.

### De Bubble-resetknop

`api/onboarding-credentials-reset.js` weigert nu met een 409 zodra de
onboarding een `dfo_lms_student_id` heeft. Die klant hoort in het LMS, en een
Bubble-wachtwoord helpt hem niet. Bestaande, Bubble-only studenten houden de
knop gewoon.

## Spoor C — sessies uit het LMS

De mentoren werken sinds augustus 2026 in het nieuwe LMS. Het CRM las nog
Bubble-`1-1-session`, en dat is een bron waar het echte werk niet meer
gebeurt. Twee plekken zijn nu omgezet.

**Geen leertype-filter meer.** De Bubble-lezers filterden op
`learn_type1 = 'Alpha Program'`. Dat onderscheid is vervallen (beslissing
Maxim, 7 september 2026): elke coachingsessie telt mee. Voeg dus nergens een
leertype-filter toe — een sessie is een sessie.

### De gedeelde lezer: `api/_lib/dfo-lms-sessies.js`

Eén regel staat centraal: **"leeg" en "niet gelukt" mogen nooit hetzelfde
zijn.** Elke Bubble-lezer in het CRM vangt zijn fouten af naar een lege
lijst, waardoor een storing en "er is niets" er identiek uitzien. Precies
daardoor kon de verschuiving maandenlang onopgemerkt blijven.

Elke functie geeft daarom `bron_status` terug:

| | |
|---|---|
| `gelezen` | de bevraging is gelukt. Nul rijen betekent dan **echt** nul. |
| `onbereikbaar` | de bevraging is mislukt. Het aantal zegt niets. |
| `niet-geconfigureerd` | de `DFO_LMS_*`-variabelen ontbreken. |

Daarnaast telt de module wat er **buiten de filter viel** —
`overgeslagen_afgehandeld`, `zonder_student`, `zonder_email`,
`zonder_bubble_koppeling` — zodat een uitkomst niet alleen zegt wat er
doorkwam maar ook wat er wegviel.

### De twee koppelingen

- **Student → CRM:** `hlms_student.bubble_user_id`. Gemeten op 7 september
  2026: 299 van de 304 rijen dragen 'm, en die waarden zijn uniek. De vijf
  zonder zijn vier handmatige adminrijen en de eerste CRM-aanmaak. Dankzij
  die brug blijft `student_signals.bubble_student_id` gewoon werken.
- **Mentor → CRM:** op **e-mailadres** (`hlms_personeel.email` ↔
  `team_members.email`). Het LMS kent geen `Created By` zoals Bubble; de
  toerekening loopt via `mentor_id`, wat eerlijker is: niet wie de rij
  aanmaakte, maar wiens sessie het was.

### No-show-detectie — `api/cron/noshow-detect.js`

Leest nu `hlms_sessie` met `status='no_show'` sinds het watermerk. Bij een
mislukte bevraging eindigt de cron met een 502 **zonder het watermerk te
verzetten**, zodat een storing geen no-shows overslaat.

De oude wees-tak (no-shows zonder gekoppelde student) is vervallen:
`hlms_sessie.student_id` is nooit leeg — 0 van 44 gemeten.

### Afgeleide intake-status — `api/onboarding-intake-status.js`

Kijkt nu per **student** in plaats van per mentor. Dat lost twee dingen
tegelijk op: de Bubble-bron is leeg, én een student van een mentor zonder
Bubble-koppeling viel voorheen sowieso buiten beeld.

**Kon de bron niet gelezen worden, dan wordt er niets afgeleid** —
`intake_status: null` in plaats van een status. Zou je wel afleiden, dan komt
elke student op `nog_te_benaderen` (rang 4 in `INTAKE_RANK`) en dus
**bovenaan** de probleemlijst, ook iemand die dertien sessies achter de rug
heeft. Dat is niet leeg maar **onwaar**, en het zet iemand tot een verkeerde
handeling aan: bellen wie al lang bezig is. De frontend patcht alleen bij een
niet-lege waarde, dus een leeg antwoord laat de vorige stand staan.

### De eerste sessie sluit de onboarding — `api/cron/onboarding-eerste-sessie-afronden.js`

**De regel (Maxim, 7 september 2026):** de **vroegste afgeronde** sessie van
een student sluit diens onboarding automatisch af. Geen soort-onderscheid:
er bestaat geen kennismakingsgesprek en geen Alpha/Delta — elke coachingsessie
telt.

Let op het verschil met "de eerste sessie mits afgerond". Was de eerste sessie
een no-show, dan sluit die niets af; de eerstvolgende sessie die wél afgerond
raakt doet het alsnog. Anders zou één gemiste eerste call de onboarding voor
altijd open laten staan.

**Wat er wordt vastgelegd**, en waarom dat een harde eis is: niet alleen dát de
onboarding afgerond is maar **welke sessie het deed** —
`auto_afgerond_sessie_id`, `auto_afgerond_sessie_op` en `auto_afgerond_op`.
Die staan ook in het detailscherm onder *Afgerond*, niet alleen in de databank.
Een onboarding die "afgerond" zegt zonder aanwijsbare oorzaak is precies het
schermsoort dat dit project twee keer een halve dag heeft gekost.

**Idempotent op drie manieren.** `auto_afgerond_sessie_id` is de sterkste:
staat die gevuld, dan gebeurt er nooit meer iets — óók niet wanneer iemand de
onboarding daarna handmatig heropent. Een mens die bewust heropent mag niet
door dezelfde sessie opnieuw dichtgetrokken worden. Daarnaast een
optimistische `.is(..., null)` op de update zelf, en een overslaan-tak voor
gearchiveerde en geannuleerde onboardings.

**Geen terugwerkende vloedgolf.** Watermerk `onboarding_autocomplete_since` in
`app_settings`, zelfde patroon als de no-show-cron: ontbreekt het, dan zet de
eerste run het op nu en doet verder niets.

**Meten vóór aanzetten:** `GET ?dry=1&since=<iso>` draait exact dezelfde logica
zonder één schrijfactie, en geeft `afgesloten` plus tot twintig `voorbeelden`
terug. `since` werkt alleen samen met `dry=1`, zodat een echte run nooit
breder kan lopen dan het watermerk.

**Eén ding om te weten:** dit sluit de onboarding ook wanneer de klant de
wizard nog niet heeft afgemaakt. `api/onboarding-complete.js` valideert de
verplichte velden; deze weg doet dat niet. Dat is bewust — de onboarding is
volgens de regel klaar zodra de eerste call gedaan is.

### Gemiste eerste call krijgt een eigen signaal

Is de chronologisch eerste sessie van een student een no-show, dan krijgt het
signaal type **`eerste_call_no_show`** in plaats van `no_show`. De reden is een
andere: daar moet iemand kort op zitten om te voorkomen dat het een wanbetaler
wordt.

Bewust **geen tweede signaal** naast het gewone. Er staat een unique index op
`student_signals.session_id`, dus twee signalen voor één sessie kan sowieso
niet — en het zou de mentor twee keer laten rinkelen voor één gebeurtenis. Eén
signaal met een type dat het onderscheid draagt is juister én routeerbaar.

**De ontvanger is de hoofdmentor, niet de mentor van de sessie.** Er moet
iemand kort op zitten om te voorkomen dat het een wanbetaler wordt, en dat is
een andere verantwoordelijkheid dan het opvolgen van een gewone no-show.

De rol *hoofdmentor* bestaat nog niet. Rollen zijn wél **meervoudig** —
`user_roles` draagt ze allemaal en `profiles.role` is daar de afgeleide
hoofdrol van (`ROLE_PRIORITY` in `api/_lib/roles.js`) — dus een extra rol naast
mentor zou op zichzelf kunnen. Maar 'hoofdmentor' staat niet in
`VALID_SUPABASE_ROLES` en de CHECK op `user_roles.role` /
`role_permissions.role` laat 'm niet toe: die rol invoeren is een migratie plus
werk in het gebruikersbeheer, en dat is een aparte beslissing. Twee namen in de
code zetten is de andere kant van het probleem — dan verhuist de beslissing
naar een deploy.

Daarom loopt de adressering via een **recht**: `signals.hoofdmentor.receive`.
`resolveOntvangersVoorRecht()` in `api/_lib/notify.js` leest twee bronnen:

- `role_permissions` × `user_roles` — het recht aan een hele rol. Zodra
  'hoofdmentor' bestaat is één rij daar genoeg en verandert er niets aan de
  code. Bewust `user_roles` en niet `profiles.role`: wie de rol als *tweede*
  rol heeft staat niet in die afgeleide kolom. Dit is hetzelfde pad dat
  `user_has_permission()` (migratie 016) en de bestaande `toRole`-uitwaaiering
  in `createNotification()` volgen.
- `user_permissions` — het recht aan één persoon. De weg voor nu; zie
  migratie 016 en het precedent in 044.

**Geen super_admin-omweg.** `user_has_permission()` laat super_admins overal
door, maar dat is een *toegangs*-regel (mag je dit zien). Hier gaat het om
*adressering* (wie hoort hierover gebeld te worden). Die twee laten samenvallen
zou elk zulk bericht ook bij het systeemaccount laten belanden.

**Geen terugval.** Heeft niemand het recht, dan gaat er geen bericht uit —
niet naar de sessie-mentor, want daar mag het uitdrukkelijk niet heen. Het
signaal zelf staat er wél en is zichtbaar voor iedereen met
`students.all.view`. De cron telt dat als `eerste_call_zonder_ontvanger` en
logt het als fout, zodat het niet stil blijft.

De signaalrij zelf verandert niet: één rij per sessie, unieke index op
`session_id`, `mentor_user_id` blijft de mentor van die sessie. Alleen wie er
bericht van krijgt is anders.

**En waar dat bericht heen wijst.** De No-shows-tab van de mentor
(`/modules/mentor-students.html?tab=noshows`) filtert op `type === 'no_show'`
en toont bovendien alleen de eigen studenten van de ingelogde mentor — een
gemiste eerste call staat daar dus niet in, en de hoofdmentor is niet per se de
mentor van die student. De melding wijst daarom naar **Aandachtspunten**
(`/modules/students-overview.html?tab=signals`), waar het signaal wél staat en
via `student-signals-handle.js` afgehandeld kan worden. Daarvoor is
`students.all.view` nodig — **controleer dat beide hoofdmentoren dat recht
hebben** voor je de toekenning draait; zo niet, dan is dat een tweede rij in
`user_permissions`.

Bijkomend: `eerste_call_no_show` had in Aandachtspunten geen leesbaar label
(ruwe sleutel in de tabel) en viel door een `!== 'no_show'`-filter onder
"Meldingen (mentor)". Beide rechtgezet, met `AUTO_SIGNAL_TYPES` als één plek
zodat filter en rij-opmaak niet opnieuw uit elkaar kunnen lopen. De
"Wacht op reden"-regel blijft bewust alléén bij een gewone no-show staan: het
reden-endpoint weigert het nieuwe type, dus daar kán niemand een reden geven.

### Aanleiding en oorzaak: waarom een oude sessie tóch mag sluiten

Twee fouten die op 7 september zijn rechtgezet, allebei van de stille soort:
de code deed niets verkeerds, hij liet dingen liggen.

**1. Een student met een afgeronde sessie vóór het watermerk kon nooit meer
sluiten.** De eerste versie liet een kandidaat vallen zodra hij niet zelf de
vroegste afgeronde sessie was (`echtEerste`-filter), en telde dat als
`eerdere_afgeronde_buiten_venster`. Dat gold dan voor élke volgende sessie van
die student: niet de tweede, niet de tiende. De onboarding stond eeuwig open,
en het enige spoor was een teller waar niets mee gebeurde.

De scheiding die dat oplost:

- **Aanleiding** — een afgeronde sessie ná het watermerk. Dít is de grens die
  een inhaalslag over de historie tegenhoudt.
- **Oorzaak** — de vroegste afgeronde sessie van die student, ook van vóór het
  watermerk. Die maakte het onboarden af, en die wordt vastgelegd in
  `auto_afgerond_sessie_id` / `_op`.

De cron sluit dus op de oorzaak en verzet zijn watermerk op de aanleiding.
Andersom zou het watermerk terug in de tijd willen en kwam dezelfde rij elke
ochtend opnieuw langs. Heeft een student **alleen** sessies van vóór het
watermerk en daarna niets meer, dan is er geen aanleiding en gebeurt er niets —
dat is de enige grens tussen dit gat dichten en alsnog over de historie lopen,
en daar staat de zwaarste test op.

**2. Het watermerk verzette alleen na een geslaagde schrijfactie.** Elk
oversla-pad deed `continue` vóór die regel. Dat klinkt behoudend en was het
omgekeerde: de bevraging is oplopend gesorteerd met een limiet, dus een
overgeslagen sessie die vóór een geschreven sessie lag raakte áchter het
watermerk zonder ooit verwerkt te zijn — waarna fout 1 'm permanent
onbereikbaar maakte. En op een ochtend waarin álles werd overgeslagen bewoog
het watermerk helemaal niet. Dat is hier de regel, niet de uitzondering: van de
twaalf studenten met een afgeronde sessie hadden er elf geen onboardingrij.

Nu verzet het watermerk op elk **besluit** — overslaan is ook een besluit.
Alleen een echte fout houdt het tegen, en dan voor de rest van de ronde:
doorschuiven over een mislukte rij heen zou die definitief kwijtmaken. Een
vastgelopen watermerk is zichtbaar (`errors` in de uitkomst plus een
`console.error`); een overgeslagen rij was dat niet.

De teller heet daarom nu `gesloten_op_eerdere_sessie` in plaats van
`eerdere_afgeronde_buiten_venster`: hij telt niet meer wat wegviel, maar wat
werd afgesloten op een sessie ouder dan het watermerk.

### De titel van de sluitende sessie

De regel kijkt naar **status `afgerond`** en niet naar het soort sessie. Een
testsessie die per ongeluk op afgerond wordt gezet sluit dus een echte
onboarding. Gemeten op 7 september: twee sessies in het LMS met "test" of
"verificatie" in de titel, waarvan één afgerond. Klein, niet nul, en het groeit
zodra iemand iets uitprobeert.

**Er komt geen titelfilter.** Raden op woorden in een titel is precies het soort
regel dat later stil de verkeerde kant op valt: iemand noemt een echte sessie
"testfase 2" en die sluit niets meer, of een testsessie heet "call 1" en glipt er
alsnog door. Wat er wél is: `onboardings.auto_afgerond_sessie_titel` legt vast
wát er sloot, en het detailscherm zet die titel vet in de afgerond-regel. Wie
kijkt begrijpt meteen wat hij ziet.

**En sinds 7 september gaat er ook een melding uit.** Bij elke automatische
afsluiting, met de titel in de tekst, naar de houders van
`signals.hoofdmentor.receive` — dezelfde weg als het eerste-call-signaal. Zo
hoeft niemand een dossier te openen om te zien dat er *Testsessie
(verificatie)* staat. Nog steeds geen filter op die titel: de mens leest 'm.

Drie randvoorwaarden, alle drie met een test die rood wordt als ze wegvallen:

1. **Faalzacht.** Mislukt de melding, dan blijft de onboarding gewoon
   afgesloten en staat de reden in de logregel plus in `meldingen_mislukt`. De
   melding wordt bewust *niet* doorgeworpen naar de foutafhandeling van de rij:
   dat zou het watermerk blokkeren, en morgen komt diezelfde rij terug als
   `al_automatisch` — waarna er nooit meer een melding volgt. Andersom falen
   (afsluiting terugdraaien omdat een bericht niet aankwam) is erger.
2. **Geen terugval.** Heeft niemand het recht, dan gaat er niets uit — zeker
   niet alsnog naar de mentor van de sessie. Geteld als
   `meldingen_zonder_ontvanger` en gelogd als fout. Een kapotte
   rechten-opzoeking blokkeert het afsluiten evenmin: een onboarding niet
   sluiten omdat we niet weten wie we moeten bellen is de verkeerde kant op
   falen.
3. **Hoogstens één per afsluiting.** De melding hangt aan de *geslaagde
   overgang*, niet aan de staat van de rij. `.is('auto_afgerond_sessie_id',
   null)` maakt die overgang eenmalig, dus een herhaalde cron-run komt niet
   eens in de buurt. Daarbovenop een dedup van 7 dagen op de onboarding-id.

#### Het volume, en wanneer dit ophoudt te werken

Dit is **één melding per onboarding, voor de hele levensduur van die klant** —
niet per sessie. Een klant die er twee jaar bij zit levert er precies één op,
bij zijn eerste afgeronde call. De bovengrens is dus de instroom van nieuwe
klanten, niets anders.

Gemeten op 7 september 2026, nieuwe onboardings per week over de voorgaande
twaalf weken: 5, 4, 9, 8, 8, 3, 5, 2, 4 en 1 (lopende week). **Gemiddeld zo'n
vijf per week — ongeveer één per werkdag.**

Dat is te dragen, en het is meteen de grens. De waarde van deze melding zit erin
dat iemand hem *leest*; bij tien per dag kijkt niemand er meer naar en hebben we
ruis gebouwd in plaats van een alarm.

> **Afspraak (Maxim, 7 september 2026): wordt dit structureel meer dan ongeveer
> vijf per week, dan gaat er een dagelijkse samenvatting in plaats van losse
> meldingen.** Eén bericht met de afsluitingen van die dag en de titels erbij.
> Niet uitzetten, niet filteren — samenvatten. Hertoets het volume met:
>
> ```sql
> SELECT date_trunc('week', created_at) AS week, count(*)
>   FROM public.onboardings
>  WHERE created_at > now() - interval '12 weeks'
>  GROUP BY 1 ORDER BY 1;
> ```

De melding wijst naar `/modules/onboarding-hub.html`, hetzelfde doel als elke
andere onboarding-melding hier. Bewust géén `?onboarding=<id>`: klanten-v2 kent
die parameter niet, dus zo'n link zou het dossier niet openen en stil op een
overzicht landen. Het belangrijkste — de titel — staat al in de tekst zelf.

Een echte diep-link kán (`window.__onbOpen(id)` opent de modal, en `?v2tab=`
bestaat al) maar staat **bewust geparkeerd**: eerst zien of deze melding in de
praktijk gebruikt wordt voordat er frontendwerk aan hangt. Zie
TODO-VOLLEDIG.md.

De goedkoopste bescherming blijft de mensenregel: **geen testsessies op een
echte student afronden.** Geen enkele kolom haalt het daarbij.

#### Waarom de titel in een aparte bevraging zit

Het LMS-schema staat nergens in deze repo. Alle bevragingen hier gebruiken
alleen kolommen die gemeten zijn (`id`, `start_tijd`, `status`, `student_id`,
`mentor_id`). Dát een sessie een titel heeft is bekend; hóé die kolom heet niet.

Die naam staat daarom als één constante in `api/_lib/dfo-lms-sessies.js`
(`LMS_SESSIE_TITEL_KOLOM`), en de opzoeking is een **aparte, faalzachte** stap
ná al het werk dat er wel toe doet. Zou de titel in de hoofdbevraging staan, dan
gaf één verkeerde kolomnaam een fout op die bevraging, ging `bron_status` op
onbereikbaar, en sloot de cron **niets** meer af — een sierveld dat het hele
afsluiten omlegt. Nu blijft de titel leeg en draait de rest door. Klopt de naam
niet, dan is dat één woord om te wijzigen. Er staat een test op die rood wordt
zodra iemand de titel alsnog in de hoofdbevraging zet.

En omdat "leeg" en "niet gelukt" ook hier niet hetzelfde mogen zijn: de uitkomst
draagt `titels_gelezen` (en `titels_fout`). Een sessie zonder titel geeft `null`
met `titels_gelezen: true`; een mislukte opzoeking geeft `null` met
`titels_gelezen: false`. In de kolom staat in beide gevallen niets — het
onderscheid hoort in de cron-uitkomst en de log, niet in een sierveld.

## De onboarding-spiegel (CRM → LMS)

De mentor moet in het LMS zien welke studenten opgepakt moeten worden. Die
gegevens staan in het CRM en het LMS kan er niet bij; alleen het CRM schrijft
over de grens.

### Waar het landt

Een **eigen tabel** `hlms_crm_onboarding` in dfo-lms, één rij per onboarding,
niet kolommen op `hlms_student`. Drie redenen, in volgorde van gewicht:
eigenaarschap (die tabel is volledig van het CRM, `hlms_student` blijft van het
LMS), annuleren wordt een `DELETE` in plaats van acht kolommen op `NULL`, en de
verse-heid past er per rij op in plaats van per veld.

De sleutel is de **onboarding**, niet de student: wisselt de mentor, dan
verhuist dezelfde rij.

### Eén schrijver

`api/_lib/onboarding-spiegel.js` is de enige plek die naar die tabel schrijft.
Twee contracttests in `tests/onboarding-spiegel.test.js` bewaken dat: één die
de hele `api/`-map afzoekt op een tweede schrijfpad, en één die eist dat de
aanroepers via `spiegelNaActie()` gaan in plaats van met eigen queries.

### Eén berekening

De vier feiten komen uit dezelfde berekening als `admin-future-students-list.js`.
Dat was niet vanzelfsprekend: `computeBedenktijd` stond **in viervoud** in
`admin-future-students-list.js`, `onboardings-admin-list.js`,
`onboarding-detail.js` en `mentor-future-students-self.js`, elk met een comment
dat ze identiek waren. Ze waren het niet — twee verschillen, allebei tweeëntwee
gesplitst:

| verschil | de twee varianten | beslecht op |
|---|---|---|
| vervaldatum | `setDate(+14)` (kalenderdagen) vs `+14×24u` (336 uur) | **kalenderdagen** — de wet spreekt over veertien dagen, niet over 336 uur; over een zomertijdgrens schelen die een uur en precies op de grens klapt de uitkomst om |
| waiver zonder offertedatum | `vervallen/afstand` vs `onbekend` | **vervallen** — een klant die uitdrukkelijk afstand deed `onbekend` noemen omdat wij de offertedatum niet vonden, is een bekend feit weggooien |

Beide keuzes staan gepind in tests. Ze **veranderen het gedrag** van
`admin-future-students-list.js` en `mentor-future-students-self.js` in die
randgevallen; dat is bewust.

`onbekend` mag nooit als `vervallen` gelezen worden. De regel is dat de mentor
niet doorbelt zolang de bedenktijd loopt, dus bij onbekend geldt
terughoudendheid, niet vrij spel.

### De hersync is de waarheid, de aanroep is snelheid

`api/cron/onboarding-spiegel-sync.js` draait dagelijks (07:20 UTC, na de
afsluitcron) en **verzoent**: toevoegen wat mist, bijwerken wat er staat, en
verwijderen wat er niet meer hoort. De aanroepen vanuit de elf schrijfpunten
zijn er alleen zodat het scherm meteen klopt.

Twee groepen daarvan verdienen aparte vermelding, want zonder hen zou de
hersync het pas uren later rechtzetten:

- **De provisioning** (`onboarding-create.js`, `onboarding-dfo-lms-provision.js`).
  Dat is het eerste moment waarop `dfo_lms_student_id` bestaat en dus het
  eerste moment waarop de spiegel kán bestaan. Zonder die aanroep verschijnt
  een net aangemaakte student pas de volgende ochtend in het oppak-blok — juist
  de student die je snel wil zien.
- **De twee archiveer-crons** (`cron/archive-completed-onboardings.js` om 03:30,
  `cron-cancellation-cleanup.js` om 02:30). De hersync draait om 07:20, dus
  zonder aanroep staat een gearchiveerde of geannuleerde student vier tot vijf
  uur in het blok van zijn mentor.

Die volgorde is met opzet zo. Er zijn twintig schrijfpunten op `onboardings`;
bij twintig is het geen kwestie óf er ooit eentje de spiegel vergeet, maar
wanneer. Zou het gebeurtenis-schrijven de hoofdweg zijn, dan is een vergeten
aanroep een blijvende afwijking die niemand ziet. Nu is het hooguit een dag.

### Verdwijnen is een gevolg van de definitie

De verwachte verzameling wordt afgeleid uit het CRM: `status != 'geannuleerd'
AND archived_at IS NULL AND dfo_lms_student_id IS NOT NULL`. Een geannuleerde
onboarding kan daar per definitie niet in zitten, dus "verdwijnt overal in het
LMS" is een gevolg van die definitie en niet van een opruimactie die iemand kan
vergeten. `onboarding-cancel.js` roept de spiegel ook zelf aan, zodat het
meteen weg is in plaats van morgen.

### Als de spiegel niet geschreven kan worden

- **De hoofdactie gaat altijd door.** Een mentortoewijzing die faalt omdat het
  LMS onbereikbaar is, is erger dan een spiegel die een dag achterloopt.
- **Nooit een halve rij.** Alles wat kan mislukken gebeurt vóór er iets
  geschreven wordt; de rij gaat in één `upsert`.
- **De oude rij blijft staan** met zijn oude `bijgewerkt_op`. Er wordt
  uitdrukkelijk niet "gemarkeerd als stuk" — dat zou een schrijfactie zijn op
  grond van een mislukte lezing.
- **Het mentorscherm toont `null` als "niet opgehaald"**, niet als leeg vakje,
  en zegt het zelf als `bijgewerkt_op` te oud is. Zonder die regel ziet een
  stilstaande spiegel er identiek uit als een kloppende.
- **De cron verwijdert niets** als hij de spiegeltabel niet kon lezen: dan weet
  hij ook niet wat overtollig is. 502, en niets aangeraakt.

### De dode Bubble-kolom

`hlms_student.onboarding_status` is een bevroren Bubble-import (7 vrije-
tekstwaarden over 307 rijen, half NL half EN). Er schrijft niets meer aan, maar
er **wordt wel uit gelezen**: `hlms-student-detail-page.tsx:873` toont 'm en
`own-hlms-student-store.tsx:212` laadt 'm in het eigen studentprofiel. Daarom
niet hernoemd — alleen een `COMMENT` dat zegt waar de echte stand staat.
Hernoemen gebeurt in de LMS-PR die die twee leesplekken omzet.

Bijvangst voor die PR: `src/features/mentor/studenten/studenten-format.ts:59-90`
bevat al een `studentSectie()` die studenten in `oppikken` / `onboarding` /
`actief` verdeelt — in opzet precies het blok dat gevraagd is, maar gevoed door
die dode kolom. Die functie wordt nergens aangeroepen; er staat dus een leeg
raamwerk klaar dat op de verkeerde bron was aangesloten.

### De inhaalslag: studentrijen voor de lopende onboardings

**Waarom hij nodig is.** Gemeten 7 september 2026: van de 24 lopende
onboardings heeft er maar **twee** een `dfo_lms_student_id` — 14 met status
*aangemeld* (nul geprovisioneerd, 8 met mentor) en 10 met status *bezig* (twee
geprovisioneerd, 3 met mentor). Provisioning was per klant een operator-vinkje
en dat is zelden aangezet. Zonder inhaalslag ziet elke mentor een leeg blok
terwijl er elf klanten mét mentor op hem wachten — precies het lege scherm
waar dit hele spoor over gaat.

`api/cron/onboarding-lms-backfill.js`.

**Droogloop is de standaard.** Zonder parameters doet hij niets. Uitvoeren
vraagt `?uitvoeren=ja&aantal=<N>`, waarbij N exact het getal moet zijn dat de
droogloop als `zou_aanmaken` gaf. Klopt dat niet: 409. Zo kan niemand dit per
ongeluk aanzetten, en kan er niets veranderd zijn tussen kijken en doen.

**Dubbele klanten.** Er is een klant die in beide systemen onder twee
verschillende adressen staat. De droogloop meldt per rij `bestaat_op_onboarding`
(gekoppeld via `crm_onboarding_id`), `bestaat_op_email`, en `naam_treffers`:
LMS-rijen met dezelfde naam maar een **ander** adres. Rijen met een naam-treffer
worden bij uitvoeren **overgeslagen** — op naam matchen is raden, en dat is een
besluit voor een mens, geen script.

#### Er kan geen post uit — en dat is gerekend, niet beweerd

De uitnodiging is een aparte beslissing en die is niet genomen. Dit pad raakt 22
echte klanten tegelijk, dus "er zit geen mail in" is een eis en geen
geruststelling.

`tests/onboarding-lms-backfill-geen-post.test.js` rekent de **volledige
transitieve import-afsluiting** uit — statische én dynamische imports, want die
tweede vorm bestaat in deze repo en zou anders een gat zijn. Het resultaat is
**vijf bestanden**:

```
api/cron/onboarding-lms-backfill.js
api/supabase.js
api/_lib/dfo-lms-db.js
api/_lib/dfo-lms-student.js
api/_lib/onboarding-window.js
```

Daarop staan zeven bewijzen. De sterkste is **BEWIJS 2b**: in geen van die vijf
bestanden staat ook maar één manier om een uitgaande verbinding te maken — geen
`fetch(`, geen axios, geen http-module. Post verlaat het pand via een
netwerk-call; kan die niet gemaakt worden, dan kan er niets vertrekken, hoe de
functies ook heten. Een **tegenbewijs** toetst dat `dfo-lms-uitnodiging.js` die
call wél heeft, zodat 2b niet stilletjes een test kan worden die nergens naar
kijkt.

Eén eerlijk detail. BEWIJS 2 (het woordenfilter) sloeg eerst aan op
`noteerUitnodiging()` in `dfo-lms-student.js`. Die functie verstuurt niets — hij
schrijft de uitkomst van een uitnodiging weg in
`onboardings.dfo_lms_provision_error`, één UPDATE in het CRM. Het woord is uit
de lijst gehaald, maar niet zonder er iets sterkers voor terug te zetten: dat is
waar BEWIJS 2b vandaan komt. De reden staat in de test zelf, zodat niemand later
denkt dat de lijst is uitgekleed tot hij groen was.

Drie manieren rood bewezen: de uitnodigingsmodule alsnog importeren (4 bewijzen
vallen om), de droogloop niet meer de standaard maken (BEWIJS 5), en de
naam-treffer-rem eruit halen (BEWIJS 7).

### Nog niet gebouwd: on-hold

On-hold bestaat **nergens** in het CRM — geen kolom, geen endpoint, geen knop.
Dat is een eigen fase vóór de spiegel-uitbreiding, en die ligt apart bij Maxim.

### Bewust niet omgezet: de betaalherinnering

`api/cron/first-call-payment-reminder.js` blijft op Bubble staan en is
daarmee stil. Dat is een **keuze**, geen vergetelheid.

In het ontwerp van Maxim gaat de openstaande factuur een andere weg: de
mentor ziet bij zijn student dat er iets openstaat en spreekt de klant daar
tijdens de sessie op aan; een openstaande factuur geeft een waarschuwing bij
het inplannen, twee of meer een harde stop. Mensenwerk met een rem dus.

En zwaarder: die cron ligt al weken stil. Hem repareren betekent dat klanten
ineens weer herinneringen krijgen die ze al die tijd niet gekregen hebben —
een gedragsverandering richting betalende klanten, geen bugfix. De omzetting
is wél gemaakt en geparkeerd op branch
`claude/geparkeerd-betaalherinnering-lms-bron`, mocht het ontwerp anders
uitpakken.

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
