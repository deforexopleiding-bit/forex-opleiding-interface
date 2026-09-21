# Iris — ontwerp (fase 0)

**Hoort bij:** [`00-inventaris.md`](00-inventaris.md)
**Datum:** 21 september 2026

Dit document beschrijft het datamodel, de endpoints, de crons en de bouwvolgorde.
Het bouwt voort op wat de inventaris heeft vastgesteld — vooral op de drie
dingen die al blijken te bestaan (mailinstroom, LMS-stiltebrug, beloftes) en die
Iris dus niet opnieuw maakt.

---

## 1. Het idee in één alinea

Iris is **geen tweede postbus**. Berichten komen binnen zoals ze nu binnenkomen:
WhatsApp via de Meta-webhook in `whatsapp_messages`, mail via de IMAP-cron in
`email_messages`. Iris **kijkt mee**: ze leest wat er nieuw is, koppelt het aan
een persoon, begrijpt waar het over gaat, zet het dossier ernaast en schrijft een
antwoord klaar. Maxim of Dave tikt op Verstuur. Het bericht vertrekt via dezelfde
verzendfunctie die de gesprekken-module nu al gebruikt, en verschijnt dus in
hetzelfde gesprek.

De winst zit in wat ertussen gebeurt, niet in een nieuw kanaal.

---

## 2. Datamodel

Alle tabellen krijgen het voorvoegsel `iris_`, RLS aan en een policy met
`public.is_crm_staff()`. Alles additief; geen bestaande kolom verandert.

### 2.1 De kern: wat Iris over een bericht weet

Bestaande berichten blijven waar ze zijn. Iris houdt er **een laagje boven**
bij. Eén rij per bericht dat Iris gezien heeft:

```
iris_berichten
  id                uuid pk
  bron              text    'whatsapp' | 'email'
  bron_id           text    whatsapp_messages.id of email_messages.id (as text)
  bron_uniek        text    UNIQUE — 'wa:<uuid>' / 'mail:<uuid>'  ← idempotentie
  gesprek_id        uuid    → iris_gesprekken
  contact_id        uuid    → iris_contacten (NULL tot gekoppeld)
  richting          text    'in' | 'uit'
  ontvangen_op      timestamptz
  tekst_kort        text    eerste 500 tekens, voor lijst + prompt
  categorie         text    zie 2.2
  categorie_reden   text    waarom Iris dit dacht
  zekerheid         numeric(3,2)
  samenvatting      text    één zin: wat wil deze persoon
  verwerkt_op       timestamptz  NULL = nog niet door Iris gekeken
  verwerk_fout      text
```

**Waarom een laag erboven en geen kolommen op `whatsapp_messages`.** Die tabel
wordt door de webhook, de aanmaanmotor, Joost, Simone en de onboarding-agent
gedeeld. Er een `iris_categorie` aan hangen betekent dat elke schrijver naar die
tabel ineens met Iris te maken heeft. Een eigen tabel met een unieke bron-sleutel
houdt de scheiding hard en maakt "wat heeft Iris nog niet gezien?" een
indexeerbare vraag (`verwerkt_op IS NULL`) in plaats van een scan.

`bron_uniek` is de idempotentie-sleutel: de cron mag zo vaak draaien als hij wil.

### 2.2 De categorieën

Uit de masterprompt, één op één, als CHECK-constraint:

```
facturatie · betaalafspraak · wanbetaling_reactie · lms_toegang ·
lms_support · planning_mentor · opzeg_klacht_juridisch ·
bounce_systeem · overig · spam
```

`opzeg_klacht_juridisch` is bijzonder: daar kán geen autonomie op, ook niet als
iemand de instelling per ongeluk aanzet. Dat wordt in code afgedwongen, niet in
de instelling — zelfde redenering als lesson learned 24 over mandaten in
`CLAUDE.md`.

### 2.3 Personen en gesprekken

```
iris_contacten
  id                uuid pk
  customer_id       uuid → customers      (NULL toegestaan)
  onboarding_id     uuid → onboardings    (NULL toegestaan)
  hlms_student_id   uuid                  (los, ander project — geen FK)
  emails            text[]  genormaliseerd (lowercase, getrimd)
  telefoons         text[]  E.164 mét +
  koppelstatus      text    'gekoppeld' | 'te_bevestigen' | 'onbekend'
  koppel_reden      text    waarom, bv. 'uniek e-mailadres' of '3 kandidaten'
  weergavenaam      text
```

