# WhatsApp-template `opvolging_geen_reactie` — voorbereiding

Status: **VOORBEREID, NIET INGEDIEND.** Deze branch dient niets in bij Meta,
wijzigt geen productie-instelling en zet niets live. Wat hier staat is de
exacte specificatie plus het klikpad; Maxim drukt zelf op de knop.

Hoort bij punt B van de no-reply-opdracht. De bugfix zelf (de klok loopt vanaf
óns laatste bericht) zit in commit `5223b60`; dit document gaat alleen over de
tekst en de template.

---

## 1. Waarvoor is deze template

De no-reply-cyclus (`joost_config.autonomy_config.no_reply`, module `finance`)
stuurt reminder 1 op twee manieren:

* **vrije tekst** als het 24-uursvenster van Meta nog open is;
* **een goedgekeurde Meta-template** als dat venster dicht is.

Na de klok-fix ligt óns laatste bericht per definitie ná het laatste bericht van
de klant, en het 24-uursvenster telt vanaf de laatste klant-inbound. Bij
`reminder_1_hours = 24` (de instelling die Maxim wil) is dat venster op het
moment van sturen **altijd dicht**. Reminder 1 gaat dan dus **altijd** via een
template. Zonder template gebeurt er niets: de cron slaat de run over met reden
`NO_TEMPLATE_CONFIGURED`.

Vandaar deze template.

---

## 2. De template-spec

| Veld | Waarde |
|---|---|
| `name` | `opvolging_geen_reactie` |
| `language` | `nl` |
| `category` | `UTILITY` |
| `header` | geen |
| `footer` | geen |
| `buttons` | geen |
| `body` | zie hieronder |
| Variabelen | 1 stuks: voornaam |

### Body — definitief (besluit Maxim)

```
Hey {{klant.voornaam}}, ik heb nog geen reactie van je ontvangen op mijn bericht over je openstaande factuur. Laat je even weten hoe we dit kunnen afronden? Alvast bedankt.
```

Geen bedrag, geen factuurnummer, geen vervaldatum, geen ondertekening met een
persoonsnaam. De bijzin *"op mijn bericht over je openstaande factuur"* staat er
bewust in: die verwijzing naar de transactie is wat de template op
UTILITY-grond houdt (§4). Een eerdere variant zonder die bijzin is afgewogen en
afgewezen — de neutraliteit die dat opleverde woog niet op tegen de kans dat
Meta hem als MARKETING classificeert.

**Ter vergelijking, de bestaande R2-template `joost_reminder_2_nl` (APPROVED,
UTILITY):**

```
Hoi {{klant.voornaam}}, Ik heb nog geen reactie van je gekregen over factuur {{factuur.nummer}} van EUR {{factuur.bedrag}}, inmiddels {{factuur.dagen_overdue}} dagen open. Laat je even weten hoe je het wilt oplossen? Dan kunnen we er samen uitkomen. Team De Forex Opleiding
```

Twee verschillen die opzet zijn: de nieuwe R1 noemt geen cijfers, en hij
ondertekent niet. R2 sluit af met "Team De Forex Opleiding" — dat is geen
persoonsnaam, dus die mag blijven staan; R1 heeft bewust helemaal geen
ondertekening zodat hij overkomt als een bericht van de afzender zelf.

### Waarom `{{klant.voornaam}}` en niet `{{1}}`

De CRM-editor werkt met **named placeholders**. Bij opslaan leidt
`api/admin-meta-templates-upsert.js` daar automatisch de
`meta_param_mapping.body` uit af (`{"1": "klant.voornaam"}`), en bij submit
vertaalt `api/admin-meta-templates-submit.js` de body naar het positionele
`{{1}}` dat Meta verwacht, inclusief het verplichte `example`. Typ je zelf
`{{1}}`, dan blijft de mapping leeg en weigert Meta de submit met #132000.
Zie ook `docs/whatsapp-templates-c4-named-variables.md`.

### Voorbeeldwaarde voor Meta

Meta eist bij elke `{{n}}` een voorbeeld. Dat komt automatisch uit de
variabelen-registry (`klant.voornaam` → `Jeffrey`), dus daar hoeft niets
handmatig ingevuld te worden.

### Let op: klanten zonder voornaam

`klant.voornaam` resolvet naar `customer.first_name`, en dat veld is leeg voor
zakelijke klanten en voor klanten die alleen als bedrijfsnaam in de administratie
staan. Een lege parameter weigert Meta bij het versturen. Daarom vervangt de
cron een lege waarde in **deze** template door `daar` ("Hey daar, …") — zie
`emptyFallback` in `api/_lib/conv-reminder-template.js`. Reminder 2 houdt exact
het bestaande gedrag.

---

## 3. Het klikpad — wat Maxim precies doet

Het CRM kan zelf indienen bij Meta; Meta Business Manager is niet nodig.

