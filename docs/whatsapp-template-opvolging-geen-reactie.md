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

### Body — variant A (letterlijk Maxims tekst)

```
Hey {{klant.voornaam}}, ik heb nog geen reactie van je ontvangen. Laat je even weten hoe we dit dossier kunnen afronden? Alvast bedankt.
```

### Body — variant B (aanbevolen, zie §4)

```
Hey {{klant.voornaam}}, ik heb nog geen reactie van je ontvangen op mijn bericht over je openstaande factuur. Laat je even weten hoe we dit kunnen afronden? Alvast bedankt.
```

Beide varianten bevatten **geen bedrag, geen factuurnummer, geen vervaldatum en
geen ondertekening met een persoonsnaam** — precies zoals gevraagd. Het verschil
tussen A en B is één bijzin, en dat verschil gaat uitsluitend over de
Meta-categorie (§4).

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
4. Klik **Opslaan**. De template blijft dan lokaal staan (status `LOCAL`) — de
   bevestiging zegt dat letterlijk: *"Wordt niet naar Meta gestuurd — blijft
   lokaal totdat je Submit → Meta klikt"*. Dit is de stap waar je kunt stoppen
   als je er nog even naar wilt kijken.
5. Wanneer je hem wilt indienen: **Submit** op de regel van de template (of
   meteen **Opslaan + Submit → Meta** in stap 4). Status wordt `SUBMITTED`.
6. Wacht op de beoordeling van Meta. Status wordt `APPROVED` of `REJECTED`.
7. **Controleer na goedkeuring de categorie** — zie §4, dit is geen formaliteit.

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

### Waarom dat hier spannend is

De aanmaan-templates (`aanmaning_dag7` t/m `aanmaning_dag37`) vallen comfortabel
in die definitie: ze noemen een factuurnummer, een bedrag en een vervaldatum, en
zijn daarmee onmiskenbaar "clearly related to their … transactions". Dat is de
grond waarop een betalingsherinnering UTILITY is.

**Precies die grond haalt variant A weg.** Zonder bedrag, factuurnummer of
vervaldatum verwijst de tekst nog maar naar één ding: "dit dossier". Dat is voor
een mens duidelijk (hij staat in dezelfde WhatsApp-draad), maar de classifier
beoordeelt de template los van de gespreksgeschiedenis. Of "dossier" volstaat als
verwijzing naar *order, account, services or transactions* weet ik niet, en ik
heb geen bron die dat beslist.

**Mijn inschatting, als inschatting:** het risico is reëel maar niet groot —
matig. De tekst is niet promotioneel (geen aanbod, geen aansporing tot kopen),
en dat is de helft van de toets die hij zeker haalt. De andere helft hangt op één
woord.

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

### De kleinst mogelijke aanpassing die hem UTILITY houdt

Variant B voegt één bijzin toe: *"op mijn bericht over je openstaande factuur"*.
Daarmee staat de verwijzing naar de transactie weer expliciet in de template
zelf, zonder dat er ook maar één cijfer in staat — geen bedrag, geen
factuurnummer, geen datum.

**Wat dat kost aan neutraliteit, eerlijk:** het woord "factuur" maakt het bericht
weer herkenbaar als een geldkwestie. Dat is precies wat variant A wilde
vermijden, en het is zichtbaar in de melding op een vergrendeld scherm, waar
iemand anders kan meekijken. De toon blijft wel zacht (het is een vraag, geen
sommatie) en er staat geen enkel getal in.

Dat is de afweging voor Maxim: variant A is neutraler en loopt meer kans om als
MARKETING te eindigen; variant B is bijna net zo zacht en staat steviger in de
UTILITY-definitie. Ik zou B nemen, maar dit is een merk-keuze, niet een
technische.

### Wat ik NIET heb kunnen vaststellen

Hoe de bestaande `aanmaning_dagNN`-templates destijds zijn ingediend en op welke
grond Meta ze als UTILITY heeft goedgekeurd, staat nergens in deze repo. De
categorie leeft in `whatsapp_meta_templates.category` in de productie-database,
en die kan ik vanuit deze omgeving niet lezen. Wat ik hierboven schrijf over
"waarom die UTILITY zijn" is dus een redenering op basis van de gepubliceerde
criteria en hun inhoud, geen weergave van een besluit dat ik heb gezien. Wil je
het zeker weten: in Instellingen → WhatsApp staat de categorie per template in de
lijst.

**Bronnen**

* [Template categorization — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-categorization)
* [Template Categorization (nieuwe template-richtlijnen)](https://developers.facebook.com/docs/whatsapp/updates-to-pricing/new-template-guidelines/)
* [Utility templates — Meta for Developers](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates)
* [Pricing updates July 2025](https://developers.facebook.com/docs/whatsapp/pricing/updates-to-pricing/)

---

## 5. Aansluiten op de no-reply-cyclus

De koppeling zit al in deze branch, achter bestaande config, en doet **niets**
zolang niemand hem invult.

Nieuwe optionele config-sleutel:
`joost_config.autonomy_config.no_reply.reminder_1_template_name`.

* **Niet gezet (nu, en na deze branch nog steeds):** reminder 1 valt terug op
  `reminder_2_template_name` — exact het gedrag van vóór deze branch.
* **Gezet op `opvolging_geen_reactie`:** reminder 1 gebruikt die template,
  reminder 2 blijft z'n eigen template houden.

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
* `reminder_1_hours` staat nog op 20 en `reminder_2_hours` bestaat nog. De
  instelling die Maxim wil (24 uur, R2 laten vervallen) is een wijziging in
  `joost_config` in productie en is bewust niet doorgevoerd.
* Geen migratie, geen seed, geen wijziging aan bestaande templates.