```
iris_gesprekken
  id                uuid pk
  contact_id        uuid → iris_contacten
  kanaal            text    'whatsapp' | 'email'
  extern_id         text    whatsapp_conversations.id, of het mailadres
  extern_uniek      text    UNIQUE — ('whatsapp', conv-id) / ('email', adres)
  categorie         text
  status            text    'nieuw'|'wacht_op_ons'|'wacht_op_klant'|
                            'belofte_loopt'|'geregeld'
  toegewezen_aan    uuid → profiles   (Maxim / Dave / NULL = Iris)
  laatste_inbound   timestamptz       ← het 24u-venster
  laatste_outbound  timestamptz
  ongelezen         integer
```

**Waarom een eigen gesprekstabel naast `whatsapp_conversations`.** Omdat de
statussen niet dezelfde zijn. `whatsapp_conversations.status` is
`open`/`closed`/`archived` — dat gaat over de postbus. Iris' status gaat over het
werk: wacht dit op ons of op de klant. Die twee in één kolom persen zou betekenen
dat een `closed` gesprek niet meer "wacht op klant" kan zijn, wat het wel degelijk
kan. En het is precies de kolom die de bestaande UI en de webhook al gebruiken.

Voor mail is `extern_id` het e-mailadres, niet een thread-id. Reden: er ís geen
betrouwbaar thread-id in `email_messages`. Adres-per-persoon sluit aan bij hoe
`inbox-thread-unified.js` het nu ook doet, en lost meteen gat G6 op — mail hangt
straks aan het **contact**, niet aan `customer_id`, dus een nog-niet-gekoppeld
gesprek toont wél zijn mail.

### 2.4 Antwoorden

```
iris_concepten
  id              uuid pk
  gesprek_id      uuid → iris_gesprekken
  bericht_id      uuid → iris_berichten   (waar dit een antwoord op is)
  instructie      text     wat Maxim insprak of typte
  instructie_bron text     'spraak' | 'tekst' | 'auto'
  kanaal          text     'whatsapp' | 'email'
  onderwerp       text     alleen bij mail
  tekst           text
  template_naam   text     gevuld als het venster dicht is
  template_vars   jsonb
  status          text     'klaar'|'goedgekeurd'|'verzonden'|'geannuleerd'|'mislukt'
  verstuur_na     timestamptz   ← het ongedaan-venster van 30 seconden
  verzonden_op    timestamptz
  verzonden_door  uuid → profiles
  extern_id       text     meta_wamid of het mail-id na verzending
  fout            text
```

**Het ongedaan-venster.** Goedkeuren zet `status='goedgekeurd'` en
`verstuur_na = now() + 30s`. Annuleren vóór dat moment zet `'geannuleerd'`. Een
achtergrondtaak stuurt alles wat `goedgekeurd` is en waarvan `verstuur_na`
voorbij is.

Daar zit één ding in dat de masterprompt uitdrukkelijk verbiedt: "daarna vertrekt
het bericht meteen, niet bij een volgende ronde." Een cron die elke 5 minuten
draait zou gemiddeld 2,5 minuut vertraging geven. **Dus: de verzending gebeurt
`waitUntil()`-gewijs in het goedkeur-verzoek zelf** — 30 seconden wachten, dan
versturen, met de cron er alleen als vangnet achter voor het geval de functie
sneuvelt. `@vercel/functions` `waitUntil` is al in gebruik in `inbox-webhook.js`,
dus het patroon is bewezen in dit repo.

### 2.5 Opdrachten en acties

```
iris_opdrachten
  id              uuid pk
  vraag           text     wat Maxim vroeg
  titel           text
  plan            jsonb    de stappen die Iris voorstelt
  status          text     'gevraagd'|'uitzoeken'|'wacht_op_ok'|'uitgevoerd'|
                           'wacht_op_antwoord'|'geregeld'|'afgebroken'
  vraag_aan_maxim text     één vraag, als er iets ontbreekt
  opties          jsonb    keuzes bij die vraag
  antwoord_maxim  text
  na_uitvoeren    text     'wacht' | 'geregeld'
  verloop         jsonb    wie deed wat, wanneer
  aangemaakt_door uuid → profiles
```