1. Open **Instellingen → WhatsApp** (linkermenu, "Meta-koppeling en goedgekeurde
   templates"). Vereist recht `admin.meta_templates.manage`.
2. Klik **Nieuwe WhatsApp-template**.
3. Vul in:
   * Naam: `opvolging_geen_reactie`
   * Taal: `nl`
   * Categorie: `UTILITY`
   * Header: geen · Footer: leeg · Buttons: geen
   * Body: variant A of B uit §2, met de variabele-chip **Voornaam** op de plek
     van `{{klant.voornaam}}`.
4. Klik **Opslaan** — en stop daar. De template blijft lokaal staan (status
   `LOCAL`); de bevestiging zegt dat letterlijk: *"Wordt niet naar Meta gestuurd
   — blijft lokaal totdat je Submit → Meta klikt"*. **Klik hier niet op
   "Opslaan + Submit → Meta".**
5. Indienen doet Maxim zelf: **Submit** op de regel van de template in de lijst.
   Status wordt `SUBMITTED`.
6. Wacht op de beoordeling van Meta. Status wordt `APPROVED` of `REJECTED`.
7. **Controleer na goedkeuring het veld `category`, niet alleen `status`** — zie
   §4. Een als UTILITY ingediende template die WhatsApp als MARKETING beoordeelt
   wordt stilzwijgend goedgekeurd ALS MARKETING; je ziet dan gewoon "APPROVED"
   staan. Dit is geen formaliteit.
8. Pas ná een goedkeuring mét `category = UTILITY`: vul
   `reminder_1_template_name` in (§5).

**Alternatief voor stap 1–4:** `docs/sql-migrations/2026-09-07-wa-template-opvolging-geen-reactie.sql`
zet dezelfde rij op status `LOCAL` neer. Dat script stuurt niets naar Meta.
Doe één van beide — de UI of het script — niet allebei; een dubbele run is
overigens veilig (ON CONFLICT, en een al ingediende rij wordt niet teruggezet).

Endpoints erachter, voor wie het wil nalezen:
`api/admin-meta-templates-upsert.js` (stap 4) en
`api/admin-meta-templates-submit.js` (stap 5, POST naar
`https://graph.facebook.com/v25.0/<WABA_ID>/message_templates`).

Validatie die het CRM afdwingt: naam alleen `a-z 0-9 _`, max 50 tekens; taal uit
`nl / en_US / en / de / fr`; categorie uit `UTILITY / MARKETING / AUTHENTICATION`;
body max 1024 tekens; submit alleen vanuit status `LOCAL` of `REJECTED`.

---

## 4. UTILITY of MARKETING — wat ik wél en niet kan onderbouwen

Dit is de waarschuwing waar Maxim om vroeg. Ik heb de criteria van Meta
opgezocht; ik kan **niet** voorspellen hoe hun classifier deze specifieke tekst
beoordeelt, en ik heb geen bron gevonden waarmee ik dat hard zou kunnen maken.
Wat volgt is dus: de regels met bron, en daarna mijn inschatting als inschatting.

### De regel

Een template is UTILITY als hij **beide** van deze dingen is:

1. niet-promotioneel, én
2. óf specifiek voor / gevraagd door de gebruiker — *"clearly related to their
   order, account, services, or transactions"* — óf essentieel/kritiek voor de
   gebruiker.

Meta heeft die definitie per **1 juli 2025** juist aangescherpt "voor
specificiteit en duidelijkheid". "Payment reminder" staat in dezelfde
documentatie expliciet genoemd als voorbeeld van UTILITY, onder *account updates
or alerts*.

### Waarom dat hier spannend was

Uit productie (uitgelezen door Maxim, 7 sep 2026): **alle vijf de
`aanmaning_dagNN`-templates staan op `category = UTILITY`, `status = APPROVED`,
zonder `category_warning`, en ze bevatten allemaal een factuurnummer én een
bedrag.** Hetzelfde geldt voor `joost_reminder_2_nl`. Dat is geen bewijs van
oorzaak, maar het is wel het patroon dat de gepubliceerde criteria voorspellen:
de transactieverwijzing is wat deze berichten "clearly related to their …
transactions" maakt, en daarmee UTILITY.

**Precies die grond haalde de eerste, volledig neutrale variant weg.** Zonder
bedrag, factuurnummer of vervaldatum verwees die tekst nog maar naar één ding:
"dit dossier". Voor een mens duidelijk — hij staat in dezelfde WhatsApp-draad —
maar de classifier beoordeelt de template los van de gespreksgeschiedenis.

Daarom staat de bijzin over de openstaande factuur er nu in: hij zet de
verwijzing naar de transactie terug in de template zelf, zonder ook maar één
cijfer. Het risico is daarmee kleiner, niet nul: ik kan Meta's classifier niet
voorspellen en heb geen bron waarmee ik een uitkomst hard kan maken.

### Wat er misgaat als het misgaat — en waarom je het niet vanzelf merkt

Sinds **9 april 2025** wordt een template die je als UTILITY indient en die
WhatsApp als MARKETING beoordeelt, **goedgekeurd als MARKETING** — niet
afgewezen. Je krijgt dus gewoon "approved" te zien terwijl de categorie is
omgezet. Bovendien loopt er sindsdien een periodiek herclassificatie-proces dat
ook al goedgekeurde templates kan omzetten. Daarom stap 7 in §3: kijk na
goedkeuring naar het veld `category` van de template, niet alleen naar de status.

Wat een MARKETING-categorie concreet verandert, voor zover ik het kan
onderbouwen: het valt onder de marketing-prijs in plaats van de utility-prijs,
en de vrijstelling "utility-template binnen een open service-window is gratis"
(per 1 juli 2025) vervalt. Die vrijstelling helpt ons hier overigens sowieso
niet, want reminder 1 gaat juist uit als het venster dicht is. Over
marketing-specifieke bezorglimieten en opt-out-instellingen doe ik geen
uitspraak: dat verschilt per markt en ik heb er geen bron voor gevonden die
scherp genoeg is om op te bouwen.

Bezwaar maken kan: je kunt binnen **60 dagen** een review aanvragen, ook voor een
utility-template die naar marketing is omgezet.

### Wat de bijzin kost aan neutraliteit

Het woord "factuur" maakt het bericht weer herkenbaar als een geldkwestie, ook in
de melding op een vergrendeld scherm waar iemand anders kan meekijken. Dat is
precies wat de volledig neutrale variant wilde vermijden. Wat overblijft: de toon
is zacht (een vraag, geen sommatie), er staat geen enkel getal in, en er is geen
ondertekening. Dat is de prijs die betaald is voor de UTILITY-grond, en die
afweging is bewust gemaakt.

### Wat ik nog steeds niet kan vaststellen

Dat de vijf aanmaan-templates UTILITY zijn, is nu bekend. **Waaróm** Meta ze zo
heeft geclassificeerd is dat niet: Meta publiceert per template geen motivering,
en het ontbreken van een `category_warning` zegt alleen dat er niets is
omgezet. De redenering hierboven blijft dus een redenering op basis van de
gepubliceerde criteria, geen weergave van een besluit dat iemand heeft gezien.

**Bronnen**

* [Template categorization — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)
* [Template Categorization (nieuwe template-richtlijnen)](https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines/)
* [Utility templates — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates)
* [Pricing updates July 2025](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing/)

---

## 5. Aansluiten op de no-reply-cyclus

De koppeling zit al in deze branch, achter bestaande config, en doet **niets**
zolang niemand hem invult.

Huidige productie-config (`joost_config`, module `finance`,
`autonomy_config.no_reply`, stand 7 sep 2026):

| Sleutel | Waarde |
|---|---|
| `reminder_1_hours` | 20 |
| `reminder_2_hours` | 24 |
| `resume_after_hours` | 24 |
| `reminder_2_template_name` | `joost_reminder_2_nl` (APPROVED, UTILITY) |
| `reminder_1_template_name` | **bestaat nog niet — bewust leeg** |

Nieuwe optionele config-sleutel:
`joost_config.autonomy_config.no_reply.reminder_1_template_name`.

* **Niet gezet (zo blijft het tot de template APPROVED is):** reminder 1 valt
  terug op `reminder_2_template_name` — exact het gedrag van vóór deze branch.
  Reminder 1 stuurt dan dus nog de template mét factuurnummer en bedrag.
* **Gezet op `opvolging_geen_reactie`:** reminder 1 gebruikt de neutrale
  template, reminder 2 blijft `joost_reminder_2_nl` houden.

In te vullen in **Instellingen → Joost AI → Autonomy**, veld
`reminder_1_template_name`, direct boven het bestaande veld voor reminder 2.

De template wordt pas gebruikt zodra hij in `whatsapp_meta_templates` op
`APPROVED` staat: `fetchReminderTemplate()` accepteert alleen approved rijen.
Zet je de naam eerder in, dan valt de send terug op het legacy-pad met vijf
positionele parameters en weigert Meta hem — vul de naam dus pas in ná
goedkeuring.

De vrije-tekst-variant van reminder 1 (`buildReminder1Text`) is in deze branch
gelijkgetrokken met dezelfde neutrale strekking, zodat het niet uitmaakt welk van
de twee paden vertrekt. Ook daar staan nu geen bedragen, factuurnummers of
vervaldata meer in, en geen ondertekening.

## 6. Wat deze branch NIET doet

* Niets ingediend bij Meta.
* `reminder_1_template_name` is en blijft leeg tot de template APPROVED is.
* `reminder_1_hours` staat nog op 20 en `reminder_2_hours` bestaat nog. De
  instelling die Maxim wil (24 uur, R2 laten vervallen) is een wijziging in
  `joost_config` in productie en is bewust niet doorgevoerd.
* Geen wijziging aan bestaande templates. De seed-SQL is aanwezig maar niet
  gedraaid — SQL-migraties draaien hier altijd met de hand.
