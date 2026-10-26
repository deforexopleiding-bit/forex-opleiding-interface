# Bouwopdracht — Contentmachine 2.0: de Weekeditie

Opgesteld door Claude (Cowork) op 26 okt 2026 in opdracht van Maxim. Bouwt verder op Contentmachine 1.0 (PR's #1859–#1875 in forex-opleiding-interface, #130–#136 in dfo-website). Werk volledig autonoom in logische PR's (bouwen, testen, mergen bij groen, nameten, door). Additieve migraties mag je zelf draaien met controle voor en na. Meld afwijkingen met reden.

## 0. Wat Maxim zegt (kern)
- De **pagina** is het belangrijkste stuk: daar staat alles het mooist. Ze moet veel beter: creatiever, **interactief**, **bewegend** (zoals de animaties in The Lab: break of structure, sweep), met **sliders** zoals in de masterclass (winrate × risk/reward), data die indruk maakt ("kijk wat mogelijk is"), tips. Elke week op een **nieuwe creatieve manier**, nooit hetzelfde.
- De **nieuwsbrief** levert waarde maar is vooral de **brug naar de pagina**. Een mail kan niet interactief zijn, dus: kort, sterk, één nugget, en "lees de volledige weekeditie" → de pagina. De pagina ís de volledige wekelijkse nieuwsbrief online.
- **Stories, post en LinkedIn**: het huidige design is niet goed. Het moet de kwaliteit en stijl hebben van de 46 Instagram-posts die eerder gemaakt zijn (referenties in deze map). LinkedIn verwijst op een mooie manier naar de pagina, met een goede post erbij.
- **Na goedkeuring loopt alles vanzelf**: pagina live (en gecontroleerd), mail automatisch verstuurd, beelden klaar om te downloaden, teksten klaar om te kopiëren. Posten op Instagram/LinkedIn doet Maxim voorlopig manueel.
- Hij wil zien of er leads binnenkomen via de pagina (per kanaal is mooi meegenomen).
- Gebruik alles wat er al is (Lab, masterclassdecks, salesdeck, Instagram-posts, payouts, foto's) om elke editie aan te kleden met een **nugget** die mensen triggert.

## 1. Referenties in `docs/contentmachine/v2/`
- `stijl-instagram/` — 12 voorbeelden uit de reeks van 46 posts (DFO Instagram-kalender). **Dit is de lat voor alle social-beelden.**
- `fotos-masterclass/` — 12 echte foto's van masterclasses/teamtraining in het kantoor (zaal, scherm, publiek). Voeg ze toe aan de bibliotheek (soort `masterclass`, toestemming publiek = true: Maxim levert ze daarvoor aan).
- `logo/` — `logo.png` (donkere tekst) en `logo-wit.png`. Gebruik het echte logo overal (pagina, mail, social), niet het "DFO"-tekstblokje.
- `deck1-masterclass.html` — masterclass deel 1 met de **sliders** (winrate × risk/reward, "twee knoppen bepalen…", "een munt is 50/50…").
- `salesdeck-20244.html` — "20.244 trades": data-visuals (backtest 79% vs journal 48,5%, "je winners moeten groter zijn", "wat jouw rendement waard is op een funded account", "waar de trades vallen").
- `instagram-kalender.html` — de bron van de 46 posts (layout-systeem, typografie, kleuren).
- The Lab staat in `deforexopleiding-bit/dfo-lms-prototype` (zoek het Lab-bestand en de replay/chart-animaties: sweep vs BOS, replay-haltes, fib). Port de animatielogica, kopieer geen LMS-afhankelijkheden.

## 2. De pagina: "De Weekeditie" (dfo-website)
### 2.1 Bloksysteem
De pagina wordt niet meer uit vaste velden opgebouwd maar uit een **reeks blokken** die de generator per week kiest en vult (`output.pagina.blokken[]`, elk `{type, variant, props}`). Bouw in dfo-website een componentbibliotheek `components/weekeditie/` met per blok een strikt props-schema (zod). Exporteer alle schema's als `docs/weekeditie-blokken.json`; het CRM gebruikt die lijst in de generatorprompt en voor validatie (zelfde bestand in beide repo's, met een test die controleert dat ze gelijk zijn).

Minimaal deze blokken, mobiel eerst, vloeiend op 60 fps, `prefers-reduced-motion` gerespecteerd, toegankelijk met toetsenbord:

| type | wat | interactie/beweging |
|---|---|---|
| `hero` | opening | varianten: `video-poort` (bestaande poort), `foto` (masterclassfoto full-bleed met gradient, zoals de IG-posts), `groot-getal` (count-up van een echt cijfer), `chart` (geanimeerde chart die zich tekent) |
| `video-poort` | formulier → opname | bestaand gedrag behouden (naam, e-mail, gsm; video meteen open; cadeau eronder) |
| `replay-sweep-bos` | candles spelen af; bezoeker kiest "sweep of break?" vóór de onthulling | geport uit The Lab; props: richting, scenario, labels |
| `fib-animatie` | impuls → fib tekent 1 / 0 / 71 / −27; toggle H4 ↔ 15M; uitleg per niveau bij hover/tap | |
| `trechter` | de DFO-volgorde als stappen; tik door van H4-context tot target | stap-voor-stap, voortgangsbalk |
| `rr-sliders` | winrate- en risk/reward-sliders → resultaat over 100 trades, met dezelfde logica als deck 1 | live grafiek |
| `funded-calculator` | accountgrootte + maandrendement → wat dat waard is op een funded account (logica uit salesdeck) | sliders; duidelijke disclaimer |
| `quiz` | "Wat zou jij doen?" op een chart, 2–3 keuzes, onthulling met animatie en uitleg | antwoord pas na klik; telt als funnel-event |
| `trade-ontleed` | tijdlijn van één trade; elke stap met mini-chart die bij het scrollen verschijnt | scroll-animatie |
| `payout-muur` | kaarten met echte payouts uit de bibliotheek (enkel met toestemming), bedragen tellen op | count-up, lightbox |
| `data` | één of drie grote echte cijfers (uit de feitenbank) met context | count-up |
| `fotostrip` | "achter de schermen" met masterclassfoto's | horizontaal scrollen |
| `tip` | tip van de week als kaart (voorkant tip, achterkant waarom) | flip |
| `mythe-feit` | veelgemaakte fout vs hoe het wel zit | flip of swipe |
| `vooruitblik` | watchlist volgende week: paren met bias-pill en één zin, geen zekerheden | |
| `citaat` | korte uitspraak uit de training | |
| `cadeau` | gratis strategiesessie met Dave (bestaand) | |
| `inschrijven` | inschrijving wekelijkse analyse (voor update-drops zonder video) | |

### 2.2 Ontwerp
- Huisstijl: navy #0B1E2A/#112B3B, goud #D0A050, wit; echte logo; Inter (zelf-gehost). Neem het **niveau van de Instagram-reeks** als maatstaf: grote, strakke koppen met goudaccent op sleutelwoorden, eyebrows met lijn, echte foto's met diepte, UI-kaarten met schaduw, veel ritme en witruimte.
- **Thema-varianten** (minstens 4: bv. "nacht", "goud", "licht" à la de lichte IG-posts, "data") en hero-varianten, zodat geen twee opeenvolgende edities hetzelfde ogen.
- Sectie-overgangen met subtiele beweging (fade/slide bij scrollen), sticky inhoudsnavigatie op desktop, "deel deze editie"-knop.
- Prestatie: Lighthouse mobiel ≥ 90, CLS ~0. Geen zware libs; als je een animatielib nodig hebt, één (bv. framer-motion) en lazy per blok.

### 2.3 Regels voor de generator (pagina)
- Elke editie: 1 hero + **minstens 2 interactieve blokken** + 1 nugget (tip/mythe/data) + cadeau (+ video-poort als er een video is, + inschrijven als er geen is).
- Nooit dezelfde combinatie (thema + hero-variant + interactieve blokken) als een van de vorige 3 edities.
- **Feitenbank**: cijfers enkel uit `docs/contentmachine/feitenbank.md` (maak die aan met: 20.244 trades gelogd door 177 studenten; backtest-winrate 79% (5.947 trades) vs journal-winrate 48,5% (6.881 trades); de payouts uit de bibliotheek met datum en bedrag; DFO-fib 1/0/71/−27 en ±3,4R per trade bij TP op −27; 1% risico per trade) of uit de input van die week. Niets verzinnen. Sliders/calculators tonen rekenvoorbeelden, geen beloftes.
- Strategie enkel uit `docs/dfo-strategie-kennis.md`. Geen beloftes over snel rijk worden, geen verkooppraat.

## 3. De nieuwsbrief: teaser naar de Weekeditie
- Kort (± 150–220 woorden), elke week een ander format (de 8 formats blijven), maar altijd: sterke onderwerpregel (3 varianten), preheader, opener in Maxims stem, **één nugget** die op zich al waarde heeft, **één beeld** (een stilstaand of geanimeerd frame van het interactieve blok van de pagina: render in de CRM-pipeline een PNG of GIF van dat blok), een **open lus** ("wat zou jij doen? → het antwoord staat in de weekeditie"), één hoofdknop **"Lees de volledige weekeditie"** → de pagina met `src=nieuwsbrief`, en een PS met het cadeau.
- Echte logo in de header. Werkt in Gmail/Outlook/Apple Mail (tabellen, inline CSS), donkere look.

## 4. Social: nieuw design op het niveau van de Instagram-reeks
- Volledig nieuwe templates gebaseerd op `stijl-instagram/` en `instagram-kalender.html`: logo linksboven, teller `01 / 05` rechtsboven, eyebrow met lijn, grote vette kop met goud-accentwoorden, subtekst, `@deforexopleiding.nl` en `SWIPE →` onderaan; **foto-variant** (masterclassfoto full-bleed met donkere gradient onderaan), **donker effen**, **licht effen**, **data-variant** (enorm getal), **UI/chart-kaart-variant** (een frame van het interactieve blok als kaart met schaduw).
- **Stories** (1080x1920, 3–5): hook → nugget → bewijs/visual → "volledige weekeditie" met linkstickervak + korte URL. Zelfde systeem, verticaal gecomponeerd.
- **Carrousel** (1080x1350, 5–8) + **vierkant** (1080x1080) + **LinkedIn** (1200x1500 of 1080x1350): LinkedIn-tekst professioneler en langer (hook, 3–5 korte alinea's, inzicht, link naar de pagina met `src=linkedin`), geen hashtag-spam (max 3).
- Captions per kanaal klaar om te kopiëren, met de juiste link per kanaal.
- Render server- of client-side zoals nu, maar met deze templates; elke editie kiest een andere combinatie van varianten dan de vorige 3.
- Visuele kwaliteitscontrole: render een testset en vergelijk zelf met `stijl-instagram/`; pas aan tot het daar naast kan staan.

## 5. Goedkeuren = lanceren (één knop)
Vervang de losse knoppen door één flow **"Keur goed en lanceer"** (super_admin), met een bevestigingsscherm dat alles opsomt:
1. **Pagina**: status `gepubliceerd`; daarna controleert het CRM server-side dat `training.deforexopleiding.nl/<slug>` 200 geeft en de juiste titel toont (max 2 min wachten op ISR). Toon ✓ of de fout.
2. **Beelden**: alle social-beelden gerenderd en in Storage; zip klaar; captions per kanaal klaar ("Klaar om te posten"-paneel met kopieerknoppen en downloadknoppen).
3. **Nieuwsbrief automatisch via GoHighLevel** (route, omdat de campagne-API niet bruikbaar is):
   - Het CRM werkt één vaste GHL-template bij: **"DFO Weekeditie (actueel)"** (zelfde template-id elke week; id bewaren in een instelling).
   - Verzenden gebeurt via een **GHL-workflow** "DFO Weekeditie versturen" met trigger *tag toegevoegd: `weekeditie-verzenden`* → actie *e-mail versturen met template "DFO Weekeditie (actueel)"* → *tag verwijderen*. Claude (Cowork) maakt die workflow aan in GHL zodra jij de template-id en de tagnaam meldt; bouw een check in het CRM die meldt als de workflow nog niet bestaat.
   - Doelgroep: de bestaande nieuwsbrieflijst in GHL (zoek de bestaande tag of smart list die nu voor de nieuwsbrief gebruikt wordt en meld welke). Het CRM zet de tag `weekeditie-verzenden` op die contacten in batches (respecteer de GHL-ratelimiet), slaat uitgeschreven/DND-contacten over, en logt het aantal.
   - Keuze in het bevestigingsscherm: **nu versturen** of **inplannen** (datum/uur; een cron zet de tags op dat moment).
   - Verplicht: eerst een testmail naar de ingelogde gebruiker; zonder geslaagde test geen lancering.
   - Status in de drop: getagd X van Y, tijdstip, en (als de API het geeft) opens/kliks.
4. **Statusbord** van de drop: Pagina live ✓ · Mail verstuurd ✓ (X contacten) · Beelden klaar ✓ · Leads tot nu toe · Calls tot nu toe.

## 6. Data
- In het Contentmachine-overzicht en het statusbord per drop: bezoekers, leads, conversie, calls, en per kanaal (src) — hergebruik Trainingdrops-logica.
- Funnel-events voor de nieuwe interacties: `quiz_antwoord`, `slider_gebruikt`, `replay_gestart`, `blok_bekeken` (additieve uitbreiding van de event_type-CHECK, exacte superset) zodat we zien welke blokken werken; toon per drop de top-3 meest gebruikte blokken.

## 7. Generator 2.0 (CRM)
- Input blijft kort: video (optioneel), wat er gebeurde, foto's, optioneel trade-gegevens (paar, richting, entry/stop/target in R) en een optionele "nugget van de week".
- De generator krijgt mee: strategie-kennis, feitenbank, bibliotheek met AI-beschrijvingen, de blokkenlijst met schema's en hoe vaak/wanneer elk blok gebruikt werd, de laatste 6 edities (format, thema, hero, blokken, onderwerpregels, hooks). Kies bewust anders.
- Twee stappen: (1) **regisseur**: kiest format, thema, hero, blokken, beelden en de rode draad, met korte motivatie (zichtbaar in het werkblad); (2) **schrijver**: vult alle teksten en props per kanaal. Valideer tegen de schema's; bij fout één herstelpoging.
- Werkblad: tabblad Pagina toont de echte pagina in een iframe-voorbeeld (preview-route op de website met een token, geen publicatie nodig); per blok verplaatsen, verwijderen, toevoegen, opnieuw genereren.

## 8. Fasering
1. Componentbibliotheek Weekeditie + schema-export + preview-route (dfo-website). Pagina 22/10/26 blijft werken.
2. Generator 2.0 (regisseur/schrijver) + werkblad met live preview (CRM).
3. Nieuwsbrief-teaser + blokframe-render voor mail.
4. Social-templates 2.0 (stories, carrousel, vierkant, LinkedIn) op IG-niveau.
5. "Keur goed en lanceer" + GHL-template/workflow/tagging + statusbord + data.
6. Nieuwe demo-editie op basis van de training van 22/10/26 (niet publiceren) en een tweede demo **zonder video** (update-drop met payouts) om de variatie te tonen.

## 9. Grenzen
- CRM is live: alles additief; geen bestaande tabellen/rechten wijzigen. Geen secrets aanmaken.
- Nooit zelf een mail versturen of tags zetten op de echte lijst tijdens het bouwen/testen: test enkel met de ingelogde gebruiker of een testcontact met `+test`.
- Studentnamen/payouts enkel met toestemming. Disclaimer op pagina en mail.
- Meld na elke merge kort wat live staat en wat Claude (Cowork) moet nameten of in GHL moet aanmaken.