```
iris_acties
  id              uuid pk
  opdracht_id     uuid → iris_opdrachten   (NULL bij losse actie)
  concept_id      uuid → iris_concepten    (NULL)
  contact_id      uuid → iris_contacten
  type            text     zie hieronder
  parameters      jsonb
  status          text     'klaar'|'goedgekeurd'|'uitgevoerd'|'mislukt'|'geannuleerd'
  idempotentie    text     UNIQUE — knoppen kunnen nooit dubbel aanmaken
  uitgevoerd_door uuid → profiles
  uitgevoerd_op   timestamptz
  resultaat       jsonb
```

Actietypes: `wa_versturen`, `mail_versturen`, `lms_toegang_verlengen`,
`lms_uitnodiging`, `lms_on_hold`, `belofte_vastleggen`, `afbetalingsplan`,
`taak_aanmaken`, `belrij_toevoegen`, `factuur_nakijken`.

De `idempotentie`-kolom is UNIQUE. Een dubbele klik levert een
constraint-schending op die het endpoint als "al gedaan" afhandelt en de
bestaande rij teruggeeft. Dat is het enige waterdichte antwoord op
dubbelklikken; een uitgeschakelde knop is dat niet (het verzoek kan al onderweg
zijn).

### 2.6 Beloftes, belrij, signalen

```
iris_beloftes
  id, contact_id, factuur_ids uuid[], bedrag numeric(12,2),
  datum date, status ('actief'|'nagekomen'|'gebroken'|'geannuleerd'),
  bron ('klant'|'maxim'|'dave'|'iris'), notitie, aangemaakt_door

iris_belrij
  id, contact_id, reden, reden_detail, eigenaar uuid → profiles,
  prioriteit int, status ('open'|'bezig'|'gedaan'|'vervallen'),
  bron ('wanbetaler'|'onboarding'|'mentorsignaal'|'geen_reactie'|'hand'),
  laatste_poging_op, pogingen_totaal, dagen_met_poging int

iris_belpogingen
  id, belrij_id, contact_id, call_log_id uuid → call_log,
  uitkomst ('gesproken'|'niet_opgenomen'|'voicemail'|'bezet'|'mislukt'),
  afgebroken_voor_opname boolean,   ← telt NIET als poging
  duur_sec int,                     ← onbetrouwbaar, nooit leidend
  notitie, notitie_bron ('spraak'|'tekst'), gebeld_door, gebeld_op

iris_signalen
  id, bron_id text UNIQUE, contact_id, type, mentor_naam,
  toelichting, gevraagde_actie, signaal_op, verwerkt_op
```

`iris_belpogingen.dagen_met_poging` op de belrij-rij is met opzet een aparte
teller naast `pogingen_totaal`: de escalatieregel is "N niet-opgenomen pogingen
op M **verschillende** dagen". Twee pogingen op één dag zijn niet twee dagen.

### 2.7 Instellingen en logboek

```
iris_instellingen
  sleutel   text pk
  waarde    jsonb
  bijgewerkt_op, bijgewerkt_door
```

Sleutels bij aanvang, **alles uit**:

| sleutel | waarde |
|---|---|
| `autonomie` | per categorie `'uit'` / `'concept'` / `'zelf'` — alles `'uit'` |
| `escalatie` | `{pogingen: 3, dagen: 3}` |
| `stille_uren` | `{van: '21:00', tot: '08:00', zondag_stil: true}` |
| `dosering` | `{max_per_minuut: 6, max_per_uur: 60}` |
| `mailboxen` | welke mailboxen Iris leest, welk afzenderadres per categorie |
| `model` | `{redeneren: 'claude-sonnet-4-5', transcriptie: 'gpt-4o-transcribe'}` |

```
iris_log
  id, wanneer, wie uuid → profiles (NULL = Iris zelf), wat,
  contact_id, gesprek_id, kanaal, resultaat, fout, details jsonb
```

**Privacy.** In `iris_log` staan geen volledige telefoonnummers en geen
berichtteksten. Alleen id's, tellingen en korte omschrijvingen. Dat is dezelfde
regel als de opvolgbrug al hanteert.

---

## 3. Endpoints

Alle nieuwe endpoints: sessie + `requirePermission`. Crons: `Bearer CRON_SECRET`.

