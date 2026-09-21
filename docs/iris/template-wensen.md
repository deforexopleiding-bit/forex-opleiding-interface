# Templates die Iris mist

**Voor:** Maxim, om bij Meta te laten goedkeuren
**Datum:** 21 september 2026

Buiten het servicevenster van 24 uur mag er alleen een door Meta goedgekeurde
template weg. Iris kiest er zelf een die bij de categorie past
(`api/_lib/iris/templates.js`). Past er geen, dan gaat het bericht via mail —
en komt de gewenste template hier te staan.

**Deze lijst is nog niet tegen de databank gehouden.** Deze sessie heeft geen
toegang tot het CRM-project, dus wat er werkelijk aan goedgekeurde templates
staat is niet nagekeken. Draai eerst:

```sql
select name, language, category, status, approved_at
from whatsapp_meta_templates
where status = 'APPROVED'
order by name;
```

Staat een template hieronder er al in, streep hem dan door. Staat er iets in
wat hier ontbreekt, laat het weten — dan kan de voorkeurslijst in
`templates.js` erop aangepast worden.

---

## Hoe Iris nu kiest

| Categorie | Voorkeur, in volgorde |
|---|---|
| facturatie | `factuur_vraag` → `aanmaning_dag7` |
| betaalafspraak | `betaalafspraak_bevestiging` → `aanmaning_dag7` |
| wanbetaling_reactie | `aanmaning_dag7` |
| lms_toegang | `lms_toegang_hulp` → `opvolging_geen_reactie2` |
| lms_support | `lms_support` → `opvolging_geen_reactie2` |
| planning_mentor | `mentor_planning` → `opvolging_geen_reactie2` |
| overig | `opvolging_geen_reactie2` |
| opzeg_klacht_juridisch | **geen** — gaat altijd langs een mens |
| bounce_systeem, spam | **geen** |

De namen zijn een voorkeur, geen voorwaarde. Bestaat een template niet of is
hij niet goedgekeurd, dan valt de keuze door naar de volgende. Zo breekt de
lijst niet zodra er bij Meta iets hernoemd wordt.

---

## Gevraagd

### 1. `betaalafspraak_bevestiging`

**Categorie bij Meta:** UTILITY
**Taal:** nl

> Beste {{1}}, we hebben je betaalafspraak genoteerd: {{2}} op {{3}}. Je hoort
> tot dan niets meer van ons over deze factuur. Lukt het toch niet, laat het
> dan even weten — dan kijken we samen verder.

**Variabelen:** {{1}} naam · {{2}} bedrag · {{3}} datum

**Waarom:** dit is het bericht dat een gesprek afsluit, en het is precies het
bericht dat je buiten het venster wilt kunnen sturen. Een klant die dinsdag om
half elf 's avonds een afspraak maakt, hoort woensdagochtend een bevestiging te
krijgen — en dan is het venster vaak net dicht.

Zonder deze template gaat de bevestiging via mail. Dat werkt, maar een
WhatsApp-afspraak per mail bevestigen voelt voor een klant als een ander
gesprek.

### 2. `lms_toegang_hulp`

**Categorie bij Meta:** UTILITY
**Taal:** nl

> Beste {{1}}, we zagen je bericht over het inloggen. We hebben je toegang
> nagekeken en sturen je zo een nieuwe link. Lukt het daarna nog niet, laat
> het weten.

**Variabelen:** {{1}} naam

**Waarom:** "ik kan niet inloggen" komt binnen op `onboarding@` en via
WhatsApp, vaak 's avonds als iemand gaat studeren. De volgende ochtend is het
venster dicht. Nu moet dat via mail, en dat is precies het kanaal waar de
persoon al niet op reageerde.

### 3. `factuur_vraag`

**Categorie bij Meta:** UTILITY
**Taal:** nl

> Beste {{1}}, we hebben je vraag over je factuur ontvangen en kijken het na.
> Je hoort vandaag nog van ons.

**Variabelen:** {{1}} naam

**Waarom:** een ontvangstbevestiging. Klein, maar het scheelt de tweede vraag
("heeft iemand mijn bericht gezien?") die er anders een dag later komt.

### 4. `mentor_planning`

**Categorie bij Meta:** UTILITY
**Taal:** nl

> Beste {{1}}, over je sessie met {{2}}: {{3}}. Laat weten of dat lukt.

**Variabelen:** {{1}} naam · {{2}} mentor · {{3}} wat er voorgesteld wordt

**Waarom:** sessies verzetten gebeurt buiten kantooruren, want dat is wanneer
iemand zijn agenda bekijkt.

---

## Wat er NIET gevraagd wordt

**Geen template voor opzeggingen, klachten of iets juridisch.** Die categorie
gaat altijd langs een mens, en een template zou de verleiding scheppen om dat
te omzeilen. Dat staat ook in de code: `VOORKEUR.opzeg_klacht_juridisch` is
uitdrukkelijk een lege lijst.

**Geen MARKETING-templates.** Ook goedgekeurde marketing-templates worden door
Iris geweigerd. Een betalingsherinnering onder die categorie versturen is een
overtreding van Meta's eigen indeling, en het is een categorie waar klanten
zich voor kunnen afmelden — dan mist een aanmaning zijn doel.

---

## Als er geen template past

Drie uitwegen, in deze volgorde:

1. **Mail**, als er een adres bekend is.
2. **Wachten** tot de klant zelf weer iets stuurt — dan gaat het venster open.
3. **Deze lijst aanvullen**, zodat het de volgende keer wél kan.

Wat er uitdrukkelijk **niet** gebeurt: een andere template pakken die er
ongeveer op lijkt. Een bericht persen in een template die er niet over gaat, is
erger dan een dag wachten — de klant leest dan iets wat niet bij zijn vraag
past, en concludeert dat er niemand meekijkt.