| Endpoint | Doet |
|---|---|
| `api/iris-post.js` | de lijst en één gesprek |
| `api/iris-dossier.js` | de dossierkaart per persoon |
| `api/iris-schrijf.js` | concept maken uit een instructie |
| `api/iris-verstuur.js` | goedkeuren, ongedaan maken, versturen |
| `api/iris-transcribe.js` | spraak naar tekst |
| `api/iris-opdracht.js` | opdrachten aanmaken, beantwoorden, afsluiten |
| `api/iris-actie.js` | acties uitvoeren |
| `api/iris-belrij.js` | belrij + belpogingen |
| `api/iris-instellingen.js` | lezen en schrijven |
| `api/iris-log.js` | logboek |

Helpers in `api/_lib/iris/`: `koppel.js`, `classificeer.js`, `dossier.js`,
`venster.js`, `verzend.js`, `toon.js`, `autonomie.js`, `instellingen.js`.

---

## 4. Crons

Drie, tegen 62 bestaande. Vercel Pro heeft ruimte; de frequentie van vijf
minuten wordt op het plan gecontroleerd en anders naar het kleinst toegestane
gezet met een melding.

| Cron | Ritme | Doet |
|---|---|---|
| `cron-iris-werk` | `*/5 * * * *` | nieuwe berichten koppelen + classificeren; concepten maken; goedgekeurde acties uitvoeren; beloftes en escalaties opvolgen; signalen ophalen |
| `cron-iris-gezondheid` | `0 6 * * *` | instroom, koppeling, wachtrijen, vastgelopen berichten — met alarmmail |
| ~~`cron-iris-mail-ophalen`~~ | — | **vervalt**, zie beslissing B2 in de inventaris |

`cron-iris-werk` doet alles achter een schakelaar. Staat `IRIS_AAN` uit, dan
kijkt hij alleen en schrijft hij niets weg dat naar buiten gaat.

---

## 5. Toon en harde regels — waar ze in code landen

De regels uit sectie 5 van de masterprompt zijn geen promptinstructies maar
controles in code. Het verschil is wezenlijk: een prompt kan overtuigd worden,
een `if` niet. Zelfde redenering als lesson learned 24 in `CLAUDE.md`.

| Regel | Waar hij staat |
|---|---|
| Nooit over een factuur vóór de vervaldatum | `_lib/iris/verzend.js`, hergebruikt `dunning-overdue-guard.js` |
| Stille uren en niet op zondag | `_lib/iris/venster.js`, hergebruikt de zomer-/wintertijdlogica van `dunning-office-hours.js` |
| Geen verzonnen feiten — `[invullen]` blokkeert verzending | `_lib/iris/verzend.js`, harde weigering |
| Klachten en opzeggingen nooit automatisch | `_lib/iris/autonomie.js`, categorie hardgecodeerd uitgesloten |
| Geen naam of handtekening van een persoon | `_lib/iris/toon.js` |
| Nooit blokkeren of toegang intrekken | die actietypes bestaan niet in `iris_acties` |

---

## 6. Bouwvolgorde

| Fase | Wat | Vlag |
|---|---|---|
| 0 | inventaris + ontwerp | — |
| 1 | tabellen, RLS, rechten, instellingen | `IRIS_AAN` uit |
| 2 | koppelen + classificeren, schaduw | uit |
| 3 | gesprekken-audit + Post + Dossiers | `GESPREKKEN_V2` uit |
| 4 | schrijven + versturen met goedkeuring | uit |
| 5 | opdrachten | uit |
| 6 | beloftes + Joost-pauzehaak (losse PR) | `IRIS_PAUZEERT_JOOST` uit |
| 7 | belrij + escalatie + ochtendoverzicht | uit |
| 8 | mentorsignalen + signaalcontract | uit |
| 9 | LMS-acties | uit |
| 10 | venster + templates + template-wensen | uit |
| 11 | autonomie per categorie + droogtest | uit |
| 12 | gezondheid, logboek, handleiding | — |

Elke fase is één of meer PR's: bouwen, testen, mergen bij groen, na de merge het
echte endpoint en het echte scherm nakijken, `?v=` ophogen.

---

## 7. Wat dit ontwerp niet doet

- **Geen tweede webhook op hetzelfde nummer.** Meta stuurt naar één adres; een
  tweede zou de eerste verdringen.
- **Geen wijziging aan de aanmaanmotor.** De enige aanraking is één extra bron
  in een poort die er al staat, achter een vlag.
- **Geen schrijfactie naar het LMS-schema.** Alleen de bestaande
  machine-endpoints en `dfo-lms-db.js`.
- **Geen kolom weg, geen kolom hernoemd.** Alles additief.
